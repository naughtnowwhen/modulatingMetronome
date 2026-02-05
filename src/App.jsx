import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Wake Lock (keep screen on while playing) ──────────────────────────
let wakeLockSentinel = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* not supported or denied */ }
}
function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release();
    wakeLockSentinel = null;
  }
}

// ─── Pink Noise Generator (Voss-McCartney) ─────────────────────────────
class PinkNoise {
  constructor(numGenerators = 7) {
    this.numGenerators = numGenerators;
    this.generators = new Array(numGenerators).fill(0).map(() => Math.random() * 2 - 1);
    this.beatCount = 0;
  }

  next() {
    this.beatCount++;
    const changed = this.beatCount ^ (this.beatCount - 1);
    for (let i = 0; i < this.numGenerators; i++) {
      if (changed & (1 << i)) {
        this.generators[i] = Math.random() * 2 - 1;
      }
    }
    return this.generators.reduce((a, b) => a + b, 0) / this.numGenerators;
  }

  reset() {
    this.generators = new Array(this.numGenerators).fill(0).map(() => Math.random() * 2 - 1);
    this.beatCount = 0;
  }
}

// ─── Kuramoto Ensemble ──────────────────────────────────────────────────
class KuramotoEnsemble {
  constructor(N = 16, baseBPM = 125, spread = 0.03, coupling = 3.0) {
    this.N = N;
    this.baseFreq = baseBPM / 60;
    this.coupling = coupling;
    this.spread = spread;
    this.frustration = 0;
    // Initialize phases clustered near 0 (±π/6) so ensemble starts synchronized
    this.phases = new Array(N).fill(0).map(() => (Math.random() - 0.5) * Math.PI / 3);
    this.naturalFreqs = new Array(N).fill(0).map(() =>
      this.baseFreq * (1 + (Math.random() * 2 - 1) * spread)
    );
  }

  step(dt) {
    const newPhases = new Array(this.N);
    for (let i = 0; i < this.N; i++) {
      let couplingSum = 0;
      for (let j = 0; j < this.N; j++) {
        couplingSum += Math.sin(this.phases[j] - this.phases[i] - this.frustration);
      }
      const dtheta = this.naturalFreqs[i] + (this.coupling / this.N) * couplingSum;
      newPhases[i] = this.phases[i] + dtheta * dt;
    }
    this.phases = newPhases;
  }

  getOrderParameter() {
    let sumCos = 0, sumSin = 0;
    for (let i = 0; i < this.N; i++) {
      sumCos += Math.cos(this.phases[i]);
      sumSin += Math.sin(this.phases[i]);
    }
    const r = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / this.N;
    const psi = Math.atan2(sumSin, sumCos);
    return { r, psi };
  }

