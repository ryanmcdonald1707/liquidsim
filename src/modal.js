// Linear potential-flow free-surface dynamics in an upright cylindrical cup.
//
// The free surface of a liquid in a cylinder of radius R and depth H is
// expanded in its exact eigenmodes
//
//     phi_mn(r, theta) = J_m(k_mn r) * {cos, sin}(m theta)
//
// where k_mn R is the n-th zero of J_m' (no flux through the wall). Every mode
// is an independent damped harmonic oscillator with the full dispersion
// relation of gravity-capillary waves over finite depth
//
//     omega^2 = (g k + sigma/rho k^3) tanh(k H)
//
// so sloshing, ring waves, capillary ripples running ahead of gravity waves,
// and the reflections from the wall all come out of the physics rather than
// being faked. Each oscillator is integrated with its exact propagator, so the
// scheme is unconditionally stable up to the stiff ~200 Hz capillary modes.

// ---------------------------------------------------------------------------
// Bessel functions J_0..J_M(x) by Miller's backward recurrence (stable for all
// orders at once), normalised with 1 = J_0 + 2 sum J_2k.
function besselJAll(x, M, out) {
  out.fill(0);
  if (x < 1e-12) { out[0] = 1; return out; }
  const big = Math.max(M, x);
  const nStart = 2 * Math.floor((big + 15 + Math.sqrt(40 * big)) / 2);
  let jp1 = 0, j = 1e-30, sum = 0;
  for (let n = nStart; n > 0; n--) {
    const jm1 = (2 * n / x) * j - jp1;
    jp1 = j; j = jm1; // j is now J_{n-1}
    if (Math.abs(j) > 1e200) {
      j *= 1e-200; jp1 *= 1e-200; sum *= 1e-200;
      for (let k = 0; k <= M; k++) out[k] *= 1e-200;
    }
    const idx = n - 1;
    if (idx <= M) out[idx] = j;
    if (idx > 0 && (idx & 1) === 0) sum += 2 * j;
  }
  sum += j;
  const inv = 1 / sum;
  for (let k = 0; k <= M; k++) out[k] *= inv;
  return out;
}

export class ModalSurface {
  constructor(opts = {}) {
    this.R = opts.R ?? 0.04;           // m, inner radius
    this.H = opts.H ?? 0.07;           // m, liquid depth
    this.g = opts.g ?? 9.81;
    this.sigma = opts.sigma ?? 0.052;  // N/m, coffee (surfactants lower it)
    this.rho = opts.rho ?? 1000;
    this.nu = opts.nu ?? 0.45e-6;      // m^2/s, hot (~70 C) water-like
    this.xMax = opts.xMax ?? 110;      // highest k R kept
    this.Nr = opts.Nr ?? 256;          // radial samples for the GPU profile
    this.dt = opts.dt ?? 1 / 240;      // fixed substep
    this.contactDamping = opts.contactDamping ?? 0.22; // 1/s, contact-line losses
    this.extraDamping = opts.extraDamping ?? 0;      // 1/s per unit k, e.g. an oil film
    this.build();
  }

