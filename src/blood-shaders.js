// Blood on surfaces: a thin-film (lubrication) flow solver with blood's
// non-Newtonian rheology, contact-line pinning, absorption/wicking into porous
// substrates, clotting and evaporation, plus rendering with haemoglobin optics.
//
// State texture (per cell, NEAREST):  r = film thickness h (mm)
//                                     g = blood soaked into the substrate (mm)
//                                     b = age of the blood in this cell (s)
//                                     a = dried deposit (mm)
// Plane coordinates: u across, v up-slope, both in metres, |u|,|v| <= HALF.

const surfaceGLSL = /* glsl */ `
uniform int uSurface; // 0 tile, 1 concrete, 2 wood, 3 fabric, 4 steel
// substrate relief (mm, negative = lower): grout lines, pores, grain, weave
float relief(vec2 p) {
  if (uSurface == 0) {
    vec2 g = abs(fract(p / 0.1 + 0.5) - 0.5) * 0.1;
    float d = min(g.x, g.y);
    return -1.3 * (1.0 - smoothstep(0.0012, 0.0022, d));
  } else if (uSurface == 1) {
    return (vnoise(p * 900.0) - 0.5) * 0.25 + (vnoise(p * 180.0) - 0.5) * 0.35 - 0.3 * smoothstep(0.82, 0.95, vnoise(p * 400.0 + 7.0));
  } else if (uSurface == 2) {
    float grain = vnoise(vec2(p.x * 25.0, p.y * 900.0)) * 0.5 + vnoise(vec2(p.x * 5.0, p.y * 300.0)) * 0.5;
    vec2 g = abs(fract(p.y / 0.12 + 0.5) - 0.5) * 0.12 * vec2(0.0, 1.0);
    return (grain - 0.5) * 0.08 - 0.6 * (1.0 - smoothstep(0.0005, 0.0012, g.y));
  } else if (uSurface == 3) {
    vec2 w = p / 0.0009;
    float warp = sin(w.x * PI) * sign(sin(w.y * PI * 0.5));
    return warp * 0.08;
  }
  return (vnoise(vec2(p.x * 3000.0, p.y * 12.0)) - 0.5) * 0.02;
}
`;

export const bloodCommon = surfaceGLSL + /* glsl */ `
uniform float uHalf; // half-size of the surface patch (m)
vec2 cellToP(vec2 fc, vec2 res) { return (fc / res - 0.5) * 2.0 * uHalf; }
`;

