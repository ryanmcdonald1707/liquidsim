import * as G from './gl.js';
import * as geo from './geometry.js';
import * as S from './shaders.js';
import * as R from './rain-shaders.js';

const { mat4 } = G;

// ---------------------------------------------------------------------------
// Rain physics
//  Marshall-Palmer (1948) drop size distribution:  N(D) = N0 exp(-L D),
//    N0 = 8000 m^-3 mm^-1, L = 4.1 R^-0.21 mm^-1   (R = rain rate in mm/h)
//  Terminal velocity (Atlas et al. fit to Gunn & Kinzer 1949):
//    v(D) = 9.65 - 10.3 exp(-0.6 D) m/s  (D in mm)
const vTerm = (Dmm) => Math.max(0.3, 9.65 - 10.3 * Math.exp(-0.6 * Dmm));
function rainStats(Rmm) {
  const L = 4.1 * Math.pow(Rmm, -0.21), N0 = 8000;
  let flux = 0, fluxBig = 0, conc = 0;
  for (let D = 0.1; D < 7; D += 0.02) {
    const n = N0 * Math.exp(-L * D) * 0.02;
    conc += n; flux += n * vTerm(D);
    if (D > 1.2) fluxBig += n * vTerm(D);
  }
  const D0 = 3.67 / L;   // median volume diameter (mm)
  // visibility in rain (empirical, km)
  const vis = Math.min(20, 25 * Math.pow(Rmm, -0.63));
  return { L, flux, fluxBig, conc, D0, vis };
}
function sampleD(L) {
  // draw from exp(-L D) on [0.3, 6] mm
  const a = 0.3, b = 6, u = Math.random();
  return a - Math.log(1 - u * (1 - Math.exp(-L * (b - a)))) / L;
}

// ---------------------------------------------------------------------------
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
const status = document.getElementById('status');
function fail(msg) { status.textContent = msg; status.classList.add('err'); throw new Error(msg); }
if (!gl) fail('WebGL2 is not available in this browser.');
if (!gl.getExtension('EXT_color_buffer_float')) fail('This GPU cannot render to float textures (EXT_color_buffer_float).');
gl.getExtension('EXT_float_blend');

const DEF = {
  R_IN: 0.04, R_OUT: 0.045, INNER_BOTTOM: 0.0, INNER_TOP: 0.1, RIM_Y: 0.1, CUP_Y0: 0.0, SAUCER_R: 0.0, SAUCER_H: 0.0, MEN_H: 1.0, SURF_Y: 0.05,
  WIN_AZ: -0.72, WIN_EL0: 0.3, WIN_EL1: 0.82, WIN_AW: 0.3, WIN_E: 4.6, WIN_ELC: 0.56,
};
const fnum = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const HEAD = `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${Object.entries(DEF).map(([k, v]) => `#define ${k} ${fnum(v)}`).join('\n')}\n`;
const src = (s) => HEAD + S.common + R.rainCommon + s;

const P = {
  bg: G.program(gl, src(S.bgVS), src(R.bgFS)),
  ground: G.program(gl, src(R.groundVS), src(R.groundFS)),
  prop: G.program(gl, src(R.propVS), src(R.propFS)),
  streak: G.program(gl, src(R.streakVS), src(R.streakFS)),
  drop: G.program(gl, src(R.dropVS), src(R.dropFS)),
  window: G.program(gl, src(S.fsVS), src(R.windowFS)),
  bright: G.program(gl, src(S.fsVS), src(S.brightFS)),
  blur: G.program(gl, src(S.fsVS), src(S.blurFS)),
  composite: G.program(gl, src(S.fsVS), src(S.compositeFS)),
};

// ---------------------------------------------------------------------------
// Meshes
function cylinder(r, h, segs = 24) {
  const positions = [], normals = [], indices = [];
  for (let j = 0; j <= 1; j++) for (let s = 0; s <= segs; s++) {
    const th = s / segs * Math.PI * 2;
    positions.push(r * Math.cos(th), h * j, r * Math.sin(th));
    normals.push(Math.cos(th), 0, Math.sin(th));
  }
  for (let s = 0; s < segs; s++) { const a = s, b = s + segs + 1; indices.push(a, b, a + 1, a + 1, b, b + 1); }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices };
}
function groundGrid(size, n) {
  const positions = [], indices = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push((i / n - 0.5) * size, 0, (j / n - 0.5) * size);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
  return { positions: new Float32Array(positions), indices };
}
const meshes = {
  quad: G.mesh(gl, geo.quad()),
  ground: G.mesh(gl, groundGrid(120, 60)),
  pole: G.mesh(gl, cylinder(0.06, 4.6)),
};
{ const b = geo.box(-0.25, -0.06, -0.12, 0.25, 0.04, 0.12); meshes.head = G.mesh(gl, geo.withNormals(b.positions, b.indices)); }
const LAMPS = [[-3.2, 4.5, -2.5], [3.4, 4.5, -10], [-3.2, 4.5, -18]];

