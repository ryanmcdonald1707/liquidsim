// Rain: an outdoor street in the rain (and the same street seen through a
// rain-covered window). Shaders assume the shared `common` chunk (noise,
// fresnel, uTime, uCamPos) has been prepended.

export const rainCommon = /* glsl */ `
uniform float uLight;     // 0 day (overcast), 1 dusk, 2 night
uniform float uFog;       // extinction of rain + haze (1/m)
uniform float uRain;      // rain rate (mm/h)
uniform vec3 uLamp0, uLamp1, uLamp2;
uniform vec3 uLampCol;
uniform float uLampI;     // radiant intensity of a streetlamp (W/sr-ish units)

vec3 skyColour(vec3 d) {
  float el = clamp(d.y, -0.2, 1.0);
  vec3 day = mix(vec3(0.86, 0.88, 0.92) * 3.4, vec3(0.7, 0.74, 0.8) * 2.6, smoothstep(0.0, 0.7, el));
  vec3 dusk = mix(vec3(0.62, 0.42, 0.36) * 0.9, vec3(0.16, 0.19, 0.3) * 0.5, smoothstep(0.0, 0.4, el));
  vec3 night = mix(vec3(0.05, 0.038, 0.03), vec3(0.006, 0.008, 0.014), smoothstep(0.0, 0.3, el)); // city glow on the clouds
  vec3 c = uLight < 0.5 ? day : uLight < 1.5 ? dusk : night;
  // low, heavy rain clouds
  float cl = fbm(d.xz / max(d.y, 0.05) * 0.6 + uTime * 0.01);
  return c * mix(1.0, 0.75 + 0.5 * cl, smoothstep(0.02, 0.3, d.y));
}
float daylight() { return uLight < 0.5 ? 1.0 : uLight < 1.5 ? 0.35 : 0.02; }

// skyline of the street: tall buildings to the sides, receding along -z
vec4 skyline(vec3 d) {
  float az = atan(d.x, -d.z);
  float el = d.y;
  float side = abs(sin(az));
  float bw = floor(az * 11.0 + 0.5 * sin(az * 3.0));
  float hb = (0.03 + 0.2 * pow(hash12(vec2(bw, 1.0)), 1.5)) * (0.3 + 0.9 * side);
  hb *= step(0.12, hash12(vec2(bw, 9.0)));   // occasional gaps
  if (el > hb) return vec4(0.0);
  float tone = 0.6 + 0.5 * hash12(vec2(bw, 4.0));
  vec3 wall = vec3(0.14, 0.14, 0.15) * tone * (uLight < 0.5 ? 1.6 : uLight < 1.5 ? 0.35 : 0.04);
  vec2 w = vec2(az * 140.0, el * 190.0);
  vec2 f = fract(w), id = floor(w);
  float win = step(0.3, f.x) * step(f.x, 0.7) * step(0.35, f.y) * step(f.y, 0.75) * step(el, hb - 0.012);
  float lit = step(0.8, hash12(id + bw * 7.0));
  vec3 warm = mix(vec3(1.0, 0.7, 0.42), vec3(0.75, 0.85, 1.0), step(0.7, hash12(id * 3.1)));
  vec3 winCol = uLight < 0.5 ? mix(wall * 0.45, skyColour(vec3(0.0, 1.0, 0.0)) * 0.35, 0.3) : warm * (uLight < 1.5 ? 0.5 : 0.9) * lit + wall * 0.5 * (1.0 - lit);
  wall = mix(wall, winCol, win);
  return vec4(wall, 1.0);
}

vec3 outEnv(vec3 d, float blur) {
  d = normalize(d);
  vec3 sky = skyColour(d);
  if (d.y < 0.0) sky = mix(sky, skyColour(vec3(d.x, 0.0, d.z)) * 0.4, smoothstep(0.0, -0.1, d.y));
  vec4 b = skyline(d);
  // distance haze: buildings (~40 m away) fade into the rain
  float haze = exp(-uFog * 70.0) * 0.85;
  return mix(sky, mix(sky, b.rgb, haze), b.a * (1.0 - blur * 0.5));
}

vec3 skyIrr(vec3 n) {
  vec3 up = skyColour(vec3(0.0, 1.0, 0.0)) * 0.9, hor = skyColour(normalize(vec3(n.x, 0.15, n.z))) * 0.6, down = up * 0.12;
  return PI * (n.y > 0.0 ? mix(hor, up, n.y) : mix(hor, down, -n.y)) * 0.55;
}

float D_GGX(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }

vec3 lampAt(int i) { return i == 0 ? uLamp0 : i == 1 ? uLamp1 : uLamp2; }

// direct light from the streetlamps: diffuse + GGX specular
vec3 lampShade(vec3 p, vec3 n, vec3 v, vec3 alb, float rough, float f0) {
  vec3 sum = vec3(0.0);
  if (uLampI <= 0.0) return sum;
  for (int i = 0; i < 3; i++) {
    vec3 l = lampAt(i) - p;
    float d2 = dot(l, l), dl = sqrt(d2);
    l /= dl;
    float nl = max(dot(n, l), 0.0);
    if (nl <= 0.0) continue;
    // lamps shine downwards (a shaded cone): l points from p up to the lamp
    float cone = smoothstep(-0.2, 0.5, l.y);
    vec3 E = uLampCol * uLampI * cone / d2 * exp(-uFog * dl);
    vec3 h = normalize(l + v);
    float a = max(rough * rough, 0.002);
    float spec = D_GGX(max(dot(n, h), 0.0), a) * fresnel(dot(h, v), f0) / (4.0 * max(dot(n, v), 0.08));
    sum += E * (alb / PI * nl + spec * nl);
  }
  return sum;
}

// single scattering of lamp light by rain and haze along a view ray:
// the classic closed form for a point light in a homogeneous medium
vec3 lampGlow(vec3 ro, vec3 rd, float tmax) {
  vec3 sum = vec3(0.0);
  if (uLampI <= 0.0) return sum;
  float sig = uFog * 1.4;
  for (int i = 0; i < 3; i++) {
    vec3 L = lampAt(i);
    float t0 = dot(L - ro, rd);
    float h = max(length(L - ro - rd * t0), 0.05);
    float I = (atan((tmax - t0) / h) - atan(-t0 / h)) / h;
    // raindrops scatter strongly forwards: glows are brightest looking at a lamp
    float fwd = 1.0 + 4.0 * pow(max(dot(rd, normalize(L - ro)), 0.0), 12.0);
    sum += uLampCol * uLampI * sig / (4.0 * PI) * I * fwd * exp(-uFog * max(t0, 0.0));
  }
  return sum;
}

vec3 fogColour(vec3 rd) {
  return skyColour(normalize(vec3(rd.x, 0.05, rd.z))) * 0.8;
}
vec3 applyAtmos(vec3 col, vec3 ro, vec3 rd, float t) {
  float T = exp(-uFog * t);
  return col * T + fogColour(rd) * (1.0 - T) + lampGlow(ro, rd, t);
}
`;