  build() {
    const { R, H, g, sigma, rho, nu, xMax, Nr } = this;
    const M = Math.ceil(xMax) + 2;
    this.Mmax = M;

    // Tabulate J_m(x) on a fine grid for all orders.
    const dx = 0.01;
    const nx = Math.ceil((xMax + 2) / dx) + 2;
    const tab = new Float32Array(nx * (M + 2));
    const tmp = new Float64Array(M + 2);
    for (let i = 0; i < nx; i++) {
      besselJAll(i * dx, M + 1, tmp);
      for (let m = 0; m <= M + 1; m++) tab[m * nx + i] = tmp[m];
    }
    const J = (m, x) => {
      const f = x / dx, i = Math.min(Math.floor(f), nx - 2), t = f - i;
      const b = m * nx + i;
      return tab[b] * (1 - t) + tab[b + 1] * t;
    };
    const dJ = (m, x) => (m === 0 ? -J(1, x) : 0.5 * (J(m - 1, x) - J(m + 1, x)));

    // Roots of J_m' below xMax -> modes.
    const modes = [];
    let maxM = 0;
    for (let m = 0; m <= M - 1; m++) {
      let prev = dJ(m, dx);
      for (let i = 2; i * dx < xMax; i++) {
        const x = i * dx, cur = dJ(m, x);
        if ((prev > 0 && cur <= 0) || (prev < 0 && cur >= 0)) {
          let a = x - dx, b = x, fa = prev;
          for (let it = 0; it < 30; it++) { // bisection refine
            const c = 0.5 * (a + b), fc = dJ(m, c);
            if ((fa > 0) === (fc > 0)) { a = c; fa = fc; } else b = c;
          }
          const root = 0.5 * (a + b);
          modes.push({ m, x: root });
          if (m > maxM) maxM = m;
        }
        prev = cur;
      }
    }
    this.M = maxM;

    const list = [];
    for (const md of modes) {
      list.push({ ...md, sin: 0 });
      if (md.m > 0) list.push({ ...md, sin: 1 });
    }
    const n = list.length;
    this.n = n;
    this.mOrd = new Int16Array(n);
    this.isSin = new Uint8Array(n);
    this.k = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.gamma = new Float64Array(n);
    this.gamma0 = new Float64Array(n);
    this.couple = new Float64Array(n);  // k tanh(kH): pressure -> surface accel
    this.basis = new Float32Array(n * Nr);
    this.dbasis = new Float32Array(n * Nr);
    this.accelProj = new Float64Array(n);
    this.a = new Float64Array(n);
    this.v = new Float64Array(n);

    const shapeCache = new Map();
    for (let i = 0; i < n; i++) {
      const { m, x, sin } = list[i];
      const k = x / R;
      const th = Math.tanh(k * H);
      const w2 = (g * k + (sigma / rho) * k * k * k) * th;
      const w = Math.sqrt(w2);
      // Damping: bulk viscosity, inextensible surfactant film, wall Stokes
      // layer, and pinned-contact-line dissipation.
      const mx = Math.min((m / x) * (m / x), 0.9);
      const gBulk = 2 * nu * k * k;
      const gFilm = k * Math.sqrt(nu * w / 8);
      const gWall = (Math.sqrt(nu * w / 2) / R) * 0.5 * (1 + mx) / (1 - mx);
      const gBottom = k * Math.sqrt(nu * w / 2) / Math.sinh(Math.min(2 * k * H, 50));
      const gam = gBulk + gFilm + gWall + gBottom + this.contactDamping;
      this.mOrd[i] = m; this.isSin[i] = sin; this.k[i] = k;
      this.omega[i] = w; this.gamma0[i] = gam; this.gamma[i] = gam + this.extraDamping * k * R; this.couple[i] = k * th;

      const key = m + ':' + x;
      let sh = shapeCache.get(key);
      if (!sh) {
        const Jx = J(m, x);
        const radNorm = (R * R / 2) * (1 - (m * m) / (x * x)) * Jx * Jx;
        const angNorm = m === 0 ? 2 * Math.PI : Math.PI;
        const s = 1 / Math.sqrt(radNorm * angNorm);
        const B = new Float32Array(Nr), dB = new Float32Array(Nr);
        for (let ir = 0; ir < Nr; ir++) {
          const xr = x * ir / (Nr - 1);
          B[ir] = J(m, xr) * s;
          dB[ir] = k * dJ(m, xr) * s;
        }
        // Projection of the potential a.x onto m = 1 modes: pi * int B r^2 dr.
        let q = 0;
        if (m === 1) {
          const N = 2000;
          for (let j = 0; j <= N; j++) {
            const r = R * j / N, wgt = (j === 0 || j === N) ? 0.5 : 1;
            q += wgt * J(1, k * r) * s * r * r;
          }
          q *= Math.PI * R / N;
        }
        sh = { B, dB, q };
        shapeCache.set(key, sh);
      }
      this.basis.set(sh.B, i * Nr);
      this.dbasis.set(sh.dB, i * Nr);
      this.accelProj[i] = sh.q;
    }
    this.setStep(this.dt);
  }

  setStep(dt) {
    // Exact 2x2 propagator of x'' + 2 gamma x' + omega^2 x = 0 over dt, for
    // both under-damped (waves) and over-damped (e.g. honey) modes.
    this.dt = dt;
    const n = this.n;
    this.m11 = new Float64Array(n); this.m12 = new Float64Array(n);
    this.m21 = new Float64Array(n); this.m22 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = this.omega[i], g = this.gamma[i], w2 = w * w;
      if (w > g * 1.0001) {
        const wd = Math.sqrt(w2 - g * g), e = Math.exp(-g * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
        this.m11[i] = e * (c + (g / wd) * s); this.m12[i] = e * s / wd;
        this.m21[i] = -e * (w2 / wd) * s; this.m22[i] = e * (c - (g / wd) * s);
      } else {
        const b = Math.max(Math.sqrt(Math.max(g * g - w2, 0)), 1e-3 * g);
        const l1 = -g + b, l2 = -g - b, E1 = Math.exp(l1 * dt), E2 = Math.exp(l2 * dt), d = l1 - l2;
        this.m11[i] = (-l2 * E1 + l1 * E2) / d; this.m12[i] = (E1 - E2) / d;
        this.m21[i] = l1 * l2 * (E2 - E1) / d; this.m22[i] = (l1 * E1 - l2 * E2) / d;
      }
    }
  }