// Outflow from each cell towards its 4 neighbours (mm per substep): R, L, U, D.
export const fluxFS = /* glsl */ `
uniform sampler2D uS, uRelief;
uniform float uDt, uCos, uSin, uRho, uG, uHpin, uHres, uTauY, uMu0, uMuInf, uLam, uN, uFront, uClotT, uTimeScale;
out vec4 o;
float phiAt(ivec2 c, float h, vec2 res) {
  vec2 p = cellToP(vec2(c) + 0.5, res);
  return uRho * uG * (uCos * (h + texelFetch(uRelief, c, 0).r) * 1e-3 + uSin * p.y);
}
float carreau(float tau) {
  // solve mu(gd) * gd = tau for the Carreau-Yasuda model of whole blood
  float mu = uMu0;
  for (int i = 0; i < 8; i++) {
    float gd = tau / mu;
    float m2 = uMuInf + (uMu0 - uMuInf) * pow(1.0 + uLam * uLam * gd * gd, (uN - 1.0) * 0.5);
    mu = sqrt(mu * m2);
  }
  return mu;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uS, 0);
  vec2 res = vec2(sz);
  vec4 s = texelFetch(uS, c, 0);
  float h = s.r;
  if (h <= uHres) { o = vec4(0.0); return; }
  float dx = 2.0 * uHalf / res.x;
  float phi = phiAt(c, h, res);
  // clotting: fibrin network makes the blood effectively solid over minutes
  float clot = 1.0 + 400.0 * pow(clamp(s.b / uClotT, 0.0, 1.5), 4.0);
  ivec2 nb[4] = ivec2[](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  vec4 f = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 cn = c + nb[k];
    if (cn.x < 0 || cn.y < 0 || cn.x >= sz.x || cn.y >= sz.y) continue;
    float hn = texelFetch(uS, cn, 0).r;
    float dphi = phi - phiAt(cn, hn, res);
    if (dphi <= 0.0) continue;
    bool dry = hn < 0.015;
    // contact-line pinning: a thin film cannot advance onto dry surface.
    // Line tension makes it curvature-dependent: a dry cell in a notch of the
    // front (many wet neighbours) is easily wetted, one beyond a bulging
    // corner is not - fronts round off instead of growing along grid axes
    if (dry) {
      float wetN = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        ivec2 cc = clamp(cn + ivec2(i, j), ivec2(0), sz - 1);
        wetN += step(0.015, texelFetch(uS, cc, 0).r);
      }
      if (h * (0.45 + 1.1 * wetN / 9.0) < uHpin) continue;
    }
    float hm = h * 1e-3;
    float tau = hm * dphi / dx; // wall shear stress (Pa)
    if (tau < uTauY) continue;   // yield stress (rouleaux networks)
    float mu = carreau(tau) * clot;
    float q = hm * hm * hm / (3.0 * mu) * dphi / dx;   // m^2/s
    float dh = q * uDt / dx * 1e3;                     // mm
    if (dry) dh *= uFront; // moving contact lines dissipate strongly
    f[k] = dh;
  }
  float avail = max(h - uHres, 0.0) * 0.45;
  float tot = f.x + f.y + f.z + f.w;
  if (tot > avail) f *= avail / tot;
  o = f;
}
`;

export const updateFS = /* glsl */ `
uniform sampler2D uS, uF, uSrc;
uniform float uDt, uTimeScale, uEvap, uAbsorb, uCap, uWickX, uWickY, uUseSrc;
uniform vec4 uSmear;    // from.xy, to.xy (m)
uniform float uSmearR;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uS, 0);
  vec2 res = vec2(sz);
  vec4 s = texelFetch(uS, c, 0);
  vec4 fo = texelFetch(uF, c, 0);
  float inflow = 0.0;
  if (c.x > 0) inflow += texelFetch(uF, c + ivec2(-1, 0), 0).x;
  if (c.x < sz.x - 1) inflow += texelFetch(uF, c + ivec2(1, 0), 0).y;
  if (c.y > 0) inflow += texelFetch(uF, c + ivec2(0, -1), 0).z;
  if (c.y < sz.y - 1) inflow += texelFetch(uF, c + ivec2(0, 1), 0).w;
  float h = s.r - (fo.x + fo.y + fo.z + fo.w) + inflow;
  float src = uUseSrc > 0.5 ? texelFetch(uSrc, c, 0).r : 0.0;
  h += src;
  // fresh blood resets the clock of the mixture proportionally
  float age = s.b;
  if (src > 0.0) age *= s.r / max(s.r + src, 1e-6);

  // smear: drag the film along the stroke, leaving streaks
  vec2 p = cellToP(vec2(c) + 0.5, res);
  if (uSmearR > 0.0) {
    vec2 a = uSmear.xy, b = uSmear.zw, ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    float d = length(p - a - ab * t);
    float m = 1.0 - smoothstep(uSmearR * 0.6, uSmearR, d);
    if (m > 0.0) {
      vec2 back = p - ab;
      vec2 bc = (back / (2.0 * uHalf) + 0.5) * res;
      vec4 sb = texelFetch(uS, ivec2(clamp(bc, vec2(0.0), res - 1.0)), 0);
      vec2 dir = normalize(ab + 1e-9);
      float streak = 0.55 + 0.45 * vnoise(vec2(dot(p, vec2(-dir.y, dir.x)) * 2500.0, 0.0));
      float moved = mix(h, sb.r * streak, m * 0.85);
      h = moved;
      age = mix(age, sb.b, m * 0.85);
    }
  }

  // absorption into a porous substrate, then capillary wicking inside it
  float soak = s.g;
  if (uAbsorb > 0.0 && h > 0.0) {
    float a = min(h, uAbsorb * uDt * clamp(1.0 - soak / uCap, 0.0, 1.0));
    h -= a; soak += a;
  }
  if (uWickX > 0.0) {
    // capillary wicking: conservative flux between cells, with the pore
    // mobility of the wetter side of each face (so liquid can invade dry
    // fibres), fastest at intermediate saturation
    float s0 = s.g;
    float sl = c.x > 0 ? texelFetch(uS, c + ivec2(-1, 0), 0).g : s0;
    float sr = c.x < sz.x - 1 ? texelFetch(uS, c + ivec2(1, 0), 0).g : s0;
    float sd = c.y > 0 ? texelFetch(uS, c + ivec2(0, -1), 0).g : s0;
    float su = c.y < sz.y - 1 ? texelFetch(uS, c + ivec2(0, 1), 0).g : s0;
    #define MOB(a, b) clamp(max(a, b) / uCap, 0.0, 1.0)
    soak += uWickX * (MOB(s0, sl) * (sl - s0) + MOB(s0, sr) * (sr - s0))
          + uWickY * (MOB(s0, sd) * (sd - s0) + MOB(s0, su) * (su - s0));
    soak = max(soak, 0.0);
  }

  // evaporation (fastest at thin edges) leaves a coffee-ring deposit of
  // cells and proteins (~45 % haematocrit + plasma solids)
  float dep = s.a;
  if (h > 0.0) {
    float edge = 1.0 - smoothstep(0.02, 0.35, h);
    float e = min(h, uEvap * uDt * uTimeScale * (1.0 + 3.0 * edge));
    h -= e;
    dep += e * 0.5 * (1.0 + 2.5 * edge);
    if (h < 0.004) { dep += h * 0.5; h = 0.0; }
    age += uDt * uTimeScale;
  } else if (soak > 0.0) {
    age += uDt * uTimeScale;
  }
  o = vec4(max(h, 0.0), soak, age, dep);
}
`;

