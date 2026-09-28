import { ModalSurface } from './modal.js';
import * as G from './gl.js';
import * as geo from './geometry.js';
import * as S from './shaders.js';
import { createMultigrid } from './multigrid.js';
import * as MX from './mix3d.js';
import * as LS from './lab-shaders.js';
import { LIQUIDS, ADDITIVES, CATEGORIES } from './liquids.js';

const { mat4 } = G;

// Beaker (metres). Origin on the bench at the centre of the beaker.
const D = {
  R_IN: 0.040, R_OUT: 0.0418, INNER_BOTTOM: 0.004, INNER_TOP: 0.124, RIM_Y: 0.1265,
  CUP_Y0: 0.0, SAUCER_R: 0.0, SAUCER_H: 0.0, MEN_H: 1.5, ROD_R: 0.0028,
};
const WIN = { AZ: -0.72, EL0: 0.3, EL1: 0.82, AW: 0.3, E: 4.6 };
WIN.ELC = 0.5 * (WIN.EL0 + WIN.EL1);
const fnum = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = [
  ...Object.entries(D).map(([k, v]) => `#define ${k} ${fnum(v)}`),
  ...Object.entries(WIN).map(([k, v]) => `#define WIN_${k === 'AZ' ? 'AZ' : k} ${fnum(v)}`),
  'uniform float uSurfY;', '#define SURF_Y uSurfY', '#define LAB_ENV 1',
].join('\n');
const HEAD = `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${defines}\n`;
const src = (s) => HEAD + S.common + MX.grid3 + LS.labCommon + s;
const flowSrc = (s) => HEAD + S.common + s;

// ---------------------------------------------------------------------------
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
const status = document.getElementById('status');
function fail(msg) { status.textContent = msg; status.classList.add('err'); throw new Error(msg); }
if (!gl) fail('WebGL2 is not available in this browser.');
if (!gl.getExtension('EXT_color_buffer_float')) fail('This GPU cannot render to float textures (EXT_color_buffer_float).');
const floatLinear = !!gl.getExtension('OES_texture_float_linear');

// ---------------------------------------------------------------------------
// State
const state = {
  liquid: 'water', additive: 'bluedye', fill: 0.075, gravity: 1.0,
  base: null,            // current base optics (possibly with baked-in additives)
  addTotal: 0, oil: 0,
  pour: 0, pourPos: [0, 0], pourDur: 1, poured: false,
  slosh: [],
  foamH: 0, frost: 0, magnet: false, spike: 0,
};
let modal = null, M = 0, Nr = 256, profiles = null, profTex = null;
let men = { h: 0, lc: 0.0027 };
const stokes = { k: 0, h2: 0 };

const L = gl.LINEAR, NEAR = gl.NEAREST;
const RGBA16F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
const RGBA32F = [gl.RGBA32F, gl.RGBA, gl.FLOAT];
const HRES = 512, VRES = 256, DRES = 512;
const heightT = G.target(gl, HRES, HRES, ...(floatLinear ? RGBA32F : RGBA16F), L);
const vel = G.pingpong(gl, VRES, VRES, ...RGBA16F, L);
const pres = G.pingpong(gl, VRES, VRES, ...RGBA16F, L);
const divT = G.target(gl, VRES, VRES, ...RGBA16F, L);
const curlT = G.target(gl, VRES, VRES, ...RGBA16F, L);
const dye = G.pingpong(gl, DRES, DRES, ...RGBA16F, L);
const dyeF = G.target(gl, DRES, DRES, ...RGBA16F, L);
const dyeB = G.target(gl, DRES, DRES, ...RGBA16F, L);
const probeT = G.target(gl, 129, 1, ...RGBA32F, NEAR);
const probe = G.asyncReader(gl, 129, 1);
const probeBuf = new Float32Array(129 * 4);
const wetTex = G.texture(gl, 1, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, L, new Float32Array([-1e3, 0, 0, 0]));

// an oil film calms the short waves (Marangoni elasticity)
const oilDamping = () => 0.08 * Math.min(state.oil * 30, 1) + 0.6 * Math.min(state.foamH / 0.01, 1.5);
function buildModal() {
  const liq = LIQUIDS[state.liquid];
  const g = 9.81 * state.gravity;
  modal = new ModalSurface({
    R: D.R_IN, H: state.fill - D.INNER_BOTTOM, g, sigma: liq.sigma, rho: liq.rho, nu: liq.nu, dt: 1 / 240,
    contactDamping: liq.metal ? 0.12 : 0.22, extraDamping: oilDamping(),
  });
  M = modal.M; Nr = modal.Nr;
  profiles = new Float32Array(Nr * (M + 1) * 4);
  if (profTex) gl.deleteTexture(profTex);
  profTex = floatLinear
    ? G.texture(gl, Nr, M + 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, L)
    : G.texture(gl, Nr, M + 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, L);
  // static meniscus: rise (or, for mercury, depression) at the wall
  const lc = Math.sqrt(liq.sigma / (liq.rho * g));
  const th = liq.theta * Math.PI / 180;
  men = { lc, h: 1000 * lc * Math.sqrt(2 * (1 - Math.sin(th))) * Math.sign(Math.cos(th)) };
  updateReadout();
}