  reset() { this.a.fill(0); this.v.fill(0); }

  // Extra damping growing with wavenumber (e.g. an oil film: Marangoni
  // elasticity calms the short waves) - cheap, no rebuild of the modes.
  setExtraDamping(e) {
    if (e === this.extraDamping) return;
    this.extraDamping = e;
    for (let i = 0; i < this.n; i++) this.gamma[i] = this.gamma0[i] + e * this.k[i] * this.R;
    this.setStep(this.dt);
  }

  // Advance by one fixed substep with the cup accelerating at (ax, az) m/s^2
  // (horizontal, in the cup's x/z plane).
  substep(ax, az) {
    const { n, a, v, m11, m12, m21, m22, omega, couple, accelProj, mOrd, isSin } = this;
    for (let i = 0; i < n; i++) {
      let eq = 0;
      if (mOrd[i] === 1) {
        // In the cup frame the fictitious force derives from Phi = a.x.
        const P = (isSin[i] ? az : ax) * accelProj[i];
        eq = -couple[i] * P / (omega[i] * omega[i]);
      }
      const x0 = a[i] - eq, v0 = v[i];
      a[i] = m11[i] * x0 + m12[i] * v0 + eq;
      v[i] = m21[i] * x0 + m22[i] * v0;
    }
  }

  // The waves are carried by the mean swirl: in a flow rotating at Omega a
  // pattern with angular number m is Doppler-shifted by m*Omega, i.e. each
  // cos/sin mode pair rotates by the angle m*Omega*dt.
  rotate(Omega, dt) {
    if (Omega === 0) return;
    const { n, a, v, mOrd, isSin } = this;
    for (let i = 0; i + 1 < n; i++) {
      const m = mOrd[i];
      if (m === 0 || isSin[i] || !isSin[i + 1] || mOrd[i + 1] !== m) continue;
      const ph = m * Omega * dt, c = Math.cos(ph), sn = Math.sin(ph);
      const ac = a[i], as = a[i + 1], vc = v[i], vs = v[i + 1];
      a[i] = ac * c - as * sn; a[i + 1] = ac * sn + as * c;
      v[i] = vc * c - vs * sn; v[i + 1] = vc * sn + vs * c;
      i++;
    }
  }

  // Spectral statistics for the nonlinear corrections: energy-weighted mean
  // wavenumber, mean square elevation over the disk (m^2) and RMS slope.
  spectrum() {
    let e = 0, ek = 0, ek2 = 0;
    for (let i = 0; i < this.n; i++) { const a2 = this.a[i] * this.a[i]; e += a2; ek += a2 * this.k[i]; ek2 += a2 * this.k[i] * this.k[i]; }
    const area = Math.PI * this.R * this.R;
    return { kMean: e > 0 ? ek / e : 0, meanH2: e / area, slope: Math.sqrt(ek2 / area) };
  }

  // Wave breaking: once the surface gets too steep, the shortest waves
  // spill and lose energy first (whitecapping), instead of every mode being
  // scaled down together.
  breakWaves(dt, threshold = 0.28) {
    const sp = this.spectrum();
    if (sp.slope <= threshold) return 0;
    const excess = sp.slope / threshold - 1;
    for (let i = 0; i < this.n; i++) {
      const w = Math.min(1, (this.k[i] / Math.max(sp.kMean, 1)) ** 2);
      const f = Math.exp(-dt * 25 * excess * w);
      this.a[i] *= f; this.v[i] *= f;
    }
    return excess;
  }

  // Slowest decay rate of the fundamental slosh mode (1/s) and its frequency (Hz).
  sloshInfo() {
    const i = this.mOrd.indexOf(1);
    const w = this.omega[i], g = this.gamma[i];
    if (w > g) return { hz: Math.sqrt(w * w - g * g) / (2 * Math.PI), decay: g, over: false };
    return { hz: 0, decay: g - Math.sqrt(g * g - w * w), over: true };
  }

  // Evaluate a mode's radial profile and derivative at radius r.
  _radial(i, r) {
    const Nr = this.Nr;
    const f = Math.min(Math.max(r / this.R, 0), 1) * (Nr - 1);
    const j = Math.min(Math.floor(f), Nr - 2), t = f - j, b = i * Nr + j;
    return [
      this.basis[b] * (1 - t) + this.basis[b + 1] * t,
      this.dbasis[b] * (1 - t) + this.dbasis[b + 1] * t,
    ];
  }

