/* Aumara Realms — WITNESSING soundscape (AudioWorklet).
   Ported from WitnessingAudio.swift. The sound reads the same generative field
   the picture is drawn from, at eight points around the camera:
     rain grains   — short mineral pings where the ground is moving
     erosion hiss  — noise grains where the ground is falling
     settling ring — a soft struck-bar resonance when a crest comes to rest
     ground tone   — a low, quiet sine
     pad           — root, fifth and octave; the height of the land picks the root
   then a scan-rate tremolo, a motion filter, pan, a ping-pong echo and a limiter.
   Slider values are the ones saved in the app's trace mode. */

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  lowpass(f, q, sr) {
    const w0 = 2 * Math.PI * f / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (Math.abs(y) < 1e-18) y = 0;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const TAU = Math.PI * 2;
const KZ = TAU / 128;
const clamp01 = v => Math.min(1, Math.max(0, v));
const PENT = [0, 2, 4, 7, 9];
const BAR_MODES = [1.0, 2.756, 5.404, 8.933, 13.345];
const LISTEN = [[-20, 4], [-9, 16], [2, 8], [13, 20], [22, 6], [-14, 24], [6, 2], [-3, 12]];
const NG = 24, NH = 8, NM = 8;

// App values (trace mode).
const S = {
  rain: 0.383, ring: 0.150, hiss: 0.176, pitch: 0.128, drip: 0.176, warmth: 0.100,
  abstract: 0.935, genlock: 0.976, motion: 0.696, dir: 0.469, scan: 0.563,
};
const STONE = { decay: 0.9994, bright: 0.8, spread: 1.0 };     // Stone Character 0.162 → stone
const DRONE_LVL = 1.0, EVENT_LVL = 0.7, TEX_LVL = 0.55;         // app mix defaults
const OUT_GAIN = 5.0;                                           // level matched to the Reflecting web port

// The field (WitnessingField.height) — the same function the picture uses.
function fieldHeight(wx, wz, t, breath) {
  const speed = 0.20;
  let h = 0;
  h += Math.sin(wx * 0.16 + wz * (2 * KZ) + t * speed) * 0.82;
  h += Math.sin(wx * -0.13 + wz * (4 * KZ) + t * speed * 0.62 + 1.7) * 0.52;
  h += Math.sin(wx * 0.29 + wz * (-5 * KZ) + t * speed * 1.65 + 3.1) * 0.28;
  h += Math.sin(wx * 0.060 + wz * KZ + t * 0.08) * (0.5 + 0.5 * Math.sin(t * 0.060)) * 1.45;
  h += Math.sin(wx * -0.045 + wz * KZ - t * 0.05 + 2.0) * (0.5 + 0.5 * Math.sin(t * 0.045 + 2.3)) * 1.05;
  h += (clamp01(breath) - 0.5) * 1.30;
  return h;
}

class WitnessingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.k = 48000 / sr;                         // per-sample decays were tuned at 48 kHz
    // L1 rain grains
    this.gPhase = new Float32Array(NG); this.gEnv = new Float32Array(NG);
    this.gFreq = new Float32Array(NG).fill(440);
    this.gNoise = new Int32Array(NG); for (let i = 0; i < NG; i++) this.gNoise[i] = 12345 + i * 7919;
    // L3 hiss grains
    this.hEnv = new Float32Array(NH); this.hState = new Float32Array(NH);
    this.hNoise = new Int32Array(NH); for (let i = 0; i < NH; i++) this.hNoise[i] = 54321 + i * 6151;
    // L2 settling resonators (bar modes × 65 Hz)
    this.mInc = new Float64Array(NM); this.mAmp = new Float64Array(NM); this.mTarget = new Float64Array(NM);
    this.mPhase = new Float64Array(NM); this.mDecay = new Float64Array(NM);
    const decayScale = 0.6 + S.ring * 1.4;
    for (let i = 0; i < NM; i++) {
      this.mInc[i] = TAU * 65 * BAR_MODES[i % 5] * (i < 5 ? 1 : 2) / sr;
      this.mDecay[i] = Math.pow(Math.exp(-1 / (sr * (2 + i * 0.5))), 1 / decayScale);
    }
    this.mAttack = (1 / 48) * this.k;
    // L4 ground
    this.gp0 = 0; this.gp1 = 0;
    // L5 pad
    this.padA = [0.00, 0.31, 0.57]; this.padB = [0.12, 0.44, 0.83];
    this.padFreq = [110, 165, 220]; this.padTarget = [110, 165, 220];
    this.padAmp = [1, 1, 1]; this.padWeight = [1.0, 0.65, 0.45];
    this.padDegree = 0; this.padCand = 0; this.padCandT = 0; this.padCommitAge = 100;
    this.padLP = 0; this.padMotion = 0; this.padPresence = 0.15;
    this.settleCooldown = 0;
    // filters, echo
    this.rainWah = new Biquad(); this.motionFilter = new Biquad();
    this.rainEnv = 0; this.scanPhase = 0; this.freePhase = 0;
    this.dLen = Math.floor(sr * 0.42);
    this.dL = new Float32Array(this.dLen); this.dR = new Float32Array(this.dLen); this.dI = 0;
    this.lpL = 0; this.lpR = 0;
    this.pan = Math.sin(S.dir * TAU);
    // gesture
    this.gY = 0.5; this.gSpeed = 0; this.gTouch = 0; this.gPress = 0;
    this.entry = 0;
    this.mono = new Float32Array(128);
    // field clock: follows the picture, coasts between messages
    this.in = { t: 72, camX: 0, camZ: 0, breath: 0.5, phase: 0, rate: 1, y: 0.5, speed: 0, down: 0, trace: 0 };
    this.port.onmessage = e => Object.assign(this.in, e.data);
  }

  rainGrain(velocity, hint, groundFreq) {
    let slot = -1;
    for (let g = 0; g < NG; g++) if (this.gEnv[g] < 0.001) { slot = g; break; }
    if (slot < 0) return;
    const f = groundFreq * BAR_MODES[hint % 5] * STONE.spread;
    this.gFreq[slot] = Math.min(Math.max(f, 80), sampleRate * 0.45);
    this.gEnv[slot] = velocity * STONE.bright;
    this.gPhase[slot] = 0;
  }
  hissGrain(velocity) {
    let slot = -1;
    for (let h = 0; h < NH; h++) if (this.hEnv[h] < 0.001) { slot = h; break; }
    if (slot < 0) return;
    this.hEnv[slot] = velocity * 0.5; this.hState[slot] = 0;
  }
  strikeSoft(velocity, maxAmp) {
    for (let i = 0; i < NM; i++) {
      const headroom = Math.max(0, 1 - (this.mAmp[i] + this.mTarget[i]) / maxAmp);
      this.mTarget[i] += velocity * (1 - i * 0.04) * headroom;
    }
  }

  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const sr = sampleRate, dt = n / sr, inv = 1 / sr, I = this.in, k = this.k;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const M = this.mono;

    // Coast the field clock between messages from the picture.
    I.t += dt * I.rate; I.camZ += 0.8 * dt * I.rate;
    I.phase += dt * I.rate / 10.9; if (I.phase >= 1) I.phase -= 1;

    // Genlock: same breath clock and free oscillator as the picture.
    this.freePhase += dt * 0.7;
    const genOsc = Math.sin(I.phase * TAU) * S.genlock + Math.sin(this.freePhase) * (1 - S.genlock);
    const padSwell = 1 + genOsc * 0.10;

    // Gesture.
    const fast = 1 - Math.exp(-dt / 0.08), slow = 1 - Math.exp(-dt / 2);
    this.gY += fast * (I.y - this.gY);
    this.gSpeed += fast * (I.speed - this.gSpeed);
    this.gTouch += (1 - Math.exp(-dt / 0.25)) * (I.down - this.gTouch);
    const pressT = Math.max(Math.min(I.trace, 1), this.gTouch * (1 - this.gSpeed));
    this.gPress += slow * (pressT - this.gPress);

    const effRain = clamp01(S.rain * (1 + this.gSpeed * this.gTouch * 1.6) * (1 - this.gPress * 0.5));
    const groundFreq = 40 + S.pitch * 120 + (1 - this.gY) * this.gTouch * 40;

    const re = Math.min(1, this.entry / 15);
    const grainEase = 0.1 + 0.9 * (re * re * (3 - 2 * re));
    this.settleCooldown -= dt;

    // Read the field at the listening points: grains from its motion, pad from its height.
    const fs = dt * 60;
    let hSum = 0, mSum = 0, crestSum = 0;
    for (let i = 0; i < LISTEN.length; i++) {
      const wx = LISTEN[i][0] + I.camX, wz = LISTEN[i][1] + I.camZ;
      const h0 = fieldHeight(wx, wz, I.t, I.breath);
      const vel = (fieldHeight(wx, wz, I.t + 1 / 30, I.breath) - h0) * 30;
      const speed = Math.abs(vel);
      hSum += h0; mSum += speed; crestSum += Math.max(0, h0);
      const hint = Math.max(0, Math.min(60, Math.floor(clamp01((h0 + 2.5) / 6) * 60)));

      if (Math.random() < (0.030 + Math.min(0.12, speed * 0.5)) * fs) {
        if (Math.random() < effRain * grainEase) this.rainGrain(0.55 + Math.min(0.40, speed * 0.9), hint, groundFreq);
      }
      if (vel < -0.08 && Math.random() < Math.min(0.12, -vel * 0.35) * fs) {
        if (Math.random() < grainEase) this.hissGrain(0.45 + Math.min(0.40, -vel * 0.8));
      }
      if (h0 > 1.2 && speed < 0.08 && Math.random() < 0.02 * fs && this.settleCooldown <= 0) {
        this.settleCooldown = 0.6;
        this.strikeSoft(0.7 * 0.16 * S.ring * (1 + this.gPress * 0.5), 0.12);
      }
    }

    // Pad control.
    const nOff = LISTEN.length;
    const crest = crestSum / nOff;
    const presT = 0.15 + 0.85 * clamp01((crest - 0.4) / 1.6);
    this.padPresence += (1 - Math.exp(-dt / 3)) * (presT - this.padPresence);
    const hNorm = clamp01((hSum / nOff + 2.5) / 11);
    this.padMotion += (1 - Math.exp(-dt / 1.5)) * (Math.min(1, mSum / nOff * 0.6) - this.padMotion);
    const cand = Math.min(4, Math.max(0, Math.floor(hNorm * 5)));
    if (cand !== this.padCand) { this.padCand = cand; this.padCandT = 0; } else this.padCandT += dt;
    this.padCommitAge += dt;
    if (this.padCand !== this.padDegree && this.padCandT > 4) {
      this.padDegree = this.padCand;
      const root = 110 * Math.pow(2, PENT[this.padDegree] / 12);
      this.padTarget = [root, root * 1.5, root * 2];
      this.padCommitAge = 0;
    }
    for (let v = 0; v < 3; v++) {
      if (this.padFreq[v] !== this.padTarget[v] && this.padCommitAge > v * 0.9) {
        this.padAmp[v] = Math.max(0, this.padAmp[v] - dt / 1.5);
        if (this.padAmp[v] <= 0.001) this.padFreq[v] = this.padTarget[v];
      } else this.padAmp[v] = Math.min(1, this.padAmp[v] + dt / 2);
    }
    const padCoef = 1 - Math.exp(-TAU * Math.min(700 + this.padMotion * 900, sr * 0.45) / sr);
    const pe = Math.min(1, this.entry / 4);
    const padGain = 0.11 * DRONE_LVL * (pe * pe * (3 - 2 * pe) * this.padPresence) * padSwell;

    // Filters.
    this.rainWah.lowpass(Math.min(Math.max(350 + this.rainEnv * 5200, 250), sr * 0.45), 0.7 + S.drip * 3, sr);
    this.motionFilter.lowpass(Math.min(Math.max(450 + S.motion * 4800 + (genOsc * 0.5 + 0.5) * 1400, 300), sr * 0.45), 0.9, sr);
    const scanFreq = 26 + S.scan * 150, scanDepth = S.scan * 0.3;
    const groundDrive = 1 + S.warmth;
    const gDecay = Math.pow(STONE.decay, k), hDecay = Math.pow(0.9992, k);
    const hPole = 0.15 + S.hiss * 0.25;
    let rainPeak = 0;
    const gE = this.gEnv, gP = this.gPhase, gF = this.gFreq, gN = this.gNoise;
    const hE = this.hEnv, hS = this.hState, hN = this.hNoise;

    for (let i = 0; i < n; i++) {
      // L1 rain grains
      let rain = 0;
      for (let g = 0; g < NG; g++) {
        if (gE[g] <= 0.001) continue;
        gN[g] = (Math.imul(gN[g], 1664525) + 1013904223) | 0;
        const noise = gN[g] / 2147483647;
        gP[g] += gF[g] * inv; if (gP[g] > 1) gP[g] -= 1;
        rain += (Math.sin(gP[g] * TAU) * 0.6 + noise * 0.4) * gE[g];
        gE[g] *= gDecay;
      }
      rain *= 0.26 * effRain * EVENT_LVL;
      rain = rain * (1 - S.drip) + this.rainWah.run(rain) * S.drip;
      const ar = Math.abs(rain); if (ar > rainPeak) rainPeak = ar;

      // L3 erosion hiss
      let hiss = 0;
      for (let h = 0; h < NH; h++) {
        if (hE[h] <= 0.001) continue;
        hN[h] = (Math.imul(hN[h], 1664525) + 1013904223) | 0;
        const noise = hN[h] / 2147483647;
        const filtered = noise - hS[h];
        hS[h] += hPole * (noise - hS[h]);
        hiss += filtered * hE[h];
        hE[h] *= hDecay;
      }
      hiss *= 0.25 * S.hiss * TEX_LVL;

      // L4 ground tone
      this.gp0 += groundFreq * inv; if (this.gp0 > 1) this.gp0 -= 1;
      this.gp1 += groundFreq * 1.003 * inv; if (this.gp1 > 1) this.gp1 -= 1;
      const groundRaw = (Math.sin(this.gp0 * TAU) * 0.5 + Math.sin(this.gp1 * TAU) * 0.3 + Math.sin(this.gp0 * 2 * TAU) * 0.22) * 0.045;
      const ground = Math.tanh(groundRaw * groundDrive) * (1 + S.warmth * 0.3) * DRONE_LVL * 0.63;

      // L5 pad
      let padRaw = 0;
      for (let v = 0; v < 3; v++) {
        this.padA[v] += this.padFreq[v] * inv; if (this.padA[v] > 1) this.padA[v] -= 1;
        this.padB[v] += this.padFreq[v] * 1.0015 * inv; if (this.padB[v] > 1) this.padB[v] -= 1;
        const a = this.padA[v] * TAU;
        padRaw += (Math.sin(a) + Math.sin(this.padB[v] * TAU) + 0.12 * Math.sin(2 * a)) * 0.5 * this.padAmp[v] * this.padWeight[v];
      }
      this.padLP += padCoef * (padRaw - this.padLP);

      let dry = rain + hiss + ground;
      this.scanPhase += scanFreq * inv; if (this.scanPhase > 1) this.scanPhase -= 1;
      dry *= 1 - scanDepth * (0.5 + 0.5 * Math.sin(this.scanPhase * TAU));
      dry = this.motionFilter.run(dry);
      M[i] = dry + this.padLP * padGain;
    }

    // L2 settling resonators.
    for (let m = 0; m < NM; m++) {
      let amp = this.mAmp[m], target = this.mTarget[m];
      if (amp <= 0.0001 && target <= 0.0001) continue;
      let phase = this.mPhase[m];
      const inc = this.mInc[m], decay = this.mDecay[m], att = this.mAttack;
      for (let i = 0; i < n; i++) {
        if (target > 0.0001) { const ramp = target * att; amp += ramp; target -= ramp; }
        M[i] += amp * Math.sin(phase);
        phase += inc; amp *= decay;
      }
      if (phase > TAU) phase -= TAU * Math.floor(phase / TAU);
      this.mPhase[m] = phase; this.mTarget[m] = target; this.mAmp[m] = amp < 0.0001 ? 0 : amp;
    }

    // Rain envelope for the drip filter (fast attack, slow release; per-block rates scaled to this block size).
    const bk = n / 512;
    this.rainEnv += (rainPeak > this.rainEnv ? 1 - Math.pow(0.3, bk) : 1 - Math.pow(0.82, bk)) * (rainPeak - this.rainEnv);

    // Pan (FB Direction), ping-pong echo (Realm → Abstract), limiter, entry ease.
    this.pan += (1 - Math.pow(0.96, bk)) * (Math.sin(S.dir * TAU) - this.pan);
    const lg = Math.sqrt(0.5 * (1 - this.pan)), rg = Math.sqrt(0.5 * (1 + this.pan));
    const fb = 0.2 + S.abstract * 0.45, wet = S.abstract * 0.42;
    const e0 = Math.min(this.entry / 6, 1);
    this.entry += dt;
    const e1 = Math.min(this.entry / 6, 1);
    const g0 = e0 * e0 * (3 - 2 * e0), g1 = e1 * e1 * (3 - 2 * e1), gStep = (g1 - g0) / n;

    for (let i = 0; i < n; i++) {
      let l = M[i] * lg, r = M[i] * rg;
      const dLo = this.dL[this.dI], dRo = this.dR[this.dI];
      this.lpL += 0.30 * (dRo - this.lpL);
      this.lpR += 0.30 * (dLo - this.lpR);
      let wl = Math.tanh(l + this.lpL * fb), wr = Math.tanh(r + this.lpR * fb);
      if (!Number.isFinite(wl) || !Number.isFinite(wr)) { wl = wr = 0; this.lpL = this.lpR = 0; }
      this.dL[this.dI] = wl; this.dR[this.dI] = wr;
      if (++this.dI >= this.dLen) this.dI = 0;
      l += dLo * wet; r += dRo * wet;
      const g = (g0 + gStep * (i + 1)) * OUT_GAIN;
      L[i] = Math.tanh(l * g) * 0.89;
      R[i] = Math.tanh(r * g) * 0.89;
    }
    return true;
  }
}

registerProcessor('witnessing', WitnessingProcessor);