// ---------------------------------------------------------------------------
const P = {
  bg: G.program(gl, src(S.bgVS), src(S.bgFS)),
  bench: G.program(gl, src(S.meshVS), src(LS.benchFS)),
  rod: G.program(gl, src(S.meshVS), src(LS.rodFS)),
  stream: G.program(gl, src(S.meshVS), src(LS.streamFS)),
  surface: G.program(gl, src(LS.labSurfaceVS), src(LS.labSurfaceFS)),
  side: G.program(gl, src(LS.labSideVS), src(LS.labSideFS)),
  glass: G.program(gl, src(LS.glassVS), src(LS.glassFS)),
  vapor: G.program(gl, src(LS.vaporVS), src(LS.vaporFS)),
  height: G.program(gl, flowSrc(S.fsVS), flowSrc(S.heightFS)),
  advectVel: G.program(gl, flowSrc(S.fsVS), flowSrc(S.advectVelFS)),
  curl: G.program(gl, flowSrc(S.fsVS), flowSrc(S.curlFS)),
  force: G.program(gl, flowSrc(S.fsVS), flowSrc(S.forceFS)),
  div: G.program(gl, flowSrc(S.fsVS), flowSrc(S.divFS)),
  jacobi: G.program(gl, flowSrc(S.fsVS), flowSrc(S.jacobiFS)),
  residual: G.program(gl, flowSrc(S.fsVS), flowSrc(S.residualFS)),
  restrict: G.program(gl, flowSrc(S.fsVS), flowSrc(S.restrictFS)),
  prolong: G.program(gl, flowSrc(S.fsVS), flowSrc(S.prolongFS)),
  grad: G.program(gl, flowSrc(S.fsVS), flowSrc(S.gradFS)),
  advectDye: G.program(gl, flowSrc(S.fsVS), flowSrc(S.advectDyeFS)),
  maccormack: G.program(gl, flowSrc(S.fsVS), flowSrc(S.maccormackFS)),
  probe: G.program(gl, flowSrc(S.fsVS), flowSrc(S.probeFS)),
  bright: G.program(gl, flowSrc(S.fsVS), flowSrc(S.brightFS)),
  blur: G.program(gl, flowSrc(S.fsVS), flowSrc(S.blurFS)),
  composite: G.program(gl, flowSrc(S.fsVS), flowSrc(S.compositeFS)),
};

// ---------------------------------------------------------------------------
// Meshes
const glassProfile = geo.smooth([
  [0, 0], [0.036, 0], [0.0405, 0.0006], [0.0418, 0.0035], [0.0418, 0.03], [0.0418, 0.1235], [0.0426, 0.1252],
  [0.0431, 0.1262], [0.0424, 0.1267], [0.0412, 0.1262], [0.0400, 0.1238], [0.0400, 0.03], [0.0400, 0.0075],
  [0.0392, 0.0048], [0.036, 0.004], [0, 0.004],
], 5);
function cylinder(r, y0, y1, segs = 128, rings = 1) {
  const positions = [], normals = [], indices = [];
  for (let j = 0; j <= rings; j++) for (let s = 0; s <= segs; s++) {
    const th = s / segs * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
    positions.push(r * c, y0 + (y1 - y0) * j / rings, r * sn);
    normals.push(c, 0, sn);
  }
  for (let j = 0; j < rings; j++) for (let s = 0; s < segs; s++) {
    const a = j * (segs + 1) + s, b = a + segs + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices };
}
const meshes = {
  glass: G.mesh(gl, geo.lathe(glassProfile, 160)),
  side: G.mesh(gl, cylinder(D.R_OUT + 0.0001, D.INNER_BOTTOM, D.INNER_TOP, 160, 1)),
  surface: G.mesh(gl, geo.polarDisk(D.R_IN + 0.0003, 200, 384)),
  bench: G.mesh(gl, geo.plane(4)),
  rod: G.mesh(gl, cylinder(D.ROD_R, 0, 1, 24, 1)),
  stream: G.mesh(gl, cylinder(1, 0, 1, 24, 1)),
  quad: G.mesh(gl, geo.quad()),
};
const VAPOR_BOX = [-0.16, 0.0, -0.16, 0.16, D.RIM_Y + 0.2, 0.16];
meshes.vapor = G.mesh(gl, geo.box(...VAPOR_BOX));

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
  hdr = G.target(gl, w, h, ...RGBA16F, L);
  const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  bloomA = G.target(gl, bw, bh, ...RGBA16F, L); bloomB = G.target(gl, bw, bh, ...RGBA16F, L);
  bloomC = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, L); bloomD = G.target(gl, bw >> 1 || 1, bh >> 1 || 1, ...RGBA16F, L);
}
function pass(prog, dst, uniforms) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
  gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
  G.use(gl, prog, uniforms);
  meshes.quad.draw();
}
const mg = createMultigrid(gl, VRES, P, pass);
const mixer = MX.createMixer(gl, pass, (fs) => G.program(gl, flowSrc(S.fsVS), flowSrc(fs)));
// a blend weight defined per 1/60 s frame, converted to this step's dt
const perFrame = (w, dt) => 1 - Math.pow(1 - w, dt * 60);
function clearTargets(...ts) {
  for (const t of ts) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
}