// ---------------------------------------------------------------------------
// Targets
const RGBA16F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
let quality = 1, W = 0, H = 0, msaa = null, hdr = null, bloomA, bloomB, bloomC, bloomD, sceneT, blurA, blurB, dropT;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (w === W && h === H) return;
  W = w; H = h; canvas.width = w; canvas.height = h;
  if (msaa) { gl.deleteFramebuffer(msaa.fbo); gl.deleteRenderbuffer(msaa.color); gl.deleteRenderbuffer(msaa.depth); }
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
  const color = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, color);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, w, h);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  msaa = { fbo, color, depth };
  for (const t of [hdr, bloomA, bloomB, bloomC, bloomD, sceneT, blurA, blurB, dropT]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
  hdr = G.target(gl, w, h, ...RGBA16F, gl.LINEAR);
  sceneT = G.target(gl, w, h, ...RGBA16F, gl.LINEAR);
  dropT = G.target(gl, w, h, ...RGBA16F, gl.LINEAR);
  const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  bloomA = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR); bloomB = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR);
  bloomC = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, gl.LINEAR); bloomD = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, gl.LINEAR);
  blurA = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR); blurB = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR);
}
function pass(prog, dst, u) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
  gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
  G.use(gl, prog, u);
  meshes.quad.draw();
}

// ---------------------------------------------------------------------------
// State
const sim = {
  scene: 'street', ground: 0, light: 2, rain: 12, wind: 2, puddle: 0.55,
  wet: 0.8, time: 0, stats: rainStats(12),
};
const cam = { az: 0.0, el: 0.28, dist: 3.6, target: [0, 0.6, -2.5] };
let camM = null;
function cameraMatrices() {
  let eye, t;
  if (sim.scene === 'window') { eye = [0, 3.2, 7]; t = [0, 1.2, -8]; }
  else {
    t = cam.target;
    const ce = Math.cos(cam.el);
    eye = [t[0] + cam.dist * Math.sin(cam.az) * ce, t[1] + cam.dist * Math.sin(cam.el), t[2] + cam.dist * Math.cos(cam.az) * ce];
    eye[1] = Math.max(eye[1], 0.15);
  }
  const view = mat4.lookAt(eye, t, [0, 1, 0]);
  const proj = mat4.perspective((sim.scene === 'window' ? 42 : 55) * Math.PI / 180, W / H, 0.05, 300);
  const vp = mat4.mul(proj, view);
  return { eye, view, vp, inv: mat4.invert(vp) };
}