// ---------------------------------------------------------------------------
export const bgFS = /* glsl */ `
uniform mat4 uInvViewProj;
in vec2 vNdc;
out vec4 o;
void main() {
  vec4 a = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(a.xyz / a.w - uCamPos);
  vec3 c = outEnv(d, 0.0);
  // distant rain curtains: faint vertical streaks drifting down
  float az = atan(d.x, -d.z);
  float streak = vnoise(vec2(az * 900.0, d.y * 8.0 + uTime * 6.0)) * vnoise(vec2(az * 260.0, d.y * 3.0 + uTime * 3.0));
  c += fogColour(d) * streak * 0.25 * smoothstep(0.0, 60.0, uRain) * smoothstep(-0.05, 0.2, d.y);
  c = applyAtmos(c, uCamPos, d, 80.0);
  o = vec4(c, 1.0);
}
`;

// Ground: asphalt or cobbles, wetted by the rain, puddles in its low spots,
// raindrop ripple rings on the puddles.
export const groundVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }
`;
export const groundFS = /* glsl */ `
uniform int uGround;      // 0 asphalt, 1 cobblestones
uniform float uWetness;       // surface film wetness 0..1
uniform float uPuddle;    // puddle water level 0..1
uniform float uRipPeriod; // seconds between drops per ripple cell (large = none)
in vec3 vWorld;
out vec4 o;