// ---------------------------------------------------------------------------
// Camera & input
const cam = { az: 0.35, el: 0.3, dist: 0.42, target: [0, 0.058, 0] };
const rod = { active: false, auto: 0, pos: [0, 0], vel: [0, 0], goal: [0, 0], blend: 0, fluid: [0, 0] };
let camM = null, simTime = 0;
function cameraMatrices() {
  const ce = Math.cos(cam.el), t = cam.target;
  const eye = [t[0] + cam.dist * Math.sin(cam.az) * ce, t[1] + cam.dist * Math.sin(cam.el), t[2] + cam.dist * Math.cos(cam.az) * ce];
  const view = mat4.lookAt(eye, t, [0, 1, 0]);
  const proj = mat4.perspective(28 * Math.PI / 180, W / H, 0.01, 20);
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
function hitPlane(ray, y) {
  if (Math.abs(ray.d[1]) < 1e-6) return null;
  const t = (y - ray.o[1]) / ray.d[1];
  return t < 0 ? null : [ray.o[0] + ray.d[0] * t, ray.o[2] + ray.d[2] * t];
}
const clampStir = (p) => { const r = Math.hypot(...p), lim = D.R_IN - 0.007; return r > lim ? p.map((v) => v * lim / r) : p; };

let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const s = hitPlane(rayFromEvent(e), state.fill);
  const onLiquid = s && Math.hypot(...s) < D.R_IN * 0.98;
  if (onLiquid && e.button === 0 && !e.shiftKey) { drag = { mode: 'stir', t0: performance.now(), x: e.clientX, y: e.clientY, moved: 0, start: s }; rod.goal = clampStir(s); }
  else drag = { mode: 'orbit', x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.mode === 'orbit') {
    cam.az -= (e.clientX - drag.x) * 0.006;
    cam.el = Math.min(1.45, Math.max(0.02, cam.el + (e.clientY - drag.y) * 0.005));
  } else {
    drag.moved += Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    const s = hitPlane(rayFromEvent(e), state.fill);
    if (s) rod.goal = clampStir(s);
    if (drag.moved > 6 && !rod.active) { rod.active = true; rod.pos = rod.goal.slice(); }
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
const endDrag = () => {
  if (drag && drag.mode === 'stir' && drag.moved <= 6 && performance.now() - drag.t0 < 400) dropAt(drag.start);
  if (drag && drag.mode === 'stir') rod.active = false;
  drag = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(1.0, Math.max(0.12, cam.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

// ---------------------------------------------------------------------------
// Actions
function dropAt(p) {
  const liq = LIQUIDS[state.liquid];
  modal.impulse(p[0], p[1], 0.012 * (1000 / liq.rho) ** 0.5, 0.0035);
}
function pour() {
  const add = ADDITIVES[state.additive];
  state.pourDur = state.pour = add.drops ? 0.35 : 1.4;
  const a = Math.random() * Math.PI * 2, r = Math.random() * 0.012;
  state.pourPos = [r * Math.cos(a), r * Math.sin(a)];
  if (add.immiscible) { state.oil += add.amount; modal.setExtraDamping(oilDamping()); updateReadout(); return; }
  state.poured = true;
  const base = LIQUIDS[state.liquid];
  if (base.foam) state.foamH = Math.min(base.foam * 1.2, state.foamH + base.foam * 0.5);
  // on liquid metal everything floats: it stays on top as a film
  state.addTotal = Math.min(1, state.addTotal + add.amount);
}
function knock() {
  const a = cam.az + Math.PI + (Math.random() - 0.5);
  modal.knock(0.06 * (1000 / LIQUIDS[state.liquid].rho) ** 0.5, Math.sin(a), Math.cos(a));
}
function sloshPulse(dx, dz) {
  const A = 9 * state.gravity ** 0.5;
  state.slosh.push({ t: 0, dx, dz, A });
}
function autoStir() { rod.auto = 4.5; }

// Switching additives bakes what's already mixed in into the base liquid.
function bakeAdditive() {
  const add = ADDITIVES[state.additive];
  const c = state.poured ? Math.min(1, mixer.meanConc(state.fill)) : 0;
  if (c > 0 && !add.immiscible) {
    for (let i = 0; i < 3; i++) {
      state.base.sigA[i] += (add.sigA[i] - state.base.sigA[i]) * c;
      state.base.sigS[i] += (add.sigS[i] - state.base.sigS[i]) * c;
    }
  }
  state.addTotal = 0;
  state.poured = false;
  mixer.clearConc();
  // clear the additive channels but keep any floating oil (.g)
  gl.colorMask(true, false, true, true);
  clearTargets(dye.read, dye.write);
  gl.colorMask(true, true, true, true);
}
function setLiquid(key) {
  state.liquid = key;
  const liq = LIQUIDS[key];
  state.base = { sigA: liq.sigA.slice(), sigS: liq.sigS.slice() };
  state.addTotal = state.oil = 0;
  mixer.reset();
  state.poured = false;
  state.foamH = liq.foam || 0; state.frost = 0; state.spike = 0;
  clearTargets(vel.read, vel.write, pres.read, pres.write, dye.read, dye.write);
  buildModal();
  syncUI();
}
function buildModalKeep() {
  const a = modal ? { a: modal.a.slice(), v: modal.v.slice() } : null;
  buildModal();
  if (a && a.a.length === modal.n) { modal.a.set(a.a); modal.v.set(a.v); }
}
function resetSample() { setLiquid(state.liquid); }

// ---------------------------------------------------------------------------
// UI
const $ = (id) => document.getElementById(id);
function chips(el, table, key, onPick) {
  el.innerHTML = '';
  for (const [k, v] of Object.entries(table)) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.key = k;
    b.innerHTML = `<i style="background:${v.swatch}"></i>${v.name}`;
    b.addEventListener('click', () => onPick(k));
    el.appendChild(b);
  }
}
{
  const el = $('liquids');
  el.innerHTML = '';
  for (const [title, keys] of CATEGORIES) {
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = title; el.appendChild(h);
    const row = document.createElement('div'); row.className = 'chips';
    for (const k of keys) {
      const v = LIQUIDS[k], b = document.createElement('button');
      b.className = 'chip'; b.dataset.key = k;
      b.innerHTML = `<i style="background:${v.swatch}"></i>${v.name}`;
      b.addEventListener('click', () => setLiquid(k));
      row.appendChild(b);
    }
    el.appendChild(row);
  }
}
chips($('additives'), ADDITIVES, 'additive', (k) => { if (k !== state.additive) { bakeAdditive(); state.additive = k; } syncUI(); });
function syncUI() {
  for (const b of $('liquids').querySelectorAll('.chip')) b.classList.toggle('on', b.dataset.key === state.liquid);
  const mag = $('b-magnet');
  mag.hidden = !LIQUIDS[state.liquid].magnetic;
  mag.classList.toggle('off', !state.magnet);
  for (const b of $('additives').children) b.classList.toggle('on', b.dataset.key === state.additive);
  $('b-pour').firstChild.textContent = `Pour ${ADDITIVES[state.additive].name.toLowerCase()}`;
  $('note').textContent = LIQUIDS[state.liquid].note;
}
const fillEl = $('fill'), gEl = $('gravity');
let rebuildTimer = 0;
const scheduleRebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(buildModalKeep, 120); };
fillEl.addEventListener('input', () => {
  state.fill = D.INNER_BOTTOM + parseFloat(fillEl.value) * 1e-6 / (Math.PI * D.R_IN * D.R_IN);
  $('fill-v').textContent = `${fillEl.value} ml`;
  scheduleRebuild();
});
gEl.addEventListener('input', () => {
  state.gravity = Math.pow(10, parseFloat(gEl.value));
  $('g-v').textContent = `${state.gravity.toFixed(2)} g`;
  scheduleRebuild();
});
for (const b of document.querySelectorAll('[data-g]')) b.addEventListener('click', () => {
  state.gravity = parseFloat(b.dataset.g); gEl.value = Math.log10(state.gravity);
  $('g-v').textContent = `${state.gravity.toFixed(2)} g`; buildModalKeep();
});
$('b-stir').addEventListener('click', autoStir);
$('b-pour').addEventListener('click', pour);
$('b-drop').addEventListener('click', () => { const a = Math.random() * 6.28, r = Math.random() * 0.02; dropAt([r * Math.cos(a), r * Math.sin(a)]); });
$('b-knock').addEventListener('click', knock);
$('b-slosh').addEventListener('click', () => { const a = cam.az + Math.PI / 2; sloshPulse(Math.cos(a), -Math.sin(a)); });
$('b-reset').addEventListener('click', resetSample);
$('b-magnet').addEventListener('click', () => { state.magnet = !state.magnet; syncUI(); updateReadout(); });
window.addEventListener('keydown', (e) => {
  if (!G.isShortcut(e)) return;
  const k = e.key.toLowerCase();
  if (k === 's') autoStir(); else if (k === 'p') pour(); else if (k === 'k') knock(); else if (k === 'r') resetSample();
  else if (k === 'g' && LIQUIDS[state.liquid].magnetic) $('b-magnet').click();
  else if (k === 'd') $('b-drop').click();
  else if (k.startsWith('arrow')) {
    const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    const ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    sloshPulse(d[0] * ca + d[1] * sa, -d[0] * sa + d[1] * ca);
  }
});

// Terminal rise speed of a gas bubble: Stokes' law for small bubbles, capped
// by the inertial regime (~1.6 sqrt(g r)) for millimetre bubbles.
function riseSpeed(liq) {
  const g = 9.81 * state.gravity, r = liq.bubble || 0.0005;
  const stokes = (2 / 9) * liq.rho * g * r * r / (liq.rho * liq.nu);
  return Math.min(stokes, 1.6 * Math.sqrt(g * r));
}
function updateReadout() {
  const liq = LIQUIDS[state.liquid], g = 9.81 * state.gravity;
  const mu = liq.rho * liq.nu * 1000;
  const sl = modal.sloshInfo();
  const cmin = Math.pow(4 * g * liq.sigma / liq.rho, 0.25);
  const bond = liq.rho * g * D.R_IN * D.R_IN / liq.sigma;
  const rows = [
    ['Density', `${liq.rho.toLocaleString()} kg/m³`],
    ['Viscosity', mu < 10 ? `${mu.toFixed(2)} mPa·s` : `${(mu / 1000).toFixed(mu < 1e4 ? 2 : 1)} Pa·s`],
    ['Surface tension', `${(liq.sigma * 1000).toFixed(0)} mN/m`],
    ['Capillary length', `${(men.lc * 1000).toFixed(2)} mm`],
    ['Meniscus at wall', `${men.h > 0 ? '+' : ''}${men.h.toFixed(2)} mm`],
    ['Slowest ripple speed', `${(cmin * 100).toFixed(1)} cm/s`],
    ['Bond number', bond.toFixed(0)],
    ['Slosh', sl.over ? `over-damped (τ ${(1 / sl.decay).toFixed(2)} s)` : `${sl.hz.toFixed(2)} Hz, τ ${(1 / sl.decay).toFixed(1)} s`],
    ['Wave modes', modal.n.toLocaleString()],
  ];
  if (liq.carb) rows.push([liq.boil ? 'Boiling bubbles rise at' : 'Bubbles rise at', `${(riseSpeed(liq) * 100).toFixed(0)} cm/s`]);
  if (liq.foam) rows.push(['Head half-life', liq.halfLife < 60 ? `${liq.halfLife} s` : `${(liq.halfLife / 60).toFixed(0)} min`]);
  if (liq.magnetic) rows.push(['Spike spacing', `${(2 * Math.PI * men.lc * 1000).toFixed(1)} mm`], ['Magnet', state.magnet ? 'on' : 'off']);
  $('readout').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------------------------------------------------------------------------
// Simulation
const swirlEta = new Float64Array(129);
function stepPhysics(dt) {
  simTime += dt;
  const liq = LIQUIDS[state.liquid], add = ADDITIVES[state.additive];
  const g = 9.81 * state.gravity;

  // rod
  if (rod.auto > 0) {
    rod.auto -= dt;
    const w = 2 * Math.PI * 1.1, rr = 0.02;
    rod.goal = [rr * Math.cos(simTime * w), rr * Math.sin(simTime * w)];
    if (!rod.active) { rod.active = true; rod.pos = rod.goal.slice(); }
    if (rod.auto <= 0 && !(drag && drag.mode === 'stir')) rod.active = false;
  }
  const prev = rod.pos.slice(), k = 1 - Math.exp(-dt * 30);
  rod.pos = [rod.pos[0] + (rod.goal[0] - rod.pos[0]) * k, rod.pos[1] + (rod.goal[1] - rod.pos[1]) * k];
  let vx = (rod.pos[0] - prev[0]) / dt, vz = (rod.pos[1] - prev[1]) / dt;
  const sp = Math.hypot(vx, vz), lim = 0.6 / (1 + liq.nu * 2000);
  if (sp > lim) { vx *= lim / sp; vz *= lim / sp; }
  rod.vel = [vx, vz];
  rod.blend += ((rod.active ? 1 : 0) - rod.blend) * (1 - Math.exp(-dt * 12));

  // slosh pulses: push then stop
  let ax = 0, az = 0;
  state.slosh = state.slosh.filter((s) => {
    s.t += dt;
    const f = s.t < 0.12 ? 1 : s.t < 0.24 ? -1 : 0;
    ax += s.dx * s.A * f; az += s.dz * s.A * f;
    return s.t < 0.24;
  });

  // waves
  const n = Math.max(1, Math.round(dt / modal.dt)), sub = dt / n;
  const relV = [rod.vel[0] - rod.fluid[0], rod.vel[1] - rod.fluid[1]];
  const dipole = 0.004 * Math.min(1, 3e-5 / liq.nu + 0.02);
  for (let i = 0; i < n; i++) {
    modal.substep(ax, az);
    if (rod.blend > 0.9) modal.dipole(rod.pos[0], rod.pos[1], relV[0], relV[1], dipole, 0.003, sub);
  }
  if (Math.random() < dt * 3) modal.jitter(2e-6);
  // bursting bubbles: boiling liquid nitrogen churns, fizzy drinks prickle
  if (liq.carb && state.foamH < 0.002) {
    const n = liq.boil ? 3 : 1, amp = liq.boil ? 0.0018 : 0.00025 * liq.carb;
    for (let i = 0; i < n; i++) if (Math.random() < dt * (liq.boil ? 60 : 25)) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * D.R_IN * 0.9;
      modal.impulse(r * Math.cos(a), r * Math.sin(a), amp, liq.boil ? 0.0025 : 0.0012);
    }
  }
  // the foam head drains and coarsens; stirring a fizzy drink whips up more
  if (liq.foam) {
    state.foamH *= Math.pow(0.5, dt / liq.halfLife);
    const stir = rod.blend > 0.8 ? Math.hypot(rod.vel[0] - rod.fluid[0], rod.vel[1] - rod.fluid[1]) : 0;
    if (stir > 0.08) state.foamH = Math.min(liq.foam * 1.2, state.foamH + dt * stir * 0.02);
  }
  modal.setExtraDamping(Math.round(oilDamping() * 40) / 40); // quantised: rebuilding propagators costs ~4 ms
  // frost builds on glass holding a cryogenic liquid
  state.frost += ((liq.vapor === 'fog' ? 1 : 0) - state.frost) * (1 - Math.exp(-dt / (liq.vapor === 'fog' ? 12 : 3)));
  // ferrofluid spikes grow when the magnet is on (and relax when it's off)
  state.spike += ((liq.magnetic && state.magnet ? 7 : 0) - state.spike) * (1 - Math.exp(-dt * (state.magnet ? 3 : 6)));
  const pouring = state.pour > 0;
  if (pouring) {
    const p = state.pourPos, j = () => (Math.random() - 0.5) * 0.003;
    const strength = add.drops ? 0.03 : 0.12;
    modal.impulse(p[0] + j(), p[1] + j(), strength * dt * (add.rho / liq.rho), 0.0024);
  }

  // surface flow
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  const vt = [1 / VRES, 1 / VRES], dtx = [1 / DRES, 1 / DRES];
  const h = 2 * D.R_IN / VRES;
  const tauSpin = Math.min(22, Math.max(0.05, (state.fill ** 2) / (liq.nu * Math.PI ** 2)));
  const visc = Math.min(0.85, 1 - Math.exp(-liq.nu * dt / (h * h)));
  pass(P.advectVel, vel.write, { uVel: vel.read.tex, uDt: dt, uDamp: Math.exp(-dt / tauSpin), uVisc: visc, uTexel: vt }); vel.swap();
  pass(P.curl, curlT, { uVel: vel.read.tex, uTexel: vt });
  pass(P.force, vel.write, {
    uVel: vel.read.tex, uCurl: curlT.tex, uDye: dye.read.tex, uDt: dt, uConf: liq.nu > 1e-5 ? 0 : 1, uTime: simTime, uTexel: vt,
    uSpoon: [rod.pos[0], rod.pos[1], 0.0045, rod.blend > 0.8 ? 1 : 0], uSpoonVel: rod.vel, uKick: [0, 0, 0],
  }); vel.swap();
  pass(P.div, divT, { uVel: vel.read.tex, uDye: dye.read.tex, uTexel: vt });
  mg.solve(pres, divT);
  pass(P.grad, vel.write, { uVel: vel.read.tex, uP: pres.read.tex, uDt: dt, uTexel: vt }); vel.swap();

  // additive transport
  const slow = Math.min(1, Math.pow(1e-6 / liq.nu, 0.35));
  const onMetal = !!liq.metal;
  const sink = add.buoyancy === 'sink' && !onMetal, float = add.buoyancy === 'float' || onMetal;
  const diffuse = onMetal ? 0.03 : Math.max(0.02, 0.22 * slow);
  const decay = onMetal ? 0 : (sink ? 1 / 5 : float ? 1 / 60 : 1 / 16) * Math.max(slow, 0.05);
  const srcGain = onMetal ? 0.8 : sink ? 0.15 : float ? 1.5 : 1;
  const rate = add.drops ? 3.5 : 2.2;
  const cap = onMetal ? 1 : add.drops ? 0.25 : 0.32;
  const oilPouring = pouring && add.immiscible;
  pass(P.advectDye, dyeF, { uVel: vel.read.tex, uSrc: dye.read.tex, uDt: dt, uTexel: dtx });
  pass(P.advectDye, dyeB, { uVel: vel.read.tex, uSrc: dyeF.tex, uDt: -dt, uTexel: dtx });
  pass(P.maccormack, dye.write, {
    uVel: vel.read.tex, uOrig: dye.read.tex, uFwd: dyeF.tex, uBwd: dyeB.tex, uDt: dt, uTime: simTime, uTexel: dtx,
    uPour: pouring && !oilPouring ? [state.pourPos[0], state.pourPos[1], add.drops ? 0.003 : 0.0045, (sink ? 0.4 : rate) * Math.min(1, state.pour * 3)] : [0, 0, 0, 0],
    uOilPour: oilPouring ? [state.pourPos[0], state.pourPos[1], 0.005, 2.0 * Math.min(1, state.pour * 3)] : [0, 0, 0, 0],
    uFoamFromPour: 0,
    uFroth: [0, 0, 0, 0], uDecay: [decay, 0, 0], uDiffuse: perFrame(diffuse, dt), uDiffuseG: perFrame(0.02, dt), uCap: cap, uSrcGain: srcGain,
  }); dye.swap();
  if (pouring) state.pour -= dt;

  // the bulk: 3D flow carrying the additive (sinking, rising, plunging, stirred)
  {
    const [rA, rB] = rodEnds();
    const gp = Math.max(-3, Math.min(3, g * (add.rho - liq.rho) / liq.rho));
    const stirring = rod.blend > 0.8 ? Math.min(1, Math.hypot(...relV) * 4) : 0;
    // the source rate that delivers the additive's volume over the pour
    const r = add.drops ? 0.0013 : sink ? 0.0028 : 0.0024;
    const vLiq = Math.PI * D.R_IN ** 2 * (state.fill - D.INNER_BOTTOM);
    const tIn = state.pourDur * (add.drops ? 0.025 / 0.11 : 1);
    // a drop is a compact blob; a stream penetrates a few centimetres
    const zs = add.drops ? 1.2 : 5;
    const vBlob = Math.PI ** 1.5 * zs * r ** 3;
    // a stream falling ~15 cm hits at sqrt(2 g h) ~ 1.7 m/s: its Reynolds
    // number decides between a billowing turbulent plume (milk) and a
    // coherent laminar rope (honey)
    const Re = Math.sqrt(2 * g * 0.15) * 2 * r / (add.nu || 1e-6);
    const turb = add.drops ? 0 : Math.min(1, Math.max(0, (Re - 800) / 2200));
    const jet = { x: state.pourPos[0], z: state.pourPos[1], r, zs, mix: 0.3 * turb, speed: add.drops ? 0.12 : 0.4, rate: add.amount * vLiq / (tIn * vBlob) };
    mixer.step({
      dt, surfY: state.fill, nu: liq.nu, nuAdd: add.immiscible ? liq.nu : add.nu || liq.nu, gp, time: simTime,
      light: state.poured,
      // (sugars and fats in viscous additives diffuse slowly: sharper edges)
      diff: perFrame((0.004 * slow + 0.02 * stirring) * Math.min(1, Math.pow(1e-6 / (add.nu || 1e-6), 0.25)), dt),
      rod: { a: rA, b: rB, vel: rod.vel, r: D.ROD_R, on: rod.blend > 0.8 },
      // dye falls as separate drops; a pour is a continuous stream
      jet: pouring && !add.immiscible && (!add.drops || (state.pourDur - state.pour) % 0.11 < 0.025) ? jet : null,
    });
  }

  // probe
  if (probe.poll()) probeBuf.set(probe.out);
  pass(P.probe, probeT, { uVel: vel.read.tex, uProbe: rod.pos });
  probe.request(probeT);
  rod.fluid = [probeBuf[512], probeBuf[513]];

  // the swirl carries the waves around (Doppler shift m*Omega)
  { let Lm = 0, I = 0; for (let i = 0; i < 128; i++) { const r = (i + 0.5) / 128 * D.R_IN; Lm += probeBuf[i * 4] * r * r; I += r * r * r; } modal.rotate(Lm / I, dt); }
  // radial profiles: waves + vortex dip + meniscus
  modal.fillProfiles(profiles);
  let acc = 0; swirlEta[0] = 0;
  const dr = D.R_IN / 128;
  for (let i = 0; i < 128; i++) { const u = probeBuf[i * 4], r = (i + 0.5) * dr; acc += (u * u) / (g * r) * dr; swirlEta[i + 1] = acc; }
  let mean = 0;
  for (let i = 0; i <= 128; i++) mean += swirlEta[i] * 2 * i * dr * dr * (i === 0 || i === 128 ? 0.5 : 1);
  mean /= D.R_IN * D.R_IN;
  for (let ir = 0; ir < Nr; ir++) {
    const r = D.R_IN * ir / (Nr - 1), f = r / dr, i = Math.min(127, Math.floor(f)), t = f - i;
    const eta = (swirlEta[i] * (1 - t) + swirlEta[i + 1] * t - mean) * 1000;
    const ub = probeBuf[Math.min(127, Math.max(0, Math.round(f - 0.5))) * 4];
    const e = Math.exp(-(D.R_IN - r) / men.lc);
    profiles[ir * 4 + 1] = eta + men.h * e;
    profiles[ir * 4 + 3] = (r > 1e-4 ? (ub * ub) / (g * r) : 0) + men.h * 0.001 * e / men.lc;
  }
  // steep waves break (short ones first); only a slosh over the rim spills
  modal.breakWaves(dt);
  const wall = modal.wallHeights(profiles, 64, new Float32Array(64));
  let maxH = 0; for (const x of wall) maxH = Math.max(maxH, Math.abs(x));
  const room = Math.max(4, (D.INNER_TOP - state.fill) * 1000 - men.h);
  if (maxH > room) { const s = Math.sqrt(room / maxH); for (let i = 0; i < modal.n; i++) { modal.a[i] *= s; modal.v[i] *= s; } }
  const spec = modal.spectrum();
  stokes.k = Math.min(spec.kMean, 0.3 / Math.max(Math.sqrt(spec.meanH2), 1e-6));
  stokes.h2 = spec.meanH2 * 1e6;
  gl.bindTexture(gl.TEXTURE_2D, profTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Nr, M + 1, gl.RGBA, gl.FLOAT, profiles);
}

// ---------------------------------------------------------------------------
// Rendering
function segMatrix(A, B, r = 1) {
  // cylinder mesh (unit length along +y, radius baked or r) from A to B
  const Y = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], len = Math.hypot(...Y);
  const y = Y.map((v) => v / len);
  let x = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  x = [x[0] - y[0] * d, x[1] - y[1] * d, x[2] - y[2] * d];
  const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return new Float32Array([...x.map((v) => v * r), 0, ...Y, 0, ...z.map((v) => v * r), 0, ...A, 1]);
}
function rodEnds() {
  const restA = [0.07, D.ROD_R, 0.06], restB = [0.24, D.ROD_R, -0.05];
  const s = rod.pos;
  const camH = [Math.sin(cam.az), Math.cos(cam.az)];
  let lean = [-s[0] + camH[0] * 0.02, -s[1] + camH[1] * 0.02];
  const ll = Math.hypot(...lean) || 1; lean = lean.map((v) => v / ll);
  const stirA = [s[0], D.INNER_BOTTOM + 0.006, s[1]];
  const Lr = 0.2, la = 0.28;
  const stirB = [s[0] + lean[0] * Math.sin(la) * Lr, stirA[1] + Math.cos(la) * Lr, s[1] + lean[1] * Math.sin(la) * Lr];
  const b = rod.blend * rod.blend * (3 - 2 * rod.blend);
  const lift = Math.sin(Math.PI * b) * 0.13;
  const mix = (p, q) => p.map((v, i) => v + (q[i] - v) * b + (i === 1 ? lift : 0));
  return [mix(restA, stirA), mix(restB, stirB)];
}

function render() {
  camM = cameraMatrices();
  const liq = LIQUIDS[state.liquid], add = ADDITIVES[state.additive];
  const [rA, rB] = rodEnds();
  const sink = add.buoyancy === 'sink' && !liq.metal, float = add.buoyancy === 'float' || liq.metal;
  const U = {
    uCupPos: [0, 0, 0], uTime: simTime, uWet: wetTex, uCamPos: camM.eye, uViewProj: camM.vp, uSurfY: state.fill,
    uHeight: heightT.tex, uDye: dye.read.tex,
    uSigA: state.base.sigA, uSigS: state.base.sigS, uAddA: add.sigA, uAddS: add.sigS, uF0: liq.f0 || [0, 0, 0],
    uAddBase: state.addTotal, uIor: liq.ior, uMetal: liq.metal ? 1 : 0,
    uConc3: mixer.conc.read.tex, uGC: MX.CG, uSurfGain: sink ? 0.3 : float ? 1 : 0.6, uSurfLayer: float ? 0.002 : 0.0007, uVel3: mixer.vel.read.tex, uLightA: mixer.lightA.tex, uLightB: mixer.lightB.tex,
    uDn: liq.metal || add.immiscible ? 0 : (add.ior || liq.ior) - liq.ior, uRodA: rA, uRodB: rB, uRodIn: rod.blend > 0.6 ? 1 : 0,
    uOilA: ADDITIVES.oil.sigA, uOilS: ADDITIVES.oil.sigS, uHasOil: state.oil > 0 ? 1 : 0,
    uHasAdd: state.poured ? 1 : 0,
    uOilThick: state.oil * (state.fill - D.INNER_BOTTOM),
    uCarb: liq.carb || 0, uBubR: liq.bubble || 0.0005, uRise: liq.carb ? riseSpeed(liq) : 0, uBoil: liq.boil ? 1 : 0,
    uFoamH: state.foamH, uFoamCol: liq.foamCol || [0.95, 0.93, 0.88], uFrost: state.frost,
  };

  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  pass(P.height, heightT, { uProfiles: profTex, uM: { int: M }, uNr: Nr, uSpike: state.spike, uSpikeK: 1 / men.lc, uK2: liq.metal ? 0 : stokes.k, uMeanH2: stokes.h2 });

  gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.fbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.depthMask(false);
  G.use(gl, P.bg, { ...U, uInvViewProj: camM.inv });
  meshes.quad.draw();
  gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);

  const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  G.use(gl, P.bench, { ...U, uModel: I4 });
  meshes.bench.draw();
  G.use(gl, P.rod, { ...U, uModel: segMatrix(rA, rB) });
  meshes.rod.draw();
  if (state.pour > 0) {
    const p = state.pourPos, wob = 0.0006 * Math.sin(simTime * 40);
    const r = add.drops ? 0.0012 : sink ? 0.0028 : 0.0022;
    G.use(gl, P.stream, { ...U, uModel: segMatrix([p[0] + wob, state.fill - 0.002, p[1]], [p[0], state.fill + 0.25, p[1]], r), uStreamA: add.sigA, uStreamS: add.sigS, uStreamR: r, uStreamIor: add.ior || 1.34 });
    meshes.stream.draw();
  }
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  G.use(gl, P.side, U);
  meshes.side.draw();
  gl.disable(gl.CULL_FACE);
  G.use(gl, P.surface, U);
  meshes.surface.draw();

  // glass: back faces, then front faces, premultiplied alpha
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.enable(gl.CULL_FACE);
  G.use(gl, P.glass, U);
  gl.cullFace(gl.FRONT); meshes.glass.draw();
  gl.cullFace(gl.BACK); meshes.glass.draw();
  // steam from hot liquids, cold fog from liquid nitrogen
  if (liq.vapor) {
    gl.disable(gl.DEPTH_TEST);
    gl.cullFace(gl.FRONT);
    G.use(gl, P.vapor, { ...U, uVapor: liq.vapor === 'fog' ? -1 : 1, uBoxMin: VAPOR_BOX.slice(0, 3), uBoxMax: VAPOR_BOX.slice(3) });
    meshes.vapor.draw();
    gl.enable(gl.DEPTH_TEST);
  }
  gl.disable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdr.fbo);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  pass(P.bright, bloomA, { uSrc: hdr.tex, uTexel: [1 / W, 1 / H] });
  pass(P.blur, bloomB, { uSrc: bloomA.tex, uDir: [1 / bloomA.w, 0] });
  pass(P.blur, bloomA, { uSrc: bloomB.tex, uDir: [0, 1 / bloomA.h] });
  pass(P.blur, bloomC, { uSrc: bloomA.tex, uDir: [2 / bloomA.w, 0] });
  pass(P.blur, bloomD, { uSrc: bloomC.tex, uDir: [0, 2 / bloomA.h] });
  pass(P.composite, null, { uHdr: hdr.tex, uBloom1: bloomA.tex, uBloom2: bloomD.tex, uExposure: 1.2, uTime: simTime, uRes: [W, H] });
}

