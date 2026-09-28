import * as G from './gl.js';

// Real 3D mixing for the lab beaker: an incompressible Boussinesq flow on a
// 40 x 40 x 64 grid carrying the additive's volume fraction on a finer
// 80 x 80 x 128 grid. Both 3D grids live in 2D texture atlases (one N x N
// tile per horizontal layer) so every pass is a single full-screen draw.
//
//   - the pour enters as a jet with its own momentum,
//   - denser additives sink and lighter ones rise (buoyancy g' = g Δρ/ρ),
//   - the stirring rod drags the liquid along its whole immersed length,
//   - friction on the floor and wall spins the swirl down and drives the
//     secondary "tea-leaf" circulation (inward on the floor, up the middle),
//   - pressure: red-black SOR; the surface is a rigid lid (the waves are
//     handled by the modal solver),
//   - the additive is advected with MacCormack + a monotone limiter.

export const VG = [40, 64, 8];    // velocity grid: N, layers, tiles per atlas row
export const CG = [80, 128, 16];  // concentration grid

// GLSL helpers for a 3D grid stored as an atlas; g = (N, NY, tiles per row).
export const grid3 = /* glsl */ `
uniform vec3 uG;     // this pass's grid
uniform vec3 uGV;    // velocity grid
uniform vec3 uGC;    // concentration grid
vec2 atlasSize(vec3 g) { return vec2(g.x * g.z, g.x * ceil(g.y / g.z)); }
vec3 cellSize(vec3 g) { return vec3(2.0 * R_IN / g.x, (INNER_TOP - INNER_BOTTOM) / g.y, 2.0 * R_IN / g.x); }
ivec3 cellOf(vec2 frag, vec3 g) {
  ivec2 f = ivec2(frag); int n = int(g.x), tpr = int(g.z);
  ivec2 t = f / n;
  return ivec3(f.x - t.x * n, t.y * tpr + t.x, f.y - t.y * n);
}
vec3 cellPos(ivec3 c, vec3 g) { return vec3(-R_IN, INNER_BOTTOM, -R_IN) + (vec3(c) + 0.5) * cellSize(g); }
// highest layer whose centre is under the free surface
float topLayer(vec3 g) { return max(floor((SURF_Y - INNER_BOTTOM) / cellSize(g).y - 0.5), 0.0); }
bool solid(ivec3 c, vec3 g) {
  vec3 p = cellPos(c, g);
  return c.y < 0 || c.x < 0 || c.z < 0 || c.x >= int(g.x) || c.z >= int(g.x) || length(p.xz) > R_IN;
}
bool air(ivec3 c, vec3 g) { return float(c.y) > topLayer(g); }
vec4 fetch3(sampler2D t, ivec3 c, vec3 g) {
  int n = int(g.x), tpr = int(g.z);
  c = clamp(c, ivec3(0), ivec3(n - 1, int(g.y) - 1, n - 1));
  return texelFetch(t, ivec2((c.y % tpr) * n + c.x, (c.y / tpr) * n + c.z), 0);
}
// trilinear sample at a world position (bilinear in the tile, lerp across layers);
// clamped below the free surface so the top layer extends up to it
vec4 sample3(sampler2D t, vec3 pos, vec3 g) {
  vec3 c = (pos - vec3(-R_IN, INNER_BOTTOM, -R_IN)) / cellSize(g) - 0.5;
  c = clamp(c, vec3(0.0), vec3(g.x - 1.0, topLayer(g), g.x - 1.0));
  float j0 = floor(c.y), f = c.y - j0, j1 = min(j0 + 1.0, g.y - 1.0);
  vec2 A = atlasSize(g);
  vec2 o0 = vec2(mod(j0, g.z), floor(j0 / g.z)) * g.x, o1 = vec2(mod(j1, g.z), floor(j1 / g.z)) * g.x;
  return mix(texture(t, (o0 + c.xz + 0.5) / A), texture(t, (o1 + c.xz + 0.5) / A), f);
}
`;

