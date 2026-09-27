import { ModalSurface } from './modal.js';
import * as G from './gl.js';
import * as geo from './geometry.js';
import * as S from './shaders.js';

const { mat4 } = G;

// ---------------------------------------------------------------------------
// Scene dimensions (metres). Origin is on the table at the centre of the cup.
const D = {
  R_IN: 0.040, R_OUT: 0.0457, CUP_Y0: 0.006, INNER_BOTTOM: 0.016,
  DEPTH: 0.070, INNER_TOP: 0.0985, RIM_Y: 0.1017, SAUCER_R: 0.0785, SAUCER_H: 0.0152,
  MEN_H: 1.5,  // mm, capillary rise of coffee on glazed ceramic
  MEN_L: 0.0023, // m, capillary length sqrt(sigma / rho g)
};
D.SURF_Y = D.INNER_BOTTOM + D.DEPTH;
const WIN = { AZ: -0.72, EL0: 0.3, EL1: 0.82, AW: 0.3, E: 4.6 };
WIN.ELC = 0.5 * (WIN.EL0 + WIN.EL1);

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const defines = [
  ...Object.entries(D).map(([k, v]) => `#define ${k} ${f(v)}`),
  `#define WIN_AZ ${f(WIN.AZ)}`, `#define WIN_EL0 ${f(WIN.EL0)}`, `#define WIN_EL1 ${f(WIN.EL1)}`,
  `#define WIN_ELC ${f(WIN.ELC)}`, `#define WIN_AW ${f(WIN.AW)}`, `#define WIN_E ${f(WIN.E)}`,
].join('\n');
const HEAD = `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${defines}\n`;
const vs = (src) => HEAD + S.common + src;
const fs = (src) => HEAD + S.common + src;

// ---------------------------------------------------------------------------
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
const status = document.getElementById('status');
function fail(msg) { status.textContent = msg; status.classList.add('err'); throw new Error(msg); }
if (!gl) fail('WebGL2 is not available in this browser.');
if (!gl.getExtension('EXT_color_buffer_float')) fail('This GPU cannot render to float textures (EXT_color_buffer_float).');
const floatLinear = !!gl.getExtension('OES_texture_float_linear');

// ---------------------------------------------------------------------------
// Physics: modal free surface
const modal = new ModalSurface({ R: D.R_IN, H: D.DEPTH, dt: 1 / 240 });
const Nr = modal.Nr, M = modal.M;
const profiles = new Float32Array(Nr * (M + 1) * 4);

// ---------------------------------------------------------------------------
// GPU resources
const L = gl.LINEAR, NEAR = gl.NEAREST;
const RGBA16F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
const RGBA32F = [gl.RGBA32F, gl.RGBA, gl.FLOAT];

const profTex = floatLinear
  ? G.texture(gl, Nr, M + 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, L)
  : G.texture(gl, Nr, M + 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, L);
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
const probeBuf = new Float32Array(129 * 4);

// bubbles
const BW = 64, BH = 48, NB = BW * BH;
function initialBubbles() {
  const data = new Float32Array(NB * 4);
  let i = 0;
  const put = (x, z, r, life) => { if (i < NB) { data.set([x, z, r, life], i * 4); i++; } };
  const rsize = () => Math.exp(Math.log(0.00012) + (Math.log(0.0012) - Math.log(0.00012)) * Math.pow(Math.random(), 2.4));
  // clumps collected against the wall by the meniscus
  for (let c = 0; c < 9; c++) {
    const a = Math.random() * Math.PI * 2, n = 40 + Math.random() * 110;
    const spread = 0.003 + Math.random() * 0.006;
    for (let k = 0; k < n; k++) {
      const aa = a + (Math.random() - 0.5) * spread / D.R_IN * 3;
      const rr = D.R_IN - 0.0006 - Math.abs(randn()) * spread * 0.5;
      put(rr * Math.cos(aa), rr * Math.sin(aa), rsize(), 40 + Math.random() * 200);
    }
  }
  // a few loners
  for (let k = 0; k < 25; k++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * D.R_IN * 0.95;
    put(rr * Math.cos(a), rr * Math.sin(a), rsize(), 20 + Math.random() * 100);
  }
  return data;
}
function randn() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random()); }
const bub = G.pingpong(gl, BW, BH, ...RGBA32F, NEAR, initialBubbles());

