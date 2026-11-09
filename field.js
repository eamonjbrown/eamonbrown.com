// eamonbrown.com — home page: suminagashi, by the mathematics of marbling.
//
// Ink is treated the way it behaves on water: as a thin film that can be
// pushed and folded but never compressed. Two exact, area-preserving
// operations are applied every frame (after Jaffer / Lu et al.):
//
//   • Drop  — ink keeps falling at the centre (one letter-height below the
//     N of EAMON). A drop of area dA pushes every point outward:
//         p' = c + (p−c)·sqrt(1 + dA / (π|p−c|²))
//     so rings are born at the centre and drift out, naturally growing
//     thinner and more crowded as they go — no healing back, the pattern
//     renews itself and old disturbances leave the screen.
//
//   • Breath — the pointer drags the surface along its heading with the
//     marbling tine profile λ/(|d|+λ) (a sharp cusp on the path: the pointed
//     chevrons of real suminagashi), written as a stream function so it is
//     divergence-free.
//
// What is stored is not a picture but a label: for every point, how long ago
// its ink was laid down (stored as an offset from the undisturbed circles).
// Rings are drawn per pixel from that label, so edges stay razor sharp and
// line weight changes only where the film was really stretched or squeezed.
(() => {
  const canvas = document.querySelector('canvas.field');
  if (!canvas) return;
  const ctxOpts = { antialias: false, alpha: false, depth: false, stencil: false };
  let gl = canvas.getContext('webgl2', ctxOpts);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', ctxOpts);
  if (!gl) { canvas.style.background = '#070708'; return; }

  const MAXS = 16;                 // simultaneous breath strokes
  const PERIOD = 2.6;              // seconds per new ring at the centre
  const LIFE = 0.42;               // s — a breath keeps moving the water briefly

  // ── Shaders ──────────────────────────────────────────────────────
  const V2 = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const V1 = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

  const NOISE = `
float hash(float n){ return fract(sin(n * 127.1 + 1.7) * 43758.5453); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1,0)), u.x), mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), u.x), u.y);
}`;

  // Simulation step (WebGL2 + float render targets only).
  const SIM = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uSize;      // sim texture size (px)
uniform vec2 uC;         // drop centre (sim px)
uniform float uA;        // area of one ring (sim px²)
uniform float uDA;       // area dropped this step
uniform float uTime;
uniform float uAmb;      // ambient drift, px / step
uniform float uR1;       // radius of one ring-area disc
uniform float uReach;
uniform float uSeed;     // >0 once: give old ink a wandering history
uniform int uN;
uniform vec4 uS0[${MAXS}];  // x0, y0, ux, uy
uniform vec4 uS1[${MAXS}];  // length, z (px this step), lambda, D
out vec4 o;
${NOISE}

// Catmull-Rom from 9 bilinear taps — keeps the field sharp over thousands of
// steps; clamped to the local 2×2 range so cusps never ring.
float sampleCR(vec2 q){
  vec2 sp = q - 0.5;
  vec2 t1 = floor(sp) + 0.5;
  vec2 f = q - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) / uSize, t3 = (t1 + 2.0) / uSize, t12 = (t1 + w2 / w12) / uSize;
  float r =
      (texture(uPrev, vec2(t0.x,  t0.y)).r * w0.x + texture(uPrev, vec2(t12.x, t0.y)).r * w12.x + texture(uPrev, vec2(t3.x, t0.y)).r * w3.x) * w0.y
    + (texture(uPrev, vec2(t0.x, t12.y)).r * w0.x + texture(uPrev, vec2(t12.x, t12.y)).r * w12.x + texture(uPrev, vec2(t3.x, t12.y)).r * w3.x) * w12.y
    + (texture(uPrev, vec2(t0.x,  t3.y)).r * w0.x + texture(uPrev, vec2(t12.x, t3.y)).r * w12.x + texture(uPrev, vec2(t3.x, t3.y)).r * w3.x) * w3.y;
  ivec2 b = clamp(ivec2(floor(sp)), ivec2(0), ivec2(uSize) - 2);
  float a00 = texelFetch(uPrev, b, 0).r, a10 = texelFetch(uPrev, b + ivec2(1,0), 0).r;
  float a01 = texelFetch(uPrev, b + ivec2(0,1), 0).r, a11 = texelFetch(uPrev, b + ivec2(1,1), 0).r;
  return clamp(r, min(min(a00, a10), min(a01, a11)), max(max(a00, a10), max(a01, a11)));
}

// Breath: stream function psi = G(s)·H(d), H' = tine profile with a cusp at d = 0.
vec2 breath(vec2 p){
  vec2 v = vec2(0.0);
  for (int i = 0; i < ${MAXS}; i++){
    if (i >= uN) break;
    vec4 a = uS0[i], b = uS1[i];
    vec2 u = a.zw, n = vec2(-u.y, u.x);
    vec2 r = p - a.xy;
    float s = dot(r, u), d = dot(r, n);
    float L = b.x, lam = b.z, D = b.w;
    float sc = 0.5 * L + 0.30 * uReach, S = 0.5 * L + 0.55 * uReach;
    float gs = (s - sc) / S;
    float G = exp(-gs * gs);
    float e = exp(-(d * d) / (D * D));
    if (G * e < 1e-4) continue;
    float ad = abs(d);
    float lg = log(1.0 + ad / lam);
    float H  = sign(d) * lam * lg * e;
    float Hp = e * (lam / (lam + ad) - 2.0 * ad * lam * lg / (D * D));
    float Gp = -2.0 * gs / S * G;
    v += b.y * (u * (Hp * G) - n * (H * Gp));
  }
  return v;
}

// The water is never perfectly still: a very slow, divergence-free drift.
vec2 ambient(vec2 p){
  float r = length(p - uC);
  float k = uAmb * smoothstep(0.8 * uR1, 3.0 * uR1, r);
  if (k <= 0.0) return vec2(0.0);
  vec2 q = p / (uR1 * 2.4) + vec2(uTime * 0.021, -uTime * 0.017);
  vec2 q2 = p / (uR1 * 0.9) + vec2(-uTime * 0.034, uTime * 0.027);
  const float e = 0.07;
  float dy = (noise(q + vec2(0, e)) - noise(q - vec2(0, e))) + 0.35 * (noise(q2 + vec2(0, e)) - noise(q2 - vec2(0, e)));
  float dx = (noise(q + vec2(e, 0)) - noise(q - vec2(e, 0))) + 0.35 * (noise(q2 + vec2(e, 0)) - noise(q2 - vec2(e, 0)));
  return k * vec2(dy, -dx) / (2.0 * e);
}

void main(){
  vec2 p = gl_FragCoord.xy;
  vec2 q1 = p - breath(p) - ambient(p);          // undo this step's breath…
  vec2 rel = q1 - uC;
  float r2 = dot(rel, rel);
  float rem = r2 - uDA / 3.14159265;             // …then undo the drop
  float old = 0.0;                               // inside the new drop: fresh ink
  if (rem > 0.0) old = sampleCR(uC + rel * sqrt(rem / r2));
  vec2 pc = p - uC;
  if (uSeed > 0.0) {
    // rings drift off true circles the longer they have been on the water
    float r = length(pc);
    float n = noise(p / (uR1 * 2.8) + 7.0) - 0.5 + 0.45 * (noise(p / (uR1 * 0.95) + 19.0) - 0.5);
    old += uSeed * n * 6.2831853 * r * (0.022 * r) / uA * smoothstep(1.2 * uR1, 5.0 * uR1, r);
  }
  // label offset from the undisturbed circles, in rings
  o = vec4(old + 3.14159265 * (r2 - dot(pc, pc)) / uA, 0.0, 0.0, 1.0);
}`;

  // Display: rings from the label, per device pixel.
  const DRAW_BODY = `
uniform vec2 uRes;
uniform float uScale;    // sim px per device px
uniform vec2 uSim;       // sim texture size
uniform vec2 uC;         // centre, sim px
uniform float uA;        // ring area, sim px²
uniform float uT;        // rings dropped so far (mod 1024)
uniform float uHasD;
uniform sampler2D uD;
${NOISE}
float ringW(float k){ float h = hash(mod(k, 1024.0)); return 0.07 + 0.55 * h * h; }
float ringD(float k){
  float kk = mod(k, 1024.0);
  float d = mix(0.78, 1.0, hash(kk + 3.1));
  return hash(kk + 9.7) < 0.08 ? d * 0.55 : d;    // now and then a dilute drop
}
// box-filtered coverage of [lo, hi] by a pixel centred at f, half-width hw
float cover(float f, float hw, float lo, float hi){
  return clamp((min(f + hw, hi) - max(f - hw, lo)) / (2.0 * hw), 0.0, 1.0);
}
void main(){
  vec2 ps = gl_FragCoord.xy * uScale;
  float dl = uHasD > 0.5 ? TEX(uD, ps / uSim).r : 0.0;
  vec2 rel = ps - uC;
  float r2 = dot(rel, rel);
  float L = uT - (dl + 3.14159265 * r2 / uA);     // the ring label at this pixel
  float fw = FWIDTH(L);
  fw = max(fw, 1e-4);
  float k = floor(L), f = L - k, hw = 0.5 * fw;
  float w = ringW(k), wp = ringW(k - 1.0), wn = ringW(k + 1.0);
  float c0 = cover(f, hw, 0.0, w);
  float ink = c0 * ringD(k)
            + cover(f, hw, -1.0, wp - 1.0) * ringD(k - 1.0)
            + cover(f, hw, 1.0, 1.0 + wn) * ringD(k + 1.0);
  // pigment gathers a little at the edge of each ring
  float edge = min(f, w - f);
  ink *= 1.0 + 0.10 * c0 * (1.0 - smoothstep(0.0, 2.5 * fw, edge));
  // rings finer than a pixel settle to their average tone
  ink = mix(ink, 0.24, smoothstep(0.45, 1.2, fw));
  vec3 ground = vec3(0.028, 0.027, 0.030) * (0.9 + 0.1 * noise(gl_FragCoord.xy * 0.35));
  vec3 inkCol = vec3(0.90, 0.885, 0.86);
  FRAG = vec4(mix(ground, inkCol, clamp(ink, 0.0, 1.0)), 1.0);
}`;
  const DRAW2 = `#version 300 es
precision highp float;
out vec4 outColor;
#define FRAG outColor
#define TEX texture
#define FWIDTH(x) fwidth(x)
` + DRAW_BODY;
  // WebGL1: no derivatives guaranteed — use the analytic slope of the label.
  const DRAW1 = `precision highp float;
#define FRAG gl_FragColor
#define TEX texture2D
#define FWIDTH(x) (6.2831853 * sqrt(r2) / uA * uScale)
` + DRAW_BODY;

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  function program(vsrc, fsrc) {
    const vs = compile(gl.VERTEX_SHADER, vsrc), fs = compile(gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return null; }
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const nm = info.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  const draw = program(isGL2 ? V2 : V1, isGL2 ? DRAW2 : DRAW1);
  if (!draw) { canvas.style.background = '#070708'; return; }
  let sim = null;
  let floatOK = false;
  if (isGL2 && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) {
    sim = program(V2, SIM);
    floatOK = !!sim;
  }

  const vbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ── Label field: two half-float targets, ping-ponged ──────────────
  let SW = 0, SH = 0, tex = [], fbo = [], cur = 0;
  function makeTarget() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, SW, SH, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { t, f } : null;
  }
  function allocSim(w, h) {
    tex.forEach(t => gl.deleteTexture(t)); fbo.forEach(f => gl.deleteFramebuffer(f));
    tex = []; fbo = []; SW = w; SH = h;
    for (let i = 0; i < 2; i++) {
      const r = makeTarget();
      if (!r) { floatOK = false; return false; }
      tex.push(r.t); fbo.push(r.f);
    }
    cur = 0; return true;
  }

  // ── Layout: canvas size, centre, ring scale ──────────────────────
  let W = 0, H = 0, dpr = 1, cssW = 0, cssH = 0, simScale = 1;
  let ccx = 0, ccy = 0;            // centre, css px (y up)
  let A = 1, R1 = 1, M = 1;        // ring area, its disc radius, min side (sim px)
  const anchor = document.querySelector('[data-ink-anchor]');
  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = canvas.clientWidth; cssH = canvas.clientHeight;
    W = Math.max(1, Math.floor(cssW * dpr)); H = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = W; canvas.height = H;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const capH = parseFloat(getComputedStyle(anchor).fontSize) * 0.7;
      const glyphBottom = r.top + r.height / 2 + capH / 2;
      ccx = r.left + r.width / 2; ccy = cssH - (glyphBottom + capH);
    } else { ccx = cssW / 2; ccy = cssH / 2; }
    // sim resolution ≈ css px, capped
    const want = Math.min(1, 1400 / Math.max(cssW, cssH));
    let realloc = false;
    if (floatOK) {
      const nw = Math.ceil(cssW * want), nh = Math.ceil(cssH * want);
      // keep the field through small resizes (mobile address bar)
      if (!SW || nw > SW * 1.02 || nh > SH * 1.1 || nw < SW * 0.9 || nh < SH * 0.75) {
        simScale = want; realloc = allocSim(nw, nh);
      }
    } else simScale = want;
    // ring area: rings ~8 css px apart at the farthest corner, centre disc 60–112 px
    const rmax = Math.max(Math.hypot(ccx, ccy), Math.hypot(cssW - ccx, ccy), Math.hypot(ccx, cssH - ccy), Math.hypot(cssW - ccx, cssH - ccy));
    const r1css = Math.max(40, Math.min(112, 0.17 * Math.min(cssW, cssH), Math.sqrt(2 * rmax * 8)));
    R1 = r1css * simScale; A = Math.PI * R1 * R1; M = Math.min(cssW, cssH) * simScale;
    if (realloc) prewarm();
  }

  // ── Breath strokes ───────────────────────────────────────────────
  const strokes = [];
  const s0 = new Float32Array(MAXS * 4), s1 = new Float32Array(MAXS * 4);
  let px = null, py = null, lastMove = -1e9;
  function addStroke(x0, y0, x1, y1, gain) {        // css px, y down
    const dx = x1 - x0, dy = -(y1 - y0), L = Math.hypot(dx, dy);
    if (L < 0.4) return;
    const Ls = Math.min(L, 90) * simScale;
    strokes.push({
      x: x0 * simScale, y: (cssH - y0) * simScale, ux: dx / L, uy: dy / L, L: Ls,
      z: Ls * 0.036 * gain, life: 1,
    });
    if (strokes.length > MAXS) strokes.shift();
  }
  function moveTo(x, y) {
    if (px !== null) addStroke(px, py, x, y, 1);
    px = x; py = y; lastMove = performance.now();
  }
  window.addEventListener('pointermove', e => moveTo(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerleave', () => { px = null; });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) moveTo(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchend', () => { px = null; });

  // When nobody is breathing on it, now and then the air does (very gently).
  let auto = null, nextAuto = 0;
  function autoBreath(now) {
    if (now - lastMove < 7000) { auto = null; return; }
    if (!auto && now > nextAuto) {
      const ang = Math.random() * Math.PI * 2;
      const rr = (0.25 + Math.random() * 0.35) * Math.min(cssW, cssH);
      const head = ang + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1) + (Math.random() - 0.5) * 0.9;
      auto = { x: ccx + Math.cos(ang) * rr, y: (cssH - ccy) - Math.sin(ang) * rr, hx: Math.cos(head), hy: -Math.sin(head), t: 0 };
      nextAuto = now + 7000 + Math.random() * 5000;
    }
    if (auto) {
      const sp = 7 * Math.sin(Math.PI * Math.min(1, auto.t / 50));   // ease in / out over ~0.8 s
      const nx = auto.x + auto.hx * sp, ny = auto.y + auto.hy * sp;
      addStroke(auto.x, auto.y, nx, ny, 0.7);
      auto.x = nx; auto.y = ny;
      if (++auto.t > 50) auto = null;
    }
  }

  // ── Simulation step ─────────────────────────────────────────────
  let seedOnce = 0, tRings = 0.37, simTime = Math.random() * 100;
  function step(dt) {
    const dA = A * dt / PERIOD;
    tRings += dt / PERIOD;
    if (tRings > 2048) tRings -= 1024;
    simTime += dt;
    if (!floatOK) return;
    const f60 = dt * 60;
    let n = 0;
    for (let i = strokes.length - 1; i >= 0 && n < MAXS; i--) {
      const s = strokes[i];
      s0[n * 4] = s.x; s0[n * 4 + 1] = s.y; s0[n * 4 + 2] = s.ux; s0[n * 4 + 3] = s.uy;
      s1[n * 4] = s.L; s1[n * 4 + 1] = s.z * s.life * f60; s1[n * 4 + 2] = 0.016 * M; s1[n * 4 + 3] = 0.085 * M;
      n++;
    }
    const k = Math.exp(-dt / LIFE);
    for (let i = strokes.length - 1; i >= 0; i--) { strokes[i].life *= k; if (strokes[i].life < 0.03) strokes.splice(i, 1); }

    const u = sim.u;
    gl.useProgram(sim.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - cur]);
    gl.viewport(0, 0, SW, SH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
    gl.uniform1i(u.uPrev, 0);
    gl.uniform2f(u.uSize, SW, SH);
    gl.uniform2f(u.uC, ccx * simScale, ccy * simScale);
    gl.uniform1f(u.uA, A);
    gl.uniform1f(u.uDA, dA);
    gl.uniform1f(u.uTime, simTime);
    gl.uniform1f(u.uAmb, 0.016 * simScale * f60);
    gl.uniform1f(u.uR1, R1);
    gl.uniform1f(u.uReach, 0.16 * M);
    gl.uniform1f(u.uSeed, seedOnce); seedOnce = 0;
    gl.uniform1i(u.uN, n);
    if (n) { gl.uniform4fv(u.uS0, s0); gl.uniform4fv(u.uS1, s1); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cur = 1 - cur;
  }

  // Give the surface a history before it is first seen: a few earlier breaths.
  function prewarm() {
    if (!floatOK) return;
    const saved = strokes.splice(0);
    seedOnce = 1;
    const m = Math.min(cssW, cssH);
    for (let b = 0; b < 4; b++) {
      const ang = Math.random() * Math.PI * 2, rr = (0.3 + Math.random() * 0.5) * m;
      let x = ccx + Math.cos(ang) * rr, y = (cssH - ccy) - Math.sin(ang) * rr;
      const head = ang + Math.PI / 2 * (b % 2 ? 1 : -1) + (Math.random() - 0.5);
      for (let i = 0; i < 14; i++) {
        const nx = x + Math.cos(head) * 9, ny = y - Math.sin(head) * 9;
        addStroke(x, y, nx, ny, 0.8); x = nx; y = ny;
        step(1 / 60);
      }
      for (let i = 0; i < 26; i++) step(1 / 60);
    }
    strokes.length = 0; strokes.push(...saved);
  }

  function render() {
    const u = draw.u;
    gl.useProgram(draw.p);
    gl.viewport(0, 0, W, H);
    if (floatOK) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[cur]); }
    gl.uniform1i(u.uD, 0);
    gl.uniform1f(u.uHasD, floatOK ? 1 : 0);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uScale, simScale / dpr);
    gl.uniform2f(u.uSim, Math.max(SW, 1), Math.max(SH, 1));
    gl.uniform2f(u.uC, ccx * simScale, ccy * simScale);
    gl.uniform1f(u.uA, A);
    gl.uniform1f(u.uT, tRings);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  layout();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = !document.hidden, last = performance.now();
  document.addEventListener('visibilitychange', () => {
    const was = running; running = !document.hidden;
    if (running && !was && !reduce) { last = performance.now(); requestAnimationFrame(frame); }
  });
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    autoBreath(now);
    step(dt);
    render();
    if (running && !reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(t => { last = t; frame(t); });
})();