const head = /* glsl */ `
in vec2 vUv;
out vec4 o;
`;

// velocity: advection + forces
export const vAdvectFS = head + grid3 + /* glsl */ `
uniform sampler2D uVel3, uConc3;
uniform float uDt, uGp, uVisc, uDrag, uCreep;
uniform vec3 uRodA, uRodB;
uniform vec4 uRod;        // vx, vz, radius, active
uniform vec4 uJet;        // x, z, radius, downward speed (0 = off)
uniform float uJetMix;    // > 0: a turbulent stream; 0: separate drops
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  if (solid(c, uG) || air(c, uG)) { o = vec4(0.0); return; }
  vec3 p = cellPos(c, uG), h = cellSize(uG);
  vec3 u0 = fetch3(uVel3, c, uG).xyz;
  // semi-Lagrangian (midpoint) backtrace
  vec3 mid = p - 0.5 * uDt * u0;
  vec3 u = sample3(uVel3, p - uDt * sample3(uVel3, mid, uG).xyz, uG).xyz;
  // viscosity: relax towards the neighbour mean (walls count as no-slip)
  vec3 nb = vec3(0.0);
  for (int a = 0; a < 3; a++) for (int s = -1; s <= 1; s += 2) {
    ivec3 e = ivec3(0); e[a] = s;
    ivec3 q = c + e;
    nb += solid(q, uG) ? vec3(0.0) : air(q, uG) ? u0 : fetch3(uVel3, q, uG).xyz;
  }
  u = mix(u, nb / 6.0, uVisc);
  // buoyancy of the additive
  u.y -= uGp * sample3(uConc3, p, uGC).x * uDt;
  // the rod: a cylinder dragging the liquid with it
  if (uRod.w > 0.5) {
    vec3 ab = uRodB - uRodA;
    float t = clamp(dot(p - uRodA, ab) / dot(ab, ab), 0.0, 1.0);
    float d = length(p - (uRodA + t * ab));
    float k = exp(-pow(d / (uRod.z + 0.6 * h.x), 2.0));
    u.xz = mix(u.xz, uRod.xy, k * (1.0 - exp(-uDt * 60.0)));
  }
  // the poured stream plunges in as a turbulent round jet: it spreads at
  // ~12 degrees and slows as it entrains the water around it (momentum flux
  // is conserved, so the centreline speed falls as 1/width)
  if (uJet.w > 0.0) {
    float depth = SURF_Y - p.y, r0 = max(uJet.z, 0.7 * h.x);
    float b = r0 + 0.2 * depth, wc = uJet.w * r0 / b;
    float k = exp(-pow(length(p.xz - uJet.xy) / b, 2.0)) * smoothstep(0.0, 0.002, depth);
    // (a drop only punches ~1 cm in; the vortex ring carries it from there)
    if (uJetMix <= 0.0) k *= exp(-depth / 0.006);
    u.y = mix(u.y, -wc, k * (1.0 - exp(-uDt * 25.0)));
    // unresolved eddies (~25 % turbulence intensity), carried down with the
    // jet; the pressure projection makes the forcing divergence-free
    vec3 nq = (p + vec3(0.0, uTime * wc * 0.7, 0.0)) / b * 1.5;
    vec3 e = vec3(vnoise3(nq), vnoise3(nq + 17.3), vnoise3(nq + 31.7)) - 0.5;
    u += e * k * 1.2 * wc * wc / b * uDt * step(0.0001, uJetMix);
  }
  // floor and wall friction (unresolved Ekman / Stewartson layers)
  float wall = step(R_IN - 1.5 * h.x, length(p.xz));
  if (c.y == 0 || wall > 0.5) u.xz *= exp(-uDt * uDrag * (1.0 + length(u.xz) * 20.0));
  if (wall > 0.5) u.y *= exp(-uDt * uDrag);
  u *= exp(-uDt * uCreep);
  // (safety net: nothing in a beaker moves faster than this)
  float sp = length(u);
  if (sp > 0.6) u *= 0.6 / sp;
  o = vec4(u, 0.0);
}
`;

