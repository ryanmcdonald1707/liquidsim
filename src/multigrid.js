import * as G from './gl.js';

// Geometric multigrid V-cycle for the 2D pressure Poisson equation on the
// circular cup/beaker. Plain Jacobi needs O(N^2) sweeps to converge on an
// N x N grid; a V-cycle removes every error frequency on the grid where it is
// cheapest, so a couple of cycles converge far better than the old 36 sweeps.
export function createMultigrid(gl, size, progs, pass, levels = 5) {
  const F = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
  const L = [];
  for (let i = 1, n = size >> 1; i < levels && n >= 8; i++, n >>= 1) {
    L.push({ n, p: G.pingpong(gl, n, n, ...F, gl.LINEAR), rhs: G.target(gl, n, n, ...F, gl.LINEAR), res: G.target(gl, n, n, ...F, gl.LINEAR) });
  }
  const fineRes = G.target(gl, size, size, ...F, gl.LINEAR);
  const clear = (t) => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); };
  const smooth = (p, rhs, n, k) => {
    for (let i = 0; i < k; i++) { pass(progs.jacobi, p.write, { uP: p.read.tex, uDiv: rhs.tex, uTexel: [1 / n, 1 / n], uOmega: 0.85 }); p.swap(); }
  };
  function vcycle(level, p, rhs, n, res) {
    if (level === L.length) { smooth(p, rhs, n, 24); return; }
    smooth(p, rhs, n, 3);
    pass(progs.residual, res, { uP: p.read.tex, uDiv: rhs.tex, uTexel: [1 / n, 1 / n] });
    const c = L[level];
    pass(progs.restrict, c.rhs, { uSrc: res.tex, uTexel: [1 / c.n, 1 / c.n] });
    clear(c.p.read); clear(c.p.write);
    vcycle(level + 1, c.p, c.rhs, c.n, c.res);
    pass(progs.prolong, p.write, { uP: p.read.tex, uE: c.p.read.tex, uTexel: [1 / n, 1 / n] }); p.swap();
    smooth(p, rhs, n, 3);
  }
  return {
    // p: fine-level pressure ping-pong (warm-started), div: right-hand side
    solve(p, div, cycles = 2) { for (let i = 0; i < cycles; i++) vcycle(0, p, div, size, fineRes); },
  };
}
