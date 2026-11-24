/* BROWN ENSEMBLE — web version.
   Every mark is cut from 600 dpi scans of Bob Brown's 1450–1950 (1929) and
   traced as a filled outline, an "atom". A small ensemble of performers moves
   across the page. On the web the atoms are joined back into the passages they
   were cut from (a line, a stanza, a drawing with its words). Each performer
   holds one passage and morphs into another: often the one that follows it in
   the poem, otherwise a relative, chosen first from the same page of the book
   and then by a similarity map of the marks themselves (kinship).

   Ported from the native app (Performer / Ensemble / MotionStyle / Grammar)
   by way of its browser port. No headband on the web, so the grammar reads
   the hand: movement stands in for arousal, a slow simulated breath sets the
   tempo, and a click or tap calls the nearest figure forward. */
(() => {
  'use strict';

  const canvas = document.querySelector('canvas.stage');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  const STILL = location.hash === '#still';     // thumbnail: one settled frame, then stop
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const DATA = 'be/', VER = '?v=6';

  // ── Tuning: Eamon's web lock of Oct 21, with fewer and smaller figures for a full-screen page ──────────────────────────────
  const S = {
    count: 7, speed: 0.25, size: 0.6, tempo: 4.3, hold: 6, range: 2.5,
    inkFade: 0.3, tone: 0.5, veil: 0.1, excursion: 29.6, surge: 0.2,
    encDist: 0.2, encCool: 16.5, spacing: 1.3, read: 1, attract: 0.6,
  };
  const TAU_KIN = 0.04, MEMORY = 12;            // kinship temperature, atoms each performer avoids repeating
  const PAPER = '#f6f3e9';                      // the app's paper and ink
  const INK = [13, 11, 9], FAR = [176, 168, 156];     // black ink to a pale warm wash

  const ss = t => { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (t * 6 - 15) + 10); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ── Atom library ───────────────────────────────────────────────────
  // Chunks of polylines: int16 start point, int8 steps, 0.02 units each.
  // Atoms are normalised so the longer side spans −80…+80 units.
  let IDX = null, loaded = 0, KIN = null;
  const atoms = [];        // { subs: [Float32Array xy…], a: aspect, path: Path2D|null, rings: null }

  function parseChunk(buf) {
    const dv = new DataView(buf), q = IDX.q;
    let o = 0;
    while (o < buf.byteLength) {
      const nSub = dv.getUint16(o, true); o += 2;
      const subs = [];
      for (let s = 0; s < nSub; s++) {
        const n = dv.getUint16(o, true); let x = dv.getInt16(o + 2, true), y = dv.getInt16(o + 4, true); o += 6;
        const pts = new Float32Array(n * 2);
        pts[0] = x * q; pts[1] = y * q;
        for (let i = 1; i < n; i++) { x += dv.getInt8(o); y += dv.getInt8(o + 1); o += 2; pts[2 * i] = x * q; pts[2 * i + 1] = y * q; }
        subs.push(pts);
      }
      { const i = atoms.length; atoms.push({ subs, a: IDX.aspect[i], cls: IDX.cls[i], rows: IDX.rows[i], page: IDX.page[i], path: null, rings: null }); }
    }
    loaded = atoms.length;
  }
  function pathOf(at) {
    if (at.path) return at.path;
    const p = new Path2D();
    for (const s of at.subs) {
      p.moveTo(s[0], s[1]);
      for (let i = 2; i < s.length; i += 2) p.lineTo(s[i], s[i + 1]);
      p.closePath();
    }
    return (at.path = p);
  }

  // Each outline resampled to a ring of NPT points, for morphing.
  const NPT = 96, MAX_RINGS = 140;
  function ringsOf(at) {
    if (at.rings) return at.rings;
    const out = [];
    for (const s of at.subs) {
      const n = s.length / 2;
      const L = new Float32Array(n + 1);
      let area = 0, cx = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, dx = s[2 * j] - s[2 * i], dy = s[2 * j + 1] - s[2 * i + 1];
        L[i + 1] = L[i] + Math.hypot(dx, dy);
        area += s[2 * i] * s[2 * j + 1] - s[2 * j] * s[2 * i + 1];
        cx += s[2 * i];
      }
      const total = L[n];
      if (total <= 0) continue;
      const r = new Float32Array(NPT * 2);
      let k = 0;
      for (let i = 0; i < NPT; i++) {
        const t = total * i / NPT;
        while (k < n - 1 && L[k + 1] < t) k++;
        const j = (k + 1) % n, f = (t - L[k]) / Math.max(1e-6, L[k + 1] - L[k]);
        r[2 * i] = s[2 * k] + (s[2 * j] - s[2 * k]) * f;
        r[2 * i + 1] = s[2 * k + 1] + (s[2 * j + 1] - s[2 * k + 1]) * f;
      }
      let cy = 0; for (let i = 0; i < n; i++) cy += s[2 * i + 1];
      out.push({ pts: r, cx: cx / n, cy: cy / n, len: total, area });
    }
    if (out.length > MAX_RINGS) { out.sort((a, b) => b.len - a.len); out.length = MAX_RINGS; }
    // The largest outline is ink; outlines wound the other way are holes (the
    // counters of letters). Ink winds one way and holes the other, so a
    // non-zero fill gives ink minus holes at every stage of a morph.
    let big = out[0];
    for (const r of out) if (Math.abs(r.area) > Math.abs(big.area)) big = r;
    const sign = big && big.area < 0 ? -1 : 1;
    const flip = r => {
      const p = r.pts;
      for (let i = 0, j = NPT - 1; i < j; i++, j--) {
        const x = p[2 * i], y = p[2 * i + 1]; p[2 * i] = p[2 * j]; p[2 * i + 1] = p[2 * j + 1]; p[2 * j] = x; p[2 * j + 1] = y;
      }
    };
    const ink = [], holes = [];
    for (const r of out) {
      const hole = r.area * sign < 0;
      if ((r.area > 0) === hole) flip(r);   // ink counter-clockwise, holes clockwise
      (hole ? holes : ink).push(r);
    }
    ink.sort((a, b) => a.cx - b.cx); holes.sort((a, b) => a.cx - b.cx);   // paired left to right
    return (at.rings = { ink, holes });
  }

  // ── Kinship: softmax over similarity, steered by variety ───────────
  const sims = () => new Float32Array(loaded);
  function kinship(i, j) {
    if (!KIN || i < 0 || j < 0) return 0;
    const dim = IDX.dim, a = i * dim, b = j * dim;
    let d = 0;
    for (let k = 0; k < dim; k++) d += KIN[a + k] * KIN[b + k];
    return d / (IDX.kinScale * IDX.kinScale);
  }
  // `from` is the atom the choice is related to: the performer's own, or,
  // when it enters the page, one that another performer is holding.
  function pickAtom(p, variety, used, from) {
    const n = loaded;
    if (n < 2) return 0;
    const cur = from == null ? p.atom : from;
    const ok = i => i !== cur && i !== p.atom && !used.has(i) && !p.recent.includes(i);
    if (!KIN || cur == null || cur < 0) {
      for (let t = 0; t < 40; t++) { const i = Math.floor(Math.random() * n); if (ok(i)) return i; }
      return Math.floor(Math.random() * n);
    }
    const dim = IDX.dim, s2 = 1 / (IDX.kinScale * IDX.kinScale), steer = 1 - 2 * variety;
    const row = cur * dim, sc = sims(), page = atoms[cur].page;
    // keep drawings and writing in balance: whichever the page is short of is favoured
    let nd = 0, nl = 0;
    for (const q of perf) if (q !== p && !q.dormant && q.atom >= 0) { nl++; if (atoms[q.next != null ? q.next : q.atom].cls === 'd') nd++; }
    const wantD = nl ? (nd / nl < 0.42 ? 0.05 : nd / nl > 0.6 ? -0.05 : 0) : 0;
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!ok(i)) { sc[i] = -Infinity; continue; }
      let d = 0; const o = i * dim;
      for (let k = 0; k < dim; k++) d += KIN[row + k] * KIN[o + k];
      const v = steer * d * s2 + (atoms[i].page === page ? 0.06 : 0) + (atoms[i].cls === 'd' ? wantD : -wantD);   // marks from the same page of the book are family first
      sc[i] = v; if (v > best) best = v;
    }
    if (best === -Infinity) return Math.floor(Math.random() * n);
    let total = 0;
    for (let i = 0; i < n; i++) { sc[i] = sc[i] === -Infinity ? 0 : Math.exp((sc[i] - best) / TAU_KIN); total += sc[i]; }
    let r = Math.random() * total;
    for (let i = 0; i < n; i++) { r -= sc[i]; if (r <= 0) return i; }
    return n - 1;
  }

  // The passage that follows atom `i` on its page of the book, if it is loaded and free.
  function after(i, used) { const n = IDX.next[i]; return n != null && n >= 0 && n < loaded && !used.has(n) ? n : -1; }

  // ── Motion styles (MotionStyle.swift) ──────────────────────────────
  function drift() {}                              // depth is no longer steered by the style: see the current in step()
  function regen(p, tan) {
    const s = p.st;
    s.p1 = [rand(-1, 1), rand(-0.8, 0.8)];
    s.c1 = [s.p0[0] + tan[0], s.p0[1] + tan[1]];
    s.c2 = [s.p1[0] + rand(-0.5, 0.5), s.p1[1] + rand(-0.5, 0.5)];
    s.dur = rand(3.5, 6.5);
  }
  function kick(p) {
    const a = Math.floor(Math.random() * 12) * Math.PI / 6, v = rand(0.18, 0.35);
    p.st.vx = Math.cos(a) * v; p.st.vy = Math.sin(a) * v; p.st.beat = rand(0.6, 1.8);
  }
  const STYLES = {
    traverse: {
      enter(p) { const a = rand(0, 6.283), v = rand(0.12, 0.26); p.st = { vx: Math.cos(a) * v, vy: Math.sin(a) * v, turn: rand(-0.6, 0.6), dt: p.depth < 0.5 ? rand(0.6, 0.95) : rand(0.05, 0.4) }; },
      update(p, dt) {
        const c = Math.cos(p.st.turn * dt), n = Math.sin(p.st.turn * dt), vx = p.st.vx;   // a straight line that slowly curves
        p.st.vx = vx * c - p.st.vy * n; p.st.vy = vx * n + p.st.vy * c;
        p.x += p.st.vx * dt; p.y += p.st.vy * dt; drift(p, p.st.dt, dt, 0.18);
      },
    },
    orbital: {
      enter(p) { const v = rand(0.04, 0.1), a = rand(0, 6.283); p.st = { cx: rand(-0.4, 0.4), cy: rand(-0.3, 0.3), vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: rand(0.25, 0.55), w: rand(0.18, 0.45) * (Math.random() < 0.5 ? 1 : -1), ph: Math.atan2(p.y, p.x) }; },
      update(p, dt) {
        const s = p.st; s.cx += s.vx * dt; s.cy += s.vy * dt;
        if (Math.abs(s.cx) > 0.9) s.vx = -s.vx; if (Math.abs(s.cy) > 0.7) s.vy = -s.vy;
        s.ph += s.w * dt;
        const tx = s.cx + Math.cos(s.ph) * s.r, ty = s.cy + Math.sin(s.ph) * s.r * 0.7;
        p.x += (tx - p.x) * Math.min(1, dt * 0.6); p.y += (ty - p.y) * Math.min(1, dt * 0.6);
        drift(p, 0.5 + 0.4 * Math.sin(s.ph * 0.3), dt, 0.5);
      },
    },
    geologic: {
      enter(p) { const a = rand(0, 6.283), v = rand(0.012, 0.028); p.st = { vx: Math.cos(a) * v, vy: Math.sin(a) * v, dt: rand(0.1, 0.9), r: rand(0.02, 0.06) }; },
      update(p, dt) { p.x += p.st.vx * dt; p.y += p.st.vy * dt; drift(p, p.st.dt, dt, p.st.r); },
    },
    fluid: {
      enter(p) { p.st = { p0: [p.x, p.y], t: 0 }; regen(p, [0, 0]); },
      update(p, dt) {
        const s = p.st; s.t += dt / s.dur;
        if (s.t >= 1) { const tan = [s.p1[0] - s.c2[0], s.p1[1] - s.c2[1]]; s.p0 = s.p1; regen(p, tan); s.t = 0; }
        const t = s.t, m = 1 - t;
        const bz = i => m * m * m * s.p0[i] + 3 * m * m * t * s.c1[i] + 3 * m * t * t * s.c2[i] + t * t * t * s.p1[i];
        p.x += (bz(0) - p.x) * Math.min(1, dt * 4); p.y += (bz(1) - p.y) * Math.min(1, dt * 4);
      },
    },
    angular: {
      enter(p) { p.st = {}; kick(p); p.st.cx = p.st.vx; p.st.cy = p.st.vy; },
      update(p, dt) {
        p.st.beat -= dt; if (p.st.beat <= 0) kick(p);
        const e = Math.min(1, dt * 5);
        p.st.cx += (p.st.vx - p.st.cx) * e; p.st.cy += (p.st.vy - p.st.cy) * e;
        p.x += p.st.cx * dt; p.y += p.st.cy * dt;
      },
    },
  };
  const KINDS = ['fluid', 'fluid', 'orbital', 'traverse', 'geologic'];   // smooth styles only
  function setStyle(p, kind) {
    p.kind = kind || KINDS[Math.floor(Math.random() * KINDS.length)];
    STYLES[p.kind].enter(p);
    p.styleLeft = S.hold * rand(0.6, 1.6);
    // each phrase of movement has its own pace and its own slight tilt
    p.pace = rand(0.7, 1.5);
    p.tiltT = rand(-0.07, 0.07);
  }

  // ── Stage ──────────────────────────────────────────────────────────
  let W = 0, H = 0, REF = 1600, PX = 1;       // canvas pixels; REF = the "1600-wide" stage the tuning was made on
  function resize() {
    const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
    let dpr = Math.min(devicePixelRatio || 1, STILL ? 2 : 2.5);
    const cap = STILL ? 1.6e6 : 6e6;
    if (cw * ch * dpr * dpr > cap) dpr = Math.sqrt(cap / (cw * ch));
    const w = Math.max(2, Math.round(cw * dpr)), h = Math.max(2, Math.round(ch * dpr));
    if (w === W && h === H) return;
    W = w; H = h; PX = dpr;
    canvas.width = W; canvas.height = H;
    REF = Math.sqrt(W * H) * 4 / 3;
    if (STILL && stillDone) { drawFrame(); }
  }
  // Pixels per atom unit at mid depth.
  function baseScale(i, sizeMul) {
    const at = atoms[i], a = at.a;
    if (at.cls === 'p') {
      const line = 0.05 * REF * S.size * sizeMul;                    // height of one line of writing at mid depth
      let h = at.rows * line * 1.2, w = h * a;
      const k = Math.min(1, W * 0.9 / w, H * 0.62 / h);              // a long line or a tall stanza still fits the page
      w *= k; h *= k;
      return Math.max(w, h) / 160;
    }
    let w = 405 / 1600 * REF * S.size * sizeMul * (a > 1 ? Math.sqrt(a) : 1);
    if (a > 1) w = Math.min(w, W * 0.92);
    return w / 160;
  }
  const depthScale = z => Math.min(8, Math.pow(2, (0.5 - z) * S.range * 1.5));

  // ── Performers ─────────────────────────────────────────────────────
  let perf = [];
  const inUse = () => { const u = new Set(); for (const p of perf) { if (p.dormant) continue; u.add(p.atom); if (p.next != null) u.add(p.next); } return u; };
  const needRead = i => S.read * (atoms[i].cls === 'p' ? 1.3 + 1.15 * atoms[i].rows + 0.12 * Math.min(atoms[i].a, 8) : 1.8);   // time to read it
  const isRead = p => p.readT >= needRead(p.atom);

  function newPerformer(i, n) {
    const p = {
      i, x: rand(-0.8, 0.8), y: rand(-0.7, 0.7), depth: 0.42 + i / (n - 1 || 1) * 0.9, zv: rand(0.016, 0.03),
      atom: -1, next: null, k: 0, mdur: 1, pairs: null, recent: [],
      nextMorph: (0.3 + i * 0.17) * S.tempo, encCool: 0, dormant: 0, fadeIn: STILL ? 1 : 0, role: null, target: 0,
      black: true, bias: 0, wash: 0, readT: 0, legible: false, hw: 0.3, hh: 0.2,
      h: 0, fvx: 0, fvy: 0, offx: 0, offy: 0, seen: false, sx: null, sy: null,
      pace: 1, clock: rand(0, 20), pw: rand(0.25, 0.7), burst: 0, nextBurst: rand(3, 12), tilt: 0, tiltT: 0, lean: 0,
    };
    p.atom = pickAtom(p, 0.5, inUse());
    inkWeight(p);
    setStyle(p);
    return p;
  }
  // Most figures are solid black ink, like the drawings in the book. The rest
  // are lighter layers: washes of different greys, partly see-through.
  function inkWeight(p) {
    p.black = Math.random() < 0.58;
    p.bias = p.black ? 0 : rand(0.12, 0.85);       // how grey
    p.wash = p.black ? 0 : rand(0.15, 0.6);        // how see-through
  }
  function remember(p, i) { p.recent.push(i); if (p.recent.length > MEMORY) p.recent.shift(); }

  function startMorph(p, to, dur) {
    if (p.next != null || to == null || to === p.atom) return;
    p.next = to; p.k = 0; p.mdur = dur || 1.1;
    const A = ringsOf(atoms[p.atom]), B = ringsOf(atoms[to]);
    const sa = baseScale(p.atom, 1), sb = baseScale(to, 1);
    const pairs = [];
    const point = (r, s) => { const p = new Float32Array(NPT * 2); for (let j = 0; j < NPT; j++) { p[2 * j] = r.cx * s; p[2 * j + 1] = r.cy * s; } return p; };
    const scaled = (r, s) => { const p = new Float32Array(NPT * 2); for (let j = 0; j < NPT * 2; j++) p[j] = r.pts[j] * s; return p; };
    // ink to ink: the shorter side repeats its outlines
    const n = Math.max(A.ink.length, B.ink.length);
    const list = [];
    for (let i = 0; i < n; i++) list.push([A.ink[Math.floor(i * A.ink.length / n)], B.ink[Math.floor(i * B.ink.length / n)]]);
    // hole to hole; a hole with no partner opens from, or closes to, a point
    const nh = Math.max(A.holes.length, B.holes.length), mh = Math.min(A.holes.length, B.holes.length);
    for (let i = 0; i < nh; i++) list.push([i < A.holes.length ? A.holes[i] : null, i < B.holes.length ? B.holes[i] : null, i >= mh]);
    for (const [a, b] of list) {
      if (!a && !b) continue;
      if (!a) { pairs.push([point(b, sb), scaled(b, sb)]); continue; }
      if (!b) { pairs.push([scaled(a, sa), point(a, sa)]); continue; }
      const pa = scaled(a, sa), pr = new Float32Array(NPT * 2);
      // start points aligned by a coarse search
      let best = 0, bd = Infinity;
      for (let o = 0; o < NPT; o += 4) {
        let d = 0;
        for (let j = 0; j < NPT; j += 8) { const q = (j + o) % NPT, dx = pa[2 * j] - b.pts[2 * q] * sb, dy = pa[2 * j + 1] - b.pts[2 * q + 1] * sb; d += dx * dx + dy * dy; }
        if (d < bd) { bd = d; best = o; }
      }
      for (let j = 0; j < NPT; j++) { const q = (j + best) % NPT; pr[2 * j] = b.pts[2 * q] * sb; pr[2 * j + 1] = b.pts[2 * q + 1] * sb; }
      pairs.push([pa, pr]);
    }
    p.pairs = pairs;
  }
  function finishMorph(p) {
    remember(p, p.atom);
    p.atom = p.next; p.next = null; p.k = 0; p.readT = 0; p.pairs = null;
  }
  function respawn(p) {
    p.x = rand(-0.75, 0.75); p.y = rand(-0.65, 0.65);
    p.depth = rand(1.05, 1.3); p.zv = rand(0.016, 0.03); p.role = null;
    inkWeight(p);                             // each entrance has its own weight of ink
    if (p.next != null) finishMorph(p);
    remember(p, p.atom);
    // enter holding a relative of something already on the page
    const on = perf.filter(q => q !== p && !q.dormant && q.atom >= 0 && Math.abs(q.x) < 1.1 && Math.abs(q.y) < 1.1);
    const host = on.length ? on[Math.floor(Math.random() * on.length)] : null;
    const hostAtom = host ? (host.next != null ? host.next : host.atom) : -1;
    const follow = host && Math.random() < 0.4 ? after(hostAtom, inUse()) : -1;      // the poem carries on in another hand
    p.atom = follow >= 0 ? follow : host ? pickAtom(p, 0.12, inUse(), hostAtom) : pickAtom(p, G.variety, inUse());
    p.fadeIn = 0; p.readT = 0; p.offx = 0; p.offy = 0; p.h = 0; p.seen = false; p.sx = null; p.fvx = p.fvy = 0;
    setStyle(p);
  }
  function syncCount() {
    const narrow = Math.min(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight) < 560;
    const n = Math.min(narrow ? 7 : S.count, Math.max(2, loaded - 1));
    while (perf.length < n) perf.push(newPerformer(perf.length, n));
    perf.length = Math.min(perf.length, n);
  }

  // ── Depth director and encounters (Ensemble.swift) ─────────────────
  let nextExcursion = 8;
  function surge(p) { p.role = 'surge'; p.target = -0.3; }
  function director(dt) {
    nextExcursion -= dt; if (nextExcursion > 0) return;
    nextExcursion = S.excursion * rand(0.75, 1.25);
    const mid = perf.filter(p => !p.role && p.depth > 0.1 && p.depth < 0.7 && p.next == null && !p.dormant && isRead(p));
    if (!mid.length) { nextExcursion = 2.5; return; }
    const a = mid[Math.floor(Math.random() * mid.length)]; surge(a);
    if (Math.random() < 0.5) {
      const rest = perf.filter(p => p !== a && !p.role && !p.dormant && isRead(p));
      if (rest.length) { const b = rest[Math.floor(Math.random() * rest.length)]; b.role = 'recede'; b.target = rand(0.85, 1.05); }
    }
  }
  function encounters() {
    for (let i = 0; i < perf.length; i++) for (let j = i + 1; j < perf.length; j++) {
      const a = perf[i], b = perf[j];
      if (a.dormant || b.dormant || a.encCool > 0 || b.encCool > 0 || a.next != null || b.next != null || a.role === 'surge' || b.role === 'surge' || !isRead(a) || !isRead(b)) continue;
      if (Math.abs(a.x) > 1 || Math.abs(a.y) > 1 || Math.abs(b.x) > 1 || Math.abs(b.y) > 1) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) < S.encDist && Math.abs(a.depth - b.depth) < 0.3) {
        // the deeper one takes the other's form; the other leaves
        const absorber = a.depth >= b.depth ? a : b, leaving = absorber === a ? b : a;
        startMorph(absorber, leaving.atom, 2.0);
        leaving.dormant = 0.9;
        const deep = a.depth > 0.75 && b.depth > 0.75;
        absorber.encCool = S.encCool * (deep ? 1.8 : 1); leaving.encCool = S.encCool;
      }
    }
  }

  // ── Signals, read from the hand, and the grammar (Vigilance) ───────
  const P = { x: 0.5, y: 0.5, lastX: 0, lastY: 0, lastT: 0, lastMove: -1, raw: 0, speed: 0, activity: 0, breathT: 0 };
  const G = { variety: 0.3, size: 1, ink: 0.94, tempo: S.tempo };
  function signals(dt, now) {
    const moving = P.lastMove > 0 && now - P.lastMove < 0.09;
    const spT = moving ? P.raw : 0;
    P.speed += (spT - P.speed) * (1 - Math.exp(-dt / (spT > P.speed ? 0.03 : 0.28)));
    const actT = clamp(P.speed * 1.6, 0, 1);
    P.activity += (actT - P.activity) * (1 - Math.exp(-dt / (actT > P.activity ? 2.2 : 8)));
    P.breathT += dt;
    const breath = 0.5 + 0.5 * Math.sin(P.breathT * 2 * Math.PI / 10.9);   // about 5.5 breaths a minute
    const a = P.activity;
    G.variety = clamp(0.3 + 0.5 * a, 0, 1);       // stillness keeps to kin; movement reaches for strangers
    G.size = 1 + 0.2 * a;
    G.ink = clamp(0.88 + 0.12 * a, 0, 1);
    G.tempo = clamp(S.tempo - 1.0 * breath, 0.4, 8);
  }
  function onMove(e) {
    const r = canvas.getBoundingClientRect(), now = performance.now() / 1000;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (P.lastT) {
      const dt = Math.max(now - P.lastT, 1 / 240);
      P.raw = Math.min(Math.hypot(px - P.lastX, py - P.lastY) / dt, 1500) / 1500;
    }
    P.lastX = px; P.lastY = py; P.lastT = now; P.lastMove = now;
    P.x = px / r.width; P.y = py / r.height;
  }
  if (!STILL) {
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', e => {
      P.lastT = 0; onMove(e);
      // a click or tap calls the nearest figure forward
      const tx = P.x * 2 - 1, ty = P.y * 2 - 1;
      let best = null, bd = Infinity;
      for (const p of perf) {
        if (p.dormant || p.role || p.next != null || p.fadeIn < 0.9) continue;
        const d = Math.hypot(p.x + p.offx - tx, p.y + p.offy - ty);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) surge(best);
    });
    canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') P.lastT = 0; });
    canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
  }

  // How alike the marks two performers hold are, 0…1, refreshed a few times a second.
  let kinT = 0;
  function updateKin(raw) {
    kinT -= raw; if (kinT > 0) return; kinT = 0.4;
    for (const p of perf) p.kin = p.kin || new Map();
    for (let i = 0; i < perf.length; i++) for (let j = i + 1; j < perf.length; j++) {
      const a = perf[i], b = perf[j];
      const k = (a.dormant || b.dormant) ? 0 : clamp((kinship(a.atom, b.atom) - 0.66) / 0.24, 0, 1);
      a.kin.set(b, k); b.kin.set(a, k);
    }
    // each performer is drawn only to its closest relative on the page
    for (const p of perf) {
      p.mate = null; let best = 0.05;
      for (const [q, k] of p.kin) if (k > best && perf.includes(q) && !q.dormant) { best = k; p.mate = q; }
    }
  }

  // ── Step ───────────────────────────────────────────────────────────
  function step(raw) {
    const dt = raw * S.speed;                   // one clock for travel
    director(dt);
    updateKin(raw);
    for (const p of perf) {
      if (p.encCool > 0) p.encCool -= dt;
      if (p.dormant > 0) { p.dormant -= raw * 0.6; if (p.dormant <= 0) { p.dormant = 0; respawn(p); } continue; }
      p.styleLeft -= dt; if (p.styleLeft <= 0) setStyle(p);
      if (p.legible && p.next == null) p.readT += raw;
      const waiting = p.next == null && !isRead(p) && p.fadeIn > 0.9;
      // a mark that has not been read yet slows and holds, eased
      const hT = waiting ? (p.legible ? 1 : 0.55) : 0;
      p.h += (hT - p.h) * Math.min(1, raw * 1.2);
      const damp = (p.role === 'surge' ? 0.35 : 1) * (1 - 0.4 * p.h);
      // liveliness: an uneven pace, with a short dart now and then
      p.clock += raw;
      const live = p.pace * (1 + 0.22 * Math.sin(p.clock * p.pw));
      const ox = p.x;
      STYLES[p.kind].update(p, dt * damp * live);
      // the current: every mark comes forward out of the page, slowing while it is being read,
      // quickening once it has been, until it passes through the screen
      if (!p.role) p.depth -= p.zv * raw * (waiting ? 1 - 0.85 * p.h : p.depth < 0.36 ? 7 : p.depth < 0.7 ? 2.2 : 1);

      // neighbours keep a little distance, unless their marks are alike:
      // kin drift toward each other, so meetings happen between related marks
      let fx = 0, fy = 0;
      for (const q of perf) {
        if (q === p || q.dormant) continue;
        const kin = (p.kin && p.kin.get(q)) || 0;
        const dx = p.x - q.x, dy = (p.y - q.y) * 1.6, d = Math.hypot(dx, dy) + 1e-3, R = (p.black && q.black ? 0.62 : 0.4) + (p.hw + q.hw) * 0.55;   // solid blacks give each other more room
        const near = Math.max(0, 1 - Math.abs(p.depth - q.depth) / 0.3);
        if (d < R && near > 0) { const f = near * S.spacing * (q === p.mate || q.mate === p ? 1 - kin : 1) * (p.black && q.black ? 1.8 : 1) * ss((R - d) / R) * 0.8; fx += dx / d * f; fy += dy / d * f / 1.6; }
        if (q === p.mate && Math.abs(q.x) < 1.1 && Math.abs(q.y) < 1.1) {
          const ax = q.x - p.x, ay = q.y - p.y, ad = Math.hypot(ax, ay) + 1e-3, f = S.attract * kin * Math.min(ad, 0.7);
          fx += ax / ad * f; fy += ay / ad * f;
          if (!p.role && !q.role) p.depth += (q.depth - p.depth) * kin * dt * 0.5;
        }
      }
      if (waiting && !p.seen) { fx -= p.x * 0.32; fy -= p.y * 0.32; }   // a mark still entering is drawn gently on-page
      const kv = Math.min(1, dt * 2.2);
      p.fvx += (fx - p.fvx) * kv; p.fvy += (fy - p.fvy) * kv;
      p.x += p.fvx * dt; p.y += p.fvy * dt;
      if (!isFinite(p.x) || !isFinite(p.y)) { respawn(p); continue; }
      // a mark leans a little into its travel and settles to its own tilt
      p.lean += (clamp((p.x - ox) / Math.max(raw, 1e-3) * 0.6, -0.06, 0.06) - p.lean) * Math.min(1, raw * 0.9);
      p.tilt += (p.tiltT - p.tilt) * Math.min(1, raw * 0.5);

      if (p.role) {
        p.depth += (p.target - p.depth) * dt * (p.role === 'surge' ? 0.55 : 0.25);
        if (p.role === 'surge' && p.depth <= p.target + 0.03) p.role = null;
        if (p.role === 'recede' && Math.abs(p.depth - p.target) < 0.03) p.role = null;
      }
      // keep an unread mark whole on the page: a smoothed offset and an eased depth
      if (waiting && Math.abs(p.x) < 1 && Math.abs(p.y) < 1) p.seen = true;
      if (!waiting) p.seen = false;
      {
        let tx = 0, ty = 0;
        if (p.seen) {
          const ex = Math.abs(p.x) + p.hw - 0.95, ey = Math.abs(p.y) + p.hh - 0.93;
          if (ex > 0) tx = -Math.sign(p.x) * ex; if (ey > 0) ty = -Math.sign(p.y) * ey;
        }
        const kr = p.seen ? 0.9 : 0.35;
        p.offx += (tx - p.offx) * Math.min(1, raw * kr); p.offy += (ty - p.offy) * Math.min(1, raw * kr);
      }
      if (waiting && !p.role) {
        const w0 = baseScale(p.atom, G.size) * 160 * Math.min(1, atoms[p.atom].a), h0 = w0 / atoms[p.atom].a, k = Math.max(0.01, S.range * 1.5);
        const zFit = 0.5 - Math.log2(Math.min(W * 0.875 / w0, H * 0.87 / h0)) / k;
        const zBig = 0.5 - Math.log2(Math.max(1e-3, 24 * PX * (atoms[p.atom].cls === 'p' ? atoms[p.atom].rows : 1) / h0)) / k;
        const lo = Math.max(0.38, zFit), hi = Math.max(lo + 0.05, Math.min(0.66, zBig));
        p.depth += (clamp(p.depth, lo, hi) - p.depth) * Math.min(1, raw * 0.45 * p.h);
      }
      if (Math.abs(p.x + p.offx) > 1.6 || Math.abs(p.y + p.offy) > 1.6 || p.depth < -0.27) { respawn(p); continue; }
      p.fadeIn = Math.min(1, p.fadeIn + dt * 0.8);

      // morph scheduling: its own clock, in real seconds
      p.nextMorph -= raw;
      if (p.nextMorph <= 0) {
        if (p.next == null && (!isRead(p) || p.role)) p.nextMorph = 0.25;
        else { p.nextMorph = G.tempo * rand(0.45, 1.0); if (p.next == null) {
          const used = inUse(), on = Math.random() < 0.65 ? after(p.atom, used) : -1;      // a passage turns into the one after it
          startMorph(p, on >= 0 ? on : pickAtom(p, G.variety, used), rand(1.7, 2.4));
        } }
      }
      if (p.next != null) { p.k += raw / (p.mdur * 2.6); if (p.k >= 1) finishMorph(p); }
    }
    encounters();
  }

  // ── Draw ───────────────────────────────────────────────────────────
  let lastRaw = 1 / 60;
  const KJ = new Float32Array(NPT);
  function place(s, X, Y, rot) { const c = Math.cos(rot) * s, n = Math.sin(rot) * s; ctx.setTransform(c, n, -n, c, X, Y); }
  function fillAtom(i, X, Y, s, alpha, rot) {
    if (alpha <= 0.004) return;
    ctx.globalAlpha = alpha;
    place(s, X, Y, rot);
    ctx.fill(pathOf(atoms[i]), 'evenodd');
  }
  function drawFrame() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    const order = perf.slice().sort((a, b) => b.depth - a.depth);     // back to front
    for (const p of order) {
      if (p.atom < 0 || p.atom >= loaded) continue;
      const z = p.depth, ds = depthScale(z);
      const back = clamp((z + 0.2) / 1.3, 0, 1);                      // 0 front … 1 far back
      const far = ss((z - 0.68) / 0.45) * 0.8;                         // everything is pale far back and inks up as it arrives
      const tone = Math.max(far, p.black ? 0 : clamp(p.bias + back * S.tone * 0.4, 0, 0.9));   // back figures lighten toward the paper
      const ink = (p.black ? 1 - 0.35 * ss((z - 0.6) / 0.5) : G.ink * (1 - p.wash) * (1 - clamp(z, 0, 1.3) * S.inkFade))
        * (z >= 0.3 ? 1 : z <= -0.25 ? 0 : 1 - ss((0.3 - z) / 0.55))
        * (p.dormant > 0 ? Math.max(0, p.dormant / 0.9) : 1) * ss(p.fadeIn);
      const persp = clamp(1 + (0.5 - z) * 0.45, 0.75, 1.5);              // marks spread from the centre as they come forward
      let X = W / 2 + (p.x + p.offx) * W / 2 * persp, Y = H / 2 + (p.y + p.offy) * H / 2 * persp;
      {                                                               // smooth the drawn position
        const kf = 1 - Math.exp(-lastRaw / 0.14);
        if (p.sx == null || Math.hypot(X - p.sx, Y - p.sy) > REF * 0.16) { p.sx = X; p.sy = Y; }
        else { p.sx += (X - p.sx) * kf; p.sy += (Y - p.sy) * kf; }
        X = p.sx; Y = p.sy;
      }
      const a = atoms[p.atom].a, sA = baseScale(p.atom, G.size) * ds;
      const wpx = sA * 160 * Math.min(1, a), hpx = wpx / a;
      p.hw = wpx / W; p.hh = hpx / H;
      {
        const m = p.legible ? 24 * PX : 0, f = p.legible ? 0.06 : 0;  // once readable, stay readable unless clearly not
        p.legible = !p.dormant && ink > 0.2 - f && hpx / (atoms[p.atom].cls === 'p' ? atoms[p.atom].rows : 1) >= 22 * PX - m / 3
          && wpx <= W * 0.975 + m && hpx <= H * 0.98 + m
          && X - wpx / 2 >= -8 - m && X + wpx / 2 <= W + 8 + m && Y - hpx / 2 >= -8 - m && Y + hpx / 2 <= H + 8 + m;
      }
      const rot = p.tilt + p.lean;
      const c = INK.map((v, i) => Math.round(v + (FAR[i] - v) * tone));
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      if (p.next != null && p.pairs) {
        // real ink → outline morph → real ink
        const k = ss(p.k), inA = 1 - ss(p.k / 0.12), outB = ss((p.k - 0.88) / 0.12);
        fillAtom(p.atom, X, Y, sA, ink * inA, rot);
        fillAtom(p.next, X, Y, baseScale(p.next, G.size) * ds, ink * outB, rot);
        const am = ink * Math.min(1 - inA, 1 - outB);
        if (am > 0.004) {
          const s = ds * G.size;
          ctx.globalAlpha = am;
          place(s, X, Y, rot);
          ctx.beginPath();
          const um = clamp((p.k - 0.06) / 0.88, 0, 1), sw = p.clock * 0.35;
          for (let j = 0; j < NPT; j++) KJ[j] = ss(clamp(um * 1.7 - 0.7 * (0.5 + 0.5 * Math.sin(j * 6.2832 / NPT + sw)), 0, 1));
          let r = 0;
          for (const [pa, pb] of p.pairs) {
            const o = (r++ * 17) % NPT;                                   // each outline starts its sweep somewhere else
            let kk = KJ[o];
            ctx.moveTo(pa[0] + (pb[0] - pa[0]) * kk, pa[1] + (pb[1] - pa[1]) * kk);
            for (let j = 1; j < NPT; j++) { kk = KJ[(j + o) % NPT]; ctx.lineTo(pa[2 * j] + (pb[2 * j] - pa[2 * j]) * kk, pa[2 * j + 1] + (pb[2 * j + 1] - pa[2 * j + 1]) * kk); }
            ctx.closePath();
          }
          ctx.fill('nonzero');
        }
      } else fillAtom(p.atom, X, Y, sA, ink, rot);
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────
  let running = false, last = 0, stillDone = false;
  function frame(nowMs) {
    if (!running) return;
    requestAnimationFrame(frame);
    const raw = Math.min(0.05, (nowMs - last) / 1000) * (reduceMotion ? 0.5 : 1);
    last = nowMs; lastRaw = raw || 1 / 60;
    signals(raw, nowMs / 1000);
    syncCount();
    step(raw);
    drawFrame();
  }
  function start() {
    resize();
    syncCount();
    if (STILL) {
      // settle off-clock, then draw once and stop
      P.activity = 0.35; signals(0, 0);
      for (let i = 0; i < 700; i++) { lastRaw = 1 / 30; step(1 / 30); if (i % 20 === 0) drawFrame(); }
      for (const p of perf) p.sx = null;
      drawFrame(); stillDone = true;
      return;
    }
    running = true; last = performance.now();
    requestAnimationFrame(frame);
  }

  async function load() {
    IDX = await (await fetch(DATA + 'index.json' + VER)).json();
    const get = async f => (await fetch(DATA + f + VER)).arrayBuffer();
    parseChunk(await get(IDX.chunks[0].file));
    start();
    if (STILL) return;
    // the similarity map, then the rest of the book, arrive while it plays
    get('kin.bin').then(b => { KIN = new Int8Array(b); });
    for (let i = 1; i < IDX.chunks.length; i++) parseChunk(await get(IDX.chunks[i].file));
  }
  load().catch(e => { console.error('[brown-ensemble]', e); document.documentElement.classList.add('no-data'); });

  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (STILL) return;
    if (document.hidden) running = false;
    else if (loaded && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
  });
})();
