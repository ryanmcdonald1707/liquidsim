// Shaders for the liquid lab: a borosilicate beaker of liquid on a lab bench.
// Unlike the mug, the glass lets you see the liquid volume, so light is
// transported through it by ray marching: Beer-Lambert extinction, a
// Kubelka-Munk multiple-scattering source term, refraction and total internal
// reflection at every interface, a stirring rod bent by refraction, and the
// coloured shadow + caustic the liquid throws on the bench.

export const labCommon = /* glsl */ `
uniform sampler2D uHeight, uDye;
uniform vec3 uSigA, uSigS, uAddA, uAddS, uF0, uOilA, uOilS;
uniform float uAddBase, uIor, uMetal; // uAddBase: total poured fraction (for shadows)
uniform float uHasAdd, uHasOil; // skip the plume noise when nothing is poured in
uniform float uOilThick;        // thickness of the floating oil layer (m)
uniform float uCarb, uBubR, uRise, uBoil; // gas bubbles: density, radius, rise speed
uniform float uFoamH;           // foam head thickness (m)
uniform vec3 uFoamCol;
uniform sampler2D uConc3;   // 3D additive field (see mix3d.js)
uniform float uSurfGain, uSurfLayer; // surface film from the 2D flow: weight, thickness (m)
uniform vec3 uRodA, uRodB;
uniform float uRodIn;

float surfH(vec2 xz) { return texture(uHeight, xz / (2.0 * R_IN) + 0.5).r * 0.001; }
vec3 surfN(vec2 xz) { vec4 H = texture(uHeight, xz / (2.0 * R_IN) + 0.5); return normalize(vec3(-H.g, 1.0, -H.b)); }

// Additive volume fraction in 3D: the simulated 3D field (1 mm cells,
// trilinear), the high-resolution surface film from the 2D surface flow, and
// sub-grid filaments stretched vertically like real plumes.
float addConc(vec3 q) {
  if (uHasAdd < 0.5) return 0.0;
  float c = sample3(uConc3, q, uGC).x;
  float depth = max(SURF_Y - q.y, 0.0);
  float c2 = texture(uDye, q.xz / (2.0 * R_IN) + 0.5).r;
  c = max(c, c2 * uSurfGain * exp(-depth / uSurfLayer));
  if (c > 1e-4) {
    // rotated lattice so value-noise cell faces never line up with the view
    const mat3 ROT = mat3(0.8, 0.36, -0.48, -0.6, 0.48, -0.64, 0.0, 0.8, 0.6);
    vec3 nq = ROT * (q * vec3(520.0, 240.0, 520.0)) + vec3(0.0, uTime * 0.3, 0.0);
    float n = vnoise3(nq) * 0.6 + vnoise3(nq * 2.4 + 5.0) * 0.4;
    c *= 0.4 + 1.2 * n;
  }
  return clamp(c, 0.0, 1.0);
}

// Floating oil layer (immiscible, a few mm thick) kept in the dye's .g channel.
float oilConc(vec3 q) {
  if (uHasOil < 0.5) return 0.0;
  float depth = max(SURF_Y + surfH(q.xz) - q.y, 0.0);
  float th = max(uOilThick, 0.0015);
  return clamp(texture(uDye, q.xz / (2.0 * R_IN) + 0.5).g * 1.6, 0.0, 1.0) * (1.0 - smoothstep(th * 0.75, th * 1.05, depth));
}
// Foam head: a dense froth of gas cells. KM inverted so its colour is uFoamCol.
bool inFoam(vec3 q) { return uFoamH > 0.0 && q.y > SURF_Y + surfH(q.xz) - uFoamH; }
void foamMedium(vec3 q, out vec3 sa, out vec3 ss) {
  float depth = SURF_Y + surfH(q.xz) - q.y;
  float cells = vnoise3(q * 1400.0) * 0.6 + vnoise3(q * 3100.0 + 7.0) * 0.4;
  float drain = smoothstep(uFoamH, uFoamH * 0.3, depth); // wetter, denser near the liquid
  ss = vec3(9000.0) * (0.45 + 1.1 * cells) * mix(0.6, 1.0, drain);
  vec3 R = clamp(uFoamCol * (0.9 + 0.2 * cells), 0.05, 0.97);
  sa = ss * (1.0 - R) * (1.0 - R) / (4.0 * R);
}
// Optical properties of the liquid at q: base + mixed-in additive + oil.
void medium(vec3 q, out vec3 sa, out vec3 ss) {
  if (inFoam(q)) { foamMedium(q, sa, ss); return; }
  float c = addConc(q), oil = oilConc(q);
  sa = mix(mix(uSigA, uAddA, c), uOilA, oil);
  ss = mix(mix(uSigS, uAddS, c), uOilS, oil);
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
  float cm = uAddBase;
  vec3 sa = mix(uSigA, uAddA, cm), ss = mix(uSigS, uAddS, cm);
  T *= exp(-(sa + 0.85 * ss) * L);
  // the column acts as a cylindrical lens: light piles up near the rim of
  // the shadow of clear liquids
  float s = abs(dot(vec2(-d.y, d.x) / sqrt(a), p.xz)) / R_IN;
  float clear = exp(-dot(ss, vec3(0.33)) * 0.01);
  float cs = (s - 0.72) / 0.07; // (pow() of a negative base is undefined in GLSL)
  T *= 1.0 + clear * (1.8 * exp(-cs * cs) - 0.35 * smoothstep(0.9, 0.2, s));
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
  // distances light travels through the liquid to reach q; measured to the
  // local (meniscus-raised) surface and never negative - a negative path
  // would turn attenuation into amplification
  float top = SURF_Y + surfH(q.xz);
  float tl = max(min(wallDist(q, LW), (top - q.y) / max(LW.y, 1e-3)), 0.0);
  float esc = max(min(R_IN - length(q.xz), top - q.y), 0.0);
  vec3 lit = vec3(1.0, 0.97, 0.94) * WIN_E * 0.55 * exp(-seff * tl) + ambient(vec3(0.0, 1.0, 0.0)) * exp(-seff * esc);
  return kmAlbedo(sa, ss) / PI * lit;
}

// Gas bubbles rising in columns from nucleation sites (scratches on the
// bottom and the wall). Returns the distance to the nearest bubble along the
// ray (or 1e9), its normal and radius.
float bubbleHit(vec3 p, vec3 d, float tmax, out vec3 nb) {
  float best = 1e9;
  nb = vec3(0.0, 1.0, 0.0);
  if (uCarb <= 0.0) return best;
  int NS = int(uCarb * 22.0);
  float H = SURF_Y - INNER_BOTTOM;
  vec2 dxz = d.xz;
  float a2 = max(dot(dxz, dxz), 1e-6);
  for (int i = 0; i < 34; i++) {
    if (i >= NS) break;
    float fi = float(i);
    float h1 = hash12(vec2(fi, 3.1)), h2 = hash12(vec2(fi, 7.7)), h3 = hash12(vec2(fi, 11.3));
    vec2 c; float ybase = INNER_BOTTOM;
    if (h1 < 0.55 || uBoil > 0.5) { float a = h2 * 6.2832, r = sqrt(h3) * R_IN * 0.9; c = r * vec2(cos(a), sin(a)); }
    else { float a = h2 * 6.2832; c = (R_IN - 0.0012) * vec2(cos(a), sin(a)); ybase = INNER_BOTTOM + h3 * H * 0.8; }
    float sp = mix(0.004, 0.012, hash12(vec2(fi, 5.5))) * (uBoil > 0.5 ? 1.7 : 1.0);
    float speed = uRise * mix(0.8, 1.2, h3);
    float ph = fract(uTime * speed / sp + h2 * 17.0);
    float tc = clamp(dot(c - p.xz, dxz) / a2, 0.0, tmax);
    float y = p.y + d.y * tc;
    if (y < ybase - 0.002 || y > SURF_Y) continue;
    float k = floor((y - ybase) / sp - ph + 0.5);
    for (int j = 0; j < 2; j++) {
      float kk = k + float(j) - 0.0;
      float yb = ybase + (kk + ph) * sp;
      if (yb < ybase || yb > SURF_Y - 0.0008) continue;
      float u = (yb - ybase) / H;
      // bubbles grow as they rise (CO2 diffuses in, pressure drops)
      float r = uBubR * (0.35 + 0.65 * u) * mix(0.7, 1.3, hash12(vec2(fi, kk)));
      vec3 cc = vec3(c.x + 0.0007 * sin(yb * 900.0 + fi), yb, c.y + 0.0007 * cos(yb * 800.0 + fi));
      vec3 oc = p - cc;
      float b = dot(oc, d), disc = b * b - (dot(oc, oc) - r * r);
      if (disc < 0.0) continue;
      float t = -b - sqrt(disc);
      if (t > 0.0 && t < best && t < tmax) { best = t; nb = normalize(p + d * t - cc); }
    }
  }
  return best;
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
    int N = seg == 0 ? 40 : 12;
    vec3 nb;
    float tbub = seg == 0 ? bubbleHit(p, d, te, nb) : 1e9;
    for (int i = 0; i < 40; i++) {
      if (i >= N) break;
      float u0 = float(i) / float(N), u1 = float(i + 1) / float(N);
      float tA = te * u0 * u0, tB = te * u1 * u1, ds = tB - tA;
      vec3 q = p + d * (tA + ds * jit);
      if (tbub < tB) {
        // a gas bubble: beyond the critical angle (liquid -> gas) light is
        // totally reflected, giving the bright silvery rim of real bubbles
        vec3 qb = p + d * tbub;
        float ci = abs(dot(nb, d)), sinI = sqrt(max(1.0 - ci * ci, 0.0));
        float fr0 = (uIor - 1.0) / (uIor + 1.0);
        float fr = max(fresnel(ci, fr0 * fr0), smoothstep(1.0 / uIor - 0.05, 1.0 / uIor + 0.03, sinI));
        vec3 rd = reflect(d, nb);
        vec3 refl = mix(sceneRay(qb, rd), inscatter(qb, uSigA, uSigS) * 2.0 + ambient(rd) * 0.08, 0.35);
        L += T * refl * fr;
        T *= 1.0 - fr * 0.9;
        tbub = 1e9;
      }
      if (uRodIn > 0.5 && rodDist(q) < ROD_R) {
        vec3 n = rodNormal(q);
        vec3 bg = sceneRay(q, reflect(d, n));
        L += T * steel(n, -d, mix(bg, inscatter(q, uSigA, uSigS) * 3.0, 0.5));
        return L;
      }
      vec3 sa, ss;
      medium(q, sa, ss);
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
  // fizz: bursting bubbles keep the surface finely agitated
  if (uCarb > 0.0) {
    vec2 fq = p.xz * 1800.0 + vec2(uTime * 23.0, -uTime * 19.0);
    N = normalize(N + vec3(vnoise(fq) - 0.5, 0.0, vnoise(fq + 31.0) - 0.5) * 0.07 * uCarb);
  }
  // foam: a bumpy, bubbly top instead of a mirror
  if (uFoamH > 0.0005) {
    vec2 fq = p.xz * 1300.0;
    N = normalize(N + vec3(vnoise(fq) - 0.5, 0.0, vnoise(fq + 7.0) - 0.5) * 0.9 * smoothstep(0.0005, 0.003, uFoamH));
  }
  // the mesh overlaps the glass by a hair to hide the seam; march from inside
  float pr = length(p.xz);
  if (pr > R_IN * 0.998) p.xz *= R_IN * 0.998 / pr;
  vec3 R = reflect(-V, N);
  if (uMetal > 0.5) {
    vec3 F = uF0 + (1.0 - uF0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 mirror = sceneRay(p, R) * F;
    // everything is lighter than mercury: poured liquids float as a film
    vec4 dy = texture(uDye, vUv);
    float c = clamp(dy.r * 3.0, 0.0, 1.0) * uHasAdd, oil = clamp(dy.g * 1.5, 0.0, 1.0) * uHasOil;
    vec3 sa = mix(uAddA, uOilA, oil / max(c + oil, 1e-4)), ss = mix(uAddS, uOilS, oil / max(c + oil, 1e-4));
    float t = 0.0025 * max(c, oil);
    vec3 T = exp(-(sa + ss) * t / max(dot(N, V), 0.2));
    vec3 body = kmAlbedo(sa, ss) * (1.0 - T * T) / PI * (windowLight(N) + ambient(N));
    float Ff = fresnel(dot(N, V), 0.03) * step(1e-4, t);
    o = vec4(min(sceneRay(p, R) * Ff + (body + mirror * T * T) * (1.0 - Ff), vec3(40.0)), 1.0);
    return;
  }
  float fr = (uIor - 1.0) / (uIor + 1.0), f0 = fr * fr;
  float F = fresnel(dot(N, V), f0);
  vec3 refl = sceneRay(p, R);
  vec3 body = marchLiquid(p - N * 1e-5, refract(-V, N, 1.0 / uIor), 0.5 + 0.3 * (hash12(gl_FragCoord.xy) - 0.5));
  o = vec4(min(refl * F + body * (1.0 - F), vec3(40.0)), 1.0);
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
  o = vec4(min(marchLiquid(e + d * 1e-5, d, 0.5 + 0.3 * (hash12(gl_FragCoord.xy) - 0.5)) * 0.95, vec3(40.0)), 1.0);
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
uniform float uFrost;
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
  // frost: moisture from the air freezes on glass chilled by a cryogenic liquid
  if (uFrost > 0.0 && r > R_IN + 0.0008 && vWorld.y > 0.0005) {
    float below = 1.0 - smoothstep(SURF_Y - 0.004, SURF_Y + 0.012, vWorld.y);
    float fn = vnoise(vWorld.xy * 420.0 + vWorld.z * 200.0) * 0.6 + vnoise(vWorld.xy * 110.0 - vWorld.z * 60.0) * 0.4;
    float f = uFrost * below * smoothstep(0.35, 0.7, fn + 0.3 * uFrost) * 0.8;
    vec3 frost = vec3(0.9, 0.93, 0.97) / PI * (windowLight(n) + ambient(n)) * (0.8 + 0.3 * fn);
    col = mix(col, frost, f * 0.85);
    alpha = mix(alpha, 1.0, f * 0.85);
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

// Vapour above the beaker: hot liquids steam (rising, back-lit wisps), liquid
// nitrogen makes a dense cold fog that fills the headspace, spills over the
// rim and slides down the outside to pool on the bench.
export const vaporVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }
`;
export const vaporFS = /* glsl */ `
uniform float uVapor; // +1 steam, -1 fog
uniform vec3 uBoxMin, uBoxMax;
in vec3 vWorld;
out vec4 o;
float steamD(vec3 p) {
  float h = p.y - SURF_Y;
  if (h < 0.0) return 0.0;
  vec3 q = p;
  q.y -= uTime * 0.03 + h * h * 2.0;
  q.xz += 0.012 * vec2(sin(h * 45.0 - uTime * 1.1), cos(h * 38.0 + uTime * 0.9)) * smoothstep(0.0, 0.05, h);
  float n = vnoise3(q * vec3(90.0, 45.0, 90.0)) * 0.55 + vnoise3(q * vec3(210.0, 100.0, 210.0) + 7.0) * 0.3 + vnoise3(q * vec3(480.0, 240.0, 480.0) + 3.0) * 0.15;
  float spread = R_IN * 0.85 + max(p.y - RIM_Y, 0.0) * 0.4;
  float rad = 1.0 - smoothstep(spread * 0.5, spread, length(p.xz));
  float fade = smoothstep(0.0, 0.006, h) * exp(-max(p.y - RIM_Y, 0.0) / 0.05);
  return max(n - 0.56, 0.0) * 5.0 * rad * fade * 28.0;
}
float fogD(vec3 p) {
  float r = length(p.xz);
  vec3 q = p * vec3(70.0, 110.0, 70.0) + vec3(0.0, uTime * 2.2, 0.0);
  q.xz += vec2(sin(p.y * 60.0 + uTime), cos(p.y * 50.0 - uTime)) * 0.6;
  float n = vnoise3(q) * 0.55 + vnoise3(q * 2.1 + 5.0) * 0.3 + vnoise3(q * 4.7 + 9.0) * 0.15;
  float d = 0.0;
  // a dense blanket filling the headspace above the boiling liquid
  if (r < R_IN && p.y > SURF_Y) d += (1.0 - 0.6 * smoothstep(0.0, RIM_Y - SURF_Y, p.y - SURF_Y)) * (1.0 - smoothstep(RIM_Y - 0.004, RIM_Y + 0.012, p.y));
  // the curtain spilling over the rim and running down the outside
  float out_ = r - R_OUT;
  if (out_ > -0.001 && p.y < RIM_Y + 0.012) {
    float over = smoothstep(RIM_Y + 0.012, RIM_Y - 0.002, p.y);
    float thick = 0.004 + (RIM_Y - p.y) * 0.08;
    d += over * exp(-max(out_, 0.0) / thick) * 0.9;
  }
  // pooled on the bench, spreading out
  d += exp(-p.y / 0.005) * exp(-max(r - R_OUT, 0.0) / 0.05) * step(R_OUT - 0.001, r) * 0.6;
  return d * max(n - 0.42, 0.0) * 2.6 * 45.0;
}
void main() {
  vec3 ro = uCamPos, rd = normalize(vWorld - uCamPos);
  vec3 inv = 1.0 / (sign(rd) * max(abs(rd), vec3(1e-6)) + vec3(1e-12));
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float ta = max(max(max(tn.x, tn.y), tn.z), 0.0), tb = min(min(tf.x, tf.y), tf.z);
  if (tb <= ta) discard;
  const int STEPS = 56;
  float dt = (tb - ta) / float(STEPS);
  // interleaved-gradient noise: a smooth, blue-ish dither instead of speckle
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = ta + dt * ign;
  float trans = 1.0;
  vec3 col = vec3(0.0);
  float g = uVapor > 0.0 ? 0.55 : 0.3;
  float mu = dot(rd, LW);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 lightCol = vec3(1.0, 0.97, 0.94) * WIN_E * hg * 2.5 + vec3(0.55, 0.56, 0.6) * (uVapor > 0.0 ? 0.35 : 0.8);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float r = length(p.xz);
    // occluders: liquid, glass wall, bench
    if (p.y < 0.0) break;
    if (r < R_IN && p.y < SURF_Y) break;
    if (r > R_IN && r < R_OUT && p.y < RIM_Y) break;
    float d = uVapor > 0.0 ? steamD(p) : fogD(p);
    if (d > 0.0) {
      float a = 1.0 - exp(-d * dt);
      col += trans * a * lightCol;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
    t += dt;
  }
  o = vec4(col, 1.0 - trans);
}
`;