// ---------------------------------------------------------------------------
let last = performance.now(), fpsAcc = 0, fpsN = 0, slowN = 0;
function frame(now) {
  resize();
  const real = Math.max((now - last) / 1000, 1e-4), dt = Math.min(real, 1 / 30);
  last = now;
  if (!camM) camM = cameraMatrices();
  stepPhysics(Math.max(dt, 1 / 240));
  render();
  fpsAcc += real; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc;
    $('fps').textContent = `${Math.round(fps)} fps`;
    slowN = fps < 40 ? slowN + 1 : 0;
    if (slowN >= 4 && quality > 0.5) { quality *= 0.85; W = 0; slowN = 0; }
    fpsAcc = 0; fpsN = 0;
  }
  requestAnimationFrame(frame);
}

fillEl.value = String(Math.round((state.fill - D.INNER_BOTTOM) * Math.PI * D.R_IN * D.R_IN * 1e6 / 5) * 5);
$('fill-v').textContent = `${fillEl.value} ml`;
state.fill = D.INNER_BOTTOM + parseFloat(fillEl.value) * 1e-6 / (Math.PI * D.R_IN * D.R_IN);
setLiquid('water');
resize();
status.style.display = 'none';
window.__lab = {
  advance(sec) { for (let t = 0; t < sec; t += 1 / 60) stepPhysics(1 / 60); },
  state, cam, rod, setLiquid, pour, knock, autoStir, sloshPulse, dropAt, mixer, gl,
  magnet(on) { state.magnet = on; syncUI(); updateReadout(); },
  setAdditive(k) { bakeAdditive(); state.additive = k; syncUI(); },
};
requestAnimationFrame(frame);
