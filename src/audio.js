// ============================================================
//  audio.js — synthesized engine + SFX (Web Audio API)
// ============================================================

import { clamp, ico } from "./config.js";
import { muted, setMuted, saveProgress } from "./store.js";

let audio = null;

// Soft-clip distortion curve for engine grit/growl.
export function makeDistortionCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

export function initAudio() {
  if (audio) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ac = new Ctx();

  const master = ac.createGain();
  master.gain.value = muted ? 0 : 0.9;
  master.connect(ac.destination);

  // Reusable noise buffer (combustion texture, whooshes, crash).
  const len = Math.floor(ac.sampleRate * 1.0);
  const noiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // ---- Engine ----
  // Signal chain: [noise exhaust + body saw + sub] -> mixBus -> pulse (AM at
  // firing rate) -> waveshaper (growl) -> lowpass (opens with revs) -> out.
  // Pulsing the ENTIRE mix at the firing rate is what makes it read as an
  // engine (exhaust pulses) instead of a steady drone.
  const engineGain = ac.createGain();
  engineGain.gain.value = 0;
  engineGain.connect(master);

  const engineFilter = ac.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 700;
  engineFilter.connect(engineGain);

  const shaper = ac.createWaveShaper();
  shaper.curve = makeDistortionCurve(2.4);
  shaper.oversample = "2x";
  shaper.connect(engineFilter);

  const pulse = ac.createGain(); // AM by LFO -> exhaust pulses
  pulse.gain.value = 0.55;
  pulse.connect(shaper);

  const mixBus = ac.createGain();
  mixBus.gain.value = 1;
  mixBus.connect(pulse);

  // Exhaust body: band-passed noise (the bulk of the character)
  const noiseSrc = ac.createBufferSource();
  noiseSrc.buffer = noiseBuffer;
  noiseSrc.loop = true;
  const noiseBP = ac.createBiquadFilter();
  noiseBP.type = "bandpass";
  noiseBP.frequency.value = 300;
  noiseBP.Q.value = 1.2;
  const noiseGain = ac.createGain();
  noiseGain.gain.value = 0.7;
  noiseSrc.connect(noiseBP).connect(noiseGain).connect(mixBus);

  // A little tonal body + low rumble
  const osc1 = ac.createOscillator();
  osc1.type = "sawtooth";
  osc1.frequency.value = 40;
  const oscGain = ac.createGain();
  oscGain.gain.value = 0.22;
  osc1.connect(oscGain).connect(mixBus);

  const sub = ac.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 20;
  const subGain = ac.createGain();
  subGain.gain.value = 0.5;
  sub.connect(subGain).connect(mixBus);

  // Firing-rate pulse LFO (swings pulse gain ~0.1 .. 1.0)
  const lfo = ac.createOscillator();
  lfo.type = "sawtooth";
  lfo.frequency.value = 40;
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth).connect(pulse.gain);

  osc1.start();
  sub.start();
  noiseSrc.start();
  lfo.start();

  audio = {
    ac, master, engineGain, engineFilter, shaper, osc1, sub, subGain, lfo, noiseBP, noiseBuffer,
    eIdle: 44, eRev: 175, eBright: 1.0,
  };
}

export function setEngineProfile(car) {
  if (!audio || !car.engine) return;
  const e = car.engine;
  audio.eIdle = e.idle;
  audio.eRev = e.rev;
  audio.eBright = e.bright;
  audio.shaper.curve = makeDistortionCurve(e.growl);
  audio.subGain.gain.value = e.bass;
}

export function audioEngine(speed, maxSpeed, throttle, running) {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const ratio = clamp(speed / maxSpeed, 0, 1);
  const f = audio.eIdle + ratio * (audio.eRev - audio.eIdle); // firing rate (Hz)
  audio.osc1.frequency.setTargetAtTime(f, t, 0.06);
  audio.sub.frequency.setTargetAtTime(f * 0.5, t, 0.06);
  audio.lfo.frequency.setTargetAtTime(f, t, 0.06); // pulses speed up with revs
  audio.noiseBP.frequency.setTargetAtTime((260 + ratio * 500) * audio.eBright, t, 0.1);
  audio.engineFilter.frequency.setTargetAtTime((360 + ratio * 2600 + throttle * 600) * audio.eBright, t, 0.1);
  // Quieter overall so passing whooshes are clearly audible.
  const vol = running ? 0.035 + 0.075 * ratio + 0.03 * throttle : 0;
  audio.engineGain.gain.setTargetAtTime(vol, t, 0.08);
}

// Fade the engine note to silence (pause / end of run). The engine loop restores
// its own volume the next time audioEngine() runs.
export function hushEngine(target = 0.0001, tc = 0.08) {
  if (audio) audio.engineGain.gain.setTargetAtTime(target, audio.ac.currentTime, tc);
}

