// eamonbrown.com — home page: suminagashi.
// Concentric rings of white ink on black, centred one letter-height below the
// "N" of EAMON and spreading well past the edges of the screen. The pointer
// is wind: moving it drags the ink rings along with it; when it leaves an
// area the surface slowly heals back into true circles.
//
// The wind lives in a small CPU displacement grid (uploaded as a texture each
// frame); the rings themselves are drawn in a fragment shader.
(() => {
  const canvas = document.querySelector('canvas.field');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) { canvas.style.background = '#efeae0'; return; }

  // ── Displacement grid (the "water surface") ─────────────────────
  const GW = 160, GH = 100;                 // grid cells (stretched to the screen)
  const dx = new Float32Array(GW * GH), dy = new Float32Array(GW * GH);
  const tx = new Float32Array(GW * GH), ty = new Float32Array(GW * GH);
  const tex8 = new Uint8Array(GW * GH * 4);
  const MAXD = 0.22;                        // max displacement, fraction of min(w,h)
  const HEAL = 0.9955;                      // per frame: slow return to circles (~2.5 s half-life)

  const vert = `attribute vec2 p; varying vec2 vUv;
    void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const frag = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;      // drawing-buffer size, px
uniform vec2 uCenter;   // ring centre, px (GL coords, origin bottom-left)
uniform float uSpace;   // ring spacing, px
uniform float uMaxD;    // max displacement, px
uniform sampler2D uDisp;
uniform float uT;

float hash(float n){ return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1,0)), u.x), mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), u.x), u.y);
}

void main(){
  vec2 px = vUv * uRes;
  vec4 d = texture2D(uDisp, vUv);
  vec2 disp = (d.xy * 2.0 - 1.0) * uMaxD;      // wind displacement at this point
  vec2 q = px - disp;                           // sample the undisturbed pattern "upwind"

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
  if (!vs || !fs) { canvas.style.background = '#efeae0'; return; }
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

  const U = n => gl.getUniformLocation(prog, n);
  const uRes = U('uRes'), uCenter = U('uCenter'), uSpace = U('uSpace'), uMaxD = U('uMaxD'), uT = U('uT');
  gl.uniform1i(U('uDisp'), 0);

  // ── Size + ring centre (one letter-height below the N of EAMON) ──
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0;
  const anchor = document.querySelector('[data-ink-anchor]');
  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(canvas.clientWidth * dpr); H = Math.floor(canvas.clientHeight * dpr);
    canvas.width = W; canvas.height = H; gl.viewport(0, 0, W, H);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const capH = parseFloat(getComputedStyle(anchor).fontSize) * 0.7;   // cap height
      const glyphBottom = r.top + r.height / 2 + capH / 2;
      cx = (r.left + r.width / 2) * dpr;
      cy = H - (glyphBottom + capH) * dpr;            // one letter-height below the N; GL y is bottom-up
    } else { cx = W / 2; cy = H / 2; }
  }
  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  layout();

  // ── Wind ─────────────────────────────────────────────────────────
  let lastX = null, lastY = null;
  function wind(clientX, clientY) {
    if (lastX === null) { lastX = clientX; lastY = clientY; return; }
    const vx = clientX - lastX, vy = clientY - lastY;
    lastX = clientX; lastY = clientY;
    const sp = Math.hypot(vx, vy); if (sp < 0.2) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight, m = Math.min(cw, ch);
    const cellW = cw / GW, cellH = ch / GH;
    const gx = clientX / cellW, gy = (ch - clientY) / cellH;        // grid coords (y up)
    const Rpx = 0.11 * m;                                            // gust radius, px
    const k = Math.min(sp, 60) / m / MAXD * 0.55;                    // push strength
    const ux = vx / sp, uy = -vy / sp;                               // wind dir (y up)
    const x0 = Math.max(0, Math.floor(gx - 2 * Rpx / cellW)), x1 = Math.min(GW - 1, Math.ceil(gx + 2 * Rpx / cellW));
    const y0 = Math.max(0, Math.floor(gy - 2 * Rpx / cellH)), y1 = Math.min(GH - 1, Math.ceil(gy + 2 * Rpx / cellH));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = (x - gx) * cellW, py = (y - gy) * cellH;
        const fall = Math.exp(-(px * px + py * py) / (Rpx * Rpx));
        if (fall < 0.01) continue;
        const i = y * GW + x;
        // push with the wind, plus a little curl (opposite on each side of the
        // gust's path) so the ink swirls rather than simply slides
        const side = Math.sign(px * uy - py * ux) * 0.35;
        dx[i] += (ux + uy * side) * k * fall;
        dy[i] += (uy - ux * side) * k * fall;
      }
    }
  }
  window.addEventListener('pointermove', e => wind(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerleave', () => { lastX = null; });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) wind(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchend', () => { lastX = null; });

  function stepGrid() {
    // heal + a light blur so the surface stays smooth, like water settling
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x;
        const l = x > 0 ? i - 1 : i, r = x < GW - 1 ? i + 1 : i;
        const d = y > 0 ? i - GW : i, u = y < GH - 1 ? i + GW : i;
        tx[i] = (dx[i] * 4 + dx[l] + dx[r] + dx[d] + dx[u]) / 8 * HEAL;
        ty[i] = (dy[i] * 4 + dy[l] + dy[r] + dy[d] + dy[u]) / 8 * HEAL;
      }
    }
    for (let i = 0; i < GW * GH; i++) {
      const vx = Math.max(-1, Math.min(1, tx[i])), vy = Math.max(-1, Math.min(1, ty[i]));
      dx[i] = vx; dy[i] = vy;
      tex8[i * 4] = Math.round((vx * 0.5 + 0.5) * 255);
      tex8[i * 4 + 1] = Math.round((vy * 0.5 + 0.5) * 255);
      tex8[i * 4 + 2] = 0; tex8[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GW, GH, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex8);
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });
  function frame(now) {
    stepGrid();
    const m = Math.min(W, H);
    gl.uniform2f(uRes, W, H);
    gl.uniform2f(uCenter, cx, cy);
    gl.uniform1f(uSpace, Math.max(18 * dpr, m * 0.034));
    gl.uniform1f(uMaxD, MAXD * m);
    gl.uniform1f(uT, now / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (running) requestAnimationFrame(frame);
  }
  if (reduce) { stepGrid(); requestAnimationFrame(t => { frame(t); running = false; }); }
  else requestAnimationFrame(frame);
})();
