// Shaders for the liquid lab: a borosilicate beaker of liquid on a lab bench.
// Unlike the mug, the glass lets you see the liquid volume, so light is
// transported through it by ray marching: Beer-Lambert extinction, a
// Kubelka-Munk multiple-scattering source term, refraction and total internal
// reflection at every interface, a stirring rod bent by refraction, and the
// coloured shadow + caustic the liquid throws on the bench.

export const labCommon = /* glsl */ `
uniform sampler2D uHeight, uDye;
uniform vec3 uSigA, uSigS, uAddA, uAddS, uF0;
uniform float uAddBase, uPool, uIor, uMetal;
uniform vec4 uProfile;   // top weight, top depth scale, (unused), bottom-pool depth scale
uniform vec4 uColumn;    // falling stream of a sinking additive: x, z, radius, strength
uniform vec3 uRodA, uRodB;
uniform float uRodIn;

float surfH(vec2 xz) { return texture(uHeight, xz / (2.0 * R_IN) + 0.5).r * 0.001; }
vec3 surfN(vec2 xz) { vec4 H = texture(uHeight, xz / (2.0 * R_IN) + 0.5); return normalize(vec3(-H.g, 1.0, -H.b)); }

// Additive volume fraction in 3D: the simulated surface layer carried down as
// a turbulent plume, a pool at the bottom (for sinking additives), a falling
// column while pouring, and the well-mixed background.
float addConc(vec3 q) {
  float depth = max(SURF_Y - q.y, 0.0), hb = max(q.y - INNER_BOTTOM, 0.0);
  // rotated lattice so value-noise cell faces never line up with the view
  const mat3 ROT = mat3(0.8, 0.36, -0.48, -0.6, 0.48, -0.64, 0.0, 0.8, 0.6);
  // plumes are stretched vertically and drift downwards
  vec3 nq = ROT * (q * vec3(95.0, 38.0, 95.0)) + vec3(0.0, uTime * 0.35, 0.0);
  vec2 warp = (vec2(vnoise3(nq) + 0.5 * vnoise3(nq * 2.3 + 5.0), vnoise3(nq + 17.0) + 0.5 * vnoise3(nq * 2.3 + 23.0)) - 0.75) * depth * 0.45;
  float c2 = texture(uDye, (q.xz + warp) / (2.0 * R_IN) + 0.5).r;
  // billowing front: the plume thins out raggedly towards its leading edge
  float front = depth / uProfile.y;
  float fil = vnoise3(nq * 1.6 + 3.0) * 0.5 + vnoise3(nq * 3.7) * 0.3 + vnoise3(nq * 8.9 + 11.0) * 0.2;
  float billow = smoothstep(0.35, 0.75, fil + 0.35 - 0.3 * front);
  float c = uAddBase + c2 * uProfile.x * exp(-front) * mix(1.0, billow, smoothstep(0.0, 0.01, depth));
  c += uPool * exp(-hb / uProfile.w);
  if (uColumn.w > 0.0) {
    float dd = length(q.xz - uColumn.xy);
    c += uColumn.w * exp(-dd * dd / (uColumn.z * uColumn.z));
  }
  return clamp(c, 0.0, 1.0);
}

// Transmittance of window light through the beaker towards point p (outside
// or inside), with the cylindrical-lens caustic of clear liquids.
vec3 liquidTrans(vec3 p) {
  vec2 d = LW.xz;
  float a = dot(d, d), b = 2.0 * dot(p.xz, d);
  vec3 T = vec3(1.0);
  float cg = dot(p.xz, p.xz) - R_OUT * R_OUT, dg = b * b - 4.0 * a * cg;
  if (dg > 0.0) {
    float tg = (-b + sqrt(dg)) / (2.0 * a);
    if (tg > 0.0 && p.y + tg * LW.y < RIM_Y) T *= 0.9; // glass
  }
  float c = dot(p.xz, p.xz) - R_IN * R_IN, disc = b * b - 4.0 * a * c;
  if (disc <= 0.0) return T;
  float sq = sqrt(disc), t0 = (-b - sq) / (2.0 * a), t1 = (-b + sq) / (2.0 * a);
  float lo = max(max(t0, (INNER_BOTTOM - p.y) / LW.y), 0.0);
  float hi = min(t1, (SURF_Y - p.y) / LW.y);
  float L = max(hi - lo, 0.0);
  if (L <= 0.0) return T;
  if (uMetal > 0.5) return T * smoothstep(0.004, 0.0, L);
  float cm = uAddBase + uPool * 0.3;
  vec3 sa = mix(uSigA, uAddA, cm), ss = mix(uSigS, uAddS, cm);
  T *= exp(-(sa + 0.85 * ss) * L);
  // the column acts as a cylindrical lens: light piles up near the rim of
  // the shadow of clear liquids
  float s = abs(dot(vec2(-d.y, d.x) / sqrt(a), p.xz)) / R_IN;
  float clear = exp(-dot(ss, vec3(0.33)) * 0.01);
  T *= 1.0 + clear * (1.8 * exp(-pow((s - 0.72) / 0.07, 2.0)) - 0.35 * smoothstep(0.9, 0.2, s));
  return T;
}

vec3 benchShade(vec3 b, vec3 v) {
  vec2 q = b.xz;
  vec3 alb = vec3(0.58, 0.6, 0.61) * (0.93 + 0.1 * vnoise(q * 700.0) + 0.04 * vnoise(q * 90.0));
  // printed centimetre grid on the bench mat
  vec2 g = abs(fract(q / 0.01 + 0.5) - 0.5) * 0.01;
  vec2 g5 = abs(fract(q / 0.05 + 0.5) - 0.5) * 0.05;
  float fade = clamp(1.2 - length(q) * 2.5, 0.0, 1.0);
  float minor = (1.0 - smoothstep(0.00012, 0.00035, min(g.x, g.y))) * fade;
  float major = (1.0 - smoothstep(0.0003, 0.0006, min(g5.x, g5.y))) * fade;
  alb = mix(alb, vec3(0.3, 0.38, 0.44), max(minor * 0.45, major * 0.75));
  float r = length(q);
  float ao = 1.0 - 0.45 * exp(-max(r - R_OUT, 0.0) / 0.004);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 diff = alb / PI * (windowLight(n) * liquidTrans(b) + ambient(n) * ao);
  float F = fresnel(dot(n, v), 0.04);
  return diff * (1.0 - F) + env(reflect(-v, n), 0.14) * F * 0.6;
}

vec3 sceneRay(vec3 p, vec3 d) {
  if (d.y < -1e-4) {
    float t = -p.y / d.y;
    return benchShade(p + d * t, -d);
  }
  return env(d, 0.0);
}

float rodDist(vec3 q) {
  vec3 ba = uRodB - uRodA;
  float h = clamp(dot(q - uRodA, ba) / dot(ba, ba), 0.0, 1.0);
  return length(q - uRodA - ba * h);
}
vec3 rodNormal(vec3 q) {
  vec3 ba = uRodB - uRodA;
  float h = clamp(dot(q - uRodA, ba) / dot(ba, ba), 0.0, 1.0);
  return normalize(q - uRodA - ba * h);
}
vec3 steel(vec3 n, vec3 v, vec3 refl) {
  vec3 f0 = vec3(0.56, 0.57, 0.58);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  return F * refl;
}

// Radiance scattered towards the viewer by a unit of liquid at q.
vec3 inscatter(vec3 q, vec3 sa, vec3 ss) {
  vec3 st = sa + ss;
  vec3 seff = min(st, sqrt(3.0 * sa * st) + sa);
  float tl = min(wallDist(q, LW), (SURF_Y - q.y) / max(LW.y, 1e-3));
  float esc = max(min(R_IN - length(q.xz), SURF_Y - q.y), 0.0);
  vec3 lit = vec3(1.0, 0.97, 0.94) * WIN_E * 0.55 * exp(-seff * tl) + ambient(vec3(0.0, 1.0, 0.0)) * exp(-seff * esc);
  return kmAlbedo(sa, ss) / PI * lit;
}

vec3 marchLiquid(vec3 p, vec3 d, float jit) {
  vec3 L = vec3(0.0), T = vec3(1.0);
  // a ray can bounce several times by total internal reflection between the
  // bottom and the free surface before it escapes through the side
  for (int seg = 0; seg < 6; seg++) {
    float tw = wallDist(p, d);
    float tb = d.y < 0.0 ? (p.y - INNER_BOTTOM) / (-d.y) : 1e9;
    float ts = d.y > 0.0 ? max((SURF_Y + surfH(p.xz) - p.y) / d.y, 0.0) : 1e9;
    float te = min(tw, min(tb, ts));
    // stratified steps, packed towards the entry point where dense liquids
    // (coffee, milk, juice) do all their scattering
    int N = seg == 0 ? 30 : 12;
    for (int i = 0; i < 30; i++) {
      if (i >= N) break;
      float u0 = float(i) / float(N), u1 = float(i + 1) / float(N);
      float tA = te * u0 * u0, tB = te * u1 * u1, ds = tB - tA;
      vec3 q = p + d * (tA + ds * jit);
      if (uRodIn > 0.5 && rodDist(q) < ROD_R) {
        vec3 n = rodNormal(q);
        vec3 bg = sceneRay(q, reflect(d, n));
        L += T * steel(n, -d, mix(bg, inscatter(q, uSigA, uSigS) * 3.0, 0.5));
        return L;
      }
      float c = addConc(q);
      vec3 sa = mix(uSigA, uAddA, c), ss = mix(uSigS, uAddS, c);
      vec3 a = exp(-(sa + ss) * ds);
      L += T * (1.0 - a) * inscatter(q, sa, ss);
      T *= a;
      if (max(T.r, max(T.g, T.b)) < 0.002) return L;
    }
    vec3 e = p + d * te;
    vec3 nOut; // outward normal of the interface we reached
    if (te == tw) nOut = vec3(e.x, 0.0, e.z) / R_IN;
    else if (te == tb) nOut = vec3(0.0, -1.0, 0.0);
    else nOut = surfN(e.xz);
    vec3 d2 = refract(d, -nOut, uIor);
    if (dot(d2, d2) < 0.5) { // total internal reflection
      d = reflect(d, -nOut);
      p = e - nOut * 1e-5;
      continue;
    }
    float glass = te == ts ? 1.0 : 0.9;
    L += T * sceneRay(e + nOut * 1e-4, d2) * glass * (1.0 - fresnel(abs(dot(d, nOut)), 0.03));
    return L;
  }
  // still trapped after many bounces: let it leak out through the side
  return L + T * sceneRay(p, normalize(vec3(d.x, 0.0, d.z) + 1e-4)) * 0.8;
}
`;

