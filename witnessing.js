/* Aumara Realms — WITNESSING, web port.
   Ported from the iOS realm (WitnessingRenderer.swift / WitnessingShaders.metal /
   WitnessingField.swift).

   Three passes, as on device:
     scene    — a 128 × 128 field of bars. One slow generative surface sets every
                bar's height; the camera drifts forward over it, low and grazing.
     feedback — the previous composite, slid along the forms under it and
                blended with a little of the fresh scene (the trails).
     present  — crossfade from the crisp scene into the trails, keyed by
                elevation: valleys dissolve first, ridges hold.

   The slider values are the ones saved in the app's trace mode.
   Press and drag pushes into the ground: a crater with a raised ring, and a
   wake of mounds along the path (gentler than on device). */
(() => {
  'use strict';

  const canvas = document.querySelector('canvas.realm');
  if (!canvas) return;
  const QS = new URLSearchParams(location.search);
  const STILL = location.hash === '#still';                 // thumbnail: render one settled frame, then stop
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    preserveDrawingBuffer: STILL, powerPreference: 'high-performance',
  });
  if (!gl) { document.documentElement.classList.add('no-gl'); return; }

  // ── App values (trace mode) ────────────────────────────────────────
  const V = {
    keying: 0.971, direction: 0.469, scan: 0.563, palette: 0.894,
    colorDrift: 0.786, motion: 0.696, genlock: 0.976, abstract: 0.935,
    fold: 0.150, ramp: 0.100,
  };
  const GRID = 128;
  const CAM_H = 9.5, CAM_Z = -30, LENS_SHIFT = 0.30;
  const FIELD_T0 = 72;                            // calm start, as on device

  // ── Shaders ────────────────────────────────────────────────────────
  const SCENE_VS = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aNormal;
  uniform float uPh[5];        // wave phases (time terms), computed in JS
  uniform vec2  uEnv;          // slow mound envelopes
  uniform float uBreath;       // 0..1, rides the breath clock
  uniform float uCamZ;         // camera Z, wrapped to the field period
  uniform float uCamX;
  uniform float uCamY, uPitch, uFov, uAspect, uShift;
  uniform float uPress;        // touch press envelope
  uniform vec2  uPressPos;     // press point, relative to the camera column
  uniform vec4  uTrail[18];    // xy = position (relative), z = strength × fade
  uniform int   uTrailN;
  out vec3 vWorld;
  out vec3 vNormal;
  out float vElev;

  const float KZ = 6.2831853 / 128.0;

  float field(float wx, float wz) {
    float h = 0.0;
    h += sin(wx *  0.16 + wz * ( 2.0 * KZ) + uPh[0]) * 0.82;
    h += sin(wx * -0.13 + wz * ( 4.0 * KZ) + uPh[1]) * 0.52;
    h += sin(wx *  0.29 + wz * (-5.0 * KZ) + uPh[2]) * 0.28;
    h += sin(wx *  0.060 + wz * KZ + uPh[3]) * uEnv.x * 1.45;
    h += sin(wx * -0.045 + wz * KZ + uPh[4]) * uEnv.y * 1.05;
    h += (uBreath - 0.5) * 1.30;
    return h;                  // hbO neutral (×1.0), fade 1
  }

  void main() {
    int ix = gl_InstanceID % ${GRID};
    int iz = gl_InstanceID / ${GRID};
    float worldX = float(ix - ${GRID / 2});
    float worldZ = float(iz - ${GRID / 2}) - uCamZ;
    if (worldZ < -64.0) worldZ += 128.0;
    if (worldZ >  64.0) worldZ -= 128.0;

    if (worldX * worldX + worldZ * worldZ > 78.0 * 78.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vElev = 0.0;
      return;
    }

    float fh = field(worldX + uCamX, worldZ + uCamZ);

    // Touch: a crater under the finger, a raised ring around it.
    if (uPress > 0.02) {
      vec2 dd = vec2(worldX, worldZ) - uPressPos;
      float d2 = dot(dd, dd);
      if (d2 < 220.0) {
        float d = sqrt(d2);
        float crater = -5.5 * exp(-d2 / 18.0);
        float ring   =  1.7 * exp(-((d - 6.0) * (d - 6.0)) / 6.0);
        fh += (crater + ring) * uPress;
      }
    }
    // Drag wake: mounds along the recent path.
    for (int i = 0; i < 18; i++) {
      if (i >= uTrailN) break;
      vec2 dd = vec2(worldX, worldZ) - uTrail[i].xy;
      float d2 = dot(dd, dd);
      if (d2 < 90.0) fh += 1.3 * exp(-d2 / 14.0) * uTrail[i].z;
    }

    float edge = clamp((worldZ - 40.0) / 22.0, 0.0, 1.0);
    float barH = max(0.4, 0.8 + fh * 3.6 * (1.0 - edge * edge));
    // Web only: bars close to the camera stay below eye level, so ground
    // pushed up by a touch cannot wall off the view.
    barH = min(barH, 6.0 + 8.0 * smoothstep(-28.0, 2.0, worldZ) + 30.0 * smoothstep(2.0, 20.0, worldZ));
    vElev = clamp((fh + 2.5) / 6.0, 0.0, 1.0);

    vec3 world = vec3(aPos.x + worldX, (aPos.y + 0.5) * barH, aPos.z + worldZ);
    vec3 rel = world - vec3(0.0, uCamY, ${CAM_Z.toFixed(1)});
    float cp = cos(uPitch), sp = sin(uPitch);
    vec3 view = vec3(rel.x, rel.y * cp - rel.z * sp, rel.y * sp + rel.z * cp);

    float f = 1.0 / tan(uFov * 0.5);
    const float near = 0.5, far = 150.0;
    vec4 clip = vec4(f / uAspect * view.x, f * view.y,
                     (far + near) / (far - near) * view.z - 2.0 * far * near / (far - near),
                     view.z);
    clip.y += uShift * clip.w;          // lens shift: horizon rides high, angle unchanged
    gl_Position = clip;
    vWorld = world;
    vNormal = aNormal;
  }`;

  const SCENE_FS = `#version 300 es
  precision highp float;
  in vec3 vWorld;
  in vec3 vNormal;
  in float vElev;
  uniform float uPalRot, uColorTemp, uCamY;
  out vec4 outColor;
  void main() {
    float t = vElev * 0.60 + uPalRot;
    vec3 aA = vec3(0.50, 0.50, 0.55), bA = vec3(0.50, 0.50, 0.45), cA = vec3(1.00, 1.00, 1.00), dA = vec3(0.00, 0.10, 0.20);
    vec3 aB = vec3(0.55, 0.50, 0.50), bB = vec3(0.50, 0.45, 0.50), cB = vec3(1.00, 0.70, 0.40), dB = vec3(0.00, 0.15, 0.20);
    float w = clamp(uColorTemp, 0.0, 1.0);
    vec3 rgb = mix(aA, aB, w) + mix(bA, bB, w) * cos(6.28318 * (mix(cA, cB, w) * t + mix(dA, dB, w)));
    rgb = 0.24 + 0.76 * rgb;   // web only: a floor under the palette, so its dark phase is not near-black

    vec3 cam = vec3(0.0, uCamY, ${CAM_Z.toFixed(1)});
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(cam - vWorld);
    float ndotl = max(dot(n, normalize(vec3(0.3, 1.0, 0.5))), 0.0);
    float fill = max(dot(n, viewDir), 0.0) * 0.30;
    float light = 0.72 + 0.55 * ndotl + fill;
    vec3 color = rgb * light * 1.08;

    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    color += fresnel * 0.15 * 0.5;

    float fog = smoothstep(92.0, 140.0, length(vWorld - cam));
    color = mix(color, vec3(0.60, 0.58, 0.66), fog);
    outColor = vec4(color, 1.0);
  }`;

  const FSQ_VS = `#version 300 es
  out vec2 vTC;                // texcoord with v = 0 at the top, as on device
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vTC = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FS_COMMON = `#version 300 es
  precision highp float;
  in vec2 vTC;
  uniform vec2 uRes;
  out vec4 outColor;
  vec3 S(sampler2D t, vec2 tc) { return texture(t, vec2(tc.x, 1.0 - tc.y)).rgb; }
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  `;

  const FEEDBACK_FS = FS_COMMON + `
  uniform sampler2D uScene, uHist;
  uniform float uMorph, uDir, uDrift, uNoise, uPhase, uSharp, uDecay, uRetention, uReset;

  // Where each pixel pulls its trail from is decided by the form under it:
  // along the contour lines, and by brightness, so ridges and hollows slide apart.
  vec2 contentUV(vec2 uv) {
    vec2 px = 1.0 / max(uRes, vec2(1.0));
    float lx1 = lum(S(uScene, uv + vec2(px.x, 0.0)));
    float lx0 = lum(S(uScene, uv - vec2(px.x, 0.0)));
    float ly1 = lum(S(uScene, uv + vec2(0.0, px.y)));
    float ly0 = lum(S(uScene, uv - vec2(0.0, px.y)));
    float lc  = lum(S(uScene, uv));
    vec2 grad = vec2(lx1 - lx0, ly1 - ly0);
    vec2 contour = normalize(vec2(-grad.y, grad.x) + vec2(1e-5, 0.0));
    float ang = lc * 6.28318;
    vec2 bright = vec2(cos(ang), sin(ang));
    vec2 form = normalize(contour + bright + vec2(1e-5, 0.0));
    float da = uDir * 6.28318;
    vec2 drift = vec2(cos(da), sin(da));
    vec2 undu = vec2(sin(uv.y * 3.0 + uPhase * 0.9), cos(uv.x * 3.0 + uPhase * 0.8));
    vec2 dir = mix(drift, form, clamp(uMorph, 0.0, 1.0));
    dir += undu * uNoise;
    return uv - dir * uDrift;
  }

  void main() {
    vec3 scene = S(uScene, vTC);
    if (uReset > 0.5) { outColor = vec4(scene, 1.0); return; }
    vec2 uvPrev = contentUV(vTC);
    vec2 px = 2.0 / max(uRes, vec2(1.0));
    vec3 c = S(uHist, uvPrev);
    vec3 blur = (S(uHist, uvPrev + vec2(px.x, 0.0)) + S(uHist, uvPrev - vec2(px.x, 0.0)) +
                 S(uHist, uvPrev + vec2(0.0, px.y)) + S(uHist, uvPrev - vec2(0.0, px.y))) * 0.25;
    vec3 hist = clamp((c + (c - blur) * uSharp) * uDecay, 0.0, 2.0);
    outColor = vec4(mix(scene, hist, uRetention), 1.0);
  }`;

  const PRESENT_FS = FS_COMMON + `
  uniform sampler2D uEcho, uScene;
  uniform float uScan, uFold, uRamp, uPhase, uHue, uPulse, uGain, uKey;

  float wavefold(float x, float depth) {
    float folds = 1.0 + depth * 5.0;
    float v = abs(fract(x * folds) * 2.0 - 1.0);
    return mix(x, v, clamp(depth, 0.0, 1.0));
  }
  vec3 trailPalette(float t, float phase) {
    vec3 a = vec3(0.50, 0.50, 0.55), b = vec3(0.45, 0.42, 0.48), c = vec3(1.0), d = vec3(0.00, 0.18, 0.40);
    return a + b * cos(6.28318 * (c * t + d + phase));
  }

  void main() {
    vec2 uv = vTC;
    vec3 scene = S(uScene, uv);

    // Scan deflection: bright areas lift the sample, plus a fine scanline shade.
    float probe = lum(S(uEcho, uv));
    vec2 sUV = uv - vec2(0.0, probe * uScan * 0.08);
    vec3 echo = S(uEcho, sUV);
    float lines = 0.5 + 0.5 * sin(uv.y * uRes.y * 1.5708);
    float scanShade = 1.0 - uScan * 0.35 * (1.0 - lines);

    // Colorize: fold the luma into contour bands; a vertical ramp shifts the hue.
    float trail = clamp(length(echo - scene) * 4.0, 0.0, 1.0);
    float l = lum(echo);
    float fold = wavefold(l, uFold);
    float ramp = (uv.y - 0.5) * uRamp;
    float t = fold * 1.6 + 0.05 + ramp * 0.6;
    vec3 col = trailPalette(t, uPhase) * (l * 1.4 + 0.12);
    echo = mix(echo, col, clamp(uHue, 0.0, 1.0) * trail);
    echo *= scanShade;
    echo *= (1.0 + uPulse * 0.10);
    echo = max(echo, 0.0);

    // Keying: the trails flood up the terrain by elevation.
    float lScene = lum(scene);
    float water = uGain * 1.2 - 0.05;
    float keyMask = smoothstep(water, water - 0.18, lScene);
    float effMask = mix(clamp(uGain, 0.0, 1.0), keyMask, clamp(uKey, 0.0, 1.0));
    outColor = vec4(mix(scene, echo, effMask), 1.0);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
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
  try {
    P = { scene: program(SCENE_VS, SCENE_FS), feedback: program(FSQ_VS, FEEDBACK_FS), present: program(FSQ_VS, PRESENT_FS) };
  } catch (e) { console.error('[witnessing]', e); document.documentElement.classList.add('no-gl'); return; }

  // ── Geometry: one unit cube, instanced 128 × 128 ───────────────────
  const cubeVAO = gl.createVertexArray();
  const quadVAO = gl.createVertexArray();
  let cubeIndexCount = 0;
  {
    const s = 0.5;
    const faces = [
      [[-s, s, -s], [s, s, -s], [s, s, s], [-s, s, s], [0, 1, 0]],
      [[-s, -s, s], [s, -s, s], [s, -s, -s], [-s, -s, -s], [0, -1, 0]],
      [[-s, -s, s], [-s, s, s], [s, s, s], [s, -s, s], [0, 0, 1]],
      [[s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, -s], [0, 0, -1]],
      [[-s, -s, -s], [-s, s, -s], [-s, s, s], [-s, -s, s], [-1, 0, 0]],
      [[s, -s, s], [s, s, s], [s, s, -s], [s, -s, -s], [1, 0, 0]],
    ];
    const verts = [], idx = [];
    faces.forEach((f, i) => {
      for (let k = 0; k < 4; k++) verts.push(...f[k], ...f[4]);
      const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    gl.bindVertexArray(cubeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    cubeIndexCount = idx.length;
    gl.bindVertexArray(null);
  }

  // Half-float targets when the device can render to them; 8-bit otherwise.
  const canFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const FMT = canFloat ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };

  function target(w, h, depth) {
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
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, rb };
  }
  function free(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb); } }

  // ── Resolution (adaptive) ──────────────────────────────────────────
  const coarse = matchMedia('(pointer: coarse)').matches;
  const MAX_PIX = STILL ? 1.2e6 : (coarse ? 3.4e6 : 5.6e6);
  let quality = 1.0;
  let W = 0, H = 0, sceneT, histA, histB, ping = false, histReset = true;

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
    free(sceneT); free(histA); free(histB);
    sceneT = target(W, H, true); histA = target(W, H); histB = target(W, H);
    histReset = true;
    if (STILL) restartStill();
  }

  // ── Touch: pressing into the ground ────────────────────────────────
  const T = {
    down: false, x: 0.5, y: 0.5, force: 0,
    press: 0, pressFX: 0, pressFZ: 0,
    trail: [], lastFX: 1e9, lastFZ: 1e9,
    speed: 0, rawSpeed: 0, lastT: 0, lastPX: 0, lastPY: 0, lastMove: -1, paint: 0,
  };
  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const now = performance.now() / 1000;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (T.lastT) {
      const dt = Math.max(now - T.lastT, 1 / 240);
      T.rawSpeed = Math.min(Math.hypot(px - T.lastPX, py - T.lastPY) / dt, 1500) / 1500;
    }
    T.lastPX = px; T.lastPY = py; T.lastT = now; T.lastMove = now;
    T.x = px / r.width; T.y = py / r.height;
    T.force = e.pointerType === 'mouse' ? 0 : (e.pressure || 0);
  }
  if (!STILL) {
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture?.(e.pointerId);
      T.down = true; T.lastT = 0; onMove(e);
    });
    canvas.addEventListener('pointermove', onMove);
    const up = () => { T.down = false; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
  }

  // ── Sound ──────────────────────────────────────────────────────────
  const audio = { ctx: null, node: null, gain: null, el: null, on: false, busy: false, sendT: 0 };
  const soundBtn = document.querySelector('.sound');
  // iOS: the AudioContext must be created and resumed synchronously inside the
  // tap. A silent looping <audio> keeps the ringer switch from muting it.
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
    const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
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
    await withTimeout(ctx.audioWorklet.addModule('witnessing-audio.js?v=1'), 8000, 'Loading sound');
    const node = new AudioWorkletNode(ctx, 'witnessing', { numberOfInputs: 0, outputChannelCount: [2] });
    const gain = ctx.createGain(); gain.gain.value = 0;
    node.connect(gain).connect(ctx.destination);
    Object.assign(audio, { node, gain });
  }
  function toggleSound() {
    if (audio.busy) return;
    const turnOn = !audio.on;
    if (turnOn) {
      showSound('starting');
      try { unlockAudio(); }
      catch (e) { console.error('[witnessing] audio', e); showSound('blocked', String(e.message || e)); return; }
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
        console.error('[witnessing] audio', e);
        audio.on = false;
        showSound('blocked', String(e.message || e));
      } finally {
        audio.busy = false;
      }
    })();
  }
  addEventListener('pointerdown', () => {
    if (audio.on && audio.ctx && audio.ctx.state !== 'running') { audio.ctx.resume(); audio.el?.play().catch(() => {}); }
  }, true);
  soundBtn?.addEventListener('click', e => { e.stopPropagation(); toggleSound(); });

  // ── State ──────────────────────────────────────────────────────────
  const st = {
    animT: 0, cameraZ: 0, cameraX: 0,
    coh: 0, mot: 0, dir: 0, gen: 0, key: 0, scan: 0, fold: 0, ramp: 0,
    colorDrift: 0.5, palTemp: V.palette, palRot: -0.35,   // open on a light phase of the palette
    freePhase: 0, breathT: 0,
  };
  if (STILL) {
    // Thumbnail: start settled, with the forms already risen.
    Object.assign(st, {
      animT: 40, cameraZ: 32, coh: V.abstract, mot: V.motion, dir: V.direction, gen: V.genlock,
      key: V.keying, scan: V.scan, fold: V.fold, ramp: V.ramp,
      colorDrift: V.colorDrift, palTemp: V.palette, palRot: -0.3, breathT: 2.7,
    });
  }
  const trailU = new Float32Array(18 * 4);
  const phU = new Float32Array(5);
  const TAU = Math.PI * 2;
  const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
  const wrapTau = v => v - Math.floor(v / TAU) * TAU;

  function step(dt, now) {
    const sdt = dt * (reduceMotion ? 0.4 : 1);
    st.animT += sdt;
    st.cameraZ += 0.8 * sdt;

    const lp3 = ease(dt, 3), lp2 = ease(dt, 2);
    st.colorDrift += lp3 * (V.colorDrift - st.colorDrift);
    st.palTemp    += lp3 * (V.palette - st.palTemp);
    st.palRot     += st.colorDrift * sdt * 0.04;
    st.coh  += lp2 * (V.abstract - st.coh);
    st.mot  += lp2 * (V.motion - st.mot);
    st.dir  += lp2 * (V.direction - st.dir);
    st.gen  += lp2 * (V.genlock - st.gen);
    st.key  += lp2 * (V.keying - st.key);
    st.scan += lp2 * (V.scan - st.scan);
    st.fold += lp2 * (V.fold - st.fold);
    st.ramp += lp2 * (V.ramp - st.ramp);

    // Genlock: the breath clock (about 5.5 breaths a minute) against a detuned
    // free oscillator; at this lock setting the breath clock leads.
    st.breathT += sdt;
    const breathPhase = (st.breathT / 10.9) % 1;
    st.freePhase += sdt * 0.7;
    const g = Math.min(1, Math.max(0, st.gen));
    const genOsc = Math.sin(breathPhase * TAU) * g + Math.sin(st.freePhase) * (1 - g);

    const aspect = W / H, portrait = aspect < 1;
    const camY = CAM_H + genOsc * 0.3;
    const pitch = (portrait ? -14 : -12) * Math.PI / 180;
    const fov = (portrait ? 60 : 54) * Math.PI / 180;
    const fieldT = st.animT + FIELD_T0;
    const speed = 0.20;                               // alpha neutral
    const fBreath = 0.5 + 0.5 * genOsc;

    // Touch → ground point (ray cast through the shifted lens).
    let rayHit = false;
    if (T.down) {
      const ndcx = T.x * 2 - 1, ndcy = 1 - T.y * 2 - LENS_SHIFT;
      const f = 1 / Math.tan(fov * 0.5);
      const vdx = ndcx * aspect / f, vdy = ndcy / f;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const wdy = vdy * cp + sp, wdz = -vdy * sp + cp;
      if (wdy < -1e-4) {
        const t = -CAM_H / wdy;
        T.pressFX = t * vdx + st.cameraX;
        T.pressFZ = CAM_Z + t * wdz + st.cameraZ;
        rayHit = true;
        const moved = Math.hypot(T.pressFX - T.lastFX, T.pressFZ - T.lastFZ);
        if (moved > 1.6 || T.trail.length === 0) {
          T.trail.push({ fx: T.pressFX, fz: T.pressFZ, age: 0, strength: Math.min(1.5, 0.5 + moved * 0.15) });
          if (T.trail.length > 18) T.trail.shift();
          T.lastFX = T.pressFX; T.lastFZ = T.pressFZ;
        }
      }
    } else { T.lastFX = 1e9; T.lastFZ = 1e9; }
    const pressTarget = rayHit ? Math.max(T.force, 0.7) : 0;
    T.press += (pressTarget - T.press) * ease(dt, pressTarget > T.press ? 0.22 : 0.9);
    for (const p of T.trail) p.age += dt;
    T.trail = T.trail.filter(p => p.age <= 2.8);

    const moving = T.lastMove > 0 && now - T.lastMove < 0.09;
    const spT = moving && T.down ? T.rawSpeed : 0;
    T.speed += (spT - T.speed) * (spT > T.speed ? ease(dt, 0.03) : ease(dt, 0.28));
    T.paint += ((T.down ? 1 : 0) - T.paint) * ease(dt, T.down ? 0.1 : 0.5);

    // Pass 0: the scene.
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.60, 0.58, 0.66, 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.useProgram(P.scene.p);
    const us = P.scene.u;
    phU[0] = wrapTau(fieldT * speed);
    phU[1] = wrapTau(fieldT * speed * 0.62 + 1.7);
    phU[2] = wrapTau(fieldT * speed * 1.65 + 3.1);
    phU[3] = wrapTau(fieldT * 0.08);
    phU[4] = wrapTau(-fieldT * 0.05 + 2.0);
    gl.uniform1fv(us.uPh, phU);
    gl.uniform2f(us.uEnv, 0.5 + 0.5 * Math.sin(fieldT * 0.060), 0.5 + 0.5 * Math.sin(fieldT * 0.045 + 2.3));
    gl.uniform1f(us.uBreath, fBreath);
    gl.uniform1f(us.uCamZ, st.cameraZ % GRID);
    gl.uniform1f(us.uCamX, st.cameraX);
    gl.uniform1f(us.uCamY, camY);
    gl.uniform1f(us.uPitch, pitch);
    gl.uniform1f(us.uFov, fov);
    gl.uniform1f(us.uAspect, aspect);
    gl.uniform1f(us.uShift, LENS_SHIFT);
    gl.uniform1f(us.uPress, T.press);
    gl.uniform2f(us.uPressPos, T.pressFX - st.cameraX, T.pressFZ - st.cameraZ);
    trailU.fill(0);
    T.trail.forEach((p, i) => {
      trailU[i * 4] = p.fx - st.cameraX; trailU[i * 4 + 1] = p.fz - st.cameraZ;
      trailU[i * 4 + 2] = (1 - p.age / 2.8) * p.strength;
    });
    gl.uniform4fv(us.uTrail, trailU);
    gl.uniform1i(us.uTrailN, T.trail.length);
    gl.uniform1f(us.uPalRot, st.palRot);
    gl.uniform1f(us.uColorTemp, st.palTemp);
    gl.bindVertexArray(cubeVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, cubeIndexCount, gl.UNSIGNED_SHORT, 0, GRID * GRID);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(quadVAO);

    // Pass 1: feedback (history A → B).
    const sAbs = Math.min(1, Math.max(0, st.coh));
    const read = ping ? histB : histA, write = ping ? histA : histB;
    const phase = st.animT * 0.06;
    gl.useProgram(P.feedback.p);
    const uf = P.feedback.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(uf.uScene, 0); gl.uniform1i(uf.uHist, 1);
    gl.uniform2f(uf.uRes, W, H);
    gl.uniform1f(uf.uMorph, Math.min(1, Math.max(0, st.mot)));
    gl.uniform1f(uf.uDir, st.dir);
    gl.uniform1f(uf.uDrift, 0.0075);
    gl.uniform1f(uf.uNoise, 0.18);
    gl.uniform1f(uf.uPhase, phase);
    gl.uniform1f(uf.uSharp, 0.14);
    gl.uniform1f(uf.uDecay, 0.99);
    gl.uniform1f(uf.uRetention, Math.min(0.955, 0.88 + 0.07 * sAbs + genOsc * 0.012));
    gl.uniform1f(uf.uReset, histReset ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ping = !ping; histReset = false;

    // Pass 2: present.
    gl.useProgram(P.present.p);
    const up = P.present.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, write.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
    gl.uniform1i(up.uEcho, 0); gl.uniform1i(up.uScene, 1);
    gl.uniform2f(up.uRes, W, H);
    gl.uniform1f(up.uScan, st.scan);
    gl.uniform1f(up.uFold, st.fold);
    gl.uniform1f(up.uRamp, st.ramp);
    gl.uniform1f(up.uPhase, phase);
    gl.uniform1f(up.uHue, 0.35 + 0.40 * sAbs);
    gl.uniform1f(up.uPulse, genOsc);
    gl.uniform1f(up.uGain, sAbs);
    gl.uniform1f(up.uKey, st.key);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Sound reads the same field, at the same clock and camera position.
    if (audio.on && now - audio.sendT > 0.033) {
      audio.sendT = now;
      audio.node.port.postMessage({
        t: fieldT, camX: st.cameraX, camZ: st.cameraZ % GRID, breath: fBreath, phase: breathPhase,
        rate: reduceMotion ? 0.4 : 1,
        y: T.y, speed: T.speed, down: T.down ? 1 : 0, trace: T.paint,
      });
    }
  }

  // ── Frame loop ─────────────────────────────────────────────────────
  let last = performance.now(), running = true;
  const start = last;
  const perf = { acc: 0, n: 0 };
  let stillN = 0, stillNow = 0;
  const STILL_FRAMES = 160;
  function restartStill() {
    stillN = 0;
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  function frame(nowMs) {
    if (!running) return;
    if (STILL) {
      // Build up the trails off-clock, a few frames per tick, then stop.
      for (let k = 0; k < 8 && stillN < STILL_FRAMES; k++, stillN++) { stillNow += 1 / 60; step(1 / 60, stillNow); }
      if (stillN >= STILL_FRAMES) { running = false; canvas.classList.add('ready'); return; }
      requestAnimationFrame(frame);
      return;
    }
    requestAnimationFrame(frame);
    // The trails advance a fixed step per frame, as on device (60 fps):
    // on faster displays, draw every other refresh.
    if (nowMs - last < 13.4) return;
    const dt = Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    step(dt, nowMs / 1000);

    perf.acc += dt; perf.n++;
    if (perf.n >= 40) {
      const avg = perf.acc / perf.n, early = (nowMs - start) / 1000 < 12;
      perf.acc = 0; perf.n = 0;
      if (avg > (early ? 0.024 : 0.034) && quality > 0.42) { quality *= 0.85; resize(); }
    }
  }

  addEventListener('resize', resize);
  resize();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (!STILL) running = false; audio.ctx?.suspend(); audio.el?.pause(); }
    else if (!STILL) {
      running = true; last = performance.now();
      if (audio.on) { audio.ctx?.resume(); audio.el?.play().catch(() => {}); }
      requestAnimationFrame(frame);
    }
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  requestAnimationFrame(frame);
})();