// The sound of a car blowing past: filtered noise whose pitch doppler-shifts up
// as it nears then drops as it recedes, volume swelling at the moment it's
// alongside, the whole thing sweeping across the stereo field.
export function audioWhoosh(panVal, intensity) {
  if (!audio || intensity <= 0.01) return;
  const t = audio.ac.currentTime;
  const dur = 0.42;
  const peak = t + dur * 0.4;            // the instant it's right beside you
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  src.loop = true;

  // Bandpass gives it a wind/tyre-roar body; sweep = doppler (rise then fall).
  const bp = audio.ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(360, t);
  bp.frequency.exponentialRampToValueAtTime(1100, peak);
  bp.frequency.exponentialRampToValueAtTime(300, t + dur);
  // Roll off the hiss so it reads as "air", not "static".
  const lp = audio.ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2600;

  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.7 * intensity, peak); // swell as it arrives
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);       // fade as it leaves
  src.connect(bp).connect(lp).connect(g);

  if (audio.ac.createStereoPanner) {
    const pan = audio.ac.createStereoPanner();
    const side = clamp(panVal, -1, 1) || 0.5;
    pan.pan.setValueAtTime(side, t);                 // starts on the car's side
    pan.pan.linearRampToValueAtTime(-side * 0.7, t + dur); // sweeps past behind you
    g.connect(pan).connect(audio.master);
  } else {
    g.connect(audio.master);
  }
  src.start(t);
  src.stop(t + dur);
}

export function audioCrash() {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  const lp = audio.ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  src.connect(lp).connect(g).connect(audio.master);
  src.start(t);
  src.stop(t + 0.5);
  const o = audio.ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
  const og = audio.ac.createGain();
  og.gain.setValueAtTime(0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(og).connect(audio.master);
  o.start(t);
  o.stop(t + 0.4);
}

// Metallic scrape for a glancing sideswipe.
export function audioScrape(pan) {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  const bp = audio.ac.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1600; bp.Q.value = 0.8;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  src.connect(bp).connect(g);
  if (audio.ac.createStereoPanner) {
    const p = audio.ac.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    g.connect(p).connect(audio.master);
  } else g.connect(audio.master);
  src.start(t); src.stop(t + 0.25);
}

// ---- UI / reward sounds (synth, sharing the engine's AudioContext) ----
export function ensureAudio() {
  initAudio();
  if (audio && audio.ac.state === "suspended") audio.ac.resume();
}
export function uiTone(freq, when, dur, type = "sine", peak = 0.18) {
  if (!audio) return;
  const t = audio.ac.currentTime + when;
  const o = audio.ac.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.master);
  o.start(t); o.stop(t + dur + 0.03);
}
export function audioTick()   { ensureAudio(); uiTone(880, 0, 0.05, "triangle", 0.10); uiTone(1320, 0.02, 0.05, "triangle", 0.07); }
// A short blip on each near-miss; pitch climbs with the combo tier so a long
// chain rises in a satisfying ladder.
export function audioCombo(mult) { ensureAudio(); const base = 430 + Math.min(mult, 8) * 78; uiTone(base, 0, 0.06, "triangle", 0.05); uiTone(base * 1.5, 0.03, 0.05, "sine", 0.03); }
// Time-bend swoop when an exceptional pass triggers slow-mo (a quick downward pitch).
export function audioSlowmo() {
  ensureAudio(); if (!audio) return;
  const t = audio.ac.currentTime;
  const o = audio.ac.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(580, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.3);
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  o.connect(g).connect(audio.master); o.start(t); o.stop(t + 0.36);
}
// Bright ascending shimmer when a shield saves you (protective, not a crash).
export function audioShield() { ensureAudio(); [523, 784, 1047, 1568].forEach((f, i) => uiTone(f, i * 0.05, 0.5, "triangle", 0.09)); }
// A clean two-note "armed" ding when a shield finishes charging.
export function audioShieldReady() { ensureAudio(); uiTone(880, 0, 0.12, "sine", 0.08); uiTone(1320, 0.09, 0.16, "sine", 0.07); }
// Two rising notes when the road heats up — a step-up sting, brighter each stage.
export function audioHeat(stage) { ensureAudio(); const b = 300 + Math.min(stage, 12) * 26; uiTone(b, 0, 0.12, "sawtooth", 0.06); uiTone(b * 1.5, 0.08, 0.18, "triangle", 0.07); }
export function audioCoin()   { ensureAudio(); uiTone(784, 0, 0.08, "triangle", 0.13); uiTone(1175, 0.06, 0.10, "triangle", 0.13); uiTone(1568, 0.12, 0.16, "sine", 0.10); }
export function audioUnlock() { ensureAudio(); [523, 659, 784, 1047, 1319].forEach((f, i) => uiTone(f, i * 0.08, 0.45, "triangle", 0.11)); }
export function audioDenied() { ensureAudio(); uiTone(150, 0, 0.14, "square", 0.08); uiTone(110, 0.07, 0.18, "square", 0.08); }

export function toggleMute() {
  setMuted(!muted);
  if (audio) audio.master.gain.setTargetAtTime(muted ? 0 : 0.9, audio.ac.currentTime, 0.02);
  const btn = document.getElementById("mute");
  if (btn) btn.innerHTML = ico(muted ? "ico-vol-off" : "ico-vol-on");
  saveProgress();
}