const wetData = new Float32Array(128 * 4);
const wetTex = G.texture(gl, 128, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, L, null, gl.REPEAT);

// ---------------------------------------------------------------------------
// Programs
const P = {
  bg: G.program(gl, vs(S.bgVS), fs(S.bgFS)),
  ceramic: G.program(gl, vs(S.meshVS), fs(S.ceramicFS)),
  table: G.program(gl, vs(S.meshVS), fs(S.tableFS)),
  spoon: G.program(gl, vs(S.meshVS), fs(S.spoonFS)),
  coffee: G.program(gl, vs(S.coffeeVS), fs(S.coffeeFS)),
  height: G.program(gl, vs(S.fsVS), fs(S.heightFS)),
  advectVel: G.program(gl, vs(S.fsVS), fs(S.advectVelFS)),
  curl: G.program(gl, vs(S.fsVS), fs(S.curlFS)),
  force: G.program(gl, vs(S.fsVS), fs(S.forceFS)),
  div: G.program(gl, vs(S.fsVS), fs(S.divFS)),
  jacobi: G.program(gl, vs(S.fsVS), fs(S.jacobiFS)),
  grad: G.program(gl, vs(S.fsVS), fs(S.gradFS)),
  advectDye: G.program(gl, vs(S.fsVS), fs(S.advectDyeFS)),
  maccormack: G.program(gl, vs(S.fsVS), fs(S.maccormackFS)),
  probe: G.program(gl, vs(S.fsVS), fs(S.probeFS)),
  bubbleUpdate: G.program(gl, vs(S.fsVS), fs(S.bubbleUpdateFS)),
  bubble: G.program(gl, vs(S.bubbleVS), fs(S.bubbleFS)),
  steam: G.program(gl, vs(S.steamVS), fs(S.steamFS)),
  bright: G.program(gl, vs(S.fsVS), fs(S.brightFS)),
  blur: G.program(gl, vs(S.fsVS), fs(S.blurFS)),
  composite: G.program(gl, vs(S.fsVS), fs(S.compositeFS)),
};

// ---------------------------------------------------------------------------
// Meshes
const cupProfile = geo.smooth([
  [0, 0.0045], [0.028, 0.0045], [0.0335, 0.0038], [0.0358, 0.0006], [0.0372, 0], [0.0392, 0], [0.0412, 0.0012],
  [0.0438, 0.0055], [0.0452, 0.013], [0.0457, 0.024], [0.0457, 0.06], [0.0457, 0.0885], [0.0459, 0.0932],
  [0.0452, 0.0951], [0.0439, 0.0957], [0.0423, 0.0953], [0.0409, 0.0938], [0.0401, 0.0912], [0.0400, 0.0885],
  [0.0400, 0.05], [0.0400, 0.0185], [0.0393, 0.0128], [0.0368, 0.0104], [0.031, 0.0100], [0, 0.0100],
].map(([r, y]) => [r, y + D.CUP_Y0]), 5);
const saucerProfile = geo.smooth([
  [0, 0.0024], [0.039, 0.0024], [0.0425, 0.0014], [0.0445, 0], [0.049, 0], [0.051, 0.0016], [0.061, 0.0062],
  [0.072, 0.0108], [0.0772, 0.0131], [0.0787, 0.0143], [0.0781, 0.0153], [0.0764, 0.0152], [0.0705, 0.0129],
  [0.0605, 0.0093], [0.0525, 0.0068], [0.047, 0.00605], [0.03, 0.006], [0, 0.006],
], 5);
const handlePath = [];
{
  const cx = 0.0455, cy = 0.056, ax = 0.029, ay = 0.0255, p = 2.6;
  handlePath.push([0.041, 0.0835, 1.2]);
  for (let i = 0; i <= 60; i++) {
    const t = Math.PI / 2 - (i / 60) * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const x = cx + ax * Math.sign(c) * Math.pow(Math.abs(c), 2 / p);
    const y = cy + ay * Math.sign(s) * Math.pow(Math.abs(s), 2 / p) * (1 - 0.08 * (1 - s));
    const taper = 1 + 0.18 * Math.pow(Math.abs(s), 6);
    handlePath.push([x, y, taper]);
  }
  handlePath.push([0.041, 0.0262, 1.2]);
}
const meshes = {
  cup: G.mesh(gl, geo.lathe(cupProfile, 160)),
  saucer: G.mesh(gl, geo.lathe(saucerProfile, 160)),
  handle: G.mesh(gl, geo.tube(handlePath, 0.0042, 0.0062, 40)),
  spoon: G.mesh(gl, geo.teaspoon()),
  coffee: G.mesh(gl, geo.polarDisk(D.R_IN + 0.0004, 200, 384)),
  table: G.mesh(gl, geo.plane(4)),
  quad: G.mesh(gl, geo.quad()),
  bubble: G.mesh(gl, geo.quad()),
};
const STEAM_BOX = [-0.07, D.SURF_Y - 0.002, -0.07, 0.07, D.RIM_Y + 0.17, 0.07];
meshes.steam = G.mesh(gl, geo.box(...STEAM_BOX));

