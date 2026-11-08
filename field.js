// eamonbrown.com — home page: suminagashi.
// Concentric rings of white ink on black, centred one letter-height below the
// "N" of EAMON and spreading well past the edges of the screen.
//
// The pointer is wind on water. Gusts push a velocity field that keeps
// drifting and slowly settles (momentum, like water); that flow carries the
// ink with it (semi-Lagrangian advection of a "where did this ink come from"
// map), so rings fold and stay folded rather than springing back. Over time
// the surface very slowly heals toward true circles.
//
// Simulation runs on a small CPU grid, uploaded each frame as a float texture
// (WebGL2) or an 8-bit texture (WebGL1 fallback); rings are drawn in the shader.
(() => {
  const canvas = document.querySelector('canvas.field');
  if (!canvas) return;
  let gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) { canvas.style.background = '#070708'; return; }

  // ── Water grid ───────────────────────────────────────────────────
  const GW = 192, GH = 120, N = GW * GH;
  const vx = new Float32Array(N), vy = new Float32Array(N);     // velocity, cells / frame
  const nx = new Float32Array(N), ny = new Float32Array(N);
  const mx = new Float32Array(N), my = new Float32Array(N);     // source map (cell coords)
  const ax = new Float32Array(N), ay = new Float32Array(N);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { mx[y * GW + x] = x; my[y * GW + x] = y; }
  const dispF = new Float32Array(N * 2);
  const disp8 = new Uint8Array(N * 4);
  const DRAG = 0.965;      // water keeps moving after a gust, settling over ~1–2 s
  const HEAL = 0.0007;     // per frame pull of the ink back toward circles (very slow: ~30 s+)
  const MAX8 = 0.5;        // 8-bit fallback range, fraction of min(w,h)

  const vert = `attribute vec2 p; varying vec2 vUv;
    void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const frag = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;      // drawing-buffer size, px
uniform vec2 uCenter;   // ring centre, px (GL coords, origin bottom-left)
uniform float uSpace;   // ring spacing, px
uniform vec2 uCell;     // grid cell size, px
uniform float uFloat;   // 1 = float displacement texture, 0 = 8-bit
uniform float uMax8;    // 8-bit range, px
uniform sampler2D uDisp;

float hash(float n){ return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1,0)), u.x), mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), u.x), u.y);
}

void main(){
  vec2 px = vUv * uRes;
  vec4 d = texture2D(uDisp, vUv);
  vec2 disp = uFloat > 0.5 ? d.xy * uCell : (d.xy * 2.0 - 1.0) * uMax8;
  vec2 q = px - disp;                           // where this ink came from
  vec2 rel = q - uCenter;
  float r = length(rel);
  vec2 dir = rel / max(r, 1e-3);
  // ink never makes perfect circles: a slow wobble of the radius that grows
  // outward (rings near the first drop stay round). Sampled on the direction
  // vector, not the angle, so there's no seam.
  float grow = clamp(r / (uSpace * 10.0), 0.0, 1.0);
  r += (noise(dir * 1.3 + r * 0.0018 + 11.0) - 0.5) * uSpace * 0.9 * grow;
  r += (noise(dir * 4.0 + r * 0.004 + 3.0) - 0.5) * uSpace * 0.25 * grow;

  float ringPos = r / uSpace;
  float idx = floor(ringPos);
  float f = fract(ringPos);
  // each ring its own thickness, like successive touches of the brush
  float w = mix(0.34, 0.56, hash(idx + 7.0));
  float soft = 1.1 / uSpace;                    // ~1 px edge: crisp, inked
  float ink = smoothstep(0.5 - w * 0.5 - soft, 0.5 - w * 0.5 + soft, f)
            * (1.0 - smoothstep(0.5 + w * 0.5 - soft, 0.5 + w * 0.5 + soft, f));
  // the first touch: a single round drop at the centre
  ink = max(ink, 1.0 - smoothstep(uSpace * 0.5 - 1.0, uSpace * 0.5 + 1.0, length(rel)));

  // pigment density drifts gently along each ring
  float dens = 0.86 + 0.14 * noise(dir * 2.0 + idx * 0.37);
  vec3 ground = vec3(0.028, 0.027, 0.030);
  ground *= 0.9 + 0.1 * noise(px * 0.35);       // faint grain
  vec3 inkCol = vec3(0.90, 0.885, 0.86);        // bone white
  vec3 col = mix(ground, inkCol, ink * dens);
  gl_FragColor = vec4(col, 1.0);
}`;

  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vs = sh(gl.VERTEX_SHADER, vert), fs = sh(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) { canvas.style.background = '#070708'; return; }
  const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const U = n => gl.getUniformLocation(prog, n);
  const uRes = U('uRes'), uCenter = U('uCenter'), uSpace = U('uSpace'), uCell = U('uCell'),
        uFloat = U('uFloat'), uMax8 = U('uMax8');
  gl.uniform1i(U('uDisp'), 0);
  gl.uniform1f(uFloat, isGL2 ? 1 : 0);

  // ── Size + ring centre (one letter-height below the N of EAMON) ──
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0;
  const anchor = document.querySelector('[data-ink-anchor]');
  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(canvas.clientWidth * dpr); H = Math.floor(canvas.clientHeight * dpr);
    canvas.width = W; canvas.height = H; gl.viewport(0, 0, W, H);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const capH = parseFloat(getComputedStyle(anchor).fontSize) * 0.7;
      const glyphBottom = r.top + r.height / 2 + capH / 2;
      cx = (r.left + r.width / 2) * dpr;
      cy = H - (glyphBottom + capH) * dpr;
    } else { cx = W / 2; cy = H / 2; }
  }
  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  layout();

  // ── Wind: gusts push the water ───────────────────────────────────
  let lastX = null, lastY = null;
  function wind(clientX, clientY) {
    if (lastX === null) { lastX = clientX; lastY = clientY; return; }
    const sx = clientX - lastX, sy = clientY - lastY;
    lastX = clientX; lastY = clientY;
    const sp = Math.hypot(sx, sy); if (sp < 0.3) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight, m = Math.min(cw, ch);
    const cellW = cw / GW, cellH = ch / GH;
    const gx = clientX / cellW, gy = (ch - clientY) / cellH;
    const Rpx = 0.12 * m;                                    // gust width
    const ux = sx / sp, uy = -sy / sp;                       // heading (y up)
    const strength = Math.min(sp, 80) * 0.05;                // heavier with speed
    // Blowing: the jet starts at the cursor and reaches ahead of it along its
    // heading — a long, narrow plume, strongest just in front of the cursor.
    const reach = 2.6 * Rpx;
    const ext = reach + Rpx;
    const x0 = Math.max(0, Math.floor(gx - ext / cellW)), x1 = Math.min(GW - 1, Math.ceil(gx + ext / cellW));
    const y0 = Math.max(0, Math.floor(gy - ext / cellH)), y1 = Math.min(GH - 1, Math.ceil(gy + ext / cellH));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x - gx) * cellW, py = (y - gy) * cellH;
      const along = px * ux + py * uy;                       // distance ahead of the cursor
      const across = px * uy - py * ux;                      // distance to either side
      if (along < -0.3 * Rpx) continue;                      // nothing behind the cursor
      const a = Math.max(along, 0);
      const width = Rpx * (0.45 + 0.55 * a / reach);         // plume spreads as it travels
      const fall = Math.exp(-(across * across) / (width * width)) * Math.exp(-a / reach) * Math.min(1, (along + 0.3 * Rpx) / (0.3 * Rpx));
      if (fall < 0.01) continue;
      const i = y * GW + x;
      // mostly straight ahead; the edges of the plume curl outward
      const side = Math.tanh(across / width) * 0.35;
      vx[i] += (ux + uy * side) * strength * fall / cellW;
      vy[i] += (uy - ux * side) * strength * fall / cellH;
    }
  }
  window.addEventListener('pointermove', e => wind(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerleave', () => { lastX = null; });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) wind(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchend', () => { lastX = null; });

  function bilerp(a, x, y) {
    x = Math.max(0, Math.min(GW - 1.001, x)); y = Math.max(0, Math.min(GH - 1.001, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * GW + x0;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + GW] * (1 - fx) + a[i + GW + 1] * fx) * fy;
  }

  function step() {
    // 1) velocity: viscous spread + drag (water carries on, then settles)
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      const l = x > 0 ? i - 1 : i, r = x < GW - 1 ? i + 1 : i, d = y > 0 ? i - GW : i, u = y < GH - 1 ? i + GW : i;
      nx[i] = (vx[i] * 2 + vx[l] + vx[r] + vx[d] + vx[u]) / 6 * DRAG;
      ny[i] = (vy[i] * 2 + vy[l] + vy[r] + vy[d] + vy[u]) / 6 * DRAG;
    }
    vx.set(nx); vy.set(ny);
    // 2) the water carries the ink: back-trace each cell along the flow
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      const bx = x - vx[i], by = y - vy[i];
      let sxm = bilerp(mx, bx, by), sym = bilerp(my, bx, by);
      // 3) very slow healing toward the undisturbed circles
      sxm += (x - sxm) * HEAL; sym += (y - sym) * HEAL;
      ax[i] = sxm; ay[i] = sym;
    }
    mx.set(ax); my.set(ay);
    // displacement = here − source (cells)
    if (isGL2) {
      for (let i = 0; i < N; i++) { const x = i % GW, y = (i / GW) | 0; dispF[i * 2] = x - mx[i]; dispF[i * 2 + 1] = y - my[i]; }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, GW, GH, 0, gl.RG, gl.FLOAT, dispF);
    } else {
      const cw = canvas.clientWidth, ch = canvas.clientHeight, m8 = MAX8 * Math.min(cw, ch);
      for (let i = 0; i < N; i++) {
        const x = i % GW, y = (i / GW) | 0;
        const ddx = (x - mx[i]) * cw / GW / m8, ddy = (y - my[i]) * ch / GH / m8;
        disp8[i * 4] = Math.round((Math.max(-1, Math.min(1, ddx)) * 0.5 + 0.5) * 255);
        disp8[i * 4 + 1] = Math.round((Math.max(-1, Math.min(1, ddy)) * 0.5 + 0.5) * 255);
        disp8[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GW, GH, 0, gl.RGBA, gl.UNSIGNED_BYTE, disp8);
    }
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });
  function frame() {
    step();
    const m = Math.min(W, H);
    gl.uniform2f(uRes, W, H);
    gl.uniform2f(uCenter, cx, cy);
    gl.uniform1f(uSpace, Math.max(18 * dpr, m * 0.034));
    gl.uniform2f(uCell, W / GW, H / GH);
    gl.uniform1f(uMax8, MAX8 * m);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (running) requestAnimationFrame(frame);
  }
  if (reduce) { requestAnimationFrame(() => { frame(); running = false; }); }
  else requestAnimationFrame(frame);
})();