// ---------------------------------------------------------------------------
// Falling rain and splashes (CPU particles, uploaded each frame)
const MAXP = 128 * 64;
const pData = new Float32Array(MAXP * 4), vData = new Float32Array(MAXP * 4);
const pTex = G.texture(gl, 128, 64, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
const vTex = G.texture(gl, 128, 64, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
const NRAIN = 6000;
const rain = [], splash = [];
const BOX = 9; // rendered rain within this horizontal radius of the camera target
function spawnDrop(d, top) {
  const c = cameraMatrices ? (camM ? camM.eye : [0, 1, 3]) : [0, 1, 3];
  d.D = sampleD(sim.stats.L);
  d.v = vTerm(d.D);
  // bias towards the camera: that is where streaks are visible
  const r = BOX * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
  d.p = [c[0] + r * Math.cos(a), top ? 7 + Math.random() * 2 : Math.random() * 8, c[2] - 1 + r * Math.sin(a) * 1.2 - 2];
}
for (let i = 0; i < NRAIN; i++) { const d = {}; spawnDrop(d, false); rain.push(d); }
function stepParticles(dt) {
  const active = Math.min(NRAIN, Math.round(NRAIN * Math.min(1, Math.pow(sim.rain / 30, 0.6))));
  const wind = sim.wind;
  for (let i = 0; i < active; i++) {
    const d = rain[i];
    d.p[0] += wind * 0.8 * dt; d.p[1] -= d.v * dt;
    if (d.p[1] <= 0) {
      // impact: splash a crown of fine droplets (near the camera only)
      if (splash.length < 1500 && Math.random() < 0.6 && sim.scene === 'street') {
        const n = 2 + Math.floor(d.D * 2.5 * Math.random());
        for (let k = 0; k < n; k++) {
          const a = Math.random() * Math.PI * 2, s = (0.3 + Math.random()) * Math.min(1.6, d.v * 0.18);
          splash.push({ p: [d.p[0], 0.002, d.p[2]], vel: [Math.cos(a) * s, (0.4 + Math.random() * 0.9) * Math.min(1.8, d.v * 0.2), Math.sin(a) * s], D: d.D * (0.12 + 0.2 * Math.random()) });
        }
      }
      spawnDrop(d, true);
    }
  }
  for (let i = splash.length - 1; i >= 0; i--) {
    const s = splash[i];
    s.vel[1] -= 9.81 * dt;
    s.p[0] += s.vel[0] * dt; s.p[1] += s.vel[1] * dt; s.p[2] += s.vel[2] * dt;
    if (s.p[1] < 0) splash.splice(i, 1);
  }
  // upload
  let n = 0;
  for (let i = 0; i < active && n < MAXP; i++, n++) {
    const d = rain[i];
    pData.set([d.p[0], d.p[1], d.p[2], d.D * 0.001], n * 4);
    vData.set([wind * 0.8, -d.v, 0, 0], n * 4);
  }
  for (const s of splash) { if (n >= MAXP) break; pData.set([...s.p, s.D * 0.001], n * 4); vData.set([...s.vel, 0], n * 4); n++; }
  for (let i = n; i < MAXP; i++) pData[i * 4 + 3] = 0;
  gl.bindTexture(gl.TEXTURE_2D, pTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 64, gl.RGBA, gl.FLOAT, pData);
  gl.bindTexture(gl.TEXTURE_2D, vTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 64, gl.RGBA, gl.FLOAT, vData);
  return n;
}

// ---------------------------------------------------------------------------
// Drops on the window glass. A drop is pinned by contact-angle hysteresis
// until gravity on it beats the pinning force (~2.5 mm radius on glass),
// then slides in jerky zig-zags, eats the droplets in its path and leaves a
// trail of small beads. Units: device pixels; mmPx converts.
const glass = { drops: [], acc: 0 };
const MAXG = 128 * 32;
const gData = new Float32Array(MAXG * 4);
const gTex = G.texture(gl, 128, 32, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
const mmPx = () => 180 / Math.max(W, 1); // the view spans ~18 cm of glass
function addDrop(x, y, r) { if (glass.drops.length < MAXG) glass.drops.push({ x, y, r, vy: 0, vx: 0, trail: 0, still: Math.random() * 2 }); }
function stepGlass(dt) {
  const px = 1 / mmPx();
  const st = sim.stats;
  // impacts: horizontal wind drives rain onto a vertical pane
  const hits = sim.rain > 0 ? (st.flux * (0.15 + sim.wind * 0.25)) * (W * mmPx() * H * mmPx() * 1e-6) * dt * 0.12 : 0;
  glass.acc += hits;
  while (glass.acc > 1) {
    glass.acc -= 1;
    const D = sampleD(st.L) * (0.5 + Math.random());
    addDrop(Math.random() * W, Math.random() * H, (D * 0.5 * 1.6) * px); // spreads a little on impact
  }
  // fine mist beads
  if (sim.rain > 0 && glass.drops.length < MAXG * 0.7 && Math.random() < dt * 30) addDrop(Math.random() * W, Math.random() * H, (0.15 + Math.random() * 0.3) * px);

  const rSlide = 2.0 * px;
  // spatial hash for merging
  const cell = Math.max(8, 7 * px), grid = new Map();
  const key = (x, y) => (Math.floor(x / cell) * 73856093) ^ (Math.floor(y / cell) * 19349663);
  for (const d of glass.drops) {
    const k = key(d.x, d.y); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(d);
  }
  const trails = [];
  for (const d of glass.drops) {
    if (d.dead) continue;
    if (d.r > rSlide) {
      // driving force ~ volume (r^3) against pinning ~ contact line (r)
      const drive = (d.r * d.r) / (rSlide * rSlide) - 1;
      d.still -= dt;
      if (d.still < 0) {
        d.vy = Math.min(d.vy + 900 * drive * dt, 60 * px * Math.sqrt(drive + 0.2));
        if (Math.random() < dt * 2.5) { d.still = Math.random() * 0.25; d.vy *= 0.2; } // snag on a dirt speck
        d.vx += (Math.random() - 0.5) * 400 * dt;
        d.vx *= Math.exp(-dt * 6);
      }
      const dy = d.vy * dt, dx = d.vx * dt;
      d.y += dy; d.x += dx + sim.wind * 3 * dt;
      // leave a trail of small beads
      d.trail += Math.abs(dy);
      if (d.trail > d.r * 0.9 && d.vy > 0) {
        d.trail = 0;
        if (Math.random() < 0.75) {
          const tr = d.r * (0.18 + 0.2 * Math.random());
          trails.push({ x: d.x + (Math.random() - 0.5) * d.r * 0.4, y: d.y - d.r * 1.3, r: tr, vy: 0, vx: 0, trail: 0, still: 5 });
          d.r = Math.sqrt(Math.max(d.r * d.r - tr * tr, 0));
        }
      }
    } else if (sim.rain <= 0) {
      d.r -= dt * 0.02 * px; // slow evaporation once the rain stops
      if (d.r < 0.08 * px) d.dead = true;
    }
    // merge with neighbours
    const cx = Math.floor(d.x / cell), cy = Math.floor(d.y / cell);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const a = grid.get(((cx + i) * 73856093) ^ ((cy + j) * 19349663));
      if (!a) continue;
      for (const o of a) {
        if (o === d || o.dead || d.dead) continue;
        const dd = Math.hypot(o.x - d.x, o.y - d.y);
        if (dd < (d.r + o.r) * 0.8) {
          const big = d.r >= o.r ? d : o, small = big === d ? o : d;
          big.x = (big.x * big.r * big.r + small.x * small.r * small.r) / (big.r * big.r + small.r * small.r);
          big.r = Math.sqrt(big.r * big.r + small.r * small.r);
          small.dead = true;
        }
      }
    }
  }
  glass.drops = glass.drops.filter((d) => !d.dead && d.y < H + 60).concat(trails);
  if (glass.drops.length > MAXG) glass.drops.length = MAXG;
  let n = 0;
  for (const d of glass.drops) {
    const elong = d.r > rSlide && d.vy > 1 ? Math.min(1.2, d.vy / (40 * px)) : 0;
    gData.set([d.x, d.y, d.r, elong], n * 4); n++;
  }
  for (let i = n; i < MAXG; i++) gData[i * 4 + 2] = 0;
  gl.bindTexture(gl.TEXTURE_2D, gTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 32, gl.RGBA, gl.FLOAT, gData);
  return n;
}
function wipe(x, y, r) { for (const d of glass.drops) if (Math.hypot(d.x - x, d.y - y) < r + d.r) d.dead = true; glass.drops = glass.drops.filter((d) => !d.dead); }

// ---------------------------------------------------------------------------
// Input
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; if (sim.scene === 'window') wipeAt(e); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (sim.scene === 'window') wipeAt(e);
  else {
    cam.az -= (e.clientX - drag.x) * 0.005;
    cam.el = Math.min(1.2, Math.max(0.03, cam.el + (e.clientY - drag.y) * 0.004));
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
function wipeAt(e) {
  const r = canvas.getBoundingClientRect(), s = W / r.width;
  wipe((e.clientX - r.left) * s, (e.clientY - r.top) * s, 38 * s);
}
const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(12, Math.max(1.2, cam.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

// ---------------------------------------------------------------------------
// UI
const $ = (id) => document.getElementById(id);
function chipRow(el, items, get, set) {
  el.innerHTML = '';
  for (const [k, name] of items) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = name; b.dataset.key = k;
    b.addEventListener('click', () => { set(k); sync(); });
    el.appendChild(b);
  }
  el._get = get;
}
function sync() {
  for (const el of [$('scene'), $('groundSel'), $('lightSel')]) for (const b of el.children) b.classList.toggle('on', String(el._get()) === b.dataset.key);
  $('hint').textContent = sim.scene === 'window' ? 'Drag to wipe the glass' : 'Drag to look around, scroll to move';
}
chipRow($('scene'), [['street', 'Street'], ['window', 'Window']], () => sim.scene, (k) => { sim.scene = k; });
chipRow($('groundSel'), [['0', 'Asphalt'], ['1', 'Cobblestones']], () => sim.ground, (k) => { sim.ground = +k; });
chipRow($('lightSel'), [['0', 'Overcast day'], ['1', 'Dusk'], ['2', 'Night']], () => sim.light, (k) => { sim.light = +k; });
const bindRange = (id, fn) => { const el = $(id); const f = () => fn(parseFloat(el.value)); el.addEventListener('input', f); f(); };
bindRange('rain', (v) => {
  sim.rain = v <= -0.95 ? 0 : Math.pow(10, v);
  const label = sim.rain === 0 ? 'stopped' : sim.rain < 2.5 ? 'drizzle' : sim.rain < 8 ? 'moderate' : sim.rain < 40 ? 'heavy' : 'downpour';
  $('rain-v').textContent = sim.rain === 0 ? 'off' : `${sim.rain.toFixed(sim.rain < 10 ? 1 : 0)} mm/h · ${label}`;
  sim.stats = rainStats(Math.max(sim.rain, 0.1));
});
bindRange('wind', (v) => { sim.wind = v; $('wind-v').textContent = `${v.toFixed(0)} m/s`; });
bindRange('puddle', (v) => { sim.puddle = v; $('puddle-v').textContent = v < 0.05 ? 'dry' : v < 0.5 ? 'shallow' : v < 0.8 ? 'puddles' : 'flooded'; });
window.addEventListener('keydown', (e) => {
  if (!G.isShortcut(e)) return;
  const k = e.key.toLowerCase();
  if (k === 'w') { sim.scene = sim.scene === 'window' ? 'street' : 'window'; sync(); }
  else if (k === 'n') { sim.light = (sim.light + 1) % 3; sync(); }
  else if (k === 'c') { glass.drops = []; }
});
sync();

function updateReadout() {
  const st = sim.stats, on = sim.rain > 0;
  const rows = [
    ['Rain rate', on ? `${sim.rain.toFixed(sim.rain < 10 ? 1 : 0)} mm/h` : '—'],
    ['Median drop size', on ? `${st.D0.toFixed(2)} mm` : '—'],
    ['Its fall speed', on ? `${vTerm(st.D0).toFixed(1)} m/s` : '—'],
    ['Drops in the air', on ? `${Math.round(st.conc).toLocaleString()} per m³` : '—'],
    ['Impacts', on ? `${Math.round(st.flux).toLocaleString()} per m² per s` : '—'],
    ['Visibility', on ? `${st.vis.toFixed(1)} km` : 'clear'],
    ['Ripple rings expand at', '~20 cm/s'],
    ['Surface', sim.wet > 0.6 ? 'soaked' : sim.wet > 0.2 ? 'damp' : 'dry'],
  ];
  $('readout').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------------------------------------------------------------------------
function uniforms() {
  const on = sim.light > 0 ? 1 : 0;
  const Rr = Math.max(sim.rain, 0);
  return {
    uTime: sim.time, uCamPos: camM.eye, uViewProj: camM.vp, uLight: sim.light,
    uFog: 0.0025 + (Rr > 0 ? 3.912 / (sim.stats.vis * 1000) : 0) * 3,
    uRain: Rr,
    uLamp0: LAMPS[0], uLamp1: LAMPS[1], uLamp2: LAMPS[2],
    uLampCol: [1.0, 0.72, 0.42], uLampI: on ? (sim.light === 1 ? 45 : 60) : 0,
  };
}
function renderStreet(target, nParticles) {
  const U = uniforms();
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.depthMask(false);
  G.use(gl, P.bg, { ...U, uInvViewProj: camM.inv });
  meshes.quad.draw();
  gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  // rain wets the road; ripples need standing water
  const st = sim.stats;
  const ripRate = sim.rain > 0 ? st.fluxBig * 0.25 : 0; // visible rings per m^2 per s
  const cellsPerM2 = 2 / (0.07 * 0.07);
  G.use(gl, P.ground, { ...U, uGround: { int: sim.ground }, uWetness: sim.wet, uPuddle: sim.puddle, uRipPeriod: ripRate > 0 ? Math.max(0.55, cellsPerM2 / ripRate) : 1e3 });
  meshes.ground.draw();
  for (const L of LAMPS) {
    G.use(gl, P.prop, { ...U, uEmissive: 0, uModel: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, L[0] + Math.sign(L[0]) * 0.35, 0, L[2], 1]) });
    meshes.pole.draw();
    G.use(gl, P.prop, { ...U, uEmissive: 1, uModel: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, L[0], L[1] + 0.05, L[2], 1]) });
    meshes.head.draw();
  }
  if (nParticles > 0) {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    G.use(gl, P.streak, { ...U, uP: pTex, uV: vTex, uRes: [W, H], uShutter: 1 / 60 });
    meshes.quad.drawInstanced(nParticles);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  gl.disable(gl.DEPTH_TEST);
}

let lastN = 0, lastG = 0;
function step(dt) {
  sim.time += dt;
  // the road soaks up in minutes and dries slowly when it stops
  sim.wet += ((sim.rain > 0 ? 1 : 0) - sim.wet) * (1 - Math.exp(-dt / (sim.rain > 0 ? 8 / Math.min(4, 0.5 + sim.rain / 5) : 90)));
  camM = cameraMatrices();
  lastN = stepParticles(dt);
  if (sim.scene === 'window') lastG = stepGlass(dt);
}

function render() {
  camM = cameraMatrices();
  if (sim.scene === 'street') {
    renderStreet(msaa, lastN);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdr.fbo);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  } else {
    // the street through the window: sharp (seen inside drops) and defocused
    renderStreet(msaa, lastN);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneT.fbo);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    pass(P.blur, blurA, { uSrc: sceneT.tex, uDir: [1.5 / W, 0] });
    pass(P.blur, blurB, { uSrc: blurA.tex, uDir: [0, 1.5 / blurA.h] });
    pass(P.blur, blurA, { uSrc: blurB.tex, uDir: [2.5 / blurA.w, 0] });
    pass(P.blur, blurB, { uSrc: blurA.tex, uDir: [0, 2.5 / blurA.h] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, dropT.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    G.use(gl, P.drop, { uD: gTex, uRes: [W, H] });
    meshes.quad.drawInstanced(lastG);
    gl.disable(gl.BLEND);
    pass(P.window, hdr, { ...uniforms(), uSharp: sceneT.tex, uBlur: blurB.tex, uDrops: dropT.tex, uRes: [W, H] });
  }
  pass(P.bright, bloomA, { uSrc: hdr.tex, uTexel: [1 / W, 1 / H] });
  pass(P.blur, bloomB, { uSrc: bloomA.tex, uDir: [1 / bloomA.w, 0] });
  pass(P.blur, bloomA, { uSrc: bloomB.tex, uDir: [0, 1 / bloomA.h] });
  pass(P.blur, bloomC, { uSrc: bloomA.tex, uDir: [2 / bloomA.w, 0] });
  pass(P.blur, bloomD, { uSrc: bloomC.tex, uDir: [0, 2 / bloomA.h] });
  const exposure = [0.42, 1.25, 1.9][sim.light];
  pass(P.composite, null, { uHdr: hdr.tex, uBloom1: bloomA.tex, uBloom2: bloomD.tex, uExposure: exposure, uTime: sim.time, uRes: [W, H] });
}

let last = performance.now(), acc = 0, fN = 0, slowN = 0, ro = 1;
function frame(now) {
  resize();
  const real = Math.max((now - last) / 1000, 1e-4), dt = Math.min(real, 1 / 30);
  last = now;
  step(dt);
  render();
  acc += real; fN++;
  if ((ro += real) > 0.4) { updateReadout(); ro = 0; }
  if (acc > 0.5) {
    const fps = fN / acc;
    $('fps').textContent = `${Math.round(fps)} fps`;
    slowN = fps < 40 ? slowN + 1 : 0;
    if (slowN >= 4 && quality > 0.5) { quality *= 0.85; W = 0; slowN = 0; }
    acc = 0; fN = 0;
  }
  requestAnimationFrame(frame);
}
resize();
camM = cameraMatrices();
status.style.display = 'none';
window.__rain = {
  sim, cam, glass,
  advance(sec) { for (let t = 0; t < sec; t += 1 / 60) step(1 / 60); },
  set(k, v) { sim[k] = v; if (k === 'rain') sim.stats = rainStats(Math.max(v, 0.1)); sync(); },
};
requestAnimationFrame(frame);