vec3 voronoi(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j);
    vec2 o2 = vec2(hash12(ip + g), hash12(ip + g + 19.1)) * 0.8 + 0.1;
    float d = length(g + o2 - fp);
    if (d < d1) { d2 = d1; d1 = d; id = ip + g; } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, hash12(id));
}
// surface relief (m)
float gFw = 0.0; // pixel footprint (m), set per fragment for band-limiting
float bl(float freq) { return clamp(1.2 - gFw * freq * 1.5, 0.0, 1.0); }
float relief(vec2 p) {
  float big = (fbm(p * 0.28 + 3.0) - 0.5) * 0.12;          // settled, uneven road
  if (uGround == 0) {
    float agg = (vnoise(p * 380.0) - 0.5) * 0.0016 * bl(380.0);
    return big + agg;
  }
  vec3 v = voronoi(p * 8.5);
  float stone = 0.009 * (1.0 - v.x * v.x * 1.2);
  float gap = smoothstep(0.1, 0.02, v.y - v.x);
  return big + stone * (1.0 - gap) - 0.004 * gap;
}
vec3 groundAlbedo(vec2 p, out float pores) {
  if (uGround == 0) {
    float agg = mix(0.5, vnoise(p * 380.0), bl(380.0));
    float spk = smoothstep(0.7, 0.95, vnoise(p * 900.0)) * bl(900.0) + 0.06 * (1.0 - bl(900.0));
    pores = 0.8;
    return vec3(0.075, 0.075, 0.08) * (0.8 + 0.4 * agg) + vec3(0.12) * spk + vec3(0.03, 0.028, 0.025) * fbm(p * 0.8);
  }
  vec3 v = voronoi(p * 8.5);
  float gap = smoothstep(0.1, 0.02, v.y - v.x);
  pores = mix(0.55, 0.9, gap);
  vec3 stone = mix(vec3(0.2, 0.19, 0.18), vec3(0.3, 0.26, 0.22), v.z) * (0.8 + 0.3 * mix(0.5, vnoise(p * 120.0), bl(120.0)));
  return mix(stone, vec3(0.07, 0.065, 0.06), gap * bl(40.0)) + vec3(0.02) * (1.0 - bl(40.0));
}

// Ripple rings from raindrops on standing water. Each cell of a jittered grid
// receives a drop at a random time and place every period; the ring is a
// wave packet expanding at the capillary-gravity group speed (~0.2 m/s),
// decaying as it spreads. Two offset layers let rings overlap.
vec2 ripples(vec2 p) {
  vec2 g = vec2(0.0);
  if (uRipPeriod > 50.0) return g;
  const float cs = 0.07;
  for (int layer = 0; layer < 2; layer++) {
    vec2 off = float(layer) * vec2(0.5, 0.37);
    vec2 P = p / cs + off;
    vec2 ip = floor(P);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = ip + vec2(i, j);
      float h1 = hash12(c + float(layer) * 17.0), h3 = hash12(c * 1.7 + 3.0);
      float per = uRipPeriod * (0.7 + 0.6 * h3);
      float t = uTime / per + h1;
      float cyc = floor(t), age = fract(t) * per;
      vec2 dp = (c + vec2(hash12(c + cyc * 1.31), hash12(c + cyc * 2.77)) - off) * cs;
      vec2 dv = p - dp;
      float r = length(dv);
      float R = 0.004 + 0.21 * age;
      float w = 0.006 + 0.02 * age;
      float env = exp(-(r - R) * (r - R) / (w * w)) * exp(-age * 3.2) / (1.0 + r * 30.0);
      float strength = mix(0.4, 1.0, hash12(c + cyc * 5.1));
      float k = 6.2832 / 0.012;
      g += dv / max(r, 1e-4) * env * cos(k * (r - R)) * strength;
    }
  }
  return g * 1.5; // slopes ~0.15: 0.3 mm rings at 1.2 cm wavelength
}

