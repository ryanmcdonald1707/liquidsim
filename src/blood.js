import * as G from './gl.js';
import * as geo from './geometry.js';
import * as S from './shaders.js';
import * as B from './blood-shaders.js';

const { mat4 } = G;

// ---------------------------------------------------------------------------
// Blood: physical constants (whole blood, 37 C)
const BLOOD = {
  rho: 1060,          // kg/m^3
  sigma: 0.056,       // N/m
  mu0: 0.056,         // Pa.s  zero-shear viscosity  } Carreau model,
  muInf: 0.00345,     // Pa.s  infinite-shear        } Cho & Kensey (1991)
  lambda: 3.313,      // s
  n: 0.3568,
  tauY: 0.004,        // Pa    yield stress (rouleaux)
  clotT: 360,         // s     time for a surface pool to clot
  dryT: 1500,         // s     time scale of drying / browning
  evap: 1.6e-5,       // mm/s  evaporation rate indoors
  dripVol: 5e-8,      // m^3   ~50 uL: a drip off a fingertip
};
const carreau = (gd) => BLOOD.muInf + (BLOOD.mu0 - BLOOD.muInf) * Math.pow(1 + (BLOOD.lambda * gd) ** 2, (BLOOD.n - 1) / 2);

// Substrates: pinning thickness (mm), residual film (mm), absorption (mm/s),
// pore capacity (mm), wicking (m^2/s along u / v), splash threshold on the
// Mundo parameter K = Oh Re^1.25, static contact angle (deg)
const SURFACES = {
  tile: { name: 'Glazed tile', i: 0, hPin: 1.3, hRes: 0.012, absorb: 0, cap: 1, wick: [0, 0], Kc: 200, theta: 55, swatch: '#e6e6e2' },
  concrete: { name: 'Concrete', i: 1, hPin: 0.55, hRes: 0.03, absorb: 0.012, cap: 0.5, wick: [2.5e-7, 2.5e-7], Kc: 70, theta: 35, swatch: '#8a8782' },
  wood: { name: 'Varnished wood', i: 2, hPin: 0.9, hRes: 0.02, absorb: 0.0008, cap: 0.12, wick: [1.5e-7, 3e-9], Kc: 130, theta: 45, swatch: '#8a5a33' },
  fabric: { name: 'Cotton fabric', i: 3, hPin: 0.25, hRes: 0.01, absorb: 0.6, cap: 1.0, wick: [3e-6, 3e-6], Kc: 40, theta: 20, swatch: '#ecebe6' },
  steel: { name: 'Brushed steel', i: 4, hPin: 1.5, hRes: 0.01, absorb: 0, cap: 1, wick: [0, 0], Kc: 220, theta: 70, swatch: '#9ea3a8' },
};
const TOOLS = {
  drip: { name: 'Drip', hint: 'Click: a single drop falls from the drop height' },
  bleed: { name: 'Bleed', hint: 'Hold: a steady venous ooze that pools and runs' },
  arterial: { name: 'Arterial spurt', hint: 'Hold & move: pulsatile jet at 75 bpm' },
  spatter: { name: 'Impact spatter', hint: 'Drag: direction and length set the blow' },
  castoff: { name: 'Cast-off', hint: 'Drag: flicked off a swung object in a line' },
  smear: { name: 'Smear', hint: 'Drag: wipe through wet blood' },
};

const HALF = 0.15, RES = 512;

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
const HEAD = `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${Object.entries(DEF).map(([k, v]) => `#define ${k} ${fnum(v)}`).join('\n')}\n#define LAB_ENV 1\n`;
const src = (s) => HEAD + S.common + B.bloodCommon + B.bloodOptics + s;

const RGBA32F = [gl.RGBA32F, gl.RGBA, gl.FLOAT], RGBA16F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
const state = G.pingpong(gl, RES, RES, ...RGBA32F, gl.NEAREST);
const flux = G.target(gl, RES, RES, ...RGBA32F, gl.NEAREST);
const srcT = G.target(gl, RES, RES, ...RGBA16F, gl.NEAREST);
const vis = G.target(gl, RES, RES, ...RGBA16F, gl.LINEAR);
const visTop = G.target(gl, RES, RES, ...RGBA16F, gl.LINEAR);
const reliefT = G.target(gl, RES, RES, ...RGBA32F, gl.NEAREST);
const MAXD = 512;
const dropData = new Float32Array(MAXD * 2 * 4);
const dropTex = G.texture(gl, MAXD, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);