export const vDivFS = head + grid3 + /* glsl */ `
uniform sampler2D uVel3;
float comp(ivec3 q, int a, float uc) {
  // walls and the (rigid-lid) surface: mirror the normal component, zero flux
  if (solid(q, uG) || air(q, uG)) return -uc;
  return fetch3(uVel3, q, uG)[a];
}
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  if (solid(c, uG) || air(c, uG)) { o = vec4(0.0); return; }
  vec3 h = cellSize(uG), u = fetch3(uVel3, c, uG).xyz;
  float div = 0.0;
  for (int a = 0; a < 3; a++) {
    ivec3 e = ivec3(0); e[a] = 1;
    div += (comp(c + e, a, u[a]) - comp(c - e, a, u[a])) / (2.0 * h[a]);
  }
  o = vec4(div, 0.0, 0.0, 0.0);
}
`;

// one red-black SOR half-sweep
export const vSorFS = head + grid3 + /* glsl */ `
uniform sampler2D uP3, uDiv3;
uniform int uParity;
uniform float uOmega;
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  if (solid(c, uG) || air(c, uG)) { o = vec4(0.0); return; }
  float p = fetch3(uP3, c, uG).x;
  if (((c.x + c.y + c.z) & 1) != uParity) { o = vec4(p, 0.0, 0.0, 0.0); return; }
  vec3 h = cellSize(uG), w = 1.0 / (h * h);
  float sum = 0.0, diag = 0.0;
  for (int a = 0; a < 3; a++) for (int s = -1; s <= 1; s += 2) {
    ivec3 e = ivec3(0); e[a] = s;
    ivec3 q = c + e;
    if (solid(q, uG) || air(q, uG)) continue;   // Neumann
    diag += w[a];
    sum += w[a] * fetch3(uP3, q, uG).x;
  }
  float pj = (sum - fetch3(uDiv3, c, uG).x) / max(diag, 1e-6);
  o = vec4(mix(p, pj, uOmega), 0.0, 0.0, 0.0);
}
`;

export const vProjectFS = head + grid3 + /* glsl */ `
uniform sampler2D uVel3, uP3;
float pAt(ivec3 q, float pc) { return solid(q, uG) || air(q, uG) ? pc : fetch3(uP3, q, uG).x; }
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  if (solid(c, uG) || air(c, uG)) { o = vec4(0.0); return; }
  vec3 h = cellSize(uG), u = fetch3(uVel3, c, uG).xyz;
  float pc = fetch3(uP3, c, uG).x;
  for (int a = 0; a < 3; a++) {
    ivec3 e = ivec3(0); e[a] = 1;
    u[a] -= (pAt(c + e, pc) - pAt(c - e, pc)) / (2.0 * h[a]);
  }
  o = vec4(u, 0.0);
}
`;

// concentration: plain semi-Lagrangian step (forward or, with -dt, backward)
export const cAdvectFS = head + grid3 + /* glsl */ `
uniform sampler2D uVel3, uSrc3;
uniform float uDt;
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  vec3 p = cellPos(c, uG);
  vec3 u = sample3(uVel3, p, uGV).xyz;
  o = sample3(uSrc3, p - uDt * sample3(uVel3, p - 0.5 * uDt * u, uGV).xyz, uG);
}
`;