export const labSurfaceVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos;
out vec3 vLocal, vWorld; out vec2 vUv;
void main() {
  vec2 uv = aPos.xz / (2.0 * R_IN) + 0.5;
  vLocal = vec3(aPos.x, SURF_Y + texture(uHeight, uv).r * 0.001, aPos.z);
  vWorld = vLocal;
  vUv = uv;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;
export const labSurfaceFS = /* glsl */ `
in vec3 vLocal, vWorld; in vec2 vUv;
out vec4 o;
void main() {
  vec3 N = surfN(vLocal.xz);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 p = vLocal;
  vec3 R = reflect(-V, N);
  if (uMetal > 0.5) {
    vec3 F = uF0 + (1.0 - uF0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    o = vec4(sceneRay(p, R) * F, 1.0);
    return;
  }
  float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
  float F = fresnel(dot(N, V), f0);
  vec3 refl = sceneRay(p, R);
  vec3 body = marchLiquid(p - N * 1e-5, refract(-V, N, 1.0 / uIor), hash12(gl_FragCoord.xy + fract(uTime) * 61.0));
  o = vec4(refl * F + body * (1.0 - F), 1.0);
}
`;

// Drawn on the outside of the beaker: where the eye ray enters the liquid
// through the side wall.
export const labSideVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }
`;
export const labSideFS = /* glsl */ `
in vec3 vWorld;
out vec4 o;
void main() {
  vec3 ro = uCamPos, rd = normalize(vWorld - uCamPos);
  float a = dot(rd.xz, rd.xz), b = 2.0 * dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - R_IN * R_IN;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) discard;
  float t = (-b - sqrt(disc)) / (2.0 * a);
  if (t < 0.0) discard;
  vec3 e = ro + rd * t;
  if (e.y > SURF_Y + surfH(e.xz * 0.995) || e.y < INNER_BOTTOM) discard;
  vec3 n = vec3(e.x, 0.0, e.z) / R_IN;
  if (uMetal > 0.5) {
    vec3 F = uF0 + (1.0 - uF0) * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    o = vec4(sceneRay(e, reflect(rd, n)) * F * 0.92, 1.0);
    return;
  }
  vec3 d = refract(rd, n, 1.0 / uIor);
  o = vec4(marchLiquid(e + d * 1e-5, d, hash12(gl_FragCoord.xy + fract(uTime) * 61.0)) * 0.95, 1.0);
}
`;

// Thin borosilicate shell with printed graduations; premultiplied alpha.
export const glassVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos; in vec3 aNormal;
out vec3 vWorld, vN;
void main() { vWorld = aPos; vN = aNormal; gl_Position = uViewProj * vec4(aPos, 1.0); }
`;
export const glassFS = /* glsl */ `
in vec3 vWorld, vN;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float c = max(dot(n, v), 0.0);
  float F = fresnel(c, 0.04);
  vec3 col = sceneRay(vWorld, reflect(-v, n)) * F;
  // grazing views look through more glass: darker, faintly green edges
  float edge = pow(1.0 - c, 4.0);
  col += vec3(0.015, 0.022, 0.02) * edge;
  float alpha = F + edge * 0.35;
  // white enamel graduations every 50 ml (1 cm), longer every 100 ml
  float r = length(vWorld.xz);
  if (r > R_IN + 0.001 && vWorld.y < INNER_TOP - 0.008) {
    float ang = atan(vWorld.x, vWorld.z);
    float y = (vWorld.y - INNER_BOTTOM) / 0.01;
    float k = floor(y + 0.5);
    float line = 1.0 - smoothstep(0.03, 0.06, abs(y - k));
    bool major = mod(k, 2.0) < 0.5;
    float span = major ? 0.26 : 0.13;
    float m = line * step(-span, ang - 0.15) * step(ang - 0.15, 0.0) * step(1.0, k);
    // "ml" scale bar
    m = max(m, (1.0 - smoothstep(0.004, 0.008, abs(ang - 0.15))) * step(0.5, y) * step(y, 10.5));
    vec3 white = vec3(0.9) / PI * (windowLight(n) + ambient(n));
    col = mix(col, white, m * 0.9);
    alpha = mix(alpha, 1.0, m * 0.9);
  }
  o = vec4(col, alpha);
}
`;

export const benchFS = /* glsl */ `
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() { o = vec4(benchShade(vWorld, normalize(uCamPos - vWorld)), 1.0); }
`;

export const rodFS = /* glsl */ `
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vWorld);
  vec3 r = reflect(-v, n);
  vec3 refl = mix(sceneRay(vWorld, r), env(r, 0.25), 0.3);
  refl += vec3(1.0, 0.97, 0.94) * WIN_E * 0.5 * pow(max(dot(r, LW), 0.0), 8.0);
  o = vec4(steel(n, v, refl), 1.0);
}
`;

// The falling stream while pouring.
export const streamFS = /* glsl */ `
uniform vec3 uStreamA, uStreamS;
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vWorld);
  float F = fresnel(dot(n, v), 0.03);
  float thick = 0.006 * max(dot(n, v), 0.25);
  vec3 alb = kmAlbedo(uStreamA, uStreamS);
  vec3 T = exp(-(uStreamA + uStreamS) * thick);
  vec3 body = alb / PI * (windowLight(n) + ambient(n)) * (1.0 - T) + sceneRay(vWorld, refract(-v, n, 0.75)) * T;
  o = vec4(env(reflect(-v, n), 0.0) * F + body * (1.0 - F), 1.0);
}
`;