const P = {
  bg: G.program(gl, src(S.bgVS), src(S.bgFS)),
  flux: G.program(gl, src(S.fsVS), src(B.fluxFS)),
  update: G.program(gl, src(S.fsVS), src(B.updateFS)),
  stamp: G.program(gl, src(B.stampVS), src(B.stampFS)),
  vis: G.program(gl, src(S.fsVS), src(B.visFS)),
  visTop: G.program(gl, src(S.fsVS), src(B.visTopFS)),
  relief: G.program(gl, src(S.fsVS), src(B.reliefFS)),
  plane: G.program(gl, src(B.planeVS), src(B.planeFS)),
  drop: G.program(gl, src(B.dropVS), src(B.dropFS)),
  bright: G.program(gl, src(S.fsVS), src(S.brightFS)),
  blur: G.program(gl, src(S.fsVS), src(S.blurFS)),
  composite: G.program(gl, src(S.fsVS), src(S.compositeFS)),
};
const quad = G.mesh(gl, geo.quad());

// ---------------------------------------------------------------------------
let quality = 1, W = 0, H = 0, msaa = null, hdr = null, bloomA = null, bloomB = null, bloomC = null, bloomD = null;
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
  for (const t of [hdr, bloomA, bloomB, bloomC, bloomD]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
  hdr = G.target(gl, w, h, ...RGBA16F, gl.LINEAR);
  const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  bloomA = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR); bloomB = G.target(gl, bw, bh, ...RGBA16F, gl.LINEAR);
  bloomC = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, gl.LINEAR); bloomD = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, gl.LINEAR);
}
function pass(prog, dst, u) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
  gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
  G.use(gl, prog, u);
  quad.draw();
}
function clear(t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }

// ---------------------------------------------------------------------------
const sim = {
  tool: 'drip', surface: 'tile', tilt: 0, height: 1.0, oxy: 0.35, timeScale: 1,
  drops: [], stamps: [], smear: null, time: 0, lastImpact: null, pointer: null, pulse: 0,
};
const cam = { az: 0.25, el: 0.95, dist: 0.5, target: [0, 0, 0] };
let camM = null;
const tiltR = () => sim.tilt * Math.PI / 180;
const planeN = () => [0, Math.cos(tiltR()), Math.sin(tiltR())];
const planeV = () => [0, Math.sin(tiltR()), -Math.cos(tiltR())]; // up-slope in world
const toWorld = (u, v, off = 0) => { const n = planeN(), b = planeV(); return [u + n[0] * off, v * b[1] + n[1] * off, v * b[2] + n[2] * off]; };
const toPlane = (p) => { const b = planeV(); return [p[0], p[0] * 0 + p[1] * b[1] + p[2] * b[2]]; };

function cameraMatrices() {
  const ce = Math.cos(cam.el);
  const c = toWorld(0, 0, 0);
  const t = [c[0], c[1] + 0.01, c[2]];
  const eye = [t[0] + cam.dist * Math.sin(cam.az) * ce, t[1] + cam.dist * Math.sin(cam.el), t[2] + cam.dist * Math.cos(cam.az) * ce];
  const view = mat4.lookAt(eye, t, [0, 1, 0]);
  const proj = mat4.perspective(30 * Math.PI / 180, W / H, 0.01, 20);
  const vp = mat4.mul(proj, view);
  return { eye, view, vp, inv: mat4.invert(vp) };
}
function rayFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  const m = camM.inv;
  const un = (v) => {
    const X = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], Y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    const Z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14], Wd = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    return [X / Wd, Y / Wd, Z / Wd];
  };
  const a = un([x, y, -1]), b = un([x, y, 1]);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d);
  return { o: a, d: d.map((v) => v / l) };
}
function hitSurface(e) {
  const ray = rayFromEvent(e), n = planeN();
  const dn = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
  if (Math.abs(dn) < 1e-6) return null;
  const t = -(ray.o[0] * n[0] + ray.o[1] * n[1] + ray.o[2] * n[2]) / dn;
  if (t < 0) return null;
  const p = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
  const uv = toPlane(p);
  return Math.abs(uv[0]) < HALF && Math.abs(uv[1]) < HALF ? uv : null;
}