// MacCormack correction, limiter, diffusion, the pour, and ghost cells
export const cMacFS = head + grid3 + /* glsl */ `
uniform sampler2D uVel3, uOrig3, uFwd3, uBwd3;
uniform float uDt, uDiff;
uniform vec4 uJet;        // x, z, radius, source rate (1/s at the blob's centre)
uniform float uJetZ;      // vertical extent of the source, in radii
uniform float uJetMix;    // entrainment mixing of a turbulent stream (0 for drops)
float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  ivec3 c = cellOf(gl_FragCoord.xy, uG);
  vec3 p = cellPos(c, uG), h = cellSize(uG);
  // ghost cells: outside the wall / above the surface copy the nearest liquid
  if (solid(c, uG) && c.y >= 0) {
    vec2 xz = p.xz * (R_IN - 0.7 * h.x) / max(length(p.xz), 1e-6);
    o = sample3(uFwd3, vec3(xz.x, p.y, xz.y), uG); return;
  }
  if (air(c, uG)) { o = fetch3(uFwd3, ivec3(c.x, int(topLayer(uG)), c.z), uG); return; }
  float fwd = fetch3(uFwd3, c, uG).x;
  float res = fwd + 0.5 * (fetch3(uOrig3, c, uG).x - fetch3(uBwd3, c, uG).x);
  // clamp to the extrema around the departure point
  vec3 u = sample3(uVel3, p, uGV).xyz;
  vec3 b = (p - uDt * u - vec3(-R_IN, INNER_BOTTOM, -R_IN)) / h - 0.5;
  ivec3 b0 = ivec3(floor(b));
  float lo = 1e9, hi = -1e9;
  for (int i = 0; i < 8; i++) {
    float v = fetch3(uOrig3, b0 + ivec3(i & 1, (i >> 1) & 1, i >> 2), uG).x;
    lo = min(lo, v); hi = max(hi, v);
  }
  res = clamp(res, lo, hi);
  // molecular + sub-grid turbulent diffusion
  float nb = 0.0;
  for (int a = 0; a < 3; a++) for (int s = -1; s <= 1; s += 2) {
    ivec3 e = ivec3(0); e[a] = s;
    nb += fetch3(uFwd3, c + e, uG).x;
  }
  // (the jet's turbulence mixes what it carries with the water it entrains)
  float kj = 0.0;
  if (uJet.w > 0.0 && uJetMix > 0.0) {
    float depth = SURF_Y - p.y, bj = uJet.z + 0.2 * max(depth, 0.0);
    kj = exp(-pow(length(p.xz - uJet.xy) / (1.5 * bj), 2.0)) * step(0.0, depth) * uJetMix;
  }
  res = mix(res, nb / 6.0, min(uDiff + kj, 0.9));
  // the pour: pure additive enters with the stream (a ragged, breaking jet)
  if (uJet.w > 0.0) {
    float d = length(p.xz - uJet.xy), depth = SURF_Y - p.y;
    // it punches in as a blob just under the surface rather than loading the
    // surface layer (which would then feed a trailing column for ever)
    float k = exp(-pow(d / uJet.z, 2.0) - pow((depth - 0.0015 - uJetZ * uJet.z) / (uJetZ * uJet.z), 2.0));
    // a volumetric source: what enters is set by the pour, not by the flow
    res = min(1.0, res + uDt * uJet.w * k);
  }
  o = vec4(max(res, 0.0), 0.0, 0.0, 0.0);
}
`;