// ---------------------------------------------------------------------------
// Render targets for the frame
let quality = 1;
let W = 0, H = 0, msaa = null, hdr = null, bloomA = null, bloomB = null, bloomC = null, bloomD = null;
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

// ---------------------------------------------------------------------------
// Interaction & simulation state
const cam = { az: 0.55, el: 0.6, dist: 0.36, target: [0, 0.066, 0] };
const cup = { pos: [0, 0, 0], vel: [0, 0], target: [0, 0], acc: [0, 0] };
const spoon = {
  active: false, auto: 0, pos: [0.0, 0.0], vel: [0, 0], blend: 0, faceAng: 0, faceVec: [1, 0],
  goal: [0, 0], fluid: [0, 0],
};
const events = { pour: 0, pourPos: [0, 0], milkBase: 0, milkTarget: 0, knockKick: 0, spawn: null, froth: 0 };
let steamOn = true;
let simTime = 0;
const wet = { top: new Float32Array(128).fill(D.MEN_H), g: new Float32Array(128), heights: new Float32Array(128) };

function cameraMatrices() {
  const ce = Math.cos(cam.el);
  const t = [cam.target[0] + cup.pos[0] * 0.8, cam.target[1], cam.target[2] + cup.pos[2] * 0.8];
  const eye = [t[0] + cam.dist * Math.sin(cam.az) * ce, t[1] + cam.dist * Math.sin(cam.el), t[2] + cam.dist * Math.cos(cam.az) * ce];
  const view = mat4.lookAt(eye, t, [0, 1, 0]);
  const proj = mat4.perspective(28 * Math.PI / 180, W / H, 0.01, 20);
  const vp = mat4.mul(proj, view);
  return { eye, view, proj, vp, inv: mat4.invert(vp) };
}
let camM = null;

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
  if (t < 0) return null;
  return [ray.o[0] + ray.d[0] * t, ray.o[2] + ray.d[2] * t];
}