// ---------------------------------------------------------------------------
// Drop physics
const G0 = 9.81;
function launch(pos, vel, d) {
  if (sim.drops.length < MAXD) sim.drops.push({ p: pos.slice(), v: vel.slice(), d });
}
// A drop released from rest at height H, with air drag (terminal velocity of a
// ~4.6 mm blood drop is ~7.6 m/s).
function dripAt(uv) {
  const d = Math.cbrt(6 * BLOOD.dripVol / Math.PI);
  if (sim.tilt > 60) { depositDrop(uv, d * 1.6, [0, -1], 0, Math.PI / 2, BLOOD.dripVol); return; }
  const vt = 7.6, v = vt * Math.sqrt(1 - Math.exp(-2 * G0 * sim.height / (vt * vt)));
  // start just above the surface with the speed it would have gained
  const w = toWorld(uv[0], uv[1], 0);
  const h0 = Math.min(0.25, sim.height);
  launch([w[0], w[1] + h0, w[2]], [0, -Math.sqrt(Math.max(v * v - 2 * G0 * h0, 0.01)), 0], d);
}

// Impact of a drop of diameter d (m) with speed u (m/s) at angle alpha to the
// surface: stain size from energy balance (Pasandideh-Fard et al. 1996),
// elongation W/L = sin(alpha), splash/satellites from K = Oh Re^1.25 (Mundo 1995).
function impact(uv, d, u, dir, alpha) {
  const vol = Math.PI / 6 * d * d * d;
  const surf = SURFACES[sim.surface];
  const un = u * Math.sin(alpha); // normal component drives spreading
  const Re = BLOOD.rho * u * d / 0.0045;
  const We = BLOOD.rho * u * u * d / BLOOD.sigma;
  const Oh = 0.0045 / Math.sqrt(BLOOD.rho * BLOOD.sigma * d);
  const K = Oh * Math.pow(Re, 1.25);
  const Wen = BLOOD.rho * un * un * d / BLOOD.sigma, Ren = BLOOD.rho * un * d / 0.0045;
  const th = surf.theta * Math.PI / 180;
  const spread = Math.sqrt((Wen + 12) / (3 * (1 - Math.cos(th)) + 4 * Wen / Math.sqrt(Math.max(Ren, 1))));
  const D = d * Math.max(1, spread);
  depositDrop(uv, D, dir, K / surf.Kc, alpha, vol);
  if (d > 0.0015) sim.lastImpact = { d, u, alpha, Re, We, Oh, K, D, Kc: surf.Kc };
  // satellites: secondary droplets thrown out by the crown splash
  const excess = K / surf.Kc - 1;
  if (excess > 0) {
    const n = Math.min(40, Math.floor(excess * 10 * (d / 0.004)));
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dir[1], dir[0]) + (Math.random() - 0.5) * (alpha > 1.2 ? Math.PI * 2 : 2.2);
      const r = D * (0.6 + Math.random() * 2.5 + (alpha < 1 ? Math.random() * 3 : 0));
      const sd = d * (0.05 + 0.2 * Math.random() ** 2);
      const q = [uv[0] + Math.cos(a) * r, uv[1] + Math.sin(a) * r];
      sim.stamps.push(makeStamp(q, sd * 2.2, [Math.cos(a), Math.sin(a)], 0, 0.5 + Math.random() * 0.4, Math.PI / 6 * sd * sd * sd));
    }
  }
}
function makeStamp(uv, D, dir, spines, alpha, vol) {
  const sa = Math.max(Math.sin(alpha), 0.12);
  const a = D / 2, b = D / (2 * sa);
  const h0 = (3 * vol) / (2 * Math.PI * a * b) * 1000; // mm (half-ellipsoid)
  return { uv, a, b, dir, h0, spines: Math.min(1, Math.max(0, spines)), tail: Math.max(0, 1 - sa * 1.3), seed: Math.random() * 100 };
}
function depositDrop(uv, D, dir, kRatio, alpha, vol) {
  sim.stamps.push(makeStamp(uv, D, dir, Math.max(0, kRatio - 1) * 0.8, alpha, vol));
}