// Stamp a drop impact / deposit into the source texture (additive blend).
export const stampVS = /* glsl */ `
uniform vec4 uStamp;   // centre u, v, half-width a, half-length b (m)
uniform vec2 uDir;     // travel direction in the plane (unit)
in vec3 aPos;
out vec2 vL;
void main() {
  // local coords in units of the ellipse, with room for a tail and spines
  vec2 l = aPos.xy * vec2(2.2, 3.0);
  vL = l;
  vec2 side = vec2(-uDir.y, uDir.x);
  vec2 p = uStamp.xy + side * l.x * uStamp.z + uDir * l.y * uStamp.w;
  gl_Position = vec4(p / uHalf, 0.0, 1.0);
}
`;
export const stampFS = /* glsl */ `
uniform vec4 uStamp;
uniform vec4 uShape;  // peak h (mm), spines 0..1, seed, tail 0..1
in vec2 vL;
out vec4 o;
void main() {
  float r = length(vL);
  float th = atan(vL.x, vL.y);
  // scalloped rim and splash spines radiating from the impact
  float scal = 0.06 * (vnoise(vec2(th * 9.0, uShape.z)) - 0.5);
  float sp = pow(vnoise(vec2(th * 14.0 + uShape.z * 3.0, uShape.z)), 5.0) * 1.4 * uShape.y;
  float edge = 1.0 + scal;
  float hgt = 0.0;
  if (r < edge) hgt = uShape.x * sqrt(1.0 - (r / edge) * (r / edge));
  // spines: thin radial fingers beyond the rim
  if (r >= edge && r < edge + sp) {
    float t = (r - edge) / max(sp, 1e-4);
    hgt = max(hgt, uShape.x * 0.35 * (1.0 - t) * smoothstep(0.0, 0.3, sp));
  }
  // tail pointing in the direction of travel (elongated stains)
  if (uShape.w > 0.0 && vL.y > 0.6) {
    float t = (vL.y - 0.6) / (1.8 * uShape.w + 1e-4);
    float w = 0.45 * (1.0 - t);
    if (t < 1.0 && abs(vL.x) < w) hgt = max(hgt, uShape.x * 0.5 * (1.0 - t) * (1.0 - abs(vL.x) / w));
  }
  o = vec4(hgt, 0.0, 0.0, 0.0);
}
`;

