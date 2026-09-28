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
uniform vec3 uOilSpread;        // spreading oil layer: centre x, z and radius
uniform float uCarb, uBubR, uRise, uBoil; // gas bubbles: density, radius, rise speed
uniform float uFoamH;           // foam head thickness (m)
uniform vec3 uFoamCol;
uniform sampler2D uConc3, uVel3; // 3D additive field and flow (see mix3d.js)
uniform sampler2D uLightA, uLightB; // mean additive fraction along six light paths
uniform float uDn;          // refractive index of the additive minus the base's
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
    // sub-grid filaments carried by the local flow: two noise phases, each
    // advected for a second then faded out as the other takes over (the
    // detail moves with the liquid instead of sliding through it)
    const mat3 ROT = mat3(0.8, 0.36, -0.48, -0.6, 0.48, -0.64, 0.0, 0.8, 0.6);
    vec3 v = sample3(uVel3, q, uGV).xyz;
    float n = 0.0;
    for (int k = 0; k < 2; k++) {
      float ph = fract(uTime * 0.5 + 0.5 * float(k));
      vec3 nq = ROT * ((q - v * ph * 2.0) * vec3(520.0, 240.0, 520.0)) + float(k) * 13.7;
      n += (1.0 - abs(2.0 * ph - 1.0)) * (vnoise3(nq) * 0.6 + vnoise3(nq * 2.4 + 5.0) * 0.4);
    }
    c *= 0.4 + 1.2 * n;
  }
  return clamp(c, 0.0, 1.0);
}