function stepDrops(dt) {
  const n = planeN(), keep = [];
  for (const dr of sim.drops) {
    const sub = 4;
    let hit = false;
    for (let s = 0; s < sub && !hit; s++) {
      const h = dt / sub;
      // light quadratic drag for small droplets
      const sp = Math.hypot(...dr.v), k = 0.3 * 1.2 * sp / (BLOOD.rho * dr.d) * 0.75;
      dr.v = [dr.v[0] * (1 - k * h), (dr.v[1] - G0 * h) * (1 - k * h) + 0 * h, dr.v[2] * (1 - k * h)];
      dr.p = [dr.p[0] + dr.v[0] * h, dr.p[1] + dr.v[1] * h, dr.p[2] + dr.v[2] * h];
      const dist = dr.p[0] * n[0] + dr.p[1] * n[1] + dr.p[2] * n[2];
      if (dist <= dr.d / 2) {
        hit = true;
        const uv = toPlane(dr.p);
        if (Math.abs(uv[0]) < HALF && Math.abs(uv[1]) < HALF) {
          const u = Math.hypot(...dr.v);
          const vn = -(dr.v[0] * n[0] + dr.v[1] * n[1] + dr.v[2] * n[2]);
          const b = planeV();
          const vt = [dr.v[0], dr.v[0] * 0 + dr.v[1] * b[1] + dr.v[2] * b[2]];
          const lt = Math.hypot(...vt);
          const alpha = Math.asin(Math.min(1, Math.max(0.05, vn / Math.max(u, 1e-6))));
          const dir = lt > 1e-6 ? [vt[0] / lt, vt[1] / lt] : [0, -1];
          impact(uv, dr.d, u, dir, alpha);
        }
      }
    }
    if (!hit && dr.p[1] > -1 && Math.hypot(dr.p[0], dr.p[2]) < 2) keep.push(dr);
  }
  sim.drops = keep;
}

// ---------------------------------------------------------------------------
// Tools
function spatter(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy);
  if (L < 0.005) return;
  const dir = [dx / L, dy / L];
  const speed = 3 + L * 40; // m/s: a blow
  const n = 60 + Math.floor(L * 600);
  const nrm = planeN();
  for (let i = 0; i < n; i++) {
    // droplets leave the wound a few cm off the surface, fanning out
    const o = toWorld(from[0] - dir[0] * 0.02, from[1] - dir[1] * 0.02, 0.03 + Math.random() * 0.03);
    const spread = (Math.random() - 0.5) * 0.9, lift = (Math.random() - 0.3) * 0.5;
    const t = [dir[0] * Math.cos(spread) - dir[1] * Math.sin(spread), dir[0] * Math.sin(spread) + dir[1] * Math.cos(spread)];
    const tw = toWorld(t[0], t[1], 0);
    const s = speed * (0.4 + Math.random() * 0.9);
    const v = [tw[0] * s - nrm[0] * s * (0.25 + lift * 0.4), tw[1] * s - nrm[1] * s * (0.25 + lift * 0.4), tw[2] * s - nrm[2] * s * (0.25 + lift * 0.4)];
    const d = 0.0003 + 0.0028 * Math.random() ** 3;
    launch(o, v, d);
  }
}
function castoff(from, to) {
  // droplets flung tangentially off a swung object, released along the arc
  const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy);
  if (L < 0.01) return;
  const dir = [dx / L, dy / L], nrm = planeN();
  const n = Math.floor(L * 160);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const o = toWorld(from[0] + dx * t, from[1] + dy * t, 0.25);
    const tw = toWorld(dir[0], dir[1], 0);
    const s = 5 + 3 * Math.random();
    launch(o, [tw[0] * s * 0.6 - nrm[0] * s, tw[1] * s * 0.6 - nrm[1] * s, tw[2] * s * 0.6 - nrm[2] * s], 0.0012 + 0.0015 * Math.random());
  }
}
function arterial(dt) {
  if (!sim.pointer) return;
  // 75 bpm pulse with a sharp systolic upstroke
  sim.pulse += dt * 75 / 60;
  const ph = sim.pulse % 1;
  const flow = 0.25 + 0.75 * Math.exp(-Math.pow((ph - 0.12) / 0.08, 2));
  const n = planeN();
  const origin = toWorld(sim.pointer.start[0], sim.pointer.start[1] - 0.06, 0.12);
  const target = toWorld(sim.pointer.uv[0], sim.pointer.uv[1], 0);
  const k = Math.floor(dt * 140 * flow + Math.random());
  for (let i = 0; i < k; i++) {
    const T = 0.12;
    const vx = (target[0] - origin[0]) / T, vz = (target[2] - origin[2]) / T;
    const vy = (target[1] - origin[1] + 0.5 * G0 * T * T) / T;
    const j = () => (Math.random() - 0.5) * 0.35 * (1.3 - flow);
    const s = 0.9 + 0.25 * flow;
    launch(origin, [vx * s + j(), vy * s + j(), vz * s + j()], 0.0008 + 0.0025 * Math.random() ** 2);
  }
  void n;
}
function bleed(dt) {
  if (!sim.pointer) return;
  // a steady ooze of ~1 mL/s
  const vol = 1e-6 * dt;
  const uv = sim.pointer.uv;
  const D = 0.008;
  const h0 = (3 * vol) / (2 * Math.PI * (D / 2) ** 2) * 1000;
  sim.stamps.push({ uv, a: D / 2, b: D / 2, dir: [0, 1], h0, spines: 0, tail: 0, seed: 0 });
}