  getPhases() {
    return this.phases.map(p => ((p % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  }

  reconfigure(N, baseBPM, spread, coupling, frustration) {
    const newBaseFreq = baseBPM / 60;
    if (N !== this.N) {
      // Get mean phase BEFORE changing N (old array length must match old this.N)
      const { psi } = this.getOrderParameter();
      this.N = N;
      this.phases = new Array(N).fill(0).map(() => psi + (Math.random() - 0.5) * Math.PI / 3);
      this.naturalFreqs = new Array(N).fill(0).map(() =>
        newBaseFreq * (1 + (Math.random() * 2 - 1) * spread)
      );
    } else if (spread !== this.spread || Math.abs(newBaseFreq - this.baseFreq) > 0.001) {
      this.naturalFreqs = new Array(N).fill(0).map(() =>
        newBaseFreq * (1 + (Math.random() * 2 - 1) * spread)
      );
    }
    this.baseFreq = newBaseFreq;
    this.spread = spread;
    this.coupling = coupling;
    this.frustration = frustration;
  }
}

// ─── PLL Metronome ──────────────────────────────────────────────────────
class PLLMetronome {
  constructor(baseBPM = 125, Kp = 0.25, Ki = 0.02) {
    this.baseFreq = baseBPM / 60;
    this.ncoFreq = this.baseFreq;
    this.integrator = 0;
    this.Kp = Kp;
    this.Ki = Ki;
    this.lastPhaseError = 0;
    this.lastAsynchrony = 0;
  }

  onMusicianOnset(onsetTime, scheduledBeatTime) {
    const asynchrony = onsetTime - scheduledBeatTime;
    this.lastAsynchrony = asynchrony;
    const phaseError = asynchrony * this.baseFreq * 2 * Math.PI;
    const wrapped = ((phaseError % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.integrator += this.Ki * wrapped;
    this.integrator = Math.max(-0.1, Math.min(0.1, this.integrator));
    const freqCorrection = this.Kp * wrapped + this.integrator;
    this.ncoFreq = this.baseFreq + freqCorrection * this.baseFreq / (2 * Math.PI);
    this.ncoFreq = Math.max(this.baseFreq * 0.8, Math.min(this.baseFreq * 1.2, this.ncoFreq));
    this.lastPhaseError = wrapped;
    return asynchrony;
  }

  getNextIOI() {
    return 1.0 / this.ncoFreq;
  }

  reset(baseBPM) {
    this.baseFreq = baseBPM / 60;
    this.ncoFreq = this.baseFreq;
    this.integrator = 0;
    this.lastPhaseError = 0;
    this.lastAsynchrony = 0;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────
const SCHEDULE_AHEAD = 0.1;
const TIMER_INTERVAL = 25;
const TEMPO_PRESETS = [
  { label: 'Deep 120', bpm: 120 },
  { label: 'House 125', bpm: 125 },
  { label: 'Prog 128', bpm: 128 },
  { label: 'Trance 132', bpm: 132 },
];
const PLL_MODES = [
  { label: 'Mirror', Kp: 1.0, Ki: 0, desc: 'Copies your timing exactly' },
  { label: 'Cooperative', Kp: 0.25, Ki: 0.02, desc: 'Smooth tracking like an accompanist' },
  { label: 'Stubborn', Kp: 0.05, Ki: 0.005, desc: 'Barely responds — you match it' },
  { label: 'Adversarial', Kp: -0.15, Ki: 0, desc: 'Moves away from your errors' },
  { label: 'Custom', Kp: null, Ki: null, desc: 'Manual Kp and Ki control' },
];

// ─── Subdivision options ────────────────────────────────────────────────
const SUBDIV_OPTIONS = [
  { label: '♩', value: 1, desc: 'Quarter' },
  { label: '♪♪', value: 2, desc: '8th' },
  { label: '♬♬', value: 4, desc: '16th' },
];

// ─── Utility: schedule a click sound ────────────────────────────────────
function scheduleClick(audioCtx, time, isDownbeat, gainNode) {
  const osc = audioCtx.createOscillator();
  const clickGain = audioCtx.createGain();
  osc.frequency.value = isDownbeat ? 880 : 440;
  osc.connect(clickGain);
  clickGain.connect(gainNode);
  clickGain.gain.setValueAtTime(0.8, time);
  clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
  osc.start(time);
  osc.stop(time + 0.04);
}

function scheduleSubdivClick(audioCtx, time, gainNode) {
  const osc = audioCtx.createOscillator();
  const clickGain = audioCtx.createGain();
  osc.frequency.value = 660;
  osc.connect(clickGain);
  clickGain.connect(gainNode);
  clickGain.gain.setValueAtTime(0.35, time);
  clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
  osc.start(time);
  osc.stop(time + 0.03);
}

function scheduleRefClick(audioCtx, time, isDownbeat, gainNode) {
  const osc = audioCtx.createOscillator();
  const clickGain = audioCtx.createGain();
  osc.frequency.value = isDownbeat ? 1200 : 800;
  osc.type = 'triangle';
  osc.connect(clickGain);
  clickGain.connect(gainNode);
  clickGain.gain.setValueAtTime(0.5, time);
  clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.025);
  osc.start(time);
  osc.stop(time + 0.035);
}

// ─── Component: Beat Indicator ──────────────────────────────────────────
function BeatIndicator({ currentBeat, beatsPerBar, accentColor }) {
  return (
    <div className="flex gap-2 justify-center my-2">
      {Array.from({ length: beatsPerBar }, (_, i) => (
        <div
          key={i}
          className="w-4 h-4 rounded-full transition-all duration-75"
          style={{
            backgroundColor: currentBeat === i ? accentColor : '#374151',
            boxShadow: currentBeat === i ? `0 0 12px ${accentColor}` : 'none',
            transform: currentBeat === i ? 'scale(1.4)' : 'scale(1)',
          }}
        />
      ))}
    </div>
  );
}

// ─── Component: Transport ───────────────────────────────────────────────
function Transport({ isPlaying, onToggle, bpm, onBpmChange, volume, onVolumeChange, accentColor, subdivision, onSubdivisionChange, refClick, onRefClickChange }) {
  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-800 rounded-lg">
      <div className="flex items-center gap-4">
        <button
          onClick={onToggle}
          className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg border-2 transition-colors cursor-pointer"
          style={{ borderColor: accentColor, backgroundColor: isPlaying ? accentColor : 'transparent' }}
        >
          {isPlaying ? '■' : '▶'}
        </button>

        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-gray-400 w-14">Tempo</label>
            <input
              type="range"
              min="80"
              max="180"
              value={bpm}
              onChange={e => onBpmChange(Number(e.target.value))}
              className="flex-1 accent-current"
              style={{ color: accentColor }}
            />
            <span className="text-sm font-mono w-16 text-right" style={{ color: accentColor }}>
              {bpm} BPM
            </span>
          </div>
          <div className="flex gap-1">
            {TEMPO_PRESETS.map(p => (
              <button
                key={p.bpm}
                onClick={() => onBpmChange(p.bpm)}
                className="px-2 py-0.5 text-xs rounded cursor-pointer transition-colors"
                style={{
                  backgroundColor: bpm === p.bpm ? accentColor : '#374151',
                  color: bpm === p.bpm ? '#111' : '#9CA3AF',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Vol</label>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={e => onVolumeChange(Number(e.target.value))}
            className="w-20 accent-current"
            style={{ color: accentColor }}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Subdivision selector */}
        <div className="flex items-center gap-1">
          <label className="text-xs text-gray-400 mr-1">Notes</label>
          {SUBDIV_OPTIONS.map(s => (
            <button
              key={s.value}
              onClick={() => onSubdivisionChange(s.value)}
              className="px-2 py-0.5 text-xs rounded cursor-pointer transition-colors"
              title={s.desc}
              style={{
                backgroundColor: subdivision === s.value ? accentColor : '#374151',
                color: subdivision === s.value ? '#111' : '#9CA3AF',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Reference click toggle */}
        <button
          onClick={() => onRefClickChange(!refClick)}
          className="flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded cursor-pointer transition-colors ml-auto"
          style={{
            backgroundColor: refClick ? accentColor : '#374151',
            color: refClick ? '#111' : '#9CA3AF',
          }}
        >
          <span className="text-base leading-none">◈</span> Steady ref
        </button>
      </div>
    </div>
  );
}

// ─── Component: Metrics Panel ───────────────────────────────────────────
function MetricsPanel({ ioiHistory, baseBPM, sessionStart, accentColor }) {
  const lastIOI = ioiHistory.length > 0 ? ioiHistory[ioiHistory.length - 1] : 60 / baseBPM;
  const currentBPM = lastIOI > 0 ? (60 / lastIOI).toFixed(1) : baseBPM.toFixed(1);
  const deviation = (((lastIOI - 60 / baseBPM) / (60 / baseBPM)) * 100).toFixed(2);

  const recent = ioiHistory.slice(-64);
  let sd = 0;
  if (recent.length > 1) {
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    sd = Math.sqrt(recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length);
  }
  const sdMs = (sd * 1000).toFixed(1);

  const elapsed = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="flex gap-4 text-xs font-mono text-gray-400 justify-center mt-2">
      <span>IOI: <span style={{ color: accentColor }}>{(lastIOI * 1000).toFixed(0)}ms</span></span>
      <span>BPM: <span style={{ color: accentColor }}>{currentBPM}</span></span>
      <span>SD: <span style={{ color: accentColor }}>{sdMs}ms</span></span>
      <span>Dev: <span style={{ color: accentColor }}>{deviation}%</span></span>
      <span>Time: <span style={{ color: accentColor }}>{mm}:{ss}</span></span>
    </div>
  );
}

// ─── Slider Component ───────────────────────────────────────────────────
function Slider({ label, min, max, step, value, onChange, display, accentColor }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-400 w-24 shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-current"
        style={{ color: accentColor }}
      />
      <span className="text-xs font-mono w-16 text-right" style={{ color: accentColor }}>
        {display}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 1/f Fractal Metronome
// ═══════════════════════════════════════════════════════════════════════
function FractalMetronome() {
  const ACCENT = '#14b8a6';
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(125);
  const [volume, setVolume] = useState(80);
  const [drift, setDrift] = useState(2);
  const [color, setColor] = useState(1.0);
  const [subdivision, setSubdivision] = useState(1);
  const [refClick, setRefClick] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [ioiHistory, setIoiHistory] = useState([]);
  const [sessionStart, setSessionStart] = useState(null);

  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const refGainRef = useRef(null);
  const timerRef = useRef(null);
  const nextBeatTimeRef = useRef(0);
  const prevBeatTimeRef = useRef(0);
  const beatCountRef = useRef(0);
  const pinkNoiseRef = useRef(new PinkNoise(7));
  const smoothedRef = useRef(0);
  const ioiBufferRef = useRef([]);
  const nextRefBeatTimeRef = useRef(0);
  const refBeatCountRef = useRef(0);

  // Keep params in refs so the scheduler sees latest values
  const bpmRef = useRef(bpm);
  const driftRef = useRef(drift);
  const colorRef = useRef(color);
  const subdivRef = useRef(subdivision);
  const refClickRef = useRef(refClick);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { driftRef.current = drift; }, [drift]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { subdivRef.current = subdivision; }, [subdivision]);
  useEffect(() => { refClickRef.current = refClick; }, [refClick]);

  const getNextIOI = useCallback(() => {
    const baseIOI = 60.0 / bpmRef.current;
    let sample = pinkNoiseRef.current.next();
    const beta = colorRef.current;

    // White-pink-brown blending
    if (beta < 1) {
      const white = Math.random() * 2 - 1;
      sample = sample * beta + white * (1 - beta);
    } else if (beta > 1) {
      const alpha = Math.pow(2, -(beta - 1));
      smoothedRef.current = smoothedRef.current * (1 - alpha) + sample * alpha;
      sample = smoothedRef.current;
    }

    const cv = driftRef.current / 100;
    return baseIOI * (1 + sample * cv);
  }, []);

  const startPlayback = useCallback(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    gain.connect(ctx.destination);
    const refGain = ctx.createGain();
    refGain.gain.value = volume / 100;
    refGain.connect(ctx.destination);
    audioCtxRef.current = ctx;
    gainRef.current = gain;
    refGainRef.current = refGain;

    pinkNoiseRef.current.reset();
    smoothedRef.current = 0;
    beatCountRef.current = 0;
    refBeatCountRef.current = 0;
    ioiBufferRef.current = [];
    nextBeatTimeRef.current = ctx.currentTime + 0.05;
    prevBeatTimeRef.current = nextBeatTimeRef.current;
    nextRefBeatTimeRef.current = ctx.currentTime + 0.05;
    setIoiHistory([]);
    setSessionStart(Date.now());

    const schedule = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;

      // Schedule modulating beats
      while (nextBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
        const beatTime = nextBeatTimeRef.current;
        const beatNum = beatCountRef.current;
        const isDownbeat = beatNum % 4 === 0;
        scheduleClick(ctx, beatTime, isDownbeat, gainRef.current);

        // Record IOI
        const currentIOI = beatNum > 0 ? beatTime - prevBeatTimeRef.current : getNextIOI();
        if (beatNum > 0) {
          const ioi = beatTime - prevBeatTimeRef.current;
          ioiBufferRef.current.push(ioi);
          if (ioiBufferRef.current.length > 256) ioiBufferRef.current.shift();
          setIoiHistory([...ioiBufferRef.current]);
        }

        // Schedule subdivision clicks within this beat
        const subdiv = subdivRef.current;
        const nextIOI = getNextIOI();
        if (subdiv > 1) {
          for (let s = 1; s < subdiv; s++) {
            const subTime = beatTime + (nextIOI * s) / subdiv;
            scheduleSubdivClick(ctx, subTime, gainRef.current);
          }
        }

        // Schedule visual update
        const delay = (beatTime - ctx.currentTime) * 1000;
        setTimeout(() => setCurrentBeat(beatNum % 4), Math.max(0, delay));

        prevBeatTimeRef.current = beatTime;
        beatCountRef.current++;
        nextBeatTimeRef.current += nextIOI;
      }

      // Schedule steady reference beats
      if (refClickRef.current) {
        const refIOI = 60.0 / bpmRef.current;
        while (nextRefBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
          const isDownbeat = refBeatCountRef.current % 4 === 0;
          scheduleRefClick(ctx, nextRefBeatTimeRef.current, isDownbeat, refGainRef.current);
          refBeatCountRef.current++;
          nextRefBeatTimeRef.current += refIOI;
        }
      }
    };

    schedule();
    timerRef.current = setInterval(schedule, TIMER_INTERVAL);
    requestWakeLock();
    setIsPlaying(true);
  }, [volume, getNextIOI]);

  const stopPlayback = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    releaseWakeLock();
    setIsPlaying(false);
    setCurrentBeat(-1);
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  }, [isPlaying, startPlayback, stopPlayback]);

  // Update gain in real time
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume / 100;
    if (refGainRef.current) refGainRef.current.gain.value = volume / 100;
  }, [volume]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      releaseWakeLock();
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // IOI bar visualization data
  const baseIOI = 60 / bpm;
  const recentIOIs = ioiHistory.slice(-32);

  return (
    <div className="flex flex-col gap-3">
      <Transport
        isPlaying={isPlaying}
        onToggle={togglePlayback}
        bpm={bpm}
        onBpmChange={setBpm}
        volume={volume}
        onVolumeChange={setVolume}
        accentColor={ACCENT}
        subdivision={subdivision}
        onSubdivisionChange={setSubdivision}
        refClick={refClick}
        onRefClickChange={setRefClick}
      />

      <BeatIndicator currentBeat={currentBeat} beatsPerBar={4} accentColor={ACCENT} />

      <div className="bg-gray-800 rounded-lg p-4 space-y-3">
        <Slider
          label="Drift (CV%)"
          min={0} max={5} step={0.1}
          value={drift}
          onChange={setDrift}
          display={`${drift.toFixed(1)}%`}
          accentColor={ACCENT}
        />
        <div className="text-xs text-gray-500 ml-26 pl-1">
          ±{(bpm * drift / 100).toFixed(1)} BPM → {(bpm - bpm * drift / 100).toFixed(0)}–{(bpm + bpm * drift / 100).toFixed(0)} range
        </div>
        <Slider
          label="Color (β)"
          min={0} max={2} step={0.05}
          value={color}
          onChange={setColor}
          display={color < 0.4 ? 'White' : color < 1.4 ? 'Pink' : 'Brown'}
          accentColor={ACCENT}
        />
      </div>

      {/* IOI Bar Visualization */}
      <div className="bg-gray-800 rounded-lg p-3">
        <div className="text-xs text-gray-400 mb-2">IOI History (last 32 beats)</div>
        <div className="flex items-end gap-px h-20">
          {recentIOIs.length === 0 ? (
            <div className="text-xs text-gray-600 flex items-center justify-center w-full h-full">
              Press play to begin
            </div>
          ) : (
            recentIOIs.map((ioi, i) => {
              const ratio = ioi / baseIOI;
              const height = Math.max(5, Math.min(100, ratio * 50));
              const deviation = Math.abs(ratio - 1);
              const opacity = Math.min(1, 0.3 + deviation * 10);
              const isLast = i === recentIOIs.length - 1;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-all duration-75"
                  style={{
                    height: `${height}%`,
                    backgroundColor: ACCENT,
                    opacity: isLast ? 1 : opacity,
                    boxShadow: isLast ? `0 0 6px ${ACCENT}` : 'none',
                  }}
                />
              );
            })
          )}
        </div>
        <div className="flex justify-between text-xs text-gray-600 mt-1">
          <span>Slower ↑</span>
          <span>Base IOI: {(baseIOI * 1000).toFixed(0)}ms</span>
          <span>↓ Faster</span>
        </div>
      </div>

      <MetricsPanel ioiHistory={ioiHistory} baseBPM={bpm} sessionStart={sessionStart} accentColor={ACCENT} />

      {/* CV of last 64 beats */}
      {ioiHistory.length > 4 && (() => {
        const recent = ioiHistory.slice(-64);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const sd = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
        const cv = ((sd / mean) * 100).toFixed(2);
        return (
          <div className="text-center text-xs text-gray-400">
            Measured CV: <span style={{ color: ACCENT }}>{cv}%</span> (target: {drift.toFixed(1)}%)
          </div>
        );
      })()}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Kuramoto Ensemble Metronome
// ═══════════════════════════════════════════════════════════════════════
function KuramotoMetronome() {
  const ACCENT = '#8b5cf6';
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(125);
  const [volume, setVolume] = useState(80);
  const [ensembleSize, setEnsembleSize] = useState(16);
  const [coupling, setCoupling] = useState(5.0);
  const [spread, setSpread] = useState(1.5);
  const [frustration, setFrustration] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [subdivision, setSubdivision] = useState(1);
  const [refClick, setRefClick] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [ioiHistory, setIoiHistory] = useState([]);
  const [sessionStart, setSessionStart] = useState(null);
  const [orderR, setOrderR] = useState(0);
  const [phases, setPhases] = useState([]);

  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const refGainRef = useRef(null);
  const timerRef = useRef(null);
  const animFrameRef = useRef(null);
  const ensembleRef = useRef(null);
  const simTimeRef = useRef(0);
  const lastBeatSimTimeRef = useRef(0);
  const prevPsiRef = useRef(0);
  const cumPhaseRef = useRef(0);
  const lastBeatPhaseRef = useRef(0);
  const beatCountRef = useRef(0);
  const nextBeatTimeRef = useRef(0);
  const prevBeatTimeRef = useRef(0);
  const ioiBufferRef = useRef([]);
  const isPlayingRef = useRef(false);
  const nextRefBeatTimeRef = useRef(0);
  const refBeatCountRef = useRef(0);

  const bpmRef = useRef(bpm);
  const ensembleSizeRef = useRef(ensembleSize);
  const couplingRef = useRef(coupling);
  const spreadRef = useRef(spread);
  const frustrationRef = useRef(frustration);
  const subdivRef = useRef(subdivision);
  const refClickRef = useRef(refClick);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { ensembleSizeRef.current = ensembleSize; }, [ensembleSize]);
  useEffect(() => { couplingRef.current = coupling; }, [coupling]);
  useEffect(() => { spreadRef.current = spread; }, [spread]);
  useEffect(() => { frustrationRef.current = frustration; }, [frustration]);
  useEffect(() => { subdivRef.current = subdivision; }, [subdivision]);
  useEffect(() => { refClickRef.current = refClick; }, [refClick]);

  // Reconfigure ensemble when params change (while playing)
  useEffect(() => {
    if (ensembleRef.current) {
      ensembleRef.current.reconfigure(
        ensembleSize, bpm, spread / 100, coupling, frustration * Math.PI / 180
      );
    }
  }, [ensembleSize, bpm, spread, coupling, frustration]);

  const findNextBeatIOI = useCallback(() => {
    const ens = ensembleRef.current;
    if (!ens) return 60.0 / bpmRef.current;

    const baseIOI = 60.0 / bpmRef.current;
    const dt = 0.001;
    let prevPsi = prevPsiRef.current;
    const targetPhase = lastBeatPhaseRef.current + 2 * Math.PI;

    for (let i = 0; i < 3000; i++) {
      ens.step(dt);
      simTimeRef.current += dt;
      const { psi } = ens.getOrderParameter();

      // Unwrap phase delta: compute how much psi advanced this step
      let dpsi = psi - prevPsi;
      if (dpsi > Math.PI) dpsi -= 2 * Math.PI;
      if (dpsi < -Math.PI) dpsi += 2 * Math.PI;
      cumPhaseRef.current += dpsi;
      prevPsi = psi;

      // Beat fires when cumulative phase reaches the next 2π boundary
      if (cumPhaseRef.current >= targetPhase) {
        prevPsiRef.current = psi;
        lastBeatPhaseRef.current = targetPhase; // snap to exact target to prevent drift
        const ioi = simTimeRef.current - lastBeatSimTimeRef.current;
        lastBeatSimTimeRef.current = simTimeRef.current;
        // Clamp to reasonable range (±30% of base)
        return Math.max(baseIOI * 0.7, Math.min(baseIOI * 1.4, ioi));
      }
    }
    prevPsiRef.current = prevPsi;
    // Fallback: use base IOI
    lastBeatSimTimeRef.current = simTimeRef.current;
    lastBeatPhaseRef.current = targetPhase;
    return baseIOI;
  }, []);

  const startPlayback = useCallback(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    gain.connect(ctx.destination);
    const refGain = ctx.createGain();
    refGain.gain.value = volume / 100;
    refGain.connect(ctx.destination);
    audioCtxRef.current = ctx;
    gainRef.current = gain;
    refGainRef.current = refGain;

    const ens = new KuramotoEnsemble(
      ensembleSize, bpm, spread / 100, coupling
    );
    ens.frustration = frustration * Math.PI / 180;
    ensembleRef.current = ens;

    // Warm up: run simulation for 2 seconds so ensemble locks before generating beats
    const warmupSteps = 2000;
    for (let i = 0; i < warmupSteps; i++) {
      ens.step(0.001);
    }

    simTimeRef.current = 0;
    lastBeatSimTimeRef.current = 0;
    cumPhaseRef.current = 0;
    lastBeatPhaseRef.current = 0;
    prevPsiRef.current = ens.getOrderParameter().psi;
    beatCountRef.current = 0;
    refBeatCountRef.current = 0;
    ioiBufferRef.current = [];
    isPlayingRef.current = true;

    // Find first beat
    const firstIOI = findNextBeatIOI();
    nextBeatTimeRef.current = ctx.currentTime + firstIOI;
    prevBeatTimeRef.current = ctx.currentTime;
    nextRefBeatTimeRef.current = ctx.currentTime + 0.05;
    setIoiHistory([]);
    setSessionStart(Date.now());

    const schedule = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;

      // Schedule modulating beats
      while (nextBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
        const beatTime = nextBeatTimeRef.current;
        const beatNum = beatCountRef.current;
        const isDownbeat = beatNum % 4 === 0;
        scheduleClick(ctx, beatTime, isDownbeat, gainRef.current);

        if (beatNum > 0) {
          const ioi = beatTime - prevBeatTimeRef.current;
          ioiBufferRef.current.push(ioi);
          if (ioiBufferRef.current.length > 256) ioiBufferRef.current.shift();
          setIoiHistory([...ioiBufferRef.current]);
        }

        // Schedule subdivision clicks
        const nextIOI = findNextBeatIOI();
        const subdiv = subdivRef.current;
        if (subdiv > 1) {
          const subdivIOI = beatNum > 0 ? (beatTime - prevBeatTimeRef.current) : nextIOI;
          for (let s = 1; s < subdiv; s++) {
            const subTime = beatTime + (subdivIOI * s) / subdiv;
            scheduleSubdivClick(ctx, subTime, gainRef.current);
          }
        }

        const delay = (beatTime - ctx.currentTime) * 1000;
        setTimeout(() => setCurrentBeat(beatNum % 4), Math.max(0, delay));

        prevBeatTimeRef.current = beatTime;
        beatCountRef.current++;
        nextBeatTimeRef.current += nextIOI;
      }

      // Schedule steady reference beats
      if (refClickRef.current) {
        const refIOI = 60.0 / bpmRef.current;
        while (nextRefBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
          const isDownbeat = refBeatCountRef.current % 4 === 0;
          scheduleRefClick(ctx, nextRefBeatTimeRef.current, isDownbeat, refGainRef.current);
          refBeatCountRef.current++;
          nextRefBeatTimeRef.current += refIOI;
        }
      }
    };

    schedule();
    timerRef.current = setInterval(schedule, TIMER_INTERVAL);

    // Animation loop for visualization
    const animate = () => {
      if (!isPlayingRef.current) return;
      const ens = ensembleRef.current;
      if (ens) {
        const { r } = ens.getOrderParameter();
        setOrderR(r);
        setPhases(ens.getPhases());
      }
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);

    requestWakeLock();
    setIsPlaying(true);
  }, [volume, bpm, ensembleSize, coupling, spread, frustration, findNextBeatIOI]);

  const stopPlayback = useCallback(() => {
    isPlayingRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    releaseWakeLock();
    setIsPlaying(false);
    setCurrentBeat(-1);
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  }, [isPlaying, startPlayback, stopPlayback]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume / 100;
    if (refGainRef.current) refGainRef.current.gain.value = volume / 100;
  }, [volume]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      isPlayingRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // Order parameter color
  const rColor = orderR > 0.7 ? '#22c55e' : orderR > 0.4 ? '#eab308' : '#ef4444';

  return (
    <div className="flex flex-col gap-3">
      <Transport
        isPlaying={isPlaying}
        onToggle={togglePlayback}
        bpm={bpm}
        onBpmChange={setBpm}
        volume={volume}
        onVolumeChange={setVolume}
        accentColor={ACCENT}
        subdivision={subdivision}
        onSubdivisionChange={setSubdivision}
        refClick={refClick}
        onRefClickChange={setRefClick}
      />

      <BeatIndicator currentBeat={currentBeat} beatsPerBar={4} accentColor={ACCENT} />

      <div className="bg-gray-800 rounded-lg p-4 space-y-3">
        <Slider
          label="Ensemble (N)"
          min={4} max={32} step={1}
          value={ensembleSize}
          onChange={setEnsembleSize}
          display={`${ensembleSize}`}
          accentColor={ACCENT}
        />
        <Slider
          label="Cohesion (K)"
          min={0} max={10} step={0.1}
          value={coupling}
          onChange={setCoupling}
          display={coupling.toFixed(1)}
          accentColor={ACCENT}
        />
        <div className="flex justify-between text-xs text-gray-500 ml-26 pl-1">
          <span>Loose</span><span>Tight</span>
        </div>
        <Slider
          label="Individuality"
          min={0} max={10} step={0.1}
          value={spread}
          onChange={setSpread}
          display={`${spread.toFixed(1)}%`}
          accentColor={ACCENT}
        />
        <div className="text-xs text-gray-500 ml-26 pl-1">
          ±{(bpm * spread / 100).toFixed(1)} BPM natural freq range
        </div>
        {showAdvanced && (
          <Slider
            label="Resistance (α)"
            min={0} max={45} step={1}
            value={frustration}
            onChange={setFrustration}
            display={`${frustration}°`}
            accentColor={ACCENT}
          />
        )}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer"
        >
          {showAdvanced ? '▾ Hide advanced' : '▸ Show advanced'}
        </button>
      </div>

      {/* Kuramoto Circle Visualization */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center gap-4">
          <div className="relative w-48 h-48 mx-auto shrink-0">
            <svg viewBox="-1.3 -1.3 2.6 2.6" className="w-full h-full">
              {/* Unit circle */}
              <circle cx="0" cy="0" r="1" fill="none" stroke="#374151" strokeWidth="0.02" />
              {/* Order parameter arrow */}
              {phases.length > 0 && (() => {
                const { r, psi } = ensembleRef.current?.getOrderParameter() || { r: 0, psi: 0 };
                return (
                  <line
                    x1="0" y1="0"
                    x2={r * Math.cos(psi)} y2={r * Math.sin(psi)}
                    stroke={rColor} strokeWidth="0.04" strokeLinecap="round"
                  />
                );
              })()}
              {/* Oscillator dots */}
              {phases.map((phase, i) => (
                <circle
                  key={i}
                  cx={Math.cos(phase)}
                  cy={Math.sin(phase)}
                  r="0.06"
                  fill={ACCENT}
                  opacity={0.8}
                />
              ))}
            </svg>
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="text-xs text-gray-400">Order (r)</div>
            <div className="text-3xl font-mono font-bold" style={{ color: rColor }}>
              {orderR.toFixed(2)}
            </div>
            <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-100"
                style={{ width: `${orderR * 100}%`, backgroundColor: rColor }}
              />
            </div>
            <div className="text-xs text-gray-500">
              {orderR > 0.8 ? 'Locked' : orderR > 0.5 ? 'Partial sync' : 'Desynchronized'}
            </div>
          </div>
        </div>
      </div>

      <MetricsPanel ioiHistory={ioiHistory} baseBPM={bpm} sessionStart={sessionStart} accentColor={ACCENT} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PLL Training Metronome
// ═══════════════════════════════════════════════════════════════════════
function PLLMetronomeComponent() {
  const ACCENT = '#f59e0b';
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(125);
  const [volume, setVolume] = useState(80);
  const [modeIdx, setModeIdx] = useState(1); // Cooperative default
  const [customKp, setCustomKp] = useState(0.25);
  const [customKi, setCustomKi] = useState(0.02);
  const [subdivision, setSubdivision] = useState(1);
  const [refClick, setRefClick] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [ioiHistory, setIoiHistory] = useState([]);
  const [sessionStart, setSessionStart] = useState(null);
  const [phaseError, setPhaseError] = useState(0);
  const [asyncHistory, setAsyncHistory] = useState([]); // [{scheduled, tap, async}]
  const [tapTimes, setTapTimes] = useState([]);

  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const refGainRef = useRef(null);
  const timerRef = useRef(null);
  const pllRef = useRef(null);
  const nextBeatTimeRef = useRef(0);
  const prevBeatTimeRef = useRef(0);
  const beatCountRef = useRef(0);
  const ioiBufferRef = useRef([]);
  const scheduledBeatsRef = useRef([]); // last N scheduled beat times
  const asyncBufferRef = useRef([]);
  const isPlayingRef = useRef(false);
  const nextRefBeatTimeRef = useRef(0);
  const refBeatCountRef = useRef(0);

  const bpmRef = useRef(bpm);
  const subdivRef = useRef(subdivision);
  const refClickRef = useRef(refClick);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { subdivRef.current = subdivision; }, [subdivision]);
  useEffect(() => { refClickRef.current = refClick; }, [refClick]);

  const getActiveKpKi = useCallback(() => {
    const mode = PLL_MODES[modeIdx];
    if (mode.label === 'Custom') return { Kp: customKp, Ki: customKi };
    return { Kp: mode.Kp, Ki: mode.Ki };
  }, [modeIdx, customKp, customKi]);

  // Update PLL gains when mode changes
  useEffect(() => {
    if (pllRef.current) {
      const { Kp, Ki } = getActiveKpKi();
      pllRef.current.Kp = Kp;
      pllRef.current.Ki = Ki;
    }
  }, [getActiveKpKi]);

  const handleTap = useCallback(() => {
    if (!audioCtxRef.current || !isPlayingRef.current) return;
    const tapTime = audioCtxRef.current.currentTime;

    // Find nearest scheduled beat
    const beats = scheduledBeatsRef.current;
    if (beats.length === 0) return;

    let nearestBeat = beats[0];
    let minDist = Math.abs(tapTime - beats[0]);
    for (let i = 1; i < beats.length; i++) {
      const d = Math.abs(tapTime - beats[i]);
      if (d < minDist) {
        minDist = d;
        nearestBeat = beats[i];
      }
    }

    const pll = pllRef.current;
    if (pll) {
      const asyncMs = pll.onMusicianOnset(tapTime, nearestBeat) * 1000;
      setPhaseError(asyncMs);

      const entry = { scheduled: nearestBeat, tap: tapTime, async: asyncMs };
      asyncBufferRef.current.push(entry);
      if (asyncBufferRef.current.length > 64) asyncBufferRef.current.shift();
      setAsyncHistory([...asyncBufferRef.current]);
    }
  }, []);

  const startPlayback = useCallback(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    gain.connect(ctx.destination);
    const refGain = ctx.createGain();
    refGain.gain.value = volume / 100;
    refGain.connect(ctx.destination);
    audioCtxRef.current = ctx;
    gainRef.current = gain;
    refGainRef.current = refGain;

    const { Kp, Ki } = getActiveKpKi();
    const pll = new PLLMetronome(bpm, Kp, Ki);
    pllRef.current = pll;

    beatCountRef.current = 0;
    refBeatCountRef.current = 0;
    ioiBufferRef.current = [];
    scheduledBeatsRef.current = [];
    asyncBufferRef.current = [];
    isPlayingRef.current = true;
    nextBeatTimeRef.current = ctx.currentTime + 0.05;
    prevBeatTimeRef.current = nextBeatTimeRef.current;
    nextRefBeatTimeRef.current = ctx.currentTime + 0.05;
    setIoiHistory([]);
    setAsyncHistory([]);
    setSessionStart(Date.now());

    const schedule = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;

      // Schedule modulating beats
      while (nextBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
        const beatTime = nextBeatTimeRef.current;
        const beatNum = beatCountRef.current;
        const isDownbeat = beatNum % 4 === 0;
        scheduleClick(ctx, beatTime, isDownbeat, gainRef.current);

        scheduledBeatsRef.current.push(beatTime);
        if (scheduledBeatsRef.current.length > 32) scheduledBeatsRef.current.shift();

        if (beatNum > 0) {
          const ioi = beatTime - prevBeatTimeRef.current;
          ioiBufferRef.current.push(ioi);
          if (ioiBufferRef.current.length > 256) ioiBufferRef.current.shift();
          setIoiHistory([...ioiBufferRef.current]);
        }

        // Schedule subdivision clicks
        const pllIOI = pllRef.current.getNextIOI();
        const subdiv = subdivRef.current;
        if (subdiv > 1) {
          for (let s = 1; s < subdiv; s++) {
            const subTime = beatTime + (pllIOI * s) / subdiv;
            scheduleSubdivClick(ctx, subTime, gainRef.current);
          }
        }

        const delay = (beatTime - ctx.currentTime) * 1000;
        setTimeout(() => setCurrentBeat(beatNum % 4), Math.max(0, delay));

        prevBeatTimeRef.current = beatTime;
        beatCountRef.current++;
        nextBeatTimeRef.current += pllIOI;
      }

      // Schedule steady reference beats
      if (refClickRef.current) {
        const refIOI = 60.0 / bpmRef.current;
        while (nextRefBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
          const isDownbeat = refBeatCountRef.current % 4 === 0;
          scheduleRefClick(ctx, nextRefBeatTimeRef.current, isDownbeat, refGainRef.current);
          refBeatCountRef.current++;
          nextRefBeatTimeRef.current += refIOI;
        }
      }
    };

    schedule();
    timerRef.current = setInterval(schedule, TIMER_INTERVAL);
    requestWakeLock();
    setIsPlaying(true);
  }, [volume, bpm, getActiveKpKi]);

  const stopPlayback = useCallback(() => {
    isPlayingRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    releaseWakeLock();
    setIsPlaying(false);
    setCurrentBeat(-1);
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  }, [isPlaying, startPlayback, stopPlayback]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume / 100;
    if (refGainRef.current) refGainRef.current.gain.value = volume / 100;
  }, [volume]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      isPlayingRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // Phase error color
  const absError = Math.abs(phaseError);
  const errorColor = absError < 20 ? '#22c55e' : absError < 50 ? '#eab308' : '#ef4444';

  // Async SD
  const recentAsync = asyncHistory.slice(-32);
  let asyncSD = 0;
  if (recentAsync.length > 1) {
    const mean = recentAsync.reduce((a, b) => a + b.async, 0) / recentAsync.length;
    asyncSD = Math.sqrt(recentAsync.reduce((s, v) => s + (v.async - mean) ** 2, 0) / recentAsync.length);
  }
  const meanAsync = recentAsync.length > 0
    ? recentAsync.reduce((a, b) => a + b.async, 0) / recentAsync.length
    : 0;

  const mode = PLL_MODES[modeIdx];

  return (
    <div className="flex flex-col gap-3">
      <Transport
        isPlaying={isPlaying}
        onToggle={togglePlayback}
        bpm={bpm}
        onBpmChange={setBpm}
        volume={volume}
        onVolumeChange={setVolume}
        accentColor={ACCENT}
        subdivision={subdivision}
        onSubdivisionChange={setSubdivision}
        refClick={refClick}
        onRefClickChange={setRefClick}
      />

      <BeatIndicator currentBeat={currentBeat} beatsPerBar={4} accentColor={ACCENT} />

      {/* TAP button */}
      <button
        onPointerDown={handleTap}
        className="w-full py-6 rounded-lg text-2xl font-bold cursor-pointer transition-all active:scale-95 select-none"
        style={{
          backgroundColor: isPlaying ? '#292524' : '#1c1917',
          color: isPlaying ? ACCENT : '#57534e',
          border: `2px solid ${isPlaying ? ACCENT : '#44403c'}`,
        }}
      >
        TAP
      </button>

      {/* Mode selector */}
      <div className="bg-gray-800 rounded-lg p-4 space-y-3">
        <div className="text-xs text-gray-400 mb-2">Response Mode</div>
        <div className="flex flex-wrap gap-1">
          {PLL_MODES.map((m, i) => (
            <button
              key={m.label}
              onClick={() => setModeIdx(i)}
              className="px-3 py-1 text-xs rounded cursor-pointer transition-colors"
              style={{
                backgroundColor: modeIdx === i ? ACCENT : '#374151',
                color: modeIdx === i ? '#111' : '#9CA3AF',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-500">{mode.desc}</div>

        {mode.label === 'Custom' && (
          <div className="space-y-2 pt-2">
            <Slider
              label="Kp (phase)"
              min={-0.5} max={1.0} step={0.01}
              value={customKp}
              onChange={setCustomKp}
              display={customKp.toFixed(2)}
              accentColor={ACCENT}
            />
            <Slider
              label="Ki (drift)"
              min={0} max={0.1} step={0.001}
              value={customKi}
              onChange={setCustomKi}
              display={customKi.toFixed(3)}
              accentColor={ACCENT}
            />
          </div>
        )}
      </div>

      {/* Phase error display */}
      <div className="bg-gray-800 rounded-lg p-4 text-center">
        <div className="text-xs text-gray-400 mb-1">Phase Error</div>
        <div className="text-4xl font-mono font-bold" style={{ color: errorColor }}>
          {phaseError >= 0 ? '+' : ''}{phaseError.toFixed(1)}ms
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {phaseError > 0 ? 'Late' : phaseError < 0 ? 'Early' : '—'}
        </div>
      </div>

      {/* Asynchrony timeline */}
      <div className="bg-gray-800 rounded-lg p-3">
        <div className="text-xs text-gray-400 mb-2">Asynchrony Timeline (last 16 beats)</div>
        <div className="relative h-20">
          {recentAsync.slice(-16).map((entry, i) => {
            const x = (i / 15) * 100;
            // Map async to vertical position: 0ms = center, ±100ms = edges
            const yCenter = 50;
            const yOffset = Math.max(-45, Math.min(45, entry.async * 0.45));
            return (
              <div key={i} className="absolute" style={{ left: `${x}%`, top: 0, height: '100%', width: '2px' }}>
                {/* Metronome beat marker */}
                <div
                  className="absolute w-2 h-2 rounded-full -ml-1"
                  style={{ top: `${yCenter}%`, backgroundColor: ACCENT }}
                />
                {/* Tap marker */}
                <div
                  className="absolute w-2 h-2 rounded-full -ml-1"
                  style={{ top: `${yCenter + yOffset}%`, backgroundColor: '#fff' }}
                />
                {/* Connecting line */}
                <div
                  className="absolute w-px -ml-px"
                  style={{
                    top: `${Math.min(yCenter, yCenter + yOffset)}%`,
                    height: `${Math.abs(yOffset)}%`,
                    backgroundColor: errorColor,
                    opacity: 0.5,
                  }}
                />
              </div>
            );
          })}
          {recentAsync.length === 0 && (
            <div className="text-xs text-gray-600 flex items-center justify-center h-full">
              Tap along with the beat
            </div>
          )}
        </div>
        <div className="flex justify-between text-xs text-gray-600 mt-1">
          <span>● Metronome</span>
          <span>○ Your tap</span>
        </div>
      </div>

      {/* Async stats */}
      <div className="flex gap-4 text-xs font-mono text-gray-400 justify-center">
        <span>SD: <span style={{ color: ACCENT }}>{asyncSD.toFixed(1)}ms</span></span>
        <span>Mean: <span style={{ color: ACCENT }}>{meanAsync.toFixed(1)}ms</span></span>
        <span>NCO: <span style={{ color: ACCENT }}>{pllRef.current ? (60 / pllRef.current.getNextIOI()).toFixed(1) : bpm} BPM</span></span>
      </div>

      <MetricsPanel ioiHistory={ioiHistory} baseBPM={bpm} sessionStart={sessionStart} accentColor={ACCENT} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Main App
// ═══════════════════════════════════════════════════════════════════════
const TABS = [
  { id: 'fractal', label: '1/f Fractal', color: '#14b8a6' },
  { id: 'kuramoto', label: 'Kuramoto', color: '#8b5cf6' },
  { id: 'pll', label: 'PLL', color: '#f59e0b' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('fractal');
  // Use keys to force remount (which stops playback) on tab switch
  const [keys, setKeys] = useState({ fractal: 0, kuramoto: 0, pll: 0 });

  const switchTab = (tabId) => {
    if (tabId === activeTab) return;
    // Increment key of the tab we're leaving to force unmount (stops audio)
    setKeys(prev => ({ ...prev, [activeTab]: prev[activeTab] + 1 }));
    setActiveTab(tabId);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold text-center mb-1">Modulating Metronomes</h1>
      <p className="text-xs text-gray-500 text-center mb-4">
        Scientifically-grounded tempo modulation for timing training
      </p>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-4 bg-gray-800 rounded-lg p-1">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className="flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all cursor-pointer"
            style={{
              backgroundColor: activeTab === tab.id ? tab.color + '20' : 'transparent',
              color: activeTab === tab.id ? tab.color : '#6B7280',
              borderBottom: activeTab === tab.id ? `2px solid ${tab.color}` : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active metronome */}
      {activeTab === 'fractal' && <FractalMetronome key={keys.fractal} />}
      {activeTab === 'kuramoto' && <KuramotoMetronome key={keys.kuramoto} />}
      {activeTab === 'pll' && <PLLMetronomeComponent key={keys.pll} />}

      <div className="text-center text-xs text-gray-600 mt-6">
        Built for house & EDM guitarists · 115–135 BPM sweet spot
      </div>
    </div>
  );
}