// Floating oil layer (immiscible, a few mm thick) kept in the dye's .g channel.
float oilConc(vec3 q) {
  if (uHasOil < 0.5) return 0.0;
  float depth = max(SURF_Y + surfH(q.xz) - q.y, 0.0);
  float th = max(uOilThick, 0.0015);
  // the layer spreading from where it was poured (a slightly ragged front),
  // plus whatever the surface flow has swirled around
  float front = length(q.xz - uOilSpread.xy) + 0.002 * (vnoise(q.xz * 300.0) - 0.5);
  float cov = 1.0 - smoothstep(uOilSpread.z * 0.9, uOilSpread.z, front);
  float c = max(clamp(texture(uDye, q.xz / (2.0 * R_IN) + 0.5).g * 1.6, 0.0, 1.0), cov);
  // the front is a thin, tapering lip
  float thl = th * mix(1.0, 0.4, smoothstep(uOilSpread.z * 0.8, uOilSpread.z, front));
  return c * (1.0 - smoothstep(thl * 0.75, thl * 1.05, depth));
}
// Foam head: a dense froth of gas cells. KM inverted so its colour is uFoamCol.
// The head drains from the bottom: next to the beer it is wet, with bigger
// bubbles and more liquid between them; the top is dry and fine. Its lower
// edge is ragged, and against the glass the cells press flat into polygons.
float foamBase(vec2 xz) {
  return SURF_Y + surfH(xz) - uFoamH * (1.0 + 0.12 * (vnoise(xz * 180.0) - 0.5) + 0.03 * (vnoise(xz * 600.0) - 0.5));
}
bool inFoam(vec3 q) { return uFoamH > 0.0 && q.y > foamBase(q.xz); }
// distance to the nearest cell wall of a 2D Voronoi foam (F2 - F1)
float foamCells(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int k = 0; k < 9; k++) {
    vec2 g = vec2(float(k % 3) - 1.0, float(k / 3) - 1.0);
    vec2 o = vec2(hash12(i + g), hash12(i + g + 17.3)) * 0.8 + 0.1;
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
void foamMedium(vec3 q, out vec3 sa, out vec3 ss) {
  float top = SURF_Y + surfH(q.xz), base = foamBase(q.xz);
  float wet = clamp((top - q.y) / max(top - base, 1e-4), 0.0, 1.0); // 0 top .. 1 bottom
  wet = wet * wet;
  // bubble size grows towards the wet bottom; liquid fraction 3 % -> 25 %
  float cell = mix(1700.0, 700.0, wet);
  float cells = vnoise3(q * cell) * 0.6 + vnoise3(q * cell * 2.2 + 7.0) * 0.4;
  float phi = mix(0.03, 0.25, wet);
  ss = vec3(9000.0) * (0.45 + 1.1 * cells) * mix(1.0, 0.45, wet);
  // the bottom fifth thins out into bubbly beer: a soft boundary, not an edge
  ss *= smoothstep(0.0, 0.2 * uFoamH, q.y - base);
  // polygonal cells flattened against the glass: bright Plateau borders
  // around clearer faces
  float r = length(q.xz), wallEdge = 0.0;
  if (r > R_IN - 0.0012) {
    vec2 uv = vec2(atan(q.z, q.x) * R_IN, q.y) * mix(1400.0, 650.0, wet);
    float edge = 1.0 - smoothstep(0.02, 0.12, foamCells(uv));
    ss *= mix(0.6, 1.3, edge);
    // liquid-filled Plateau borders refract light away: darker lines
    wallEdge = edge;
  }
  vec3 R = clamp(uFoamCol * (0.9 + 0.2 * cells), 0.05, 0.97);
  sa = ss * (1.0 - R) * (1.0 - R) / (4.0 * R);
  sa += vec3(2500.0) * wallEdge;
  // the liquid held in the wet foam colours it like the drink
  sa = mix(sa, uSigA, phi);
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

// Kubelka-Munk reflectance of a layer of finite thickness X (black behind).
// kmAlbedo assumes an infinitely deep medium: for weakly scattering mixtures
// (a splash of milk in water) light would wander for metres and the water's
// red absorption would tint it green. In a beaker it escapes within ~X.
const float G_FWD = 0.85; // scattering anisotropy of colloidal particles
vec3 kmFinite(vec3 sa, vec3 ss, float X) {
  vec3 S = max(ss * 0.5, vec3(1e-4));
  vec3 a = 1.0 + sa / S, b = sqrt(max(a * a - 1.0, vec3(1e-8)));
  vec3 bsx = min(b * S * X, vec3(20.0));
  vec3 e = exp(-2.0 * bsx), coth = (1.0 + e) / max(1.0 - e, vec3(1e-6));
  return 1.0 / (a + b * coth);
}

// Radiance scattered towards the viewer by a unit of liquid at q.
vec3 inscatter(vec3 q, vec3 sa, vec3 ss) {
  // distances light travels through the liquid to reach q; measured to the
  // local (meniscus-raised) surface and never negative - a negative path
  // would turn attenuation into amplification
  float top = SURF_Y + surfH(q.xz);
  float tl = max(min(wallDist(q, LW), (top - q.y) / max(LW.y, 1e-3)), 0.0);
  // the light reaching q crosses mostly *other* liquid on its way in, so the
  // optical depth of each path is taken from the 3D field, not the medium at q
  // (a milk cloud in water would otherwise be lit through centimetres of neat
  // milk and go green). Direct light comes from the window; diffuse light
  // arrives from wherever the liquid around q is thinnest: up and sideways.
  vec3 lit = vec3(0.0), amb = vec3(0.0);
  vec4 lvA = vec4(0.0), lvB = vec4(0.0);
  if (uHasAdd > 0.5) { lvA = sample3(uLightA, q, uGV); lvB = sample3(uLightB, q, uGV); }
  for (int k = 0; k < 6; k++) {
    vec3 dir = k == 0 ? LW : k == 1 ? vec3(0.0, 1.0, 0.0) : k == 2 ? vec3(1.0, 0.0, 0.0) : k == 3 ? vec3(-1.0, 0.0, 0.0) : k == 4 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 0.0, -1.0);
    float len = k == 0 ? tl : k == 1 ? max(top - q.y, 0.0) : max(wallDist(q, dir), 0.0);
    // the mean additive fraction along this path, from the light volume
    float c = 0.0;
    if (uHasAdd > 0.5) c = max(k < 3 ? lvA[k] : lvB[k - 3], 0.0);
    // scattering lengthens the path light takes, so absorption bites harder:
    // in thick media by the diffusion factor sqrt(3 mus'/mua), in thin ones
    // only by ~(1 + mus' L / 2). Uses the reduced scattering coefficient:
    // colloids like milk fat scatter strongly forwards.
    vec3 pa = mix(uSigA, uAddA, c), psr = mix(uSigS, uAddS, c) * (1.0 - G_FWD);
    vec3 mu = min(sqrt(3.0 * pa * (pa + psr)), pa * (1.0 + 0.5 * psr * len));
    vec3 Tk = exp(-mu * len);
    if (k == 0) lit += vec3(1.0, 0.97, 0.94) * WIN_E * 0.55 * Tk;
    else amb = max(amb, Tk); // diffuse light takes the easiest way in
  }
  lit += ambient(vec3(0.0, 1.0, 0.0)) * amb;
  return kmFinite(sa, ss, 1.5 * R_IN) / PI * lit;
}

// Gas bubbles rising in columns from nucleation sites (scratches on the
// bottom and the wall). Returns the distance to the nearest bubble along the
// ray (or 1e9), its normal and radius.
float bubbleHit(vec3 p, vec3 d, float tmax, out vec3 nb) {
  float best = 1e9;
  nb = vec3(0.0, 1.0, 0.0);
  if (uCarb <= 0.0) return best;
  int NS = min(int(uCarb * 40.0), 48);
  float H = SURF_Y - INNER_BOTTOM;
  vec2 dxz = d.xz;
  float a2 = max(dot(dxz, dxz), 1e-6);
  for (int i = 0; i < 48; i++) {
    if (i >= NS) break;
    float fi = float(i);
    float h1 = hash12(vec2(fi, 3.1)), h2 = hash12(vec2(fi, 7.7)), h3 = hash12(vec2(fi, 11.3));
    vec2 c; float ybase = INNER_BOTTOM;
    if (h1 < 0.55 || uBoil > 0.5) { float a = h2 * 6.2832, r = sqrt(h3) * R_IN * 0.9; c = r * vec2(cos(a), sin(a)); }
    else { float a = h2 * 6.2832; c = (R_IN - 0.0012) * vec2(cos(a), sin(a)); ybase = INNER_BOTTOM + h3 * H * 0.8; }
    // A bubble train. Each site emits at a steady rate; a bubble's radius
    // grows linearly with age as dissolved gas diffuses in (r = r0 + g t), and
    // its rise speed scales as r^2, so trains accelerate and their spacing
    // widens towards the top - the look of a champagne or beer bubble column.
    // Boiling bubbles are born near full size instead.
    float Hc = SURF_Y - 0.0008 - ybase;
    float Rt = uBubR * mix(0.75, 1.25, hash12(vec2(fi, 9.1)));
    float r0 = Rt * (uBoil > 0.5 ? 0.7 : 0.2);
    float vt = uRise * mix(0.8, 1.2, h3);            // speed at radius Rt
    float gr = vt * (Rt * Rt * Rt - r0 * r0 * r0) / (3.0 * Hc * Rt * Rt);
    float freq = mix(6.0, 22.0, hash12(vec2(fi, 5.5))) * (uBoil > 0.5 ? 0.6 : 1.0);
    float ph = h2 * 17.0;
    float tc = clamp(dot(c - p.xz, dxz) / a2, 0.0, tmax);
    float y = p.y + d.y * tc - ybase;
    if (y < -0.002 || y > Hc + 0.001) continue;
    // age of a bubble at height y, inverted from y(t) = vt/Rt^2 ((r0+gt)^3 - r0^3)/(3g)
    float K = vt / (Rt * Rt * 3.0 * gr);
    float age = (pow(max(y, 0.0) / K + r0 * r0 * r0, 1.0 / 3.0) - r0) / gr;
    float kc = floor((uTime - age) * freq + ph);
    for (int j = -1; j < 2; j++) {
      float kk = kc + float(j);
      float tk = uTime - (kk - ph) / freq;             // this bubble's age
      if (tk < 0.0) continue;
      float rk = r0 + gr * tk;
      float yb = K * (pow(rk, 3.0) - r0 * r0 * r0);
      if (yb > Hc) continue;
      float r = rk * mix(0.85, 1.15, hash12(vec2(fi, kk)));
      // a slight helical wobble as the wake sheds
      vec3 cc = vec3(c.x + 0.0005 * sin(yb * 900.0 + fi), ybase + yb, c.y + 0.0005 * cos(yb * 800.0 + fi));
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
    vec3 dc = d, off = vec3(0.0); // schlieren: bent direction and drift
    for (int i = 0; i < 40; i++) {
      if (i >= N) break;
      float u0 = float(i) / float(N), u1 = float(i + 1) / float(N);
      float tA = te * u0 * u0, tB = te * u1 * u1, ds = tB - tA;
      vec3 q = p + d * (tA + ds * jit) + off;
      // a mixture's refractive index follows its composition: rays bend
      // towards denser-index liquid (dn/ds = grad n), the shimmer you see
      // when syrup or milk goes into water
      if (uDn != 0.0 && uHasAdd > 0.5 && sample3(uConc3, q, uGC).x > 3e-4) {
        const float e = 0.0016;
        vec3 gc = vec3(
          sample3(uConc3, q + vec3(e, 0, 0), uGC).x - sample3(uConc3, q - vec3(e, 0, 0), uGC).x,
          sample3(uConc3, q + vec3(0, e, 0), uGC).x - sample3(uConc3, q - vec3(0, e, 0), uGC).x,
          sample3(uConc3, q + vec3(0, 0, e), uGC).x - sample3(uConc3, q - vec3(0, 0, e), uGC).x) / (2.0 * e);
        vec3 gn = uDn * gc / uIor;
        // (capped per step: a coarse step across a sharp honey/water edge
        // would otherwise over-bend and break the image into jagged patches)
        vec3 bend = (gn - dc * dot(gn, dc)) * ds;
        float bl = length(bend);
        if (bl > 0.04) bend *= 0.04 / bl;
        dc = normalize(dc + bend);
        off += (dc - d) * ds;
        float lo = length(off);
        if (lo > 0.006) off *= 0.006 / lo;
      }
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
    vec3 e = p + d * te + off;
    d = dc;
    vec3 nOut; // outward normal of the interface we reached
    if (te == tw) nOut = normalize(vec3(e.x, 0.0, e.z) + 1e-9);
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
    // sampled on the unwrapped glass (arc length, height) so the pattern
    // doesn't smear around the cylinder
    vec2 g = vec2(atan(vWorld.z, vWorld.x) * R_OUT, vWorld.y);
    // frost nucleates in patches and fills in from the cold bottom up; the
    // crystals grow as feathery streaks
    float patchy = vnoise(g * 90.0) * 0.55 + vnoise(g * 260.0 + 3.1) * 0.3 + vnoise(g * 700.0) * 0.15;
    float growth = uFrost * (1.2 - (vWorld.y - INNER_BOTTOM) / max(SURF_Y - INNER_BOTTOM, 0.01) * 0.5);
    float fern = vnoise(vec2(g.x * 2600.0 + g.y * 900.0, g.y * 350.0)) * vnoise(vec2(g.x * 2200.0 - g.y * 800.0, g.y * 420.0 + 5.0));
    float fn = patchy;
    float f = below * smoothstep(0.55, 0.75, patchy + growth * 0.6 - 0.3) * (0.75 + 0.5 * fern) * min(uFrost * 1.5, 1.0);
    f = clamp(f, 0.0, 0.95);
    vec3 frost = vec3(0.9, 0.93, 0.97) / PI * (windowLight(n) + ambient(n)) * (0.75 + 0.5 * fern);
    // ice crystals catch the light as tiny glints
    float glint = step(0.985, hash12(floor(g * 5000.0))) * pow(max(dot(reflect(-normalize(uCamPos - vWorld), n), LW), 0.0), 8.0);
    frost += glint * 3.0;
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
uniform float uStreamR, uStreamIor;
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vWorld);
  float fr = (uStreamIor - 1.0) / (uStreamIor + 1.0);
  float F = fresnel(dot(n, v), fr * fr);
  // the path through a round stream is the chord 2 r cos(theta)
  float thick = 2.0 * uStreamR * max(dot(n, v), 0.2);
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
  // soft, billowing wisps (millimetres to centimetres): coarse octaves only
  vec3 q = p * vec3(40.0, 60.0, 40.0) + vec3(0.0, uTime * 1.3, 0.0);
  q.xz += vec2(sin(p.y * 60.0 + uTime), cos(p.y * 50.0 - uTime)) * 0.5;
  float n = vnoise3(q) * 0.6 + vnoise3(q * 2.1 + 5.0) * 0.3 + vnoise3(q * 4.3 + 9.0) * 0.1;
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
  return d * smoothstep(0.3, 0.75, n) * 0.9 * 45.0;
}
void main() {
  vec3 ro = uCamPos, rd = normalize(vWorld - uCamPos);
  vec3 inv = 1.0 / (sign(rd) * max(abs(rd), vec3(1e-6)) + vec3(1e-12));
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float ta = max(max(max(tn.x, tn.y), tn.z), 0.0), tb = min(min(tf.x, tf.y), tf.z);
  if (tb <= ta) discard;
  const int STEPS = 96;
  float dt = (tb - ta) / float(STEPS);
  // per-pixel jitter (interleaved-gradient noise's diagonal structure shows
  // as a cross-hatch when a dense medium is undersampled)
  float ign = hash12(gl_FragCoord.xy + fract(uTime) * 91.7);
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
    // occluders: the liquid and the bench (the glass wall is transparent -
    // testing it at sample points would randomly cut off the fog inside)
    if (p.y < 0.0) break;
    if (r < R_IN && p.y < SURF_Y) break;
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