// ---------------------------------------------------------------------------
// Input
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const uv = e.button === 0 && !e.shiftKey ? hitSurface(e) : null;
  if (!uv) { drag = { mode: 'orbit', x: e.clientX, y: e.clientY }; return; }
  drag = { mode: 'tool', start: uv, last: uv, x: e.clientX, y: e.clientY };
  sim.pointer = { start: uv, uv };
  if (sim.tool === 'drip') dripAt(uv);
  if (sim.tool === 'arterial') sim.pulse = 0;
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.mode === 'orbit') {
    cam.az -= (e.clientX - drag.x) * 0.006;
    cam.el = Math.min(1.5, Math.max(0.08, cam.el + (e.clientY - drag.y) * 0.005));
    drag.x = e.clientX; drag.y = e.clientY;
    return;
  }
  const uv = hitSurface(e);
  if (!uv) return;
  if (sim.tool === 'smear') sim.smear = { from: sim.smear ? sim.smear.from : drag.last, to: uv };
  drag.last = uv;
  sim.pointer.uv = uv;
});
const endDrag = () => {
  if (drag && drag.mode === 'tool') {
    if (sim.tool === 'spatter') spatter(drag.start, drag.last);
    if (sim.tool === 'castoff') castoff(drag.start, drag.last);
  }
  drag = null; sim.pointer = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(1.5, Math.max(0.12, cam.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

// ---------------------------------------------------------------------------
// UI
const $ = (id) => document.getElementById(id);
function chips(el, table, onPick) {
  el.innerHTML = '';
  for (const [k, v] of Object.entries(table)) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.key = k;
    b.innerHTML = v.swatch ? `<i style="background:${v.swatch}"></i>${v.name}` : v.name;
    b.addEventListener('click', () => onPick(k));
    el.appendChild(b);
  }
}
function syncUI() {
  for (const b of $('tools').children) b.classList.toggle('on', b.dataset.key === sim.tool);
  for (const b of $('surfaces').children) b.classList.toggle('on', b.dataset.key === sim.surface);
  $('hint').textContent = TOOLS[sim.tool].hint;
}
chips($('tools'), TOOLS, (k) => { sim.tool = k; syncUI(); });
chips($('surfaces'), SURFACES, (k) => { sim.surface = k; cleanSurface(); syncUI(); });
const bindRange = (id, fn) => { const el = $(id); const f = () => fn(parseFloat(el.value)); el.addEventListener('input', f); f(); };
bindRange('tilt', (v) => { sim.tilt = v; $('tilt-v').textContent = `${v.toFixed(0)}°`; });
bindRange('height', (v) => { sim.height = Math.pow(10, v); $('height-v').textContent = `${sim.height < 1 ? (sim.height * 100).toFixed(0) + ' cm' : sim.height.toFixed(1) + ' m'}`; });
bindRange('oxy', (v) => { sim.oxy = v; $('oxy-v').textContent = v > 0.7 ? 'arterial' : v < 0.3 ? 'venous' : 'mixed'; });
bindRange('time', (v) => { sim.timeScale = Math.round(Math.pow(10, v)); $('time-v').textContent = `${sim.timeScale}×`; });
$('b-clean').addEventListener('click', cleanSurface);
function cleanSurface() {
  clear(state.read); clear(state.write); clear(flux); sim.drops = []; sim.stamps = []; sim.time = 0;
  pass(P.relief, reliefT, { uHalf: HALF, uSurface: { int: SURFACES[sim.surface].i }, uRes: [RES, RES] });
}

function updateReadout() {
  const li = sim.lastImpact;
  const rows = [
    ['Density', `${BLOOD.rho} kg/m³`],
    ['Surface tension', `${(BLOOD.sigma * 1000).toFixed(0)} mN/m`],
    ['Viscosity at 1 /s', `${(carreau(1) * 1000).toFixed(1)} mPa·s`],
    ['Viscosity at 1000 /s', `${(carreau(1000) * 1000).toFixed(2)} mPa·s`],
    ['Yield stress', `${(BLOOD.tauY * 1000).toFixed(0)} mPa`],
    ['Blood time', `${fmtTime(sim.time)}`],
    ['State', sim.time < BLOOD.clotT * 0.3 ? 'fresh' : sim.time < BLOOD.clotT ? 'clotting' : sim.time < BLOOD.dryT ? 'clotted, drying' : 'dried'],
  ];
  if (li) rows.push(
    ['Last drop', `${(li.d * 1000).toFixed(1)} mm @ ${li.u.toFixed(1)} m/s`],
    ['Impact angle', `${(li.alpha * 180 / Math.PI).toFixed(0)}°  (W/L ${Math.sin(li.alpha).toFixed(2)})`],
    ['Re / We / Oh', `${li.Re.toFixed(0)} / ${li.We.toFixed(0)} / ${li.Oh.toFixed(4)}`],
    ['Splash K', `${li.K.toFixed(0)} ${li.K > li.Kc ? '> ' : '< '}${li.Kc} ${li.K > li.Kc ? '(spines)' : '(round)'}`],
    ['Stain diameter', `${(li.D * 1000).toFixed(1)} mm`],
  );
  $('readout').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
const fmtTime = (t) => (t < 60 ? `${t.toFixed(0)} s` : t < 3600 ? `${(t / 60).toFixed(1)} min` : `${(t / 3600).toFixed(1)} h`);

// ---------------------------------------------------------------------------
// Simulation step
function stepSim(dt) {
  sim.time += dt * sim.timeScale;
  if (sim.tool === 'arterial' && drag && drag.mode === 'tool') arterial(dt);
  if (sim.tool === 'bleed' && drag && drag.mode === 'tool') bleed(dt);
  stepDrops(dt);

  // stamps -> source texture
  clear(srcT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, srcT.fbo);
  gl.viewport(0, 0, RES, RES);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (const s of sim.stamps) {
    G.use(gl, P.stamp, { uHalf: HALF, uStamp: [s.uv[0], s.uv[1], Math.max(s.a, 0.0004), Math.max(s.b, 0.0004)], uDir: s.dir, uShape: [s.h0, s.spines, s.seed, s.tail] });
    quad.draw();
  }
  gl.disable(gl.BLEND);
  const hadSrc = sim.stamps.length > 0;
  sim.stamps = [];

  const surf = SURFACES[sim.surface];
  const sub = 8, h = dt / sub, dx = 2 * HALF / RES;
  const t = tiltR();
  for (let i = 0; i < sub; i++) {
    pass(P.flux, flux, {
      uS: state.read.tex, uRelief: reliefT.tex, uHalf: HALF, uSurface: { int: surf.i }, uDt: h, uCos: Math.cos(t), uSin: Math.sin(t), uRho: BLOOD.rho, uG: G0,
      uHpin: surf.hPin * (0.4 + 0.6 * Math.cos(t)), uHres: surf.hRes, uTauY: BLOOD.tauY, uMu0: BLOOD.mu0, uMuInf: BLOOD.muInf, uLam: BLOOD.lambda,
      uN: BLOOD.n, uFront: 0.08, uClotT: BLOOD.clotT,
    });
    pass(P.update, state.write, {
      uS: state.read.tex, uF: flux.tex, uSrc: srcT.tex, uUseSrc: i === 0 && hadSrc ? 1 : 0, uHalf: HALF, uSurface: { int: surf.i },
      uDt: h, uTimeScale: sim.timeScale, uEvap: BLOOD.evap, uAbsorb: surf.absorb, uCap: surf.cap,
      uWickX: surf.wick[0] * h / (dx * dx), uWickY: surf.wick[1] * h / (dx * dx),
      uSmear: sim.smear ? [...sim.smear.from, ...sim.smear.to] : [0, 0, 0, 0], uSmearR: sim.smear && i === 0 ? 0.012 : 0,
    });
    state.swap();
  }
  sim.smear = null;
}

// ---------------------------------------------------------------------------
function render() {
  camM = cameraMatrices();
  pass(P.vis, vis, { uS: state.read.tex });
  pass(P.visTop, visTop, { uS: state.read.tex, uRelief: reliefT.tex });
  const t = tiltR();
  const U = { uCupPos: [0, 0, 0], uTime: sim.time, uCamPos: camM.eye, uViewProj: camM.vp, uHalf: HALF, uCos: Math.cos(t), uSin: Math.sin(t), uOxy: sim.oxy, uSurface: { int: SURFACES[sim.surface].i } };

  gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.fbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.depthMask(false);
  G.use(gl, P.bg, { ...U, uInvViewProj: camM.inv });
  quad.draw();
  gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  G.use(gl, P.plane, { ...U, uVis: vis.tex, uTop: visTop.tex, uClotT: BLOOD.clotT, uDryT: BLOOD.dryT });
  quad.draw();
  // drops in flight
  const n = Math.min(sim.drops.length, MAXD);
  if (n) {
    for (let i = 0; i < n; i++) {
      const d = sim.drops[i];
      dropData.set([d.p[0], d.p[1], d.p[2], d.d / 2], i * 4);
      dropData.set([d.v[0], d.v[1], d.v[2], 0], (MAXD + i) * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, dropTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAXD, 2, gl.RGBA, gl.FLOAT, dropData);
    G.use(gl, P.drop, { ...U, uView: camM.view, uDrops: dropTex });
    quad.drawInstanced(n);
    dropData.fill(0);
  }
  gl.disable(gl.DEPTH_TEST);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdr.fbo);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  pass(P.bright, bloomA, { uSrc: hdr.tex, uTexel: [1 / W, 1 / H] });
  pass(P.blur, bloomB, { uSrc: bloomA.tex, uDir: [1 / bloomA.w, 0] });
  pass(P.blur, bloomA, { uSrc: bloomB.tex, uDir: [0, 1 / bloomA.h] });
  pass(P.blur, bloomC, { uSrc: bloomA.tex, uDir: [2 / bloomA.w, 0] });
  pass(P.blur, bloomD, { uSrc: bloomC.tex, uDir: [0, 2 / bloomA.h] });
  pass(P.composite, null, { uHdr: hdr.tex, uBloom1: bloomA.tex, uBloom2: bloomD.tex, uExposure: 1.15, uTime: sim.time, uRes: [W, H] });
}

// ---------------------------------------------------------------------------
let last = performance.now(), acc = 0, fN = 0, slowN = 0, ro = 0;
function frame(now) {
  resize();
  const real = Math.max((now - last) / 1000, 1e-4), dt = Math.min(real, 1 / 30);
  last = now;
  if (!camM) camM = cameraMatrices();
  stepSim(dt);
  render();
  acc += real; fN++;
  if ((ro += real) > 0.25) { updateReadout(); ro = 0; }
  if (acc > 0.5) {
    const fps = fN / acc;
    $('fps').textContent = `${Math.round(fps)} fps`;
    slowN = fps < 40 ? slowN + 1 : 0;
    if (slowN >= 4 && quality > 0.5) { quality *= 0.85; W = 0; slowN = 0; }
    acc = 0; fN = 0;
  }
  requestAnimationFrame(frame);
}
syncUI();
resize();
cleanSurface();
status.style.display = 'none';
window.__blood = {
  sim, cam, dripAt, spatter, castoff, cleanSurface,
  advance(sec) { for (let t = 0; t < sec; t += 1 / 60) stepSim(1 / 60); },
  bleedFor(uv, sec) { sim.pointer = { start: uv, uv }; for (let t = 0; t < sec; t += 1 / 60) { bleed(1 / 60); stepSim(1 / 60); } sim.pointer = null; },
  arterialFor(start, uv, sec) { sim.pointer = { start, uv }; for (let t = 0; t < sec; t += 1 / 60) { arterial(1 / 60); stepSim(1 / 60); } sim.pointer = null; },
  set(k, v) { sim[k] = v; },
};
requestAnimationFrame(frame);
