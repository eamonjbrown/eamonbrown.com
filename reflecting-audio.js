/* Aumara Realms — REFLECTING soundscape (AudioWorklet).
   Ported from ReflectingAudio.swift: shimmer grains over glassy vowel pads,
   a light sub anchor, resonant filter sweep, an oversampled wavefolder on the
   pad voice, and a shimmering feedback echo. No beat, no drums.
   Gesture stirs the shimmer; stillness lets the pad bloom. */

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(type, f, q, sr) {
    const w0 = 2 * Math.PI * f / sr, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
    let b0, b1, b2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }   // lowpass
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (Math.abs(y) < 1e-18) y = 0;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const triFold = x => { const q = x * 0.25 + 0.25; const r = q - Math.floor(q + 0.5); return 4 * Math.abs(r) - 1; };
const TAU = Math.PI * 2;
const PENT = [1.0, 1.122462, 1.259921, 1.498307, 1.681793];
const VOWELS = [[730, 1090], [270, 2290], [300, 870]];
const NG = 24;

class ReflectingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.gPhase = new Float32Array(NG); this.gEnv = new Float32Array(NG);
    this.gFreq = new Float32Array(NG); this.gDecay = new Float32Array(NG).fill(0.9995);
    this.gAmp = new Float32Array(NG);
    this.gTimer = 0; this.rng = 0x9E3779B9 >>> 0;
    this.pad = new Float64Array(6);
    this.f1 = new Biquad(); this.f2 = new Biquad(); this.sweep = new Biquad();
    this.vowelPhase = 0; this.subPhase = 0; this.prevPre = 0; this.lfo = 0;
    this.dLen = Math.floor(sr * 2); this.dBuf = new Float32Array(this.dLen); this.dW = 0; this.dFb = 0;
    // Trace-mode rest values from the device (touchDefaultValue).
    this.s = { rate: 0.013, pad: 0.721, vowel: 0.452, reg: 0.039, bright: 0.271, sweep: 0.408, fold: 0.233, echo: 0.835 };
    this.in = { y: 0.5, speed: 0, touch: 0, trace: 0, breath: 0.5, activity: 0, calm: 0 };
    this.gY = 0.5; this.gSpeed = 0; this.gTouch = 0; this.gPress = 0;
    this.fade = 0; this.elapsed = 0;
    this.dcX = 0; this.dcY = 0;
    this.port.onmessage = e => Object.assign(this.in, e.data);
  }
  rand() { let r = this.rng; r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0; this.rng = r; return r / 4294967296; }

  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const sr = sampleRate, dt = n / sr, inv = 1 / sr, I = this.in, s = this.s;

    // Slider targets: device rest values, nudged by attention.
    const tgt = {
      rate: 0.013 + I.activity * 0.22,                 // focus stirs the glitter
      pad: 0.62 + I.calm * 0.25,                       // stillness lets the pad bloom
      vowel: 0.30 + I.activity * 0.35,
      reg: 0.039, bright: 0.271 + I.activity * 0.12,
      sweep: 0.408, fold: 0.233, echo: 0.835,
    };
    const lp = 1 - Math.exp(-dt / 2);
    for (const k in tgt) s[k] += lp * (tgt[k] - s[k]);

    const fast = 1 - Math.exp(-dt / 0.08), slow = 1 - Math.exp(-dt / 2);
    this.gY += fast * (I.y - this.gY);
    this.gSpeed += fast * (I.speed - this.gSpeed);
    this.gTouch += (1 - Math.exp(-dt / 0.25)) * (I.touch - this.gTouch);
    const pressT = Math.max(Math.min(I.trace, 1), this.gTouch * (1 - this.gSpeed));
    this.gPress += slow * (pressT - this.gPress);

    const baseFreq = 220 * Math.pow(2, (s.reg - 0.5) * 4);
    const bright = Math.min(s.bright + (1 - this.gY) * this.gTouch * 0.35, 1);
    const gps = (0.3 + s.rate * 40) * (1 + this.gSpeed * this.gTouch * 3);
    const gInt = sr / Math.max(gps, 0.1);
    const gDecay = Math.exp(-1 / (sr * (0.35 + (1 - bright) * 2.2)));
    const nyq = sr * 0.45;

    this.vowelPhase += (0.05 + s.vowel * 1.5) * dt;
    if (this.vowelPhase >= 1) this.vowelPhase -= Math.floor(this.vowelPhase);
    const vt = this.vowelPhase * 3, seg = Math.floor(vt) % 3, fr = vt - Math.floor(vt), nx = (seg + 1) % 3;
    const f1 = VOWELS[seg][0] + (VOWELS[nx][0] - VOWELS[seg][0]) * fr;
    const f2 = VOWELS[seg][1] + (VOWELS[nx][1] - VOWELS[seg][1]) * fr;
    const fq = 4 + bright * 10;
    this.f1.set('bp', Math.min(f1, nyq), fq, sr);
    this.f2.set('bp', Math.min(f2, nyq), fq, sr);

    const padRoot = baseFreq * 2;
    const swell = 0.82 + I.breath * 0.36;
    const det = [1, 1.004, 0.996, 1.5, 2.0, 2.997];
    const ph = this.pad, gE = this.gEnv, gP = this.gPhase, gF = this.gFreq, gD = this.gDecay, gA = this.gAmp;
    const fold = s.fold, padDepth = s.pad;

    for (let i = 0; i < n; i++) {
      if (--this.gTimer <= 0) {
        this.gTimer += gInt;
        let slot = 0, lo = gE[0];
        for (let g = 1; g < NG; g++) if (gE[g] < lo) { lo = gE[g]; slot = g; }
        const deg = PENT[Math.floor(this.rand() * 5) % 5];
        const octUp = 2 + Math.floor(this.rand() * (1 + bright * 2));
        gF[slot] = Math.min(baseFreq * Math.pow(2, octUp) * deg, nyq);
        gP[slot] = 0; gE[slot] = 0.5 + this.rand() * 0.5; gD[slot] = gDecay; gA[slot] = 0.10 + this.rand() * 0.06;
      }
      let grains = 0;
      for (let g = 0; g < NG; g++) {
        if (gE[g] <= 0.0001) continue;
        gP[g] += gF[g] * inv; if (gP[g] > 1) gP[g] -= 1;
        const p = gP[g] * TAU;
        grains += (Math.sin(p) * 0.8 + Math.sin(p * 2) * 0.2) * gE[g] * gA[g];
        gE[g] *= gD[g];
      }

      for (let k = 0; k < 6; k++) { ph[k] += padRoot * det[k] * inv; if (ph[k] > 1) ph[k] -= 1; }
      const raw = (Math.sin(ph[0] * TAU) + (ph[0] * 2 - 1) * 0.3) * 0.22
                + (Math.sin(ph[1] * TAU) + (ph[1] * 2 - 1) * 0.3) * 0.22
                + (Math.sin(ph[2] * TAU) + (ph[2] * 2 - 1) * 0.3) * 0.22
                + Math.sin(ph[3] * TAU) * 0.14 + Math.sin(ph[4] * TAU) * 0.12
                + Math.sin(ph[5] * TAU) * 0.08 * bright;
      const formant = this.f1.run(raw) * 0.7 + this.f2.run(raw) * 0.5;
      const pre = (formant + raw * bright * 0.12) * 0.5 * padDepth * swell;
      let pad;
      if (fold > 0.005) {
        const drive = 1 + fold * 3, mid = 0.5 * (this.prevPre + pre);
        const folded = 0.5 * (triFold(mid * drive) + triFold(pre * drive));
        this.prevPre = pre;
        pad = (pre * (1 - fold) + folded * fold) / (1 + fold * 0.5);
      } else { this.prevPre = pre; pad = pre; }

      this.subPhase += baseFreq * 0.5 * inv; if (this.subPhase > 1) this.subPhase -= 1;
      const sub = Math.sin(this.subPhase * TAU) * 0.05 * (0.4 + padDepth * 0.6);
      L[i] = grains + pad + sub;
    }

    // Filter sweep.
    if (s.sweep > 0.005) {
      this.lfo += (0.1 + s.sweep * 0.6) * dt; if (this.lfo > 1) this.lfo -= 1;
      const lv = Math.sin(this.lfo * TAU) * 0.5 + 0.5;
      const cut = Math.min(Math.max(400 + lv * s.sweep * 4000 + (1 - this.gY) * this.gTouch * 1500, 200), nyq);
      this.sweep.set('lp', cut, 1.5 + s.sweep * 6, sr);
      for (let i = 0; i < n; i++) { const d = L[i]; L[i] = d + (this.sweep.run(d) - d) * s.sweep; }
    }

    // Echo — fixed 0.42 s, feedback + send only (click-free). Wet goes a little
    // wider in the stereo field than the dry voice.
    const delay = Math.min(Math.floor(0.42 * sr), this.dLen - 1);
    const fb = 0.30 + s.echo * 0.45;
    const send = Math.min(Math.max(s.echo * 0.6 + this.gSpeed * this.gTouch * 0.2, 0), 0.8);

    // Fade-in (shorter than on device: here a tap starts the sound).
    this.elapsed += dt;
    if (this.elapsed > 0.25) this.fade += (1 - Math.exp(-dt / 2.0)) * (1 - this.fade);
    const g = this.fade * 0.85;

    for (let i = 0; i < n; i++) {
      let ri = this.dW - delay; if (ri < 0) ri += this.dLen;
      const dOut = this.dBuf[ri];
      this.dFb += 0.30 * (dOut - this.dFb);
      let w = L[i] + this.dFb * fb;
      if (!Number.isFinite(w)) { w = 0; this.dFb = 0; }
      this.dBuf[this.dW] = w;
      if (++this.dW >= this.dLen) this.dW = 0;

      // DC block, gain, soft limit, −1 dB ceiling.
      const x = L[i];
      const y = x - this.dcX + 0.995 * this.dcY;
      this.dcX = x; this.dcY = Math.abs(y) < 1e-15 ? 0 : y;
      const wet = dOut * send;
      L[i] = Math.tanh((y + wet * 0.85) * g) * 0.89;
      R[i] = Math.tanh((y + wet * 1.0) * g) * 0.89;
    }
    return true;
  }
}

registerProcessor('reflecting', ReflectingProcessor);
