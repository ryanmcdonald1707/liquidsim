// Procedural meshes: lathed ceramics, the handle tube, a teaspoon, the
// polar-grid liquid surface and the table.

// Centripetal Catmull-Rom smoothing of a 2D polyline (keeps end points).
export function smooth(points, sub = 6) {
  const out = [];
  const P = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// Revolve a (r, y) profile around the y axis. The profile's traversal
// direction decides which way normals face (outward = right of travel).
export function lathe(profile, segs = 128) {
  const n = profile.length;
  const positions = [], normals = [], uvs = [], indices = [];
  const nrm = profile.map((p, i) => {
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    return [ty / l, -tx / l];
  });
  let len = 0;
  const arc = profile.map((p, i) => (i ? (len += Math.hypot(p[0] - profile[i - 1][0], p[1] - profile[i - 1][1])) : 0));
  for (let s = 0; s <= segs; s++) {
    const th = (s / segs) * Math.PI * 2, c = Math.cos(th), si = Math.sin(th);
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i], [nr, ny] = nrm[i];
      positions.push(r * c, y, r * si);
      normals.push(nr * c, ny, nr * si);
      uvs.push(s / segs, arc[i] / len);
    }
  }
  for (let s = 0; s < segs; s++) for (let i = 0; i < n - 1; i++) {
    const a = s * n + i, b = (s + 1) * n + i;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices };
}

// Sweep an elliptical cross-section along a planar path (x, y) in the z = 0
// plane. a = in-plane half-thickness, b = half-width along z.
export function tube(path, a, b, sides = 32) {
  const positions = [], normals = [], uvs = [], indices = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const p = path[i], q = path[Math.min(n - 1, i + 1)], o = path[Math.max(0, i - 1)];
    let tx = q[0] - o[0], ty = q[1] - o[1];
    const l = Math.hypot(tx, ty); tx /= l; ty /= l;
    const nx = ty, ny = -tx; // in-plane normal
    const taper = p[2] ?? 1;
    for (let s = 0; s <= sides; s++) {
      const ph = (s / sides) * Math.PI * 2, c = Math.cos(ph), sn = Math.sin(ph);
      positions.push(p[0] + nx * a * taper * c, p[1] + ny * a * taper * c, b * taper * sn);
      let ex = nx * c / a, ey = ny * c / a, ez = sn / b;
      const el = Math.hypot(ex, ey, ez);
      normals.push(ex / el, ey / el, ez / el);
      uvs.push(i / (n - 1), s / sides);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < sides; s++) {
    const a0 = i * (sides + 1) + s, b0 = (i + 1) * (sides + 1) + s;
    indices.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices };
}

// A teaspoon in its local frame: +x runs from the bowl tip (x = 0) to the end
// of the handle, +y is the concave (inside) side of the bowl.
export function teaspoon() {
  const L = 0.132, NX = 140, NU = 28, thick = 0.0011;
  const width = (x) => {
    if (x < 0.046) { // bowl: egg-shaped ellipse
      const t = (x - 0.022) / 0.023;
      const w = 0.0142 * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.18 * t);
      return Math.max(w, x < 0.001 ? 0.0003 : 0.0025);
    }
    if (x < 0.06) return 0.0025 + 0.0006 * (x - 0.046) / 0.014;
    const t = (x - 0.06) / (L - 0.06);
    const w = 0.0031 + 0.0036 * t * t;
    const end = (L - x) / 0.006;
    return end < 1 ? w * Math.sqrt(Math.max(0, 1 - (1 - end) * (1 - end))) + 0.0002 : w;
  };
  const center = (x) => (x < 0.046 ? 0 : 0.0055 * Math.min(1, (x - 0.046) / 0.03) ** 1.5 + 0.0018 * Math.max(0, (x - 0.1) / 0.03));
  const depth = (x, u) => {
    if (x > 0.047) return 0;
    const t = (x - 0.022) / 0.024;
    return 0.0055 * Math.max(0, 1 - t * t) * (1 - u * u);
  };
  const positions = [], indices = [];
  const idx = (side, i, j) => side * (NX + 1) * (NU + 1) + i * (NU + 1) + j;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i <= NX; i++) {
      const x = L * (0.5 - 0.5 * Math.cos(Math.PI * i / NX));
      const w = width(x), yc = center(x);
      for (let j = 0; j <= NU; j++) {
        const u = -1 + 2 * j / NU;
        const us = Math.sin(u * Math.PI / 2);
        const edge = Math.sqrt(Math.max(0, 1 - us * us));
        const y = yc - depth(x, us) + (side ? -1 : 1) * thick * 0.5 * (0.35 + 0.65 * edge);
        positions.push(x, y, us * w);
      }
    }
  }
  for (let i = 0; i < NX; i++) for (let j = 0; j < NU; j++) {
    const a = idx(0, i, j), b = idx(0, i + 1, j);
    indices.push(a, a + 1, b, b, a + 1, b + 1);
    const c = idx(1, i, j), d = idx(1, i + 1, j);
    indices.push(c, d, c + 1, c + 1, d, d + 1);
  }
  // stitch the edges and the ends
  for (let i = 0; i < NX; i++) {
    for (const j of [0, NU]) {
      const a = idx(0, i, j), b = idx(0, i + 1, j), c = idx(1, i, j), d = idx(1, i + 1, j);
      if (j === 0) indices.push(a, b, c, c, b, d); else indices.push(a, c, b, b, c, d);
    }
  }
  for (const i of [0, NX]) for (let j = 0; j < NU; j++) {
    const a = idx(0, i, j), b = idx(0, i, j + 1), c = idx(1, i, j), d = idx(1, i, j + 1);
    if (i === 0) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, c, b, d);
  }
  return withNormals(new Float32Array(positions), indices);
}

export function withNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return { positions, normals, indices };
}

// Polar grid for the liquid surface, denser towards the wall where the
// meniscus curves sharply.
export function polarDisk(radius, rings = 180, segs = 360) {
  const positions = [], indices = [];
  positions.push(0, 0, 0);
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const rad = radius * (1 - Math.pow(1 - t, 1.3));
    for (let s = 0; s < segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      positions.push(rad * Math.cos(th), 0, rad * Math.sin(th));
    }
  }
  for (let s = 0; s < segs; s++) indices.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let i = 1; i < rings; i++) for (let s = 0; s < segs; s++) {
    const a = 1 + (i - 1) * segs + s, b = 1 + (i - 1) * segs + ((s + 1) % segs);
    const c = a + segs, d = b + segs;
    indices.push(a, b, c, c, b, d);
  }
  return { positions: new Float32Array(positions), indices };
}

export function plane(size) {
  const h = size / 2;
  return {
    positions: new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: [0, 2, 1, 0, 3, 2],
  };
}

export function quad() {
  return { positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), indices: [0, 1, 2, 0, 2, 3] };
}

// Box used as the proxy geometry for ray-marched steam.
export function box(x0, y0, z0, x1, y1, z1) {
  const p = [];
  for (let i = 0; i < 8; i++) p.push(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0);
  const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const indices = [];
  for (const [a, b, c, d] of f) indices.push(a, b, c, a, c, d);
  return { positions: new Float32Array(p), indices };
}
