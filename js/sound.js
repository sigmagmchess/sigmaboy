/*
 * SigmaBoy — synthesized sounds (WebAudio, no assets)
 */
(function (global) {
'use strict';

let ctx = null;
let enabled = true;

function ac() {
  if (!ctx) {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip(freq, dur, type, gain, when, slide) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + (when || 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain || 0.25, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noiseBurst(dur, gain, filterFreq, when) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + (when || 0);
  const len = Math.max(1, (dur * a.sampleRate) | 0);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    d[i] = ((seed / 0x40000000) - 1) * (1 - i / len);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = filterFreq || 1200;
  const g = a.createGain();
  g.gain.value = gain || 0.3;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t0);
}

const Sound = {
  setEnabled(v) { enabled = v; },
  isEnabled() { return enabled; },
  unlock() { ac(); },
  move()    { if (enabled) { noiseBurst(0.05, 0.35, 2200); blip(220, 0.06, 'sine', 0.12); } },
  capture() { if (enabled) { noiseBurst(0.08, 0.45, 900); blip(140, 0.09, 'triangle', 0.2); } },
  castle()  { if (enabled) { noiseBurst(0.05, 0.3, 1800); noiseBurst(0.05, 0.3, 1400, 0.09); } },
  check()   { if (enabled) { blip(660, 0.09, 'square', 0.07); blip(880, 0.12, 'square', 0.07, 0.09); } },
  promote() { if (enabled) { blip(520, 0.08, 'sine', 0.15); blip(660, 0.08, 'sine', 0.15, 0.08); blip(880, 0.14, 'sine', 0.15, 0.16); } },
  illegal() { if (enabled) { blip(180, 0.12, 'sawtooth', 0.08, 0, 120); } },
  gameEnd() { if (enabled) { blip(440, 0.16, 'sine', 0.14); blip(550, 0.16, 'sine', 0.14, 0.13); blip(660, 0.26, 'sine', 0.14, 0.26); } },
  lowTime() { if (enabled) { blip(990, 0.06, 'square', 0.06); } },
};

global.SigmaSound = Sound;
})(typeof self !== 'undefined' ? self : globalThis);