void main() {
  vec3 p = vWorld;
  vec3 v = normalize(uCamPos - p);
  float dist = length(uCamPos - p);
  gFw = length(fwidth(p.xz));
  float fade = clamp(1.0 - dist / 30.0, 0.0, 1.0); // detail fades with distance
  // geometry: relief normal
  float e = 0.004;
  float h0 = relief(p.xz);
  vec3 nr = normalize(vec3(-(relief(p.xz + vec2(e, 0.0)) - h0) / e, 1.0, -(relief(p.xz + vec2(0.0, e)) - h0) / e));
  vec3 N = normalize(mix(vec3(0.0, 1.0, 0.0), nr, fade));
  float pores;
  vec3 alb = groundAlbedo(p.xz, pores);
  // water fills the low spots
  float level = mix(-0.04, 0.012, uPuddle);
  float depth = level - h0;
  float pud = smoothstep(0.0, 0.0015, depth) * step(0.001, uPuddle);
  // a wet film darkens porous surfaces and makes them glossy
  alb *= mix(1.0, mix(0.72, 0.45, pores), uWetness);
  float rough = mix(mix(0.75, 0.5, float(uGround)), 0.14 + 0.08 * vnoise(p.xz * 20.0), uWetness);
  vec3 col;
  if (pud > 0.0) {
    vec2 rg = ripples(p.xz) * fade * bl(90.0);
    vec3 Nw = normalize(vec3(-rg.x, 1.0, -rg.y));
    float F = fresnel(dot(Nw, v), 0.02);
    vec3 R = reflect(-v, Nw);
    vec3 refl = outEnv(R, 0.0) + lampShade(p, Nw, v, vec3(0.0), 0.03, 1.0) * 0.0;
    // mirror-sharp lamp reflections in the water
    vec3 spec = lampShade(p, Nw, v, vec3(0.0), 0.035, 0.02);
    // the ground seen through the water, darker with depth
    vec3 under = alb * (skyIrr(nr) * daylight() + lampShade(p, nr, v, alb, 0.9, 0.02)) * exp(-depth * 60.0);
    vec3 water = refl * F + spec + under * (1.0 - F);
    vec3 film = alb / PI * skyIrr(N) + lampShade(p, N, v, alb, rough, 0.04) + outEnv(reflect(-v, N), rough) * fresnel(dot(N, v), 0.04) * uWetness;
    col = mix(film, water, pud);
  } else {
    float F = fresnel(dot(N, v), 0.04);
    vec3 envR = outEnv(reflect(-v, N), rough) * F * mix(0.2, 1.0, uWetness) * (1.0 - rough * 0.8);
    col = alb / PI * skyIrr(N) + lampShade(p, N, v, alb, rough, 0.04) + envR;
  }
  col = applyAtmos(col, uCamPos, -v, dist);
  o = vec4(min(col, vec3(60.0)), 1.0);
}
`;

// Lamp posts (dark painted metal) and lamp heads (emissive)
export const propVS = /* glsl */ `
uniform mat4 uViewProj, uModel;
in vec3 aPos; in vec3 aNormal;
out vec3 vWorld, vN;
void main() { vec4 w = uModel * vec4(aPos, 1.0); vWorld = w.xyz; vN = mat3(uModel) * aNormal; gl_Position = uViewProj * w; }
`;
export const propFS = /* glsl */ `
uniform float uEmissive;
in vec3 vWorld, vN;
out vec4 o;
void main() {
  vec3 n = normalize(vN), v = normalize(uCamPos - vWorld);
  float dist = length(uCamPos - vWorld);
  vec3 col;
  if (uEmissive > 0.5) col = uLampCol * (uLampI > 0.0 ? 60.0 : 0.3);
  else {
    vec3 alb = vec3(0.05, 0.055, 0.06);
    col = alb / PI * skyIrr(n) + lampShade(vWorld, n, v, alb, 0.3, 0.05)
        + outEnv(reflect(-v, n), 0.3) * fresnel(dot(n, v), 0.05); // wet paint
  }
  o = vec4(applyAtmos(col, uCamPos, -v, dist), 1.0);
}
`;

// Falling rain and splash droplets: camera-facing streaks along the motion
// blur of one frame; sub-pixel drops keep their energy by scaling alpha.
export const streakVS = /* glsl */ `
uniform mat4 uViewProj;
uniform sampler2D uP;     // xyz position, w diameter (m)
uniform sampler2D uV;     // xyz velocity
uniform vec2 uRes;
uniform float uShutter;
in vec3 aPos;
out vec2 vL; out float vCov; out vec3 vPos; flat out float vAlive;
void main() {
  int id = gl_InstanceID;
  ivec2 tc = ivec2(id % 128, id / 128);
  vec4 P = texelFetch(uP, tc, 0);
  vec3 V = texelFetch(uV, tc, 0).xyz;
  vAlive = step(1e-6, P.w);
  vec3 a = P.xyz, b = P.xyz - V * uShutter;
  vec4 ca = uViewProj * vec4(a, 1.0), cb = uViewProj * vec4(b, 1.0);
  // drops within half a metre of the lens are out of focus: skip them
  if (ca.w < 0.5 || cb.w < 0.5 || vAlive < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 sa = ca.xy / ca.w, sb = cb.xy / cb.w;
  vec2 dir = (sa - sb) * uRes * 0.5;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  // true width in pixels vs the >= 1 px we draw
  float wpx = P.w * uRes.y * 0.5 / ca.w * 2.2;
  float draw = max(wpx, 1.2);
  vCov = min(wpx / draw, 1.0);
  float t = aPos.y * 0.5 + 0.5; // 0 at the tail, 1 at the head
  vec2 s = mix(sb, sa, t);
  vec4 cc = mix(cb, ca, t);
  s += perp * aPos.x * draw / uRes * 2.0 * 0.5;
  s += dir * aPos.y * draw / uRes;
  vL = aPos.xy;
  vPos = a;
  gl_Position = vec4(s * cc.w, cc.z, cc.w);
}
`;
export const streakFS = /* glsl */ `
in vec2 vL; in float vCov; in vec3 vPos; flat in float vAlive;
out vec4 o;
void main() {
  float edge = 1.0 - smoothstep(0.4, 1.0, abs(vL.x));
  // a drop is a tiny lens: it shows a squeezed, inverted image of the whole
  // sky/street, so on average it looks like the diffuse sky light, plus a
  // bright forward-scattered sparkle near lamps
  vec3 v = normalize(uCamPos - vPos);
  vec3 c = skyColour(vec3(0.0, 1.0, 0.0)) * 0.55;
  for (int i = 0; i < 3; i++) {
    if (uLampI <= 0.0) break;
    vec3 l = lampAt(i) - vPos;
    float d2 = dot(l, l);
    float cosT = dot(normalize(l), -v);
    float phase = 0.3 + 6.0 * pow(max(cosT, 0.0), 6.0) + 1.5 * pow(max(-cosT, 0.0), 3.0);
    c += uLampCol * uLampI / d2 * phase * 0.35;
  }
  float a = edge * vCov * 0.55;
  float dist = length(uCamPos - vPos);
  a *= exp(-uFog * dist);
  o = vec4(c * a, a);
}
`;

// ---------------------------------------------------------------------------
// Window: drops on the glass, rendered as lenses over the blurred street.
export const dropVS = /* glsl */ `
uniform sampler2D uD;  // x, y (px), r (px), elongation
uniform vec2 uRes;
in vec3 aPos;
out vec2 vL; flat out float vElong;
void main() {
  int id = gl_InstanceID;
  vec4 d = texelFetch(uD, ivec2(id % 128, id / 128), 0);
  vElong = d.w;
  vec2 half_ = vec2(d.z, d.z * (1.0 + d.w)) * 1.15;
  vec2 px = d.xy + aPos.xy * half_;
  vL = aPos.xy * 1.15;
  gl_Position = d.z > 0.0 ? vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;
export const dropFS = /* glsl */ `
in vec2 vL; flat in float vElong;
out vec4 o;
void main() {
  // teardrop: sliding drops are elongated and narrower at the top (trailing edge)
  vec2 q = vL;
  q.x *= 1.0 + 0.35 * vElong * clamp(-q.y, 0.0, 1.0);
  float d = length(q);
  if (d > 1.0) discard;
  float a = 1.0 - smoothstep(0.82, 1.0, d);
  vec2 n = q;                       // surface slope of a spherical cap
  float th = sqrt(max(1.0 - d * d, 0.0));
  o = vec4(n * a, th * a, a);
}
`;
export const windowFS = /* glsl */ `
uniform sampler2D uSharp, uBlur, uDrops;
uniform vec2 uRes;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 dm = texture(uDrops, vUv);
  vec3 bg = texture(uBlur, vUv).rgb;
  float a = dm.a;
  vec3 col = bg;
  if (a > 0.001) {
    vec2 n = dm.rg / a;
    float th = dm.b / a;
    // each drop is a strong lens: it shows an inverted, in-focus image of the
    // scene behind it, squeezed into the drop
    vec2 inv = vUv - n * vec2(0.09 * uRes.y / uRes.x, -0.14) * (0.6 + th);
    vec3 lens = texture(uSharp, clamp(inv, 0.001, 0.999)).rgb;
    // total internal reflection darkens the steep rim of each drop
    float rim = smoothstep(0.55, 0.98, length(n));
    lens *= 1.0 - 0.75 * rim;
    // specular glints from the bright sky / lamps above
    vec3 nn = normalize(vec3(n.x, -n.y, th + 0.25));
    float spec = pow(max(dot(nn, normalize(vec3(-0.25, 0.75, 0.6))), 0.0), 40.0);
    lens += skyColour(vec3(0.0, 1.0, 0.0)) * spec * 0.6 + uLampCol * spec * (uLampI > 0.0 ? 1.2 : 0.0);
    col = mix(bg, lens, a);
  }
  // the glass pane itself: faint reflection of the dim room + slight grime
  col = col * 0.93 + vec3(0.012, 0.011, 0.01) * daylight();
  // window frame
  vec2 f = min(vUv, 1.0 - vUv);
  float frame = 1.0 - smoothstep(0.012, 0.018, min(f.x * uRes.x / uRes.y, f.y));
  col = mix(col, vec3(0.03, 0.028, 0.026) * (0.3 + daylight()), frame);
  o = vec4(col, 1.0);
}
`;