  // Impulsive surface pressure (e.g. a drop impact). I is a potential impulse
  // (m^2/s) spread as a Gaussian of width s (m). Positive pushes the surface down.
  impulse(x, z, I, s) {
    const r = Math.hypot(x, z), th = Math.atan2(z, x);
    const area = Math.PI * s * s;
    for (let i = 0; i < this.n; i++) {
      const k = this.k[i];
      const filt = Math.exp(-k * k * s * s / 4);
      if (filt < 1e-6) continue;
      const m = this.mOrd[i];
      const ang = this.isSin[i] ? Math.sin(m * th) : Math.cos(m * th);
      const [B] = this._radial(i, r);
      this.v[i] -= this.couple[i] * I * area * filt * B * ang;
    }
  }

  // Kinematic dipole source: an object moving with velocity (vx, vz) through
  // the surface pushes water up ahead of itself and leaves a trough behind.
  dipole(x, z, vx, vz, strength, s, dt) {
    const r = Math.max(Math.hypot(x, z), 1e-5), th = Math.atan2(z, x);
    const cr = x / r, sr = z / r;
    const area = Math.PI * s * s;
    for (let i = 0; i < this.n; i++) {
      const k = this.k[i];
      const filt = Math.exp(-k * k * s * s / 4);
      if (filt < 1e-6) continue;
      const m = this.mOrd[i], sn = this.isSin[i];
      const ang = sn ? Math.sin(m * th) : Math.cos(m * th);
      const dang = sn ? m * Math.cos(m * th) : -m * Math.sin(m * th);
      const [B, dB] = this._radial(i, r);
      // grad(phi) in cartesian
      const gr = dB * ang, gt = B * dang / r;
      const gx = gr * cr - gt * sr, gz = gr * sr + gt * cr;
      this.a[i] += strength * area * filt * (vx * gx + vz * gz) * dt;
    }
  }

  // A knock on the cup: the wall jerks and launches axisymmetric ring waves
  // that converge on the centre, plus a slosh in the direction of the blow.
  knock(strength, dirX, dirZ) {
    const R = this.R;
    for (let i = 0; i < this.n; i++) {
      const k = this.k[i];
      const filt = Math.exp(-k * k * 0.0012 * 0.0012 / 4);
      const m = this.mOrd[i];
      const [B] = this._radial(i, R);
      if (m === 0) this.v[i] += strength * 2 * Math.PI * R * 0.0015 * B * filt * this.couple[i];
      if (m === 1) {
        const d = this.isSin[i] ? dirZ : dirX;
        this.v[i] += strength * 0.35 * d * this.accelProj[i] * this.couple[i];
      }
    }
  }

  // Tiny random forcing so the surface is never unnaturally dead (room
  // vibration, convection).
  jitter(amount) {
    for (let i = 0; i < this.n; i++) {
      const k = this.k[i];
      if (k * this.R > 40) continue;
      this.v[i] += (Math.random() - 0.5) * amount / (1 + k * 0.01);
    }
  }

  // Build the per-order radial profiles consumed by the GPU:
  // out[(m*Nr + ir)*4 + {0,1,2,3}] = {Rc, Rs (mm), dRc/dr, dRs/dr (slope)}
  fillProfiles(out) {
    const { n, Nr, a, basis, dbasis, mOrd, isSin } = this;
    out.fill(0);
    for (let i = 0; i < n; i++) {
      const amp = a[i];
      if (Math.abs(amp) < 1e-13) continue;
      const base = mOrd[i] * Nr * 4 + (isSin[i] ? 1 : 0);
      const ah = amp * 1000, bo = i * Nr;
      for (let ir = 0; ir < Nr; ir++) {
        const o = base + ir * 4;
        out[o] += ah * basis[bo + ir];
        out[o + 2] += amp * dbasis[bo + ir];
      }
    }
  }

  // Surface elevation (mm) at the wall for nA angles, from filled profiles.
  wallHeights(profiles, nA, out) {
    const Nr = this.Nr, M = this.M;
    for (let j = 0; j < nA; j++) {
      const th = 2 * Math.PI * j / nA;
      let h = 0;
      for (let m = 0; m <= M; m++) {
        const o = (m * Nr + Nr - 1) * 4;
        h += profiles[o] * Math.cos(m * th) + profiles[o + 1] * Math.sin(m * th);
      }
      out[j] = h;
    }
    return out;
  }
}