let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const ray = rayFromEvent(e);
  const s = hitPlane(ray, D.SURF_Y);
  const local = s && [s[0] - cup.pos[0], s[1] - cup.pos[2]];
  const onCoffee = local && Math.hypot(local[0], local[1]) < D.R_IN * 0.98;
  const tbl = hitPlane(ray, 0.05);
  const onCup = !onCoffee && tbl && Math.hypot(tbl[0] - cup.pos[0], tbl[1] - cup.pos[2]) < 0.075;
  if (e.button === 2 || e.shiftKey && !onCup) drag = { mode: 'orbit', x: e.clientX, y: e.clientY };
  else if (onCoffee && e.button === 0) {
    drag = { mode: 'stir', t0: performance.now(), x: e.clientX, y: e.clientY, moved: 0, start: local };
    spoon.goal = clampStir(local);
  } else if (onCup && e.button === 0) {
    drag = { mode: 'slide', grab: [tbl[0] - cup.target[0], tbl[1] - cup.target[1]] };
  } else drag = { mode: 'orbit', x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.mode === 'orbit') {
    cam.az -= (e.clientX - drag.x) * 0.006;
    cam.el = Math.min(1.45, Math.max(0.12, cam.el + (e.clientY - drag.y) * 0.005));
    drag.x = e.clientX; drag.y = e.clientY;
  } else if (drag.mode === 'stir') {
    drag.moved += Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
    const s = hitPlane(rayFromEvent(e), D.SURF_Y);
    if (s) spoon.goal = clampStir([s[0] - cup.pos[0], s[1] - cup.pos[2]]);
    if (drag.moved > 6 && !spoon.active) { spoon.active = true; spoon.pos = spoon.goal.slice(); }
  } else if (drag.mode === 'slide') {
    const p = hitPlane(rayFromEvent(e), 0.05);
    if (p) {
      cup.target = [p[0] - drag.grab[0], p[1] - drag.grab[1]];
      const l = Math.hypot(...cup.target);
      if (l > 0.25) cup.target = cup.target.map((v) => v * 0.25 / l);
    }
  }
});
const endDrag = () => {
  if (drag && drag.mode === 'stir' && drag.moved <= 6 && performance.now() - drag.t0 < 400) drop(drag.start, 0.55);
  if (drag && drag.mode === 'stir') spoon.active = false;
  drag = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.min(0.9, Math.max(0.13, cam.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

function clampStir(p) {
  const r = Math.hypot(p[0], p[1]), lim = D.R_IN - 0.009;
  return r > lim ? [p[0] * lim / r, p[1] * lim / r] : p;
}

// ---- actions ----
function drop(p, strength = 1) {
  modal.impulse(p[0], p[1], 0.012 * strength, 0.0035);
  events.spawn = [p[0], p[1], 0.004, 0.006 * strength];
}
function sugar() {
  const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * D.R_IN * 0.6;
  const p = [r * Math.cos(a), r * Math.sin(a)];
  modal.impulse(p[0], p[1], 0.03, 0.0055);
  events.spawn = [p[0], p[1], 0.006, 0.02];
}
function pourMilk() {
  events.pour = 1.4;
  const a = Math.random() * Math.PI * 2, r = Math.random() * 0.012;
  events.pourPos = [r * Math.cos(a), r * Math.sin(a)];
  events.milkTarget = Math.min(0.3, events.milkTarget + 0.045);
}
function knock() {
  const a = cam.az + Math.PI + (Math.random() - 0.5);
  modal.knock(0.12, Math.sin(a), Math.cos(a));
}
function autoStir() { spoon.auto = 4.5; }
function reset() {
  modal.reset();
  for (const t of [vel.read, vel.write, pres.read, pres.write, dye.read, dye.write]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindTexture(gl.TEXTURE_2D, bub.read.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BW, BH, gl.RGBA, gl.FLOAT, initialBubbles());
  events.milkBase = events.milkTarget = 0; events.pour = 0;
  cup.target = [0, 0];
  wet.top.fill(D.MEN_H); wet.g.fill(0);
}
const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
bind('b-stir', autoStir); bind('b-milk', pourMilk); bind('b-sugar', sugar); bind('b-knock', knock); bind('b-reset', reset);
bind('b-steam', (e) => { steamOn = !steamOn; e.currentTarget.classList.toggle('off', !steamOn); });
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 's') autoStir(); else if (k === 'm') pourMilk(); else if (k === 'd') sugar(); else if (k === 'k') knock(); else if (k === 'r') reset();
  else if (k.startsWith('arrow')) {
    const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    // push relative to the camera
    const ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    cup.target[0] += (d[0] * ca + d[1] * sa) * 0.04;
    cup.target[1] += (-d[0] * sa + d[1] * ca) * 0.04;
  }
});

// ---------------------------------------------------------------------------
// Simulation step
const probeX = [];
for (let i = 0; i < 128; i++) probeX.push((i + 0.5) / 128 * D.R_IN);

function updateSpoon(dt) {
  if (spoon.auto > 0) {
    spoon.auto -= dt;
    const w = 2 * Math.PI * 1.25, rr = 0.021;
    spoon.goal = [rr * Math.cos(simTime * w), rr * Math.sin(simTime * w)];
    if (!spoon.active) { spoon.active = true; spoon.pos = spoon.goal.slice(); }
    if (spoon.auto <= 0 && !(drag && drag.mode === 'stir')) spoon.active = false;
  }
  const prev = spoon.pos.slice();
  // hand dynamics: follow the pointer with a short lag
  const k = 1 - Math.exp(-dt * 30);
  spoon.pos[0] += (spoon.goal[0] - spoon.pos[0]) * k;
  spoon.pos[1] += (spoon.goal[1] - spoon.pos[1]) * k;
  const vx = (spoon.pos[0] - prev[0]) / dt, vz = (spoon.pos[1] - prev[1]) / dt;
  const lim = 0.6, sp = Math.hypot(vx, vz);
  spoon.vel = sp > lim ? [vx * lim / sp, vz * lim / sp] : [vx, vz];
  spoon.blend += ((spoon.active ? 1 : 0) - spoon.blend) * (1 - Math.exp(-dt * 12));
  if (Math.hypot(...spoon.vel) > 0.02) {
    const l = Math.hypot(...spoon.vel);
    const t = [spoon.vel[0] / l, spoon.vel[1] / l];
    const kk = 1 - Math.exp(-dt * 10);
    spoon.faceVec = [spoon.faceVec[0] + (t[0] - spoon.faceVec[0]) * kk, spoon.faceVec[1] + (t[1] - spoon.faceVec[1]) * kk];
  }
}

function updateCup(dt) {
  const w = 16;
  const ax = w * w * (cup.target[0] - cup.pos[0]) - 2 * w * cup.vel[0];
  const az = w * w * (cup.target[1] - cup.pos[2]) - 2 * w * cup.vel[1];
  const lim = 25, l = Math.hypot(ax, az);
  cup.acc = l > lim ? [ax * lim / l, az * lim / l] : [ax, az];
  cup.vel[0] += cup.acc[0] * dt; cup.vel[1] += cup.acc[1] * dt;
  cup.pos[0] += cup.vel[0] * dt; cup.pos[2] += cup.vel[1] * dt;
}

function stepPhysics(dt) {
  simTime += dt;
  updateSpoon(dt);
  updateCup(dt);

  // --- waves (CPU) ---
  const n = Math.max(1, Math.round(dt / modal.dt));
  const sub = dt / n;
  const relV = [spoon.vel[0] - spoon.fluid[0], spoon.vel[1] - spoon.fluid[1]];
  for (let i = 0; i < n; i++) {
    modal.substep(cup.acc[0], cup.acc[1]);
    if (spoon.blend > 0.9) modal.dipole(spoon.pos[0], spoon.pos[1], relV[0], relV[1], 0.004, 0.0035, sub);
  }
  if (Math.random() < dt * 3) modal.jitter(2e-6);
  if (events.pour > 0) {
    // the falling stream hits the surface: a noisy train of small impacts
    const p = events.pourPos;
    const j = () => (Math.random() - 0.5) * 0.004;
    modal.impulse(p[0] + j(), p[1] + j(), 0.12 * dt * Math.min(1, events.pour), 0.0026);
  }

  // --- surface flow (GPU) ---
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  const vt = [1 / VRES, 1 / VRES], dtx = [1 / DRES, 1 / DRES];
  pass(P.advectVel, vel.write, { uVel: vel.read.tex, uDt: dt, uDamp: Math.exp(-dt / 22), uTexel: vt }); vel.swap();
  pass(P.curl, curlT, { uVel: vel.read.tex, uTexel: vt });
  const kick = events.knockKick; events.knockKick = 0;
  pass(P.force, vel.write, {
    uVel: vel.read.tex, uCurl: curlT.tex, uDye: dye.read.tex, uDt: dt, uConf: 1.0, uTime: simTime, uTexel: vt,
    uSpoon: [spoon.pos[0], spoon.pos[1], 0.0055, spoon.blend > 0.8 ? 1 : 0], uSpoonVel: spoon.vel, uKick: [0, 0, kick],
  }); vel.swap();
  pass(P.div, divT, { uVel: vel.read.tex, uDye: dye.read.tex, uTexel: vt });
  for (let i = 0; i < 36; i++) { pass(P.jacobi, pres.write, { uP: pres.read.tex, uDiv: divT.tex, uTexel: vt }); pres.swap(); }
  pass(P.grad, vel.write, { uVel: vel.read.tex, uP: pres.read.tex, uDt: dt, uTexel: vt }); vel.swap();

  // dye: MacCormack advection
  pass(P.advectDye, dyeF, { uVel: vel.read.tex, uSrc: dye.read.tex, uDt: dt, uTexel: dtx });
  pass(P.advectDye, dyeB, { uVel: vel.read.tex, uSrc: dyeF.tex, uDt: -dt, uTexel: dtx });
  const pouring = events.pour > 0;
  const stirSpeed = Math.hypot(...relV);
  pass(P.maccormack, dye.write, {
    uVel: vel.read.tex, uOrig: dye.read.tex, uFwd: dyeF.tex, uBwd: dyeB.tex, uDt: dt, uTime: simTime, uTexel: dtx,
    uPour: pouring ? [events.pourPos[0], events.pourPos[1], 0.0045, 2.2 * Math.min(1, events.pour)] : [0, 0, 0, 0],
    uFroth: spoon.blend > 0.8 && stirSpeed > 0.15 ? [spoon.pos[0], spoon.pos[1], 0.004, (stirSpeed - 0.15) * 3] : [0, 0, 0, 0],
    uDecay: [1 / 16, 1 / 45, 0],
  }); dye.swap();
  if (pouring) {
    events.pour -= dt;
    events.pourPos[0] += (Math.random() - 0.5) * 0.002; events.pourPos[1] += (Math.random() - 0.5) * 0.002;
  }
  events.milkBase += (events.milkTarget - events.milkBase) * (1 - Math.exp(-dt / 7));

  // bubbles
  let spawn = events.spawn; events.spawn = null;
  if (!spawn && pouring) spawn = [events.pourPos[0], events.pourPos[1], 0.009, 0.0012];
  if (!spawn && spoon.blend > 0.8 && stirSpeed > 0.12) spawn = [spoon.pos[0], spoon.pos[1], 0.005, 0.0015 * stirSpeed * 4];
  pass(P.bubbleUpdate, bub.write, { uState: bub.read.tex, uVel: vel.read.tex, uDt: dt, uTime: simTime, uSpawn: spawn || [0, 0, 0, 0] }); bub.swap();

  // probe: swirl profile + flow at the spoon
  pass(P.probe, probeT, { uVel: vel.read.tex, uProbe: spoon.pos });
  gl.readPixels(0, 0, 129, 1, gl.RGBA, gl.FLOAT, probeBuf);
  spoon.fluid = [probeBuf[128 * 4], probeBuf[128 * 4 + 1]];

  buildProfiles(dt);
}

// Combine modal waves, the static meniscus and the vortex dip into the
// per-order radial profile texture, and track the wet film on the wall.
const swirlEta = new Float64Array(129);
function buildProfiles(dt) {
  modal.fillProfiles(profiles);
  // vortex dip: d(eta)/dr = u_theta^2 / (g r), zero mean over the disk
  let acc = 0;
  swirlEta[0] = 0;
  const dr = D.R_IN / 128;
  for (let i = 0; i < 128; i++) {
    const u = probeBuf[i * 4], r = probeX[i];
    acc += (u * u) / (9.81 * r) * dr;
    swirlEta[i + 1] = acc;
  }
  let mean = 0;
  for (let i = 0; i <= 128; i++) { const r = i * dr; mean += swirlEta[i] * 2 * r * dr * (i === 0 || i === 128 ? 0.5 : 1); }
  mean /= D.R_IN * D.R_IN;
  for (let ir = 0; ir < Nr; ir++) {
    const r = D.R_IN * ir / (Nr - 1);
    const f = r / dr, i = Math.min(127, Math.floor(f)), t = f - i;
    const eta = (swirlEta[i] * (1 - t) + swirlEta[i + 1] * t - mean) * 1000;
    const ub = probeBuf[Math.min(127, Math.max(0, Math.round(f - 0.5))) * 4];
    const slope = r > 1e-4 ? (ub * ub) / (9.81 * r) : 0;
    const men = Math.exp(-(D.R_IN - r) / D.MEN_L);
    const o = ir * 4;
    profiles[o] += eta + D.MEN_H * men;
    profiles[o + 2] += slope + D.MEN_H * 0.001 * men / D.MEN_L;
  }
  // wave amplitude limiter (a real cup would spill / break the waves)
  modal.wallHeights(profiles, 128, wet.heights);
  let maxH = 0;
  for (let i = 0; i < 128; i++) maxH = Math.max(maxH, Math.abs(wet.heights[i] - D.MEN_H));
  if (maxH > 9) { const s = Math.pow(9 / maxH, 0.5); for (let i = 0; i < modal.n; i++) { modal.a[i] *= s; modal.v[i] *= s; } }
  for (let i = 0; i < 128; i++) {
    const hgt = wet.heights[i];
    if (hgt >= wet.top[i] - 0.05) { wet.top[i] = hgt; wet.g[i] = 1; }
    else {
      wet.top[i] = Math.max(hgt, wet.top[i] - dt * (0.25 + 0.6 * wet.g[i]));
      wet.g[i] *= Math.exp(-dt / 9);
    }
    wetData[i * 4] = wet.top[i]; wetData[i * 4 + 1] = wet.g[i];
  }
  gl.bindTexture(gl.TEXTURE_2D, wetTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RGBA, gl.FLOAT, wetData);
  gl.bindTexture(gl.TEXTURE_2D, profTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Nr, M + 1, gl.RGBA, gl.FLOAT, profiles);
}

// ---------------------------------------------------------------------------
// Spoon pose: resting on the saucer, or held upright in the coffee.
function basisMatrix(X, Y, T) {
  const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
  return new Float32Array([...X, 0, ...Y, 0, ...Z, 0, ...T, 1]);
}
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
function spoonPose() {
  // rest pose: lying on the saucer tangent to the cup, bowl up
  const phi = Math.PI / 2 + 0.3, pitch = 0.0;
  const dr = [Math.cos(phi), 0, Math.sin(phi)], tg = [-dr[2], 0, dr[0]].map((v) => -v);
  const Xr = norm([tg[0] * Math.cos(pitch), Math.sin(pitch), tg[2] * Math.cos(pitch)]);
  const Yr0 = norm([-Xr[0] * Xr[1], 1 - Xr[1] * Xr[1], -Xr[2] * Xr[1]]);
  const bowlR = 0.0625, bowlY = 0.0156;
  const Tr = [dr[0] * bowlR - Xr[0] * 0.022, bowlY - Xr[1] * 0.022, dr[2] * bowlR - Xr[2] * 0.022];
  // stirring pose
  const s = spoon.pos;
  const camH = [Math.sin(cam.az), Math.cos(cam.az)];
  let lean = [-s[0] + camH[0] * 0.02, -s[1] + camH[1] * 0.02];
  const ll = Math.hypot(...lean) || 1; lean = [lean[0] / ll, lean[1] / ll];
  const la = 0.32;
  const Xs = norm([lean[0] * Math.sin(la), Math.cos(la), lean[1] * Math.sin(la)]);
  let F = [spoon.faceVec[0], 0, spoon.faceVec[1]];
  const dp = F[0] * Xs[0] + F[2] * Xs[2];
  let Ys = [F[0] - Xs[0] * dp, -Xs[1] * dp, F[2] - Xs[2] * dp];
  if (Math.hypot(...Ys) < 1e-3) Ys = [1, 0, 0];
  Ys = norm(Ys);
  const bowlC = [s[0], D.SURF_Y - 0.036, s[1]];
  const Ts = [bowlC[0] - Xs[0] * 0.022, bowlC[1] - Xs[1] * 0.022, bowlC[2] - Xs[2] * 0.022];
  const b = spoon.blend * spoon.blend * (3 - 2 * spoon.blend);
  // lift out of the cup on the way between the poses
  const lift = Math.sin(Math.PI * b) * 0.07;
  const mix = (a, c) => a.map((v, i) => v + (c[i] - v) * b);
  const X = norm(mix(Xr, Xs));
  let Y = mix(Yr0, Ys);
  const d2 = Y[0] * X[0] + Y[1] * X[1] + Y[2] * X[2];
  Y = norm([Y[0] - X[0] * d2, Y[1] - X[1] * d2, Y[2] - X[2] * d2]);
  const T = mix(Tr, Ts); T[1] += lift;
  return basisMatrix(X, Y, T);
}

// ---------------------------------------------------------------------------
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const handleM = rotY(-0.55);

function render() {
  camM = cameraMatrices();
  const common = { uCupPos: cup.pos, uTime: simTime, uWet: wetTex, uCamPos: camM.eye, uViewProj: camM.vp };

  // mode sum -> height field
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  pass(P.height, heightT, { uProfiles: profTex, uM: { int: M }, uNr: Nr });

  gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.fbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  G.use(gl, P.bg, { ...common, uInvViewProj: camM.inv });
  gl.depthMask(false);
  meshes.quad.draw();
  gl.depthMask(true);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  G.use(gl, P.table, { ...common, uModel: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cup.pos[0], 0, -cup.pos[2], 1]) });
  meshes.table.draw();

  G.use(gl, P.ceramic, { ...common, uModel: I4, uInteriorCheck: 0 });
  meshes.saucer.draw();
  G.use(gl, P.ceramic, { ...common, uModel: I4, uInteriorCheck: 1 });
  meshes.cup.draw();
  G.use(gl, P.ceramic, { ...common, uModel: handleM, uInteriorCheck: 0 });
  meshes.handle.draw();

  G.use(gl, P.spoon, { ...common, uModel: spoonPose() });
  meshes.spoon.draw();

  G.use(gl, P.coffee, { ...common, uHeight: heightT.tex, uDye: dye.read.tex, uMilkBase: events.milkBase });
  meshes.coffee.draw();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  G.use(gl, P.bubble, { ...common, uView: camM.view, uState: bub.read.tex, uHeight: heightT.tex, uDye: dye.read.tex, uMilkBase: events.milkBase });
  meshes.bubble.drawInstanced(NB);

  if (steamOn) {
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
    G.use(gl, P.steam, { ...common, uSteam: 1, uBoxMin: STEAM_BOX.slice(0, 3), uBoxMax: STEAM_BOX.slice(3) });
    meshes.steam.draw();
    gl.disable(gl.CULL_FACE);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  // resolve MSAA
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdr.fbo);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);

  // bloom
  pass(P.bright, bloomA, { uSrc: hdr.tex, uTexel: [1 / W, 1 / H] });
  pass(P.blur, bloomB, { uSrc: bloomA.tex, uDir: [1 / bloomA.w, 0] });
  pass(P.blur, bloomA, { uSrc: bloomB.tex, uDir: [0, 1 / bloomA.h] });
  pass(P.blur, bloomC, { uSrc: bloomA.tex, uDir: [2 / bloomA.w, 0] });
  pass(P.blur, bloomD, { uSrc: bloomC.tex, uDir: [0, 2 / bloomA.h] });
  pass(P.composite, null, { uHdr: hdr.tex, uBloom1: bloomA.tex, uBloom2: bloomD.tex, uExposure: 1.25, uTime: simTime, uRes: [W, H] });
}

// ---------------------------------------------------------------------------
let last = performance.now(), fpsAcc = 0, fpsN = 0, slow = 0;
const fpsEl = document.getElementById('fps');
function frame(now) {
  resize();
  const real = Math.max((now - last) / 1000, 1e-4);
  const dt = Math.min(real, 1 / 30);
  last = now;
  if (!camM) camM = cameraMatrices();
  stepPhysics(Math.max(dt, 1 / 240));
  render();
  fpsAcc += real; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc;
    if (fpsEl) fpsEl.textContent = `${Math.round(fps)} fps · ${modal.n} wave modes`;
    // adaptive resolution for slower GPUs
    slow = fps < 40 ? slow + 1 : 0;
    if (slow >= 4 && quality > 0.5) { quality *= 0.85; W = 0; slow = 0; }
    fpsAcc = 0; fpsN = 0;
  }
  requestAnimationFrame(frame);
}
resize();
status.textContent = '';
status.style.display = 'none';
window.__sim = { advance(sec) { for (let t = 0; t < sec; t += 1 / 60) stepPhysics(1 / 60); }, modal, cam, cup, spoon, events, pourMilk, sugar, knock, autoStir, drop, reset, stepPhysics, render };
requestAnimationFrame(frame);
