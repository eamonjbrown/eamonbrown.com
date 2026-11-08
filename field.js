// eamonbrown.com — the living field on the home page.
// A slow, domain-warped noise surface lit like contour lines: dark, quiet,
// always moving, gently bent by the pointer. Pauses when the tab is hidden;
// renders a single still frame for prefers-reduced-motion.
(() => {
  const canvas = document.querySelector('canvas.field');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) { canvas.style.background = 'radial-gradient(80% 70% at 50% 45%, #18242a, #07070a)'; return; }

  const vert = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const frag = `
precision highp float;
uniform vec2 uRes; uniform float uT; uniform vec2 uPtr; uniform float uPtrAmt;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1,0)), c = hash(i + vec2(0,1)), d = hash(i + vec2(1,1));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uT * 0.035;

  // pointer bends the surface softly
  vec2 d = uv - uPtr;
  float pull = uPtrAmt * exp(-dot(d, d) * 3.5);
  uv += d * pull * 0.35;

  // domain warp (two passes) — the surface folds slowly over itself
  vec2 q = vec2(fbm(uv * 1.3 + vec2(0.0, t)), fbm(uv * 1.3 + vec2(5.2, -t * 0.8)));
  vec2 r = vec2(fbm(uv * 1.6 + 2.2 * q + vec2(1.7, 9.2) + t * 0.6),
                fbm(uv * 1.6 + 2.2 * q + vec2(8.3, 2.8) - t * 0.5));
  float h = fbm(uv * 1.4 + 2.6 * r);

  // contour lines of the height field — each contour its own hue, cycling
  // like the layered colour bands of the floor pieces.
  float bands = h * 16.0;
  float e = 0.5 - abs(fract(bands) - 0.5);           // distance to nearest contour (band units)
  float line = 1.0 - smoothstep(0.015, 0.075, e);
  float idx = floor(bands + 0.5);
  vec3 hue = 0.55 + 0.45 * cos(6.28318 * (idx * 0.137 + vec3(0.0, 0.33, 0.67) + t * 0.05));
  hue = mix(hue, vec3(0.93, 0.91, 0.88), 0.18);

  vec3 base = vec3(0.012, 0.012, 0.016) + vec3(0.02, 0.03, 0.04) * smoothstep(0.3, 0.9, h);
  vec3 col = base + hue * line * (0.55 + 0.45 * smoothstep(0.3, 0.8, h));

  // soft vignette; keep the centre slightly quieter so the name reads
  float vig = smoothstep(1.35, 0.3, length(uv * vec2(0.85, 1.05)));
  col *= 0.45 + 0.55 * vig;
  float hush = smoothstep(0.05, 0.6, length(uv * vec2(0.6, 1.4)));
  col *= 0.4 + 0.6 * hush;

  gl_FragColor = vec4(col, 1.0);
}`;

  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vs = sh(gl.VERTEX_SHADER, vert), fs = sh(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) { canvas.style.background = '#07070a'; return; }
  const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uT = gl.getUniformLocation(prog, 'uT');
  const uPtr = gl.getUniformLocation(prog, 'uPtr');
  const uPtrAmt = gl.getUniformLocation(prog, 'uPtrAmt');

  let w = 0, h = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = Math.floor(canvas.clientWidth * dpr); h = Math.floor(canvas.clientHeight * dpr);
    canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
  }
  window.addEventListener('resize', resize); resize();

  // pointer, eased
  let px = 0, py = 0, tx = 0, ty = 0, amt = 0, tAmt = 0;
  function setPtr(cx, cy) {
    const m = Math.min(canvas.clientWidth, canvas.clientHeight);
    tx = (cx - canvas.clientWidth / 2) / m; ty = -(cy - canvas.clientHeight / 2) / m; tAmt = 1;
  }
  window.addEventListener('pointermove', e => setPtr(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerleave', () => { tAmt = 0; });
  window.addEventListener('touchend', () => { tAmt = 0; });

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now() - 40000; // start mid-flow, not from a blank seed
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });

  function frame(now) {
    px += (tx - px) * 0.04; py += (ty - py) * 0.04; amt += (tAmt - amt) * 0.03;
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.uniform2f(uPtr, px, py);
    gl.uniform1f(uPtrAmt, amt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (running && !reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
