/* Aumara Realms — REFLECTING, web port.
   Ported from the iOS realm (ReflectingRenderer.swift / ReflectingShaders.metal).

   Three passes, as on device:
     glass — shards of translucent ink multiplied like riso overprints over a
             backlight, folded through a six-wedge radial mirror. A pure
             function of (time, params, cuts): never resampled, always sharp.
     well  — the previous composite recedes toward the vanishing point, spirals,
             decays; the current glass is keyed over it on ink coverage.
     blit  — contrast + saturation, to screen.

   No headband on the web, so attention is read from the hand:
     moving the cursor / finger = focus (fracture, faster morph, looser print)
     stillness                  = calm  (order, slowness, a deeper regress)
     dragging                   = carving: the stroke cuts the glass it crosses. */
(() => {
  'use strict';

  const canvas = document.querySelector('canvas.realm');
  if (!canvas) return;
  const EMBED = new URLSearchParams(location.search).has('embed');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) { document.documentElement.classList.add('no-gl'); return; }

  // ── Shaders ────────────────────────────────────────────────────────
  const VERT = `#version 300 es
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const GLASS = `#version 300 es
  precision highp float;
  precision highp int;
  uniform vec2  uRes;
  uniform float uTime, uFracture, uEcho, uDensity, uMorph, uFocus, uCoh, uBreath;
  uniform int   uGel, uCutCount;
  uniform vec4  uCutSeg[32];
  uniform vec4  uCutMeta[32];
  out vec4 outColor;

  float h1(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453123); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h1(i), h1(i + vec2(1, 0)), u.x),
               mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), u.x), u.y);
  }

  // Gel sets — transmissions. Each chromatic ink has ONE low channel, R/G/B
  // across the three, so every pair overprints to a distinct hue.
  vec3 ink(int s, int i) {
    if (s == 0) { if (i == 0) return vec3(1.00, 0.15, 0.55); if (i == 1) return vec3(0.10, 0.45, 1.00); return vec3(1.00, 0.90, 0.05); } // Riso Classic
    if (s == 1) { if (i == 0) return vec3(0.96, 0.96, 0.94); if (i == 1) return vec3(0.55, 0.56, 0.58); return vec3(0.16, 0.17, 0.19); } // Ink Wash
    if (s == 2) { if (i == 0) return vec3(0.98, 0.10, 0.60); if (i == 1) return vec3(0.10, 0.90, 0.75); return vec3(1.00, 0.45, 0.05); } // Huichol
    if (s == 3) { if (i == 0) return vec3(1.00, 0.16, 0.22); if (i == 1) return vec3(1.00, 0.90, 0.08); return vec3(0.16, 0.38, 1.00); } // Primary
    if (s == 4) { if (i == 0) return vec3(0.20, 0.85, 0.62); if (i == 1) return vec3(0.88, 0.38, 0.10); return vec3(0.58, 0.13, 0.52); } // Oxide
    if (s == 5) { if (i == 0) return vec3(0.09, 0.46, 0.87); if (i == 1) return vec3(0.46, 0.08, 0.69); return vec3(0.98, 0.50, 0.09); } // Midnight
    if (i == 0) return vec3(1.00, 0.30, 0.28); if (i == 1) return vec3(0.08, 0.62, 0.60); return vec3(0.72, 0.73, 0.75);              // Duotone
  }

  // One convex shard: intersection of five morphing half-planes.
  float shard(vec2 d, float seed, float radius, float baseAng, float aa, float t, float mr) {
    float sd = -1e9;
    for (int e = 0; e < 5; e++) {
      float fe = float(e);
      float eh  = h1(vec2(seed, fe * 3.7));
      float eh2 = h1(vec2(seed, fe * 9.1));
      float w  = 0.30 + eh2 * 0.50;
      float br = 0.5 + 0.5 * sin(t * w * mr + eh * 6.2831853);
      float rr = radius * (0.50 + 1.05 * br);
      float a = baseAng + fe * 1.2566371 + (eh - 0.5) * 0.55
              + sin(t * 0.22 * mr + eh2 * 6.2831853) * 0.26;
      sd = max(sd, dot(d, vec2(cos(a), sin(a))) - rr);
    }
    return smoothstep(aa, -aa, sd);
  }

  const int SIDES = 6;
  const float SEG = 6.2831853 / 6.0;

  vec2 mirrorFold(vec2 P, float fracture, float t, float esc, out float cellId) {
    float ang = atan(P.y, P.x);
    float rad = length(P);
    ang += sin(ang * 3.0 + t * 0.05) * 0.30 * fracture
         + sin(ang * 5.0 - t * 0.031) * 0.17 * fracture;
    float aw = ang + SEG * 0.5;
    float si = floor(aw / SEG);
    cellId = si;
    float rawla = aw - si * SEG - SEG * 0.5;
    float la = mix(abs(rawla), (rawla + SEG * 0.5) * 0.5, clamp(esc, 0.0, 1.0));
    return vec2(cos(la), sin(la)) * rad;
  }
  vec2 place(float u, float v) {
    float a = u * SEG * 0.5;
    return vec2(cos(a), sin(a)) * (0.88 * sqrt(v));
  }
  vec2 wrapDomain(vec2 P) {
    float rad = length(P);
    float a = abs(atan(P.y, P.x));
    a = abs((a / SEG - floor(a / SEG + 0.5)) * SEG);
    return vec2(cos(a), sin(a)) * rad;
  }
  float segDist(vec2 pt, vec2 a, vec2 b) {
    vec2 pa = pt - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }

  void main() {
    vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);  // top-down, as Metal
    float aspect = uRes.x / uRes.y;
    float t = uTime;

    float fracture = 1.0 + uFracture * 1.60;
    float extra    = uFracture;
    float mr = 0.80 + uMorph * 1.80;
    int   G  = int(uEcho * 5.99);
    float gDelay = 2.2 / max(mr, 0.5);

    float lum = 0.82 + 0.18 * (0.5 + 0.5 * sin(uv.x * 1.7 + t * 0.05 * mr)
                                       * sin(uv.y * 1.3 - t * 0.041 * mr));
    lum *= mix(0.88, 1.0, uBreath);

    vec2 pos = (uv - 0.5) * vec2(aspect, 1.0);
    vec2 raw = pos;
    float breathZoom = 1.0 + (uBreath - 0.5) * 0.20;

    float esc = smoothstep(0.52 - 0.22 * extra, 0.88 - 0.18 * extra, vnoise(raw * 2.2 + t * 0.02));
    float cellId = 0.0;
    pos = mirrorFold(pos / breathZoom, fracture, t, esc, cellId);

    float wh   = h1(vec2(cellId, 3.3));
    float wrot = (wh - 0.5) * 0.55 * fracture;
    float cw = cos(wrot), sw = sin(wrot);
    pos = vec2(pos.x * cw - pos.y * sw, pos.x * sw + pos.y * cw);
    pos += (vec2(fract(wh * 17.3), fract(wh * 41.7)) - 0.5) * 0.22 * fracture;
    pos *= 1.0 + (fract(wh * 29.1) - 0.5) * 0.55 * extra;
    float wedgeTime = (fract(wh * 53.7) - 0.5) * 6.0 * extra;
    float wedgeInk = 0.0;
    if (fract(wh * 11.3) < extra) wedgeInk = floor(fract(wh * 67.9) * 3.0);
    pos = wrapDomain(pos);

    // Carving — separation + re-registration, in raw screen space.
    vec2 cutShift = vec2(0.0);
    float inkShift = 0.0;
    for (int i = 0; i < 32; i++) {
      if (i >= uCutCount) break;
      vec4 sg = uCutSeg[i];
      float age = uCutMeta[i].x, life = uCutMeta[i].y;
      if (life <= 0.0) continue;
      vec2 ca = (sg.xy - 0.5) * vec2(aspect, 1.0);
      vec2 cb = (sg.zw - 0.5) * vec2(aspect, 1.0);
      vec2 ba = cb - ca;
      float bl = length(ba);
      if (bl < 1e-5) continue;
      vec2 n = vec2(-ba.y, ba.x) / bl;
      float d = segDist(raw, ca, cb);
      float side = dot(raw - ca, n) < 0.0 ? -1.0 : 1.0;
      float amp = smoothstep(0.0, 0.25, age) * (1.0 - smoothstep(life * 0.55, life, age));
      cutShift += n * side * smoothstep(0.13, 0.0, d) * amp * 0.060;
      inkShift += (side > 0.0 ? 1.0 : 0.0) * smoothstep(0.30, 0.05, d) * amp;
    }
    float shiftLen = length(cutShift);
    if (shiftLen > 0.14) cutShift *= 0.14 / shiftLen;
    inkShift = min(inkShift, 3.0);

    float aa = 1.6 / uRes.y;
    int M = int(mix(1.0, 5.99, uDensity));
    vec3 trans = vec3(1.0);
    float anyInk = 0.0;

    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      vec2 mis = (vec2(h1(vec2(fl, 2.1)), h1(vec2(fl, 5.7))) - 0.5)
               * (0.006 + 0.020 * fracture) * (1.0 + (1.0 - uCoh) * 1.8);
      vec2 dpos = pos + mis + cutShift;

      vec2 gpos[6];
      float gscale = 1.0;
      for (int g = 0; g < 6; g++) {
        float ga = float(g) * 0.19;
        float gc = cos(ga), gs = sin(ga);
        gpos[g] = vec2(dpos.x * gc - dpos.y * gs, dpos.x * gs + dpos.y * gc) * gscale;
        gscale *= 1.28;
      }
      float cov[6];
      for (int g = 0; g < 6; g++) cov[g] = 0.0;

      int Md = clamp(int(floor(float(M) * (1.0 + (uFocus - 0.5) * 0.90 * (fl - 1.0)) + 0.5)), 1, 14);

      for (int j = 0; j < 14; j++) {
        if (j >= Md) break;
        float seed = fl * 71.3 + float(j) * 13.7;
        float H  = h1(vec2(seed, 1.7));
        float hx = fract(H * 41.7), hy = fract(H * 97.3);
        float hr = fract(H * 13.1), hp = fract(H * 57.9), hs = fract(H * 29.3);
        float radius = mix(0.045, 0.20, hr * hr);
        vec2  home = place(hx, hy);
        float dphase = hp * 6.2831853;
        float dspeed = (0.05 + hs * 0.10) * mr;
        float spin   = (fract(H * 7.7) - 0.5) * 0.38 * mr;
        for (int g = 0; g < 6; g++) {
          if (g > G) break;
          float tg = t - float(g) * gDelay + wedgeTime;
          vec2 centre = home + vec2(sin(tg * dspeed + dphase), cos(tg * dspeed * 0.79 + dphase * 1.3)) * 0.18;
          vec2 d = gpos[g] - centre;
          if (dot(d, d) > radius * radius * 5.0) continue;
          cov[g] = max(cov[g], shard(d, seed, radius, dphase + tg * spin, aa, tg, mr));
        }
      }

      float gw = 1.0;
      for (int g = 0; g < 6; g++) {
        if (g > G) break;
        vec3 k = ink(uGel, (l + g + int(inkShift) + int(wedgeInk)) % 3);
        trans *= mix(vec3(1.0), k, cov[g] * gw);
        anyInk = max(anyInk, cov[g] * mix(0.55, 1.0, gw));
        gw *= 0.74;
      }
    }
    outColor = vec4(lum * trans * anyInk, anyInk);
  }`;

  const WELL = `#version 300 es
  precision highp float;
  uniform sampler2D uGlass, uPrev;
  uniform vec2  uRes;
  uniform float uDt, uDepth, uReset;
  out vec4 outColor;
  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;                 // GL bottom-up
    float aspect = uRes.x / uRes.y;
    float dt = clamp(uDt, 0.0, 0.1);
    float rot = -0.07 * dt;                            // sign flipped: y runs up here
    float grow = exp(0.55 * dt);
    float cr = cos(rot), sr = sin(rot);
    vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
    c = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * grow;
    vec2 pu = c / vec2(aspect, 1.0) + 0.5;
    float tau = 0.25 + uDepth * 2.95;
    float gate = smoothstep(0.0, 0.08, uDepth) * (1.0 - uReset);
    float inside = step(0.0, pu.x) * step(pu.x, 1.0) * step(0.0, pu.y) * step(pu.y, 1.0);
    vec3 past = texture(uPrev, pu).rgb * exp(-dt / tau) * gate * inside;
    vec4 glass = texelFetch(uGlass, ivec2(gl_FragCoord.xy), 0);
    outColor = vec4(mix(past, glass.rgb, glass.a), 1.0);
  }`;

  const BLIT = `#version 300 es
  precision highp float;
  uniform sampler2D uTex;
  uniform float uSat;
  out vec4 outColor;
  void main() {
    vec3 col = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb;
    col = pow(max(col, 0.0), vec3(1.15));
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, mix(1.15, 1.45, clamp((uSat - 0.5) * 2.0, 0.0, 1.0)));
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fsrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  let P;
  try { P = { glass: program(GLASS), well: program(WELL), blit: program(BLIT) }; }
  catch (e) { console.error('[reflecting]', e); document.documentElement.classList.add('no-gl'); return; }
  gl.bindVertexArray(gl.createVertexArray());

  // Half-float targets when the device can render to them; 8-bit otherwise.
  const canFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const FMT = canFloat ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, FMT.i, w, h, 0, gl.RGBA, FMT.t, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb };
  }
  function free(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }

  // ── Resolution (adaptive) ──────────────────────────────────────────
  // The glass kernel loops ~3 × 14 × 6 shards per pixel, so render below
  // device resolution when the GPU asks for it. Edges stay ~1.6px either way.
  const coarse = matchMedia('(pointer: coarse)').matches;
  const MAX_PIX = EMBED ? 1.2e6 : (coarse ? 3.4e6 : 5.6e6);   // ≈ native Retina / iPhone
  let quality = 1.0;
  let W = 0, H = 0, glassT, wellA, wellB, ping = false, wellReset = true;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
    let s = dpr * quality;
    const pix = cw * ch * s * s;
    if (pix > MAX_PIX) s *= Math.sqrt(MAX_PIX / pix);
    const w = Math.max(2, Math.round(cw * s)), h = Math.max(2, Math.round(ch * s));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    free(glassT); free(wellA); free(wellB);
    glassT = target(W, H); wellA = target(W, H); wellB = target(W, H);
    wellReset = true;
  }
  addEventListener('resize', resize);
  resize();

  // ── Attention, read from the hand ──────────────────────────────────
  const S = {
    activity: 0,      // 0 calm … 1 focused/stirred (fast attack, slow release)
    stillFor: 0,      // seconds since the hand last moved
    calmDepth: 0,     // grows through long stillness → deeper regress
    speed: 0,         // smoothed pointer speed, 0..1 (1500 css px/s = 1, as on device)
    down: false, x: 0.5, y: 0.5,
    lastMove: -1, lastX: 0, lastY: 0, lastT: 0, rawSpeed: 0,
    paint: 0,         // smoothed "is carving"
  };
  const cuts = [];
  const MAX_CUTS = 32;
  let lastCut = null;
  const CUT_MEMORY = 0.5;                     // → 24 s cuts
  const cutLife = () => 4 + CUT_MEMORY * 40;

  function addCutTo(pt) {
    if (!lastCut) { lastCut = pt; return; }
    const dx = pt[0] - lastCut[0], dy = pt[1] - lastCut[1];
    if (Math.hypot(dx, dy) > 0.02) {
      cuts.push({ a: lastCut, b: pt, age: 0, life: cutLife() });
      if (cuts.length > MAX_CUTS) cuts.splice(0, cuts.length - MAX_CUTS);
      lastCut = pt;
    }
  }

  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const now = performance.now() / 1000;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (S.lastT) {
      const dt = Math.max(now - S.lastT, 1 / 240);
      const v = Math.hypot(px - S.lastX, py - S.lastY) / dt;
      S.rawSpeed = Math.min(v, 1500) / 1500;
    }
    S.lastX = px; S.lastY = py; S.lastT = now; S.lastMove = now;
    S.x = px / r.width; S.y = py / r.height;
    if (S.down) addCutTo([S.x, S.y]);
    if (!EMBED) wake();
  }
  if (!EMBED) {
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture?.(e.pointerId);
      S.down = true; lastCut = null; S.lastT = 0;
      onMove(e);
      document.documentElement.classList.add('carving');
    });
    canvas.addEventListener('pointermove', onMove);
    const up = () => { S.down = false; lastCut = null; document.documentElement.classList.remove('carving'); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') S.lastT = 0; });
    // iOS: keep touches on the glass, not the page.
    canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
  }

  // Embed: a phantom hand draws a slow arc now and then, so the cuts are seen.
  const phantom = { next: 3, t: -1, a0: 0, cx: 0.5, cy: 0.5, r: 0.3, dir: 1 };
  function runPhantom(dt, now) {
    if (phantom.t < 0) {
      if (now < phantom.next) return;
      phantom.t = 0; phantom.a0 = Math.random() * Math.PI * 2;
      phantom.cx = 0.35 + Math.random() * 0.3; phantom.cy = 0.35 + Math.random() * 0.3;
      phantom.r = 0.18 + Math.random() * 0.2; phantom.dir = Math.random() < 0.5 ? -1 : 1;
      lastCut = null;
    }
    phantom.t += dt;
    const k = phantom.t / 1.4;
    const a = phantom.a0 + phantom.dir * k * 2.2;
    addCutTo([phantom.cx + Math.cos(a) * phantom.r * 0.75, phantom.cy + Math.sin(a) * phantom.r]);
    S.rawSpeed = 0.35; S.lastMove = now; S.down = true;
    if (k >= 1) { phantom.t = -1; phantom.next = now + 6 + Math.random() * 4; lastCut = null; S.down = false; }
  }

  // ── Palettes ───────────────────────────────────────────────────────
  const GELS = ['Riso Classic', 'Ink Wash', 'Huichol', 'Primary', 'Oxide', 'Midnight', 'Duotone', 'Cycle'];
  let gelChoice = 7, cycleIndex = 0, cycleClock = 0;
  const gelButtons = [...document.querySelectorAll('[data-gel]')];
  function setGel(i) {
    gelChoice = i;
    gelButtons.forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.gel === i)));
    const lab = document.querySelector('.gel-name');
    if (lab) lab.textContent = GELS[i];
  }
  gelButtons.forEach(b => b.addEventListener('click', () => setGel(+b.dataset.gel)));
  setGel(gelChoice);

  // ── Chrome: fades while you carve or sit still ─────────────────────
  let chromeTimer = 0;
  function wake(ms = 5200) {
    document.documentElement.classList.remove('quiet');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => document.documentElement.classList.add('quiet'), ms);
  }
  if (!EMBED) { addEventListener('keydown', () => wake()); wake(11000); }
  let hinted = false;

  // ── Sound ──────────────────────────────────────────────────────────
  const audio = { ctx: null, node: null, gain: null, el: null, on: false, busy: false, sendT: 0 };
  const soundBtn = document.querySelector('.sound');
  // iOS rules: the AudioContext must be created AND resumed synchronously
  // inside the tap — anything after an `await` no longer counts as a gesture.
  // A silent looping <audio> element also moves Safari onto the "playback"
  // audio session, so the ringer/silent switch doesn't mute the realm on
  // iPhones older than iOS 17 (newer ones use navigator.audioSession).
  function silentWavURL() {
    const sr = 8000, n = sr / 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    if (!audio.el) {
      audio.el = new Audio(silentWavURL());
      audio.el.loop = true; audio.el.setAttribute('playsinline', '');
    }
    audio.el.play().catch(() => {});
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new AC();
    }
    const ctx = audio.ctx;
    ctx.resume();
    const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();   // classic iOS unlock
    src.buffer = b; src.connect(ctx.destination); src.start(0);
  }
  const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
  function showSound(state, msg) {           // off | starting | on | blocked
    if (!soundBtn) return;
    soundBtn.dataset.state = state;
    soundBtn.setAttribute('aria-pressed', String(state === 'on' || state === 'starting'));
    soundBtn.title = msg || '';
  }
  async function buildGraph() {
    if (audio.node) return;
    const ctx = audio.ctx;
    if (!ctx.audioWorklet) throw new Error('This browser has no AudioWorklet');
    await withTimeout(ctx.audioWorklet.addModule('reflecting-audio.js?v=3'), 8000, 'Loading sound');
    const node = new AudioWorkletNode(ctx, 'reflecting', { numberOfInputs: 0, outputChannelCount: [2] });
    const gain = ctx.createGain(); gain.gain.value = 0;
    node.connect(gain).connect(ctx.destination);
    Object.assign(audio, { node, gain });
  }
  function toggleSound() {
    if (audio.busy) return;
    const turnOn = !audio.on;
    if (turnOn) {
      showSound('starting');                   // answer the tap at once
      try { unlockAudio(); }                   // synchronous, inside the tap
      catch (e) { console.error('[reflecting] audio', e); showSound('blocked', String(e.message || e)); return; }
    }
    audio.busy = true;
    (async () => {
      try {
        await buildGraph();
        const { ctx, gain } = audio;
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        if (turnOn) {
          if (ctx.state !== 'running') await withTimeout(ctx.resume(), 3000, 'Starting audio');
          gain.gain.linearRampToValueAtTime(1, now + 1.2);
          audio.on = true;
          showSound('on');
        } else {
          gain.gain.linearRampToValueAtTime(0, now + 0.6);
          audio.on = false;
          showSound('off');
          setTimeout(() => { if (!audio.on) { ctx.suspend(); audio.el?.pause(); } }, 700);
        }
      } catch (e) {
        console.error('[reflecting] audio', e);
        audio.on = false;
        showSound('blocked', String(e.message || e));
      } finally {
        audio.busy = false;
      }
    })();
  }
  // iOS can leave the context "interrupted" after a call, Siri or a lock.
  // The next tap anywhere brings it back.
  addEventListener('pointerdown', () => {
    if (audio.on && audio.ctx && audio.ctx.state !== 'running') { audio.ctx.resume(); audio.el?.play().catch(() => {}); }
  }, true);
  soundBtn?.addEventListener('click', e => { e.stopPropagation(); toggleSound(); });

  // ── Frame loop ─────────────────────────────────────────────────────
  let animT = 0, last = performance.now(), running = true, start = last;
  const perf = { acc: 0, n: 0, settledAt: 0 };
  const cutSeg = new Float32Array(MAX_CUTS * 4), cutMeta = new Float32Array(MAX_CUTS * 4);
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
  const clamp01 = v => Math.min(1, Math.max(0, v));

  function frame(nowMs) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    const now = nowMs / 1000;

    if (EMBED) runPhantom(dt, now);

    // Attention model.
    const moving = S.lastMove > 0 && now - S.lastMove < 0.09;
    const spT = moving ? S.rawSpeed : 0;
    S.speed += (spT - S.speed) * (spT > S.speed ? ease(dt, 0.03) : ease(dt, 0.28));
    const actT = clamp01(S.speed * 2.4 + (S.down && moving ? 0.25 : 0));
    S.activity += (actT - S.activity) * (actT > S.activity ? ease(dt, 0.45) : ease(dt, 5.5));
    S.stillFor = moving ? 0 : S.stillFor + dt;
    const calmT = clamp01((S.stillFor - 3) / 25) * (1 - S.activity);
    S.calmDepth += (calmT - S.calmDepth) * ease(dt, calmT > S.calmDepth ? 6 : 1.2);
    S.paint += ((S.down ? 1 : 0) - S.paint) * ease(dt, S.down ? 0.1 : 0.5);

    if (!hinted && cuts.length > 2 && !EMBED) { hinted = true; document.documentElement.classList.add('hinted'); }

    const a = S.activity, calm = 1 - a;
    // Calm slows everything, as on device (trace mode idles at 0.3×).
    animT += dt * (0.42 + 0.58 * a) * (reduceMotion ? 0.4 : 1);
    const breath = 0.5 + 0.5 * Math.sin(now * 2 * Math.PI / 10.9);   // ~5.5 breaths/min

    // Palette clocks.
    cycleClock += dt;
    if (cycleClock >= 30) { cycleClock -= 30; cycleIndex = (cycleIndex + 1) % 7; }
    const gel = gelChoice === 7 ? cycleIndex : gelChoice;

    // Age cuts.
    for (const c of cuts) c.age += dt;
    for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i].age >= cuts[i].life) cuts.splice(i, 1);
    cutSeg.fill(0); cutMeta.fill(0);
    cuts.forEach((c, i) => {
      cutSeg.set([c.a[0], c.a[1], c.b[0], c.b[1]], i * 4);
      cutMeta.set([c.age, c.life, 0, 0], i * 4);
    });

    // Pass 0: glass.
    gl.viewport(0, 0, W, H);
    gl.useProgram(P.glass.p);
    const ug = P.glass.u;
    gl.uniform2f(ug.uRes, W, H);
    gl.uniform1f(ug.uTime, animT + 40);                       // skip the t≈0 start pose
    gl.uniform1f(ug.uFracture, lerp(0.30, 0.88, a));          // calm → ordered
    gl.uniform1f(ug.uEcho, lerp(0.34, 0.72, S.calmDepth));    // depth of stillness = depth of image
    gl.uniform1f(ug.uDensity, 0.48);
    gl.uniform1f(ug.uMorph, lerp(0.32, 0.85, a));             // calm → slower
    gl.uniform1f(ug.uFocus, clamp01(0.5 + (a - 0.3) * 0.5));  // focus leans the palette
    gl.uniform1f(ug.uCoh, lerp(0.55, 0.95, calm));            // steadiness = clean registration
    gl.uniform1f(ug.uBreath, breath);
    gl.uniform1i(ug.uGel, gel);
    gl.uniform1i(ug.uCutCount, cuts.length);
    gl.uniform4fv(ug.uCutSeg, cutSeg);
    gl.uniform4fv(ug.uCutMeta, cutMeta);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glassT.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 1: the well.
    const read = ping ? wellB : wellA, write = ping ? wellA : wellB;
    gl.useProgram(P.well.p);
    const uw = P.well.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glassT.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(uw.uGlass, 0); gl.uniform1i(uw.uPrev, 1);
    gl.uniform2f(uw.uRes, W, H);
    gl.uniform1f(uw.uDt, dt);
    gl.uniform1f(uw.uDepth, lerp(0.74, 0.92, S.calmDepth));
    gl.uniform1f(uw.uReset, wellReset ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ping = !ping; wellReset = false;

    // Pass 2: blit.
    gl.useProgram(P.blit.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, write.tex);
    gl.uniform1i(P.blit.u.uTex, 0);
    gl.uniform1f(P.blit.u.uSat, 0.825);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Sound parameters, ~30 Hz.
    if (audio.on && now - audio.sendT > 0.033) {
      audio.sendT = now;
      audio.node.port.postMessage({
        y: S.y, speed: S.speed, touch: (S.down || moving) ? 1 : 0,
        trace: S.paint, breath, activity: a, calm: S.calmDepth,
      });
    }

    // Adaptive quality during the first seconds, then hands off.
    // Early on it can step both ways; afterwards it only steps down if the
    // GPU really falls behind (e.g. a hot phone), never back up mid-viewing.
    perf.acc += dt; perf.n++;
    if (perf.n >= 40) {
      const avg = perf.acc / perf.n, early = now - start / 1000 < 12;
      perf.acc = 0; perf.n = 0;
      if (avg > (early ? 0.024 : 0.034) && quality > 0.42) { quality *= 0.85; resize(); }
      else if (early && avg < 0.0135 && quality < 1) { quality = Math.min(1, quality * 1.12); resize(); }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; audio.ctx?.suspend(); audio.el?.pause(); }
    else {
      running = true; last = performance.now();
      if (audio.on) { audio.ctx?.resume(); audio.el?.play().catch(() => {}); }
      requestAnimationFrame(frame);
    }
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  requestAnimationFrame(frame);
})();