// Smoothed copy of the state for rendering (linear filtered, 16F).
export const visFS = /* glsl */ `
uniform sampler2D uS;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uS, 0);
  vec4 acc = vec4(0.0); float w = 0.0, ageAcc = 0.0, ageW = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    ivec2 cc = clamp(c + ivec2(i, j), ivec2(0), sz - 1);
    float k = exp(-float(i * i + j * j) / 1.3);
    vec4 t = texelFetch(uS, cc, 0);
    acc += t * k; w += k;
    // age is a property of the blood, so average it weighted by how much
    // blood (liquid, soaked or dried) each cell holds
    float m = (t.r + t.g + t.a + 1e-6) * k;
    ageAcc += t.b * m; ageW += m;
  }
  vec4 s = acc / w;
  o = vec4(s.r, s.g, ageAcc / ageW, s.a);
}
`;

// Substrate relief baked once per surface (mm).
export const reliefFS = /* glsl */ `
out vec4 o;
uniform vec2 uRes;
void main() { o = vec4(relief(cellToP(gl_FragCoord.xy, uRes)), 0.0, 0.0, 1.0); }
`;

// Smoothed height of the free surface: substrate relief + film (mm).
export const visTopFS = /* glsl */ `
uniform sampler2D uS, uRelief;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uS, 0);
  vec2 res = vec2(sz);
  float acc = 0.0, w = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    ivec2 cc = clamp(c + ivec2(i, j), ivec2(0), sz - 1);
    float k = exp(-float(i * i + j * j) / 1.3);
    acc += (texelFetch(uS, cc, 0).r + texelFetch(uRelief, cc, 0).r) * k; w += k;
  }
  o = vec4(acc / w, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Rendering
export const planeVS = /* glsl */ `
uniform mat4 uViewProj;
uniform float uCos, uSin;
in vec3 aPos;
out vec2 vP; out vec3 vWorld;
void main() {
  vec2 p = aPos.xy * uHalf;
  vP = p;
  vWorld = vec3(p.x, p.y * uSin, -p.y * uCos);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const bloodOptics = /* glsl */ `
uniform float uOxy;  // 1 = arterial (oxy-Hb), 0 = venous (deoxy-Hb)
// absorption / reduced scattering of whole blood (1/m), and its browning
// to methaemoglobin/haemichrome as it ages and dries
vec3 bloodSigA(float ox) {
  // haemoglobin absorbs blue at least as strongly as green (the Soret band
  // sits just below the blue primary), so blood is deep red, never magenta
  vec3 fresh = mix(vec3(950.0, 21000.0, 25000.0), vec3(170.0, 26000.0, 30000.0), uOxy);
  // methaemoglobin / haemichromes: the red absorption rises, browning it
  vec3 brown = vec3(3200.0, 8500.0, 12500.0);
  return mix(fresh, brown, ox);
}
const vec3 BLOOD_SIGS = vec3(1500.0, 1450.0, 1400.0);
`;

export const planeFS = /* glsl */ `
uniform sampler2D uVis, uTop;
uniform float uCos, uSin, uClotT, uDryT;
uniform float uTheta; // static contact angle on this surface (rad)
in vec2 vP; in vec3 vWorld;
out vec4 o;

vec3 substrate(vec2 p, out float rough, out float f0, out vec3 nPert) {
  nPert = vec3(0.0);
  if (uSurface == 0) {
    vec2 g = abs(fract(p / 0.1 + 0.5) - 0.5) * 0.1;
    float grout = 1.0 - smoothstep(0.0012, 0.0022, min(g.x, g.y));
    vec2 id = floor(p / 0.1 + 0.5);
    vec3 tile = vec3(0.86, 0.87, 0.86) * (0.96 + 0.06 * hash12(id));
    rough = mix(0.02, 0.5, grout); f0 = mix(0.045, 0.02, grout);
    return mix(tile, vec3(0.52, 0.5, 0.47) * (0.8 + 0.3 * vnoise(p * 3000.0)), grout);
  } else if (uSurface == 1) {
    float n = vnoise(p * 900.0) * 0.4 + vnoise(p * 140.0) * 0.4 + vnoise(p * 25.0) * 0.2;
    float pit = smoothstep(0.82, 0.95, vnoise(p * 400.0 + 7.0));
    rough = 0.45; f0 = 0.03;
    nPert = vec3(vnoise(p * 900.0 + 3.0) - 0.5, 0.0, vnoise(p * 900.0 + 9.0) - 0.5) * 0.25;
    return vec3(0.5, 0.49, 0.47) * (0.75 + 0.45 * n) * (1.0 - 0.4 * pit);
  } else if (uSurface == 2) {
    float id = floor(p.y / 0.12 + 0.5);
    float u = p.x + hash12(vec2(id, 1.0)) * 5.0, v = p.y - id * 0.12;
    float rings = fract(v * 60.0 + fbm(vec2(u * 3.0, v * 10.0 + id)) * 2.5);
    rings = smoothstep(0.0, 0.3, rings) * (1.0 - smoothstep(0.5, 1.0, rings));
    float streak = vnoise(vec2(u * 25.0, v * 900.0));
    float seam = 1.0 - smoothstep(0.0005, 0.0012, abs(abs(v) - 0.06));
    rough = 0.12; f0 = 0.04;
    return mix(vec3(0.24, 0.13, 0.06), vec3(0.5, 0.31, 0.16), 0.3 + 0.45 * rings + 0.25 * streak) * (1.0 - 0.7 * seam);
  } else if (uSurface == 3) {
    vec2 w = p / 0.0009;
    float warp = 0.5 + 0.5 * sin(w.x * PI) * sign(sin(w.y * PI * 0.5));
    float fuzz = vnoise(p * 5000.0);
    rough = 0.8; f0 = 0.02;
    return vec3(0.86, 0.85, 0.82) * (0.8 + 0.12 * warp + 0.08 * fuzz);
  }
  float br = vnoise(vec2(p.x * 3000.0, p.y * 12.0)) * 0.6 + vnoise(vec2(p.x * 600.0, p.y * 4.0)) * 0.4;
  rough = 0.1 + 0.06 * br; f0 = 0.6;
  return vec3(0.58, 0.59, 0.6) * (0.9 + 0.2 * br);
}

void main() {
  vec2 p = vP;
  vec2 uv = p / (2.0 * uHalf) + 0.5;
  vec4 s = texture(uVis, uv);
  float h = s.r, soak = s.g, age = s.b, dep = s.a;
  // contact lines: threshold a smoother copy of the film, anti-aliased, so
  // stain edges are crisp round curves instead of a blurry ramp or the
  // simulation grid's staircase
  float o1 = 1.6 / 512.0;
  vec4 sm = 0.25 * (texture(uVis, uv + vec2(o1, o1)) + texture(uVis, uv + vec2(-o1, o1)) + texture(uVis, uv + vec2(o1, -o1)) + texture(uVis, uv + vec2(-o1, -o1)));
  float hs = mix(h, sm.r, 0.8), ds = mix(dep, sm.a, 0.8);
  float aw = fwidth(hs) * 0.7 + 1e-5, awd = fwidth(ds) * 0.7 + 1e-6;
  float filmMask = smoothstep(0.008 - aw, 0.008 + aw, hs);
  float depMask = smoothstep(0.0012 - awd, 0.0012 + awd, ds);
  h = max(h, 0.01) * filmMask;
  dep = max(dep, 0.0015) * depMask;
  vec3 N0 = vec3(0.0, uCos, uSin);
  vec3 T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, uSin, -uCos);
  vec3 V = normalize(uCamPos - vWorld);

  float rough, f0; vec3 np;
  vec3 alb = substrate(p, rough, f0, np);
  float metal = uSurface == 4 ? 1.0 : 0.0;

  // how far the haemoglobin has oxidised / dried (browning)
  // wet clots stay dark red for hours; browning (met-Hb, haemichromes) is
  // driven mostly by drying
  float dryness = clamp(dep / max(dep + h, 1e-4), 0.0, 1.0);
  // drying concentrates the haemoglobin and starts the browning; full
  // browning (met-Hb, then haemichromes) takes days
  float ox = clamp(0.45 * dryness + 0.55 * (1.0 - exp(-age / 259200.0)), 0.0, 1.0);
  vec3 sa = bloodSigA(ox), ss = BLOOD_SIGS;
  // clot retraction squeezes out serum: a thin, straw-coloured, clear rim
  float serum = smoothstep(0.5, 1.0, age / uClotT) * (1.0 - smoothstep(0.03, 0.35, h)) * smoothstep(0.004, 0.02, h);
  sa = mix(sa, vec3(6.0, 12.0, 70.0), serum * 0.85);
  ss = mix(ss, vec3(8.0), serum * 0.85);
  vec3 Rinf = kmAlbedo(sa, ss);
  vec3 seff = sqrt(3.0 * sa * (sa + ss));

  // blood soaked into the substrate stains it
  // (Beer-Lambert through the blood held in the pores, down and back up;
  // the fibres' own scattering keeps it bright: deep, saturated red on cotton)
  alb *= exp(-2.0 * soak * 1e-3 * bloodSigA(ox) * 0.6);

  // dried deposit: a glossy protein film that absorbs like concentrated
  // haemoglobin (Beer-Lambert, down and back up through it): translucent
  // orange-red where thin, near-black red-brown where thick, with shrinkage
  // cracks in thick crusts
  float dryGloss = 0.0;
  if (dep > 0.0005) {
    // blood is ~80 % water: dried, its haemoglobin is ~4x as concentrated
    vec3 saD = bloodSigA(ox) * 4.0;
    alb *= exp(-2.0 * dep * 1e-3 * saD);
    // the precipitated protein crust also scatters a little: dull red-brown
    alb += vec3(0.055, 0.022, 0.016) * (1.0 - exp(-dep * 60.0));
    vec2 cp = p * 900.0;
    vec2 ip = floor(cp), fp = fract(cp);
    float md = 1e9, md2 = 1e9;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(i, j), o2 = vec2(hash12(ip + g), hash12(ip + g + 17.0));
      float d = length(g + o2 - fp);
      if (d < md) { md2 = md; md = d; } else if (d < md2) md2 = d;
    }
    // (only thick crusts - a dried-out pool - crack; spacing ~ a few thicknesses)
    float crack = (1.0 - smoothstep(0.0, 0.04, md2 - md)) * smoothstep(0.15, 0.35, dep);
    // cracks open onto the substrate (and the crust curls a little)
    // (a crack is a shadowed gap: the substrate shows only dimly)
    alb = mix(alb, substrate(p, rough, f0, np) * 0.3, crack * (1.0 - smoothstep(0.02, 0.2, h)) * 0.5);
    dryGloss = smoothstep(0.0, 0.01, dep) * (1.0 - crack);
  }
  // liquid film over the substrate: two-layer Kubelka-Munk
  float hm = h * 1e-3;
  vec3 Td = exp(-seff * hm);
  vec3 Rf = Rinf * (1.0 - Td * Td);
  vec3 Rsub = metal > 0.5 ? vec3(0.08) : alb;
  vec3 R = Rf + (1.0 - Rf) * (1.0 - Rf) * Td * Td * Rsub / max(1.0 - Rf * Rsub, vec3(1e-3));
  float wet = smoothstep(0.004, 0.03, h);
  vec3 base = mix(alb, R, wet);

  // normals: film slope (meniscus bulge of each drop and pool) + substrate
  // normals of the liquid's free surface = substrate relief + film thickness
  // (a broader stencil: the free surface is smooth on the scale of a cell, so
  // tiny bumps where the film fills the grout mustn't catch the sharp wet
  // highlight)
  float e = 1.8 / 512.0, cell = 2.0 * uHalf * e * 1e3; // mm
  float hx = texture(uTop, uv + vec2(e, 0.0)).r - texture(uTop, uv - vec2(e, 0.0)).r;
  float hy = texture(uTop, uv + vec2(0.0, e)).r - texture(uTop, uv - vec2(0.0, e)).r;
  vec2 grad = vec2(hx, hy) / (2.0 * cell) * wet;
  // the liquid meets the surface at its contact angle: cap the slope there
  float gl = length(grad), gmax = tan(uTheta);
  if (gl > gmax) grad *= gmax / gl;
  vec3 N = normalize(N0 - T * grad.x - B * grad.y + (T * np.x + B * np.z) * (1.0 - wet));

  vec3 irr = windowLight(N) + ambient(N);
  vec3 diff = base / PI * irr * (1.0 - metal * (1.0 - wet));
  // clotting blood loses its mirror gloss and turns jelly-like
  float clot = clamp(age / uClotT, 0.0, 1.0);
  float r = mix(rough, 0.02 + 0.18 * clot * clot + 0.12 * dryness, wet);
  // a dried film is glossy too, like varnish (thick crusts less so)
  r = mix(r, 0.12, dryGloss * (1.0 - wet));
  float F = mix(mix(f0, 0.04, dryGloss), 0.02, wet);
  float Fr = F + (1.0 - F) * pow(1.0 - max(dot(N, V), 0.0), 5.0) * (1.0 - r);
  vec3 spec = env(reflect(-V, N), r * 0.6) * Fr;
  if (metal > 0.5 && wet < 0.5) spec *= vec3(0.95, 0.96, 0.98);
  // soft contact shadow of the room
  o = vec4(min(diff * (1.0 - Fr * (1.0 - metal)) + spec, vec3(40.0)), 1.0);
}
`;

// Drops in flight: sphere impostors.
export const dropVS = /* glsl */ `
uniform mat4 uViewProj, uView;
uniform sampler2D uDrops;
in vec3 aPos;
out vec2 vC; out vec3 vCenter; out float vRad; out vec3 vVel;
void main() {
  vec4 d = texelFetch(uDrops, ivec2(gl_InstanceID, 0), 0);
  vec4 v = texelFetch(uDrops, ivec2(gl_InstanceID, 1), 0);
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vC = aPos.xy; vCenter = d.xyz; vRad = d.w; vVel = v.xyz;
  // stretch along the velocity a little (motion blur of fast drops)
  vec3 vs = v.xyz * 0.004;
  vec3 wp = d.xyz + (right * aPos.x + up * aPos.y) * d.w * 1.2 + vs * aPos.y * 0.5;
  gl_Position = d.w > 0.0 ? uViewProj * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;
export const dropFS = /* glsl */ `
uniform mat4 uView;
in vec2 vC; in vec3 vCenter; in float vRad; in vec3 vVel;
out vec4 o;
void main() {
  float d = length(vC);
  if (d > 1.0) discard;
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 fwd = normalize(uCamPos - vCenter);
  vec3 n = normalize(right * vC.x + up * vC.y + fwd * sqrt(1.0 - d * d));
  float F = fresnel(dot(n, fwd), 0.02);
  vec3 alb = kmAlbedo(bloodSigA(0.0), BLOOD_SIGS);
  vec3 col = alb / PI * (windowLight(n) + ambient(n)) * 0.8 + env(reflect(-fwd, n), 0.0) * F;
  o = vec4(col, 1.0);
}
`;