export function createMixer(gl, pass, program) {
  const F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
  const size = (g) => [g[0] * g[2], g[0] * Math.ceil(g[1] / g[2])];
  const vel = G.pingpong(gl, ...size(VG), ...F, gl.LINEAR);
  const prs = G.pingpong(gl, ...size(VG), ...F, gl.NEAREST);
  const div = G.target(gl, ...size(VG), ...F, gl.NEAREST);
  const conc = G.pingpong(gl, ...size(CG), ...F, gl.LINEAR);
  const cF = G.target(gl, ...size(CG), ...F, gl.LINEAR);
  const cB = G.target(gl, ...size(CG), ...F, gl.LINEAR);
  const P = {
    vAdvect: program(vAdvectFS), vDiv: program(vDivFS), vSor: program(vSorFS), vProject: program(vProjectFS),
    cAdvect: program(cAdvectFS), cMac: program(cMacFS),
  };
  const clear = (...ts) => {
    for (const t of ts) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  };
  const reset = () => clear(vel.read, vel.write, prs.read, prs.write, conc.read, conc.write, cF, cB);
  const clearConc = () => clear(conc.read, conc.write, cF, cB);
  reset();
  const h = (2 * 0.040) / VG[0];
  const omega = 2 / (1 + Math.sin(Math.PI / VG[0]));

  return {
    conc, vel, reset, clearConc,
    // mean additive fraction over the liquid (a GPU readback: only on demand)
    meanConc(surfY) {
      const [w, hh] = size(CG), n = CG[0], buf = new Float32Array(w * hh * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, conc.read.fbo);
      gl.readPixels(0, 0, w, hh, gl.RGBA, gl.FLOAT, buf);
      const dy = (0.124 - 0.004) / CG[1];
      let s = 0, k = 0;
      for (let j = 0; j < CG[1] && 0.004 + (j + 0.5) * dy < surfY; j++) {
        const ox = (j % CG[2]) * n, oy = Math.floor(j / CG[2]) * n;
        for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
          const dx = x + 0.5 - n / 2, dz = z + 0.5 - n / 2;
          if (dx * dx + dz * dz > n * n / 4) continue;
          s += buf[((oy + z) * w + ox + x) * 4]; k++;
        }
      }
      return k ? s / k : 0;
    },
    // opts: dt, surfY, nu, gp (buoyancy, m/s^2 per unit fraction), rod{a,b,vel,r,on},
    // jet{x,z,r,speed,rate} or null, time
    step(o) {
      const { dt } = o;
      const grids = { uGV: VG, uGC: CG, uSurfY: o.surfY };
      const visc = Math.min(0.9, 1 - Math.exp(-6 * o.nu * dt / (h * h)));
      // floor friction ~ sqrt(nu * Omega) / dz; creeping flow for syrups
      const drag = Math.min(40, Math.sqrt(o.nu * 20) / (0.12 / VG[1]));
      const creep = o.nu * (Math.PI / 0.04) ** 2 * 0.5;
      const rod = o.rod, jet = o.jet;
      pass(P.vAdvect, vel.write, {
        ...grids, uG: VG, uVel3: vel.read.tex, uConc3: conc.read.tex, uDt: dt, uGp: o.gp, uVisc: visc, uDrag: drag, uCreep: creep,
        uRodA: rod.a, uRodB: rod.b, uRod: [rod.vel[0], rod.vel[1], rod.r, rod.on ? 1 : 0],
        uJet: jet ? [jet.x, jet.z, jet.r, jet.speed] : [0, 0, 0, 0], uTime: o.time, uJetMix: jet ? jet.mix || 0 : 0,
      }); vel.swap();
      pass(P.vDiv, div, { ...grids, uG: VG, uVel3: vel.read.tex });
      for (let i = 0; i < (o.iters || 24); i++) {
        for (let par = 0; par < 2; par++) {
          pass(P.vSor, prs.write, { ...grids, uG: VG, uP3: prs.read.tex, uDiv3: div.tex, uParity: { int: par }, uOmega: omega });
          prs.swap();
        }
      }
      pass(P.vProject, vel.write, { ...grids, uG: VG, uVel3: vel.read.tex, uP3: prs.read.tex }); vel.swap();

      pass(P.cAdvect, cF, { ...grids, uG: CG, uVel3: vel.read.tex, uSrc3: conc.read.tex, uDt: dt });
      pass(P.cAdvect, cB, { ...grids, uG: CG, uVel3: vel.read.tex, uSrc3: cF.tex, uDt: -dt });
      pass(P.cMac, conc.write, {
        ...grids, uG: CG, uVel3: vel.read.tex, uOrig3: conc.read.tex, uFwd3: cF.tex, uBwd3: cB.tex, uDt: dt,
        uDiff: o.diff, uTime: o.time, uJet: jet ? [jet.x, jet.z, jet.r, jet.rate] : [0, 0, 0, 0], uJetZ: jet ? jet.zs : 1, uJetMix: jet ? jet.mix || 0 : 0,
      }); conc.swap();
    },
  };
}
