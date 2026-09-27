// All GLSL. `common` is prepended to every scene shader: it holds the
// procedural room (the only light source), analytic soft shadows of the cup,
// and the glazed-ceramic BRDF, so the coffee can ray trace reflections of the
// cup wall with exactly the same shading the rasteriser uses.

export const common = /* glsl */ `
#define PI 3.14159265359
uniform vec3 uCupPos;
uniform float uTime;
uniform sampler2D uWet;
uniform vec3 uCamPos;

const vec3 LW = normalize(vec3(sin(WIN_AZ) * cos(WIN_ELC), sin(WIN_ELC), -cos(WIN_AZ) * cos(WIN_ELC)));
const vec3 LAMP = normalize(vec3(0.62, 0.62, 0.48));
const vec3 FILL = normalize(vec3(0.45, 0.35, 0.85));

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

// ---------------------------------------------------------------------------
// The room: warm plaster walls, dark floor, a big daylight window with
// mullions behind the cup and a small tungsten lamp to the right.
vec3 env(vec3 d, float blur) {
  d = normalize(d);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.x, -d.z) - WIN_AZ;
  az = mod(az + PI, 2.0 * PI) - PI;
  vec3 col = mix(vec3(0.055, 0.045, 0.038), vec3(0.19, 0.16, 0.13), smoothstep(-0.3, 0.1, d.y));
  col = mix(col, vec3(0.24, 0.225, 0.21), smoothstep(0.7, 0.98, d.y));
  col *= 0.8 + 0.4 * smoothstep(-1.0, 1.0, cos(az)); // wall facing the window is lit
#ifdef LAB_ENV
  {
    // a lab: tiled splash-back, base cabinets and shelves of reagent bottles
    float det = 1.0 - smoothstep(0.02, 0.2, blur);
    float lit = 0.8 + 0.4 * smoothstep(-1.0, 1.0, cos(az));
    float daz = atan(d.x, -d.z);
    if (el > 0.0 && el < 0.26) {
      float door = fract(daz * 2.2);
      vec3 cab = vec3(0.34, 0.36, 0.38) * (0.9 + 0.1 * vnoise(vec2(daz * 40.0, el * 20.0)));
      cab *= mix(1.0, 0.35, (1.0 - smoothstep(0.0, 0.015 + blur, abs(door - 0.5) - 0.48)) * det);
      cab = mix(cab, vec3(0.75), (1.0 - smoothstep(0.004, 0.01 + blur, length(vec2((abs(door - 0.5) - 0.42) * 0.3, el - 0.21)))) * det);
      col = cab * lit;
    } else if (el >= 0.26 && el < 0.5) {
      vec2 t = vec2(daz * 16.0, el * 16.0);
      float grout = max(1.0 - smoothstep(0.0, 0.05 + blur * 4.0, abs(fract(t.x) - 0.5) - 0.45), 1.0 - smoothstep(0.0, 0.05 + blur * 4.0, abs(fract(t.y) - 0.5) - 0.45));
      col = mix(vec3(0.72, 0.74, 0.74), vec3(0.45, 0.46, 0.46), grout * det) * 0.55 * lit;
      // shelf of bottles
      float shelf = 1.0 - smoothstep(0.0, 0.006 + blur, abs(el - 0.34));
      float cell = floor(daz * 9.0), fx = fract(daz * 9.0);
      float hgt = 0.05 + 0.07 * hash12(vec2(cell, 3.0));
      float wdt = 0.18 + 0.15 * hash12(vec2(cell, 5.0));
      float inB = (1.0 - smoothstep(wdt - 0.03 - blur, wdt + blur, abs(fx - 0.5))) * step(0.34, el) * (1.0 - smoothstep(0.34 + hgt - blur, 0.34 + hgt + 0.004 + blur, el));
      float hue = hash12(vec2(cell, 7.0));
      vec3 glassCol = hue < 0.3 ? vec3(0.45, 0.24, 0.06) : hue < 0.55 ? vec3(0.12, 0.26, 0.5) : hue < 0.75 ? vec3(0.16, 0.4, 0.2) : vec3(0.8, 0.8, 0.78);
      col = mix(col, glassCol * (0.5 + 0.3 * fx) * lit, inB * step(0.2, hash12(vec2(cell, 11.0))));
      col = mix(col, vec3(0.9, 0.88, 0.84) * 0.6 * lit, shelf);
    } else if (el >= 0.56 && el < 1.0) {
      // wall cabinets with glass-panel doors
      float door = fract(daz * 3.0);
      float frame = 1.0 - smoothstep(0.0, 0.01 + blur, min(abs(door - 0.5) - 0.4, 0.0) + min(abs(el - 0.78) - 0.18, 0.0) + 0.02);
      float edge = (1.0 - smoothstep(0.0, 0.012 + blur, abs(abs(door - 0.5) - 0.5))) + (1.0 - smoothstep(0.0, 0.012 + blur, abs(el - 0.565)));
      vec3 wood = vec3(0.5, 0.36, 0.22) * (0.85 + 0.15 * vnoise(vec2(daz * 30.0, el * 200.0)));
      float cell = floor(daz * 14.0), fx = fract(daz * 14.0);
      float row = el < 0.78 ? 0.62 : 0.8;
      float hgt = 0.05 + 0.08 * hash12(vec2(cell, row * 10.0));
      float inB = (1.0 - smoothstep(0.25 - blur, 0.3 + blur, abs(fx - 0.5))) * step(row, el) * (1.0 - smoothstep(row + hgt - blur, row + hgt + blur, el));
      float hue = hash12(vec2(cell, row * 20.0));
      vec3 inside = mix(vec3(0.1, 0.1, 0.11), hue < 0.5 ? vec3(0.5, 0.3, 0.1) : hue < 0.8 ? vec3(0.2, 0.3, 0.5) : vec3(0.85), inB * 0.8);
      col = mix(wood, inside, frame * det) * lit * 0.9;
      col *= 1.0 - 0.6 * min(edge, 1.0) * det;
    }
  }
#endif
  float w = 0.006 + blur;
  float el0 = WIN_EL0, el1 = WIN_EL1, aw = WIN_AW;
  float fx = smoothstep(-aw - 0.05 - w, -aw - 0.05 + w, az) * (1.0 - smoothstep(aw + 0.05 - w, aw + 0.05 + w, az));
  float fy = smoothstep(el0 - 0.05 - w, el0 - 0.05 + w, el) * (1.0 - smoothstep(el1 + 0.05 - w, el1 + 0.05 + w, el));
  col = mix(col, vec3(0.85, 0.83, 0.8) * 0.75, fx * fy); // painted frame
  float wx = smoothstep(-aw - w, -aw + w, az) * (1.0 - smoothstep(aw - w, aw + w, az));
  float wy = smoothstep(el0 - w, el0 + w, el) * (1.0 - smoothstep(el1 - w, el1 + w, el));
  float t = clamp((el - el0) / (el1 - el0), 0.0, 1.0);
  vec3 sky = mix(vec3(1.0, 0.96, 0.9) * 13.0, vec3(0.62, 0.76, 1.0) * 9.0, pow(t, 0.7));
  // soft clouds and a line of distant trees at the bottom of the view
  float cl = fbm(vec2(az * 6.0, el * 14.0) + 3.0);
  sky *= mix(1.0, 0.8 + 0.5 * cl, 1.0 - smoothstep(0.0, 0.2, blur));
  float trees = smoothstep(0.0, 0.02 + blur, (0.18 + 0.12 * fbm(vec2(az * 9.0, 1.0))) - t);
  sky = mix(sky, vec3(0.35, 0.42, 0.3) * 1.4, trees * (1.0 - smoothstep(0.1, 0.4, blur)) * 0.9);
  // mullions (fade out with blur)
  float mw = 0.012, mb = 0.004 + blur;
  float mul = max(1.0 - smoothstep(mw - mb, mw + mb, abs(az)),
                  1.0 - smoothstep(mw - mb, mw + mb, abs(el - mix(el0, el1, 0.55))));
  sky = mix(sky, vec3(0.8, 0.78, 0.74) * 0.9, mul * (1.0 - smoothstep(0.05, 0.3, blur)));
  col = mix(col, sky, wx * wy);
  // tungsten lamp
  float c = dot(d, LAMP);
  col += vec3(1.0, 0.62, 0.3) * 40.0 * smoothstep(cos(0.035 + blur), cos(0.02), c);
  col += vec3(1.0, 0.62, 0.3) * 0.25 * pow(max(c, 0.0), 12.0);
  return col;
}

// Irradiance-ish ambient term from the room (excluding the window lobe,
// which is applied as a shadowed area light).
vec3 ambient(vec3 n) {
  vec3 up = vec3(0.6, 0.59, 0.57), down = vec3(0.16, 0.14, 0.12);
  vec3 a = mix(down, up, n.y * 0.5 + 0.5);
  a += vec3(0.95, 0.93, 0.9) * 0.55 * max(dot(n, FILL) * 0.7 + 0.3, 0.0); // pale wall behind the viewer
  a += vec3(0.9, 0.95, 1.05) * 0.35 * max(dot(n, LW) * 0.5 + 0.5, 0.0); // window bounce
  a += vec3(1.0, 0.65, 0.35) * 0.25 * max(dot(n, LAMP), 0.0);
  return a;
}
vec3 windowLight(vec3 n) { return vec3(1.0, 0.97, 0.94) * WIN_E * max(dot(n, LW), 0.0); }

// ---------------------------------------------------------------------------
// Analytic soft shadows.
float cylShadow(vec3 p, float rad, float y0, float y1, float soft) {
  if (LW.y <= 0.0) return 1.0;
  float t0 = max(0.0, (y0 - p.y) / LW.y), t1 = (y1 - p.y) / LW.y;
  if (t1 <= 0.0) return 1.0;
  vec2 dl = LW.xz;
  float tu = -dot(p.xz, dl) / dot(dl, dl);
  float tc = clamp(tu, t0, t1);
  float d = length(p.xz + tc * dl);
  float pen = 0.0015 + tc * soft;
  // the ray may pass over the top of the cylinder: soften that edge too
  float over = smoothstep(-pen, pen, (p.y + max(tu, 0.0) * LW.y) - y1);
  return max(smoothstep(rad - pen, rad + pen, d), over);
}
// shadow of the cup (and saucer) on the outside world; p in cup-local coords
float exteriorShadow(vec3 p) {
  float s = cylShadow(p, R_OUT, CUP_Y0, RIM_Y, 0.12);
  if (p.y < SAUCER_H - 0.001) s = min(s, cylShadow(p, SAUCER_R, 0.0, SAUCER_H, 0.12));
  return s;
}
// light entering the open top of the cup; p inside the cylinder
float interiorShadow(vec3 p) {
  vec2 d = LW.xz;
  float a = dot(d, d), b = 2.0 * dot(p.xz, d), c = dot(p.xz, p.xz) - R_IN * R_IN;
  float t = (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
  float yExit = p.y + t * LW.y;
  float pen = 0.001 + t * 0.14;
  return smoothstep(INNER_TOP - pen, INNER_TOP + pen, yExit);
}
// distance along d from an interior point to the cup wall
float wallDist(vec3 p, vec3 d) {
  vec2 q = d.xz;
  float a = max(dot(q, q), 1e-8), b = 2.0 * dot(p.xz, q), c = dot(p.xz, p.xz) - R_IN * R_IN;
  return (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
}

// ---------------------------------------------------------------------------
float fresnel(float c, float f0) { return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }

vec3 wetFilm(vec3 p, inout float gloss) {
  float ang = atan(p.z, p.x) / (2.0 * PI);
  vec4 w = texture(uWet, vec2(ang, 0.5));
  float y = (p.y - SURF_Y) * 1000.0; // mm above the resting surface
  float film = (1.0 - smoothstep(w.r - 0.6, w.r + 0.25, y)) * (0.35 + 0.65 * w.g);
  // old tide mark left by evaporation at the resting meniscus line
  float ring = smoothstep(MEN_H + 0.4, MEN_H + 1.0, y) * (1.0 - smoothstep(MEN_H + 1.0, MEN_H + 1.9, y));
  gloss = max(gloss, film);
  vec3 tint = mix(vec3(1.0), vec3(0.72, 0.5, 0.33), film * 0.8);
  return tint * mix(1.0, 0.82, ring * 0.7) * mix(vec3(1.0), vec3(1.0, 0.93, 0.85), ring);
}

// Glossy white glazed ceramic. interior = 1 for the inside of the cup.
vec3 shadeCeramic(vec3 p, vec3 n, vec3 v, float interior) {
  vec3 alb = vec3(0.86, 0.845, 0.815);
  float gloss = 0.0;
  float sh, ao;
  if (interior > 0.5) {
    alb *= wetFilm(p, gloss);
    sh = interiorShadow(p);
    float depth = INNER_TOP - p.y;
    ao = mix(1.0, 0.42, smoothstep(0.0, 0.05, depth));
    // the dark coffee right below absorbs the bounce light
    ao *= mix(1.0, 0.75, 1.0 - smoothstep(0.0, 0.01, p.y - SURF_Y));
  } else {
    sh = exteriorShadow(p);
    ao = 1.0 - 0.45 * exp(-max(p.y - CUP_Y0, 0.0) / 0.006) * step(length(p.xz), 0.07);
    sh = min(sh, 1.0);
    if (length(p.xz) > R_OUT + 0.002) ao *= 1.0 - 0.5 * exp(-(length(p.xz) - R_OUT) / 0.006) * step(p.y, 0.03);
  }
  vec3 diff = alb / PI * (windowLight(n) * sh + ambient(n) * ao);
  vec3 r = reflect(-v, n);
  vec3 spec;
  if (interior > 0.5) {
    // interior reflections mostly see the opposite wall
    float t = wallDist(p, r);
    float yh = p.y + t * r.y;
    vec3 wallCol = alb * 0.22 * ao;
    spec = mix(wallCol, env(r, 0.02), smoothstep(INNER_TOP - 0.004, INNER_TOP + 0.004, yh));
    if (r.y < 0.0 && yh < SURF_Y) spec = vec3(0.01, 0.006, 0.004);
  } else {
    spec = env(r, 0.015) * mix(1.0, ao, 0.6);
  }
  float F = fresnel(dot(n, v), 0.045 + gloss * 0.01);
  return diff * (1.0 - F) + spec * F;
}

// Kubelka-Munk diffuse reflectance of a semi-infinite scattering medium.
vec3 kmAlbedo(vec3 sa, vec3 ss) { vec3 k = 2.0 * sa / max(ss, vec3(1e-4)); return 1.0 + k - sqrt(k * k + 2.0 * k); }
// Optical properties (1/m). Black coffee: strong absorption rising to the
// blue, very weak colloidal scattering. Milk: strong, white scattering.
vec3 liquidSigA(float milk) { return mix(vec3(80.0, 210.0, 450.0), vec3(0.8, 1.5, 4.0), milk); }
vec3 liquidSigS(float milk) { return mix(vec3(4.0), vec3(12000.0, 12200.0, 12500.0), milk); }
// Diffuse radiance of the (roughly flat) liquid at p, as seen from above.
vec3 liquidBody(vec3 p, float milk) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  float d = INNER_TOP - p.y, r = length(p.xz);
  float ao = mix((R_IN * R_IN) / (R_IN * R_IN + d * d), 0.45, pow(r / R_IN, 3.0));
  vec3 irr = windowLight(n) * interiorShadow(p) + ambient(n) * ao;
  return kmAlbedo(liquidSigA(milk), liquidSigS(milk)) / PI * irr;
}

// Trace a ray from a point inside the cup: returns what it sees (wall, room,
// or - for downward rays - the liquid, whose look is supplied by the caller).
vec3 traceInteriorL(vec3 p, vec3 d, vec3 liquid) {
  if (d.y < -0.02) return liquid;
  float t = wallDist(p, d);
  vec3 q = p + t * d;
  if (q.y < INNER_TOP + 0.0015) {
    vec3 n = vec3(-q.x, 0.0, -q.z) / R_IN;
    return shadeCeramic(q, n, -d, 1.0);
  }
  return env(d, 0.0);
}
vec3 traceInterior(vec3 p, vec3 d) { return traceInteriorL(p, d, vec3(0.004, 0.0025, 0.0015)); }
`;

export const bgVS = /* glsl */ `
in vec3 aPos;
out vec2 vNdc;
void main() { vNdc = aPos.xy; gl_Position = vec4(aPos.xy, 1.0, 1.0); }
`;
export const bgFS = /* glsl */ `
uniform mat4 uInvViewProj;
in vec2 vNdc;
out vec4 o;
void main() {
  vec4 a = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(a.xyz / a.w - uCamPos);
  o = vec4(env(d, 0.35), 1.0);
}
`;

// ---------------------------------------------------------------------------
export const meshVS = /* glsl */ `
uniform mat4 uViewProj, uModel;
in vec3 aPos; in vec3 aNormal; in vec2 aUv;
out vec3 vLocal, vWorld, vN; out vec2 vUv;
void main() {
  vec4 lp = uModel * vec4(aPos, 1.0);
  vLocal = lp.xyz;
  vN = mat3(uModel) * aNormal;
  vWorld = lp.xyz + uCupPos;
  vUv = aUv;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const ceramicFS = /* glsl */ `
in vec3 vLocal, vWorld, vN; in vec2 vUv;
uniform float uInteriorCheck;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCamPos - vWorld);
  if (!gl_FrontFacing) n = -n;
  float r = length(vLocal.xz);
  float interior = uInteriorCheck * step(r, R_IN + 0.0006) * step(vLocal.y, INNER_TOP + 0.0005) * step(0.5, -dot(n.xz, vLocal.xz) / max(r, 1e-5) + 0.5);
  // subtle glaze waviness
  n = normalize(n + 0.004 * vec3(vnoise(vLocal.xy * 900.0) - 0.5, 0.0, vnoise(vLocal.zy * 900.0) - 0.5));
  o = vec4(shadeCeramic(vLocal, n, v, interior), 1.0);
}
`;

export const tableFS = /* glsl */ `
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() {
  vec2 p = vWorld.xz;
  float pw = 0.145;
  float id = floor(p.y / pw + 0.5);
  float v = p.y - id * pw;
  float u = p.x * 1.0 + hash12(vec2(id, 3.0)) * 7.0;
  float fade = clamp(1.0 - length(fwidth(p)) * 120.0, 0.0, 1.0);
  // figure: warped growth rings
  float warp = fbm(vec2(u * 2.5, v * 9.0 + id * 5.0)) * 2.0;
  float rings = fract((v * 55.0 + warp * 3.0 + sin(u * 3.0 + id) * 0.6) );
  rings = smoothstep(0.0, 0.25, rings) * (1.0 - smoothstep(0.55, 1.0, rings));
  float streak = vnoise(vec2(u * 30.0, v * 900.0)) * 0.6 + vnoise(vec2(u * 6.0, v * 300.0)) * 0.4;
  vec3 light = vec3(0.46, 0.27, 0.14), dark = vec3(0.23, 0.12, 0.055);
  vec3 alb = mix(dark, light, 0.35 + 0.45 * rings * fade + 0.2 * streak);
  alb *= 0.85 + 0.3 * hash12(vec2(id, 9.0));
  float pores = smoothstep(0.75, 0.95, vnoise(vec2(u * 260.0, v * 2600.0))) * fade;
  alb *= 1.0 - 0.35 * pores;
  float seam = 1.0 - (1.0 - smoothstep(0.0, 0.0012 + fwidth(v), abs(abs(v) - pw * 0.5))) * 0.8;
  alb *= seam;
  vec3 lp = vWorld - uCupPos;
  float sh = exteriorShadow(lp);
  float d = length(lp.xz);
  float ao = 1.0 - 0.55 * exp(-max(d - SAUCER_R, 0.0) / 0.007);
  vec3 n = normalize(vec3((streak - 0.5) * 0.02, 1.0, 0.0));
  vec3 vv = normalize(uCamPos - vWorld);
  vec3 diff = alb / PI * (windowLight(n) * sh + ambient(n) * ao);
  float F = fresnel(dot(n, vv), 0.04);
  vec3 spec = env(reflect(-vv, n), 0.09) * mix(ao, 1.0, 0.3) * seam;
  // the cup reflected in the varnish (a faint mirror image)
  vec3 rd = reflect(-vv, n);
  vec2 q = lp.xz; float a = dot(rd.xz, rd.xz), b = 2.0 * dot(q, rd.xz), c = dot(q, q) - R_OUT * R_OUT;
  float disc = b * b - 4.0 * a * c;
  if (disc > 0.0) {
    float t = (-b - sqrt(disc)) / (2.0 * a);
    float yh = lp.y + t * rd.y;
    if (t > 0.0 && yh < RIM_Y && yh > 0.0) spec = mix(spec, vec3(0.85) * (0.3 + 0.4 * sh), 0.6);
  }
  o = vec4(diff * (1.0 - F) + spec * F * 0.9, 1.0);
}
`;

export const spoonFS = /* glsl */ `
in vec3 vLocal, vWorld, vN; in vec2 vUv;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uCamPos - vWorld);
  vec3 r = reflect(-v, n);
  vec3 f0 = vec3(0.95, 0.93, 0.88);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float inside = step(length(vLocal.xz), R_IN) * step(vLocal.y, INNER_TOP);
  vec3 refl = inside > 0.5 ? traceInterior(vLocal, r) : env(r, 0.025);
  // polished steel with a little micro-roughness; broad window sheen
  refl = mix(refl, env(r, 0.25), 0.3);
  refl += vec3(1.0, 0.97, 0.94) * WIN_E * 0.6 * pow(max(dot(r, LW), 0.0), 6.0);
  float sh = inside > 0.5 ? interiorShadow(vLocal) : exteriorShadow(vLocal);
  refl *= mix(0.55, 1.0, sh);
  // coffee film on the part that has been dunked
  float wet = smoothstep(SURF_Y + 0.004, SURF_Y - 0.001, vLocal.y) * inside;
  o = vec4(refl * F * mix(vec3(1.0), vec3(0.6, 0.42, 0.28), wet * 0.6), 1.0);
}
`;

// ---------------------------------------------------------------------------
// The liquid surface.
export const coffeeVS = /* glsl */ `
uniform mat4 uViewProj;
uniform sampler2D uHeight;
in vec3 aPos;
out vec3 vLocal, vWorld; out vec2 vUv;
void main() {
  vec2 uv = aPos.xz / (2.0 * R_IN) + 0.5;
  float h = texture(uHeight, uv).r * 0.001;
  vLocal = vec3(aPos.x, SURF_Y + h, aPos.z);
  vWorld = vLocal + uCupPos;
  vUv = uv;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const coffeeFS = /* glsl */ `
uniform sampler2D uHeight, uDye;
uniform float uMilkBase;
in vec3 vLocal, vWorld; in vec2 vUv;
out vec4 o;

void main() {
  vec4 H = texture(uHeight, vUv);
  vec3 N = normalize(vec3(-H.g, 1.0, -H.b));
  vec3 V = normalize(uCamPos - vWorld);
  vec3 p = vLocal;
  float r = length(p.xz);
  vec4 dye = texture(uDye, vUv);
  float milk = clamp(dye.r + uMilkBase, 0.0, 1.0);
  float foam = clamp(dye.g, 0.0, 1.0);

  // Optical properties (1/m). Black coffee: strong absorption rising to the
  // blue, very weak colloidal scattering. Milk: strong, white scattering.
  vec3 sigA = liquidSigA(milk);
  vec3 sigS = liquidSigS(milk);
  vec3 ext = sigA + sigS;

  // Light arriving at the surface point
  float sh = interiorShadow(p);
  float depthBelowRim = INNER_TOP - p.y;
  float open = (R_IN * R_IN) / (R_IN * R_IN + depthBelowRim * depthBelowRim);
  float ao = mix(open, 0.45, pow(r / R_IN, 3.0));
  vec3 irr = windowLight(N) * sh + ambient(N) * ao;

  // Diffuse body (sub-surface) colour
  vec3 alb = kmAlbedo(sigA, sigS);
  vec3 body = alb / PI * irr;

  // Refraction: black coffee is translucent over millimetres, so the white
  // wall shows through as an amber rim where the liquid is thin.
  vec3 T = refract(-V, N, 1.0 / 1.333);
  float tw = wallDist(p, T);
  float tb = (p.y - INNER_BOTTOM) / max(-T.y, 1e-3);
  float t = min(tw, tb);
  vec3 q = p + T * t;
  float depth = max(SURF_Y - q.y, 0.0);
  vec3 wallIrr = (windowLight(normalize(vec3(-q.x, 0.0, -q.z))) * interiorShadow(q) + ambient(vec3(-q.x / R_IN, 0.2, -q.z / R_IN)) * 0.7);
  vec3 wall = vec3(0.86, 0.845, 0.815) / PI * wallIrr * exp(-ext * depth * 1.6);
  float Ft = 1.0 - fresnel(dot(N, V), 0.02);
  body += wall * exp(-ext * t) * Ft;

  // Froth: fine micro-bubbles, lighter and rougher
  vec2 fp = p.xz * 2600.0;
  float cells = vnoise(fp) * 0.6 + vnoise(fp * 2.3) * 0.4;
  vec3 foamCol = vec3(0.78, 0.64, 0.5) * (0.65 + 0.6 * cells);
  body = mix(body, foamCol / PI * irr, foam * 0.92);

  // Specular: exact reflection traced against the cup wall
  vec3 R = reflect(-V, N);
  float F = fresnel(dot(N, V), 0.02) * (1.0 - 0.6 * foam);
  vec3 refl = traceInterior(p, R);
  if (foam > 0.01) refl = mix(refl, env(R, 0.15) * 0.5, foam * 0.5);

  o = vec4(refl * F + body * (1.0 - F), 1.0);
}
`;

// Sum of all Bessel modes on a cartesian grid -> height (mm) + slopes.
export const heightFS = /* glsl */ `
uniform sampler2D uProfiles;
uniform int uM;
uniform float uNr;
uniform float uSpike, uSpikeK; // ferrofluid: Rosensweig spike height (mm), wavenumber (1/m)
in vec2 vUv;
out vec4 o;
// Hexagonal lattice of peaks (three plane waves 120 deg apart), sharpened into
// cones; strongest over the magnet, fading towards the wall.
float spikeField(vec2 q) {
  const vec2 d1 = vec2(1.0, 0.0), d2 = vec2(-0.5, 0.8660254), d3 = vec2(-0.5, -0.8660254);
  float P = (cos(uSpikeK * dot(d1, q)) + cos(uSpikeK * dot(d2, q)) + cos(uSpikeK * dot(d3, q))) / 3.0;
  float s = max(P, 0.0);
  float env = exp(-pow(length(q) / (0.74 * R_IN), 4.0));
  return (s * s * s - 0.09) * env; // minus the mean: volume is conserved
}
void main() {
  vec2 q = (vUv - 0.5) * 2.0 * R_IN;
  float r = max(length(q), R_IN * 1e-3);
  float th = atan(q.y, q.x);
  float x = min(r / R_IN, 1.0) * (uNr - 1.0);
  float u = (x + 0.5) / uNr;
  float rows = float(uM + 1);
  vec2 cs1 = vec2(cos(th), sin(th));
  vec2 cs = vec2(1.0, 0.0);
  float h = 0.0, hr = 0.0, ht = 0.0;
  for (int m = 0; m <= 200; m++) {
    if (m > uM) break;
    vec4 P = texture(uProfiles, vec2(u, (float(m) + 0.5) / rows));
    h += P.x * cs.x + P.y * cs.y;
    hr += P.z * cs.x + P.w * cs.y;
    ht += float(m) * (-P.x * cs.y + P.y * cs.x);
    cs = vec2(cs.x * cs1.x - cs.y * cs1.y, cs.y * cs1.x + cs.x * cs1.y);
  }
  ht *= 0.001 / r; // mm -> m, and 1/r for the angular derivative
  float c = cs1.x, s = cs1.y;
  vec2 grad = vec2(c * hr - s * ht, s * hr + c * ht);
  if (uSpike > 0.0) {
    float e = 0.00015;
    h += uSpike * spikeField(q);
    grad += uSpike * 0.001 * vec2(spikeField(q + vec2(e, 0.0)) - spikeField(q - vec2(e, 0.0)),
                                  spikeField(q + vec2(0.0, e)) - spikeField(q - vec2(0.0, e))) / (2.0 * e);
  }
  o = vec4(h, grad, 0.0);
}
`;

export const fsVS = /* glsl */ `
in vec3 aPos;
out vec2 vUv;
void main() { vUv = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// 2D surface flow: stable fluids in the circular cup.
const flowCommon = /* glsl */ `
in vec2 vUv;
out vec4 o;
uniform vec2 uTexel;
vec2 toQ(vec2 uv) { return (uv - 0.5) * 2.0 * R_IN; }
vec2 toUv(vec2 q) { return q / (2.0 * R_IN) + 0.5; }
float inside(vec2 uv) { return step(length(toQ(uv)), R_IN); }
`;

export const advectVelFS = flowCommon + /* glsl */ `
uniform sampler2D uVel;
uniform float uDt, uDamp, uVisc; // uVisc: implicit-ish viscous smoothing weight
void main() {
  vec2 q = toQ(vUv);
  if (length(q) > R_IN) { o = vec4(0.0); return; }
  vec2 u = texture(uVel, vUv).xy;
  vec2 mid = q - 0.5 * uDt * u;
  vec2 u2 = texture(uVel, toUv(mid)).xy;
  vec2 back = q - uDt * u2;
  float h = 2.0 * R_IN * uTexel.x;
  float lb = length(back);
  if (lb > R_IN - 1.5 * h) back *= (R_IN - 1.5 * h) / lb;
  vec2 bu = toUv(back);
  vec2 v = texture(uVel, bu).xy;
  if (uVisc > 0.0) {
    vec2 nb = texture(uVel, bu + vec2(uTexel.x, 0)).xy + texture(uVel, bu - vec2(uTexel.x, 0)).xy
            + texture(uVel, bu + vec2(0, uTexel.y)).xy + texture(uVel, bu - vec2(0, uTexel.y)).xy;
    v = mix(v, nb * 0.25, uVisc);
  }
  o = vec4(v * uDamp, 0.0, 1.0);
}
`;

export const curlFS = flowCommon + /* glsl */ `
uniform sampler2D uVel;
void main() {
  float h = 2.0 * R_IN * uTexel.x;
  float vR = texture(uVel, vUv + vec2(uTexel.x, 0)).y, vL = texture(uVel, vUv - vec2(uTexel.x, 0)).y;
  float uT = texture(uVel, vUv + vec2(0, uTexel.y)).x, uB = texture(uVel, vUv - vec2(0, uTexel.y)).x;
  o = vec4((vR - vL - uT + uB) / (2.0 * h), 0.0, 0.0, 1.0);
}
`;

export const forceFS = flowCommon + /* glsl */ `
uniform sampler2D uVel, uCurl, uDye;
uniform float uDt, uConf;
uniform vec4 uSpoon;     // x, z, radius, active
uniform vec2 uSpoonVel;
void main() {
  vec2 q = toQ(vUv);
  if (length(q) > R_IN) { o = vec4(0.0); return; }
  vec2 u = texture(uVel, vUv).xy;
  float h = 2.0 * R_IN * uTexel.x;
  // vorticity confinement keeps the small eddies alive
  float cL = abs(texture(uCurl, vUv - vec2(uTexel.x, 0)).x), cR = abs(texture(uCurl, vUv + vec2(uTexel.x, 0)).x);
  float cB = abs(texture(uCurl, vUv - vec2(0, uTexel.y)).x), cT = abs(texture(uCurl, vUv + vec2(0, uTexel.y)).x);
  float w = texture(uCurl, vUv).x;
  vec2 g = vec2(cR - cL, cT - cB);
  float gl = length(g);
  if (gl > 1e-6) { g /= gl; u += uDt * uConf * h * vec2(g.y, -g.x) * w * 60.0; }
  // turbulence from the milk plume
  float src = texture(uDye, vUv).a;
  if (src > 1e-3) {
    vec2 nq = q * 170.0 + vec2(uTime * 0.9, -uTime * 0.6);
    float e = 0.5;
    float n0 = vnoise(nq), nx = vnoise(nq + vec2(e, 0.0)), ny = vnoise(nq + vec2(0.0, e));
    vec2 cn = vec2(ny - n0, -(nx - n0)) / e;
    u += uDt * cn * src * 1.4;
  }
  // spoon: drags the liquid with it
  if (uSpoon.w > 0.5) {
    float d = length(q - uSpoon.xy);
    float k = exp(-(d * d) / (uSpoon.z * uSpoon.z));
    u = mix(u, uSpoonVel, clamp(k * 1.2, 0.0, 1.0) * min(1.0, uDt * 40.0));
  }
  o = vec4(u, 0.0, 1.0);
}
`;

export const divFS = flowCommon + /* glsl */ `
uniform sampler2D uVel, uDye;
void main() {
  float h = 2.0 * R_IN * uTexel.x;
  vec2 L = texture(uVel, vUv - vec2(uTexel.x, 0)).xy, R = texture(uVel, vUv + vec2(uTexel.x, 0)).xy;
  vec2 B = texture(uVel, vUv - vec2(0, uTexel.y)).xy, T = texture(uVel, vUv + vec2(0, uTexel.y)).xy;
  float div = (R.x - L.x + T.y - B.y) / (2.0 * h);
  // upwelling (milk resurfacing) makes the 2D surface flow divergent
  div -= texture(uDye, vUv).a;
  o = vec4(div * inside(vUv), 0.0, 0.0, 1.0);
}
`;

export const jacobiFS = flowCommon + /* glsl */ `
uniform sampler2D uP, uDiv;
void main() {
  float h = 2.0 * R_IN * uTexel.x;
  float C = texture(uP, vUv).x;
  vec2 dl = vUv - vec2(uTexel.x, 0), dr = vUv + vec2(uTexel.x, 0), db = vUv - vec2(0, uTexel.y), dt = vUv + vec2(0, uTexel.y);
  float L = inside(dl) > 0.5 ? texture(uP, dl).x : C;
  float R = inside(dr) > 0.5 ? texture(uP, dr).x : C;
  float B = inside(db) > 0.5 ? texture(uP, db).x : C;
  float T = inside(dt) > 0.5 ? texture(uP, dt).x : C;
  float div = texture(uDiv, vUv).x;
  o = vec4((L + R + B + T - h * h * div) * 0.25 * inside(vUv), 0.0, 0.0, 1.0);
}
`;

export const gradFS = flowCommon + /* glsl */ `
uniform sampler2D uVel, uP;
uniform float uDt;
void main() {
  vec2 q = toQ(vUv);
  float r = length(q);
  if (r > R_IN) { o = vec4(0.0); return; }
  float h = 2.0 * R_IN * uTexel.x;
  float C = texture(uP, vUv).x;
  vec2 dl = vUv - vec2(uTexel.x, 0), dr = vUv + vec2(uTexel.x, 0), db = vUv - vec2(0, uTexel.y), dt = vUv + vec2(0, uTexel.y);
  float L = inside(dl) > 0.5 ? texture(uP, dl).x : C;
  float R = inside(dr) > 0.5 ? texture(uP, dr).x : C;
  float B = inside(db) > 0.5 ? texture(uP, db).x : C;
  float T = inside(dt) > 0.5 ? texture(uP, dt).x : C;
  vec2 u = texture(uVel, vUv).xy - vec2(R - L, T - B) / (2.0 * h);
  // free-slip wall with a thin Stokes layer of friction
  if (r > R_IN - 2.5 * h) {
    vec2 n = q / r;
    u -= dot(u, n) * n;
    u *= 1.0 - uDt * 0.8;
  }
  o = vec4(u, 0.0, 1.0);
}
`;

// dye: r = surface milk, g = froth, a = upwelling source
export const advectDyeFS = flowCommon + /* glsl */ `
uniform sampler2D uVel, uSrc;
uniform float uDt; // signed: negative for the backward MacCormack pass
void main() {
  vec2 q = toQ(vUv);
  vec2 u = texture(uVel, vUv).xy;
  vec2 mid = q - 0.5 * uDt * u;
  vec2 back = q - uDt * texture(uVel, toUv(mid)).xy;
  float lb = length(back);
  if (lb > R_IN * 0.995) back *= R_IN * 0.995 / lb;
  o = texture(uSrc, toUv(back));
}
`;

export const maccormackFS = flowCommon + /* glsl */ `
uniform sampler2D uVel, uOrig, uFwd, uBwd;
uniform float uDt;
uniform vec4 uPour;     // x, z, radius, rate
uniform vec4 uFroth;    // x, z, radius, rate
uniform vec3 uDecay;    // per-second decay for milk, froth, source
uniform float uDiffuse, uDiffuseG, uCap, uSrcGain;
uniform float uFoamFromPour;   // café: a pour whips up some froth into .g
uniform vec4 uOilPour;         // lab: floating immiscible oil poured into .g
void main() {
  vec2 q = toQ(vUv);
  if (length(q) > R_IN) { o = vec4(0.0); return; }
  vec4 fwd = texture(uFwd, vUv);
  vec4 res = fwd + 0.5 * (texture(uOrig, vUv) - texture(uBwd, vUv));
  // clamp to the extrema of the departure neighbourhood (keeps it stable)
  vec2 u = texture(uVel, vUv).xy;
  vec2 back = toUv(q - uDt * u);
  vec2 ts = uTexel;
  vec4 a = texture(uOrig, back + vec2(-0.5, -0.5) * ts), b = texture(uOrig, back + vec2(0.5, -0.5) * ts);
  vec4 c = texture(uOrig, back + vec2(-0.5, 0.5) * ts), d = texture(uOrig, back + vec2(0.5, 0.5) * ts);
  res = clamp(res, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
  // molecular + sub-grid turbulent diffusion
  vec4 nb = texture(uFwd, vUv + vec2(ts.x, 0)) + texture(uFwd, vUv - vec2(ts.x, 0)) + texture(uFwd, vUv + vec2(0, ts.y)) + texture(uFwd, vUv - vec2(0, ts.y));
  // (immiscible layers get almost no diffusion, so MacCormack keeps their
  // edges crisp without destroying mass)
  float g0 = res.g;
  res = mix(res, nb * 0.25, uDiffuse);
  res.g = mix(g0, nb.g * 0.25, uDiffuseG);
  res.rgb *= exp(-uDt * uDecay);
  res.a *= exp(-uDt * 1.4);
  if (uPour.w > 0.0) {
    float dd = length(q - uPour.xy);
    float k = exp(-dd * dd / (uPour.z * uPour.z));
    float n = vnoise(q * 140.0 + uTime * 1.5) * 0.7 + vnoise(q * 400.0 - uTime) * 0.3;
    res.r += uDt * uPour.w * k * (0.3 + 1.2 * n) * 0.6;
    res.a += uDt * uPour.w * k * 2.6 * uSrcGain;
    res.g += uFoamFromPour * uDt * uPour.w * k * 0.05 * smoothstep(0.6, 0.9, vnoise(q * 1200.0 + uTime * 5.0));
  }
  if (uOilPour.w > 0.0) {
    float dd = length(q - uOilPour.xy);
    res.g += uDt * uOilPour.w * exp(-dd * dd / (uOilPour.z * uOilPour.z));
    res.a += uDt * uOilPour.w * exp(-dd * dd / (uOilPour.z * uOilPour.z)) * 1.2; // spreads over the surface
  }
  if (uFroth.w > 0.0) {
    float dd = length(q - uFroth.xy);
    float k = exp(-dd * dd / (uFroth.z * uFroth.z));
    res.g += uDt * uFroth.w * k * smoothstep(0.5, 0.9, vnoise(q * 1500.0 + uTime * 10.0));
  }
  res.r = min(res.r, uCap); res.g = min(res.g, 1.0);
  o = res;
}
`;

// Azimuthal average of the swirl velocity (for the vortex dip) + a probe of
// the flow at the spoon, read back to the CPU.
export const probeFS = /* glsl */ `
uniform sampler2D uVel;
uniform vec2 uProbe;
out vec4 o;
void main() {
  int i = int(gl_FragCoord.x);
  if (i >= 128) {
    o = vec4(texture(uVel, uProbe / (2.0 * R_IN) + 0.5).xy, 0.0, 1.0);
    return;
  }
  float r = (float(i) + 0.5) / 128.0 * R_IN;
  float s = 0.0;
  for (int k = 0; k < 96; k++) {
    float th = float(k) / 96.0 * 2.0 * PI;
    vec2 d = vec2(cos(th), sin(th));
    vec2 u = texture(uVel, r * d / (2.0 * R_IN) + 0.5).xy;
    s += dot(u, vec2(-d.y, d.x));
  }
  o = vec4(s / 96.0, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Floating bubbles: x, z, radius, life.
export const bubbleUpdateFS = /* glsl */ `
uniform sampler2D uState, uVel;
uniform float uDt;
uniform vec4 uSpawn; // x, z, radius, probability per frame
in vec2 vUv;
out vec4 o;
void main() {
  vec4 s = texture(uState, vUv);
  vec2 id = gl_FragCoord.xy;
  if (s.w <= 0.0) {
    float h = hash12(id + fract(uTime * 13.37) * 311.0);
    if (uSpawn.w > 0.0 && h < uSpawn.w) {
      float a = hash12(id * 1.7 + uTime) * 2.0 * PI;
      float rr = sqrt(hash12(id * 2.3 + uTime * 1.3)) * uSpawn.z;
      vec2 p = uSpawn.xy + rr * vec2(cos(a), sin(a));
      float lp = length(p);
      if (lp > R_IN - 0.001) p *= (R_IN - 0.001) / lp;
      float sz = exp(mix(log(0.00012), log(0.0011), pow(hash12(id * 3.1 + uTime), 2.2)));
      o = vec4(p, sz, 15.0 + 90.0 * hash12(id * 5.7 + uTime));
    } else o = s;
    return;
  }
  vec2 p = s.xy;
  vec2 u = texture(uVel, p / (2.0 * R_IN) + 0.5).xy;
  float r = max(length(p), 1e-5);
  vec2 n = p / r;
  // capillary attraction up the wetting meniscus
  vec2 drift = n * 0.006 * exp(-(R_IN - r) / 0.0035);
  // light bubbles migrate to the eye of a vortex
  float ut = dot(u, vec2(-n.y, n.x));
  drift -= n * 0.05 * ut * ut / r * 0.08;
  // micro-turbulence / Brownian jitter
  drift += 0.0006 * (vec2(hash12(id + uTime * 7.0), hash12(id * 1.3 + uTime * 5.0)) - 0.5);
  p += (u + drift) * uDt;
  float lim = R_IN - s.z * 1.1;
  float lp = length(p);
  if (lp > lim) p *= lim / lp;
  s.w -= uDt;
  o = vec4(p, s.z, s.w);
}
`;

export const bubbleVS = /* glsl */ `
uniform mat4 uViewProj, uView;
uniform sampler2D uState, uHeight, uDye;
uniform float uMilkBase;
in vec3 aPos;
uniform float uViewportH;
out vec3 vWorldPos, vCenter; out float vRad, vMilk, vVis; flat out float vAlive;
void main() {
  int id = gl_InstanceID;
  vec4 s = texelFetch(uState, ivec2(id % 64, id / 64), 0);
  vAlive = step(0.0001, s.w) * step(1e-6, s.z);
  float rad = s.z * clamp(s.w * 2.0, 0.0, 1.0);
  vec2 uv = s.xy / (2.0 * R_IN) + 0.5;
  float h = texture(uHeight, uv).r * 0.001;
  vMilk = clamp(texture(uDye, uv).r + uMilkBase, 0.0, 1.0);
  vec3 c = vec3(s.x, SURF_Y + h, s.y) + uCupPos;
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 toCam = normalize(uCamPos - c);
  // camera-facing quad pulled towards the viewer so the liquid never clips
  // it; the dome itself is ray traced in the fragment shader
  vec3 wp = c + toCam * rad * 2.0 + (right * aPos.x + up * aPos.y) * rad * 2.1;
  vWorldPos = wp; vCenter = c; vRad = max(rad, 1e-6);
  // sub-pixel bubbles are invisible in reality; fading them avoids speckle
  vec4 cc = uViewProj * vec4(c, 1.0);
  float px = rad * uViewProj[1][1] * 0.5 * uViewportH / max(cc.w, 1e-4);
  vVis = smoothstep(0.8, 2.2, px);
  gl_Position = vAlive > 0.5 ? uViewProj * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

// A floating bubble is a thin liquid film dome (a spherical cap) standing on
// the surface, with a small meniscus skirt where the film meets the liquid.
// The film is ~1 um thick, so light passes through it undeviated: what makes
// a bubble visible is only the two reflections (outer face and the inside of
// the far face) plus the curled-up liquid around its foot.
export const bubbleFS = /* glsl */ `
in vec3 vWorldPos, vCenter; in float vRad, vMilk, vVis; flat in float vAlive;
out vec4 o;
float filmR(float c) { float F = fresnel(c, 0.02); return 2.0 * F / (1.0 + F); }
void main() {
  if (vAlive < 0.5 || vVis < 0.01) discard;
  vec3 ro = uCamPos, rd = normalize(vWorldPos - uCamPos);
  // what a downward reflection sees: the liquid around the bubble
  vec3 liq = liquidBody(vCenter - uCupPos, vMilk) + vec3(0.004, 0.0025, 0.0015);
  float a = vRad;
  // small bubbles are near-hemispheres, larger ones sag into flatter caps
  float hc = a * mix(0.9, 0.5, smoothstep(0.0003, 0.0016, a));
  float Rs = (a * a + hc * hc) / (2.0 * hc);
  vec3 sc = vCenter + vec3(0.0, hc - Rs, 0.0);
  float base = vCenter.y;
  float tp = rd.y < -1e-4 ? (base - ro.y) / rd.y : 1e9;

  vec3 oc = ro - sc;
  float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - Rs * Rs);
  if (disc > 0.0) {
    float sq = sqrt(disc), t0 = -b - sq, t1 = -b + sq;
    vec3 p0 = ro + rd * t0, p1 = ro + rd * t1;
    if (p0.y >= base && t0 < tp) {
      // outer face
      vec3 n0 = (p0 - sc) / Rs;
      float F0 = filmR(dot(n0, -rd));
      vec3 R0 = traceInteriorL(p0 - uCupPos, reflect(rd, n0), liq);
      // inner face of the far side (if the ray exits through the film)
      float F1 = 0.0; vec3 R1 = vec3(0.0);
      if (p1.y >= base) {
        vec3 n1 = -(p1 - sc) / Rs;
        F1 = filmR(dot(n1, -rd));
        R1 = traceInteriorL(p1 - uCupPos, reflect(rd, n1), liq);
      }
      // soften the silhouette (bubbles are only a few pixels wide)
      float aa = smoothstep(0.0, 0.12, sq / Rs);
      vec3 col = F0 * R0 + (1.0 - F0) * F1 * R1;
      float alpha = 1.0 - (1.0 - F0) * (1.0 - F1);
      // milky films scatter a little light of their own
      float film = smoothstep(0.02, 0.2, vMilk) * 0.35;
      vec3 irr = windowLight(n0) * interiorShadow(p0 - uCupPos) + ambient(n0) * 0.7;
      col += vec3(0.9, 0.85, 0.78) / PI * irr * film * (1.0 - alpha);
      alpha += film * (1.0 - alpha);
      // the flat liquid behind is already drawn; a reflection of that same
      // liquid should not darken or tint it, so blend towards "no change"
      o = vec4(col, alpha) * aa * vVis;
      return;
    }
  }
  // meniscus skirt: the liquid climbs the foot of the film
  if (tp > 1e8) discard;
  vec3 pp = ro + rd * tp;
  vec2 dvec = pp.xz - vCenter.xz;
  float d = length(dvec);
  float w = 0.55 * a + 0.00025;
  if (d < a || d > a + w) discard;
  float t = (d - a) / w;
  float slope = 1.1 * (1.0 - t) * (1.0 - t);
  vec2 rdir = dvec / d;
  vec3 n = normalize(vec3(rdir.x * slope, 1.0, rdir.y * slope));
  float F = fresnel(dot(n, -rd), 0.02);
  vec3 R = traceInteriorL(pp - uCupPos, reflect(rd, n), liq);
  float k = (1.0 - t) * (1.0 - t) * vVis;
  o = vec4(R * F * k, F * k);
}
`;

// ---------------------------------------------------------------------------
// Steam, ray marched through a box above the cup.
export const steamVS = /* glsl */ `
uniform mat4 uViewProj;
in vec3 aPos;
out vec3 vWorld;
void main() { vWorld = aPos + uCupPos; gl_Position = uViewProj * vec4(vWorld, 1.0); }
`;
export const steamFS = /* glsl */ `
uniform float uSteam;
uniform vec3 uBoxMin, uBoxMax;
in vec3 vWorld;
out vec4 o;
float density(vec3 p) {
  float h = p.y - SURF_Y;
  if (h < 0.0) return 0.0;
  float t = uTime;
  vec3 q = p;
  q.y -= t * 0.03 + h * h * 2.0;
  q.xz += 0.012 * vec2(sin(h * 45.0 - t * 1.1), cos(h * 38.0 + t * 0.9)) * smoothstep(0.0, 0.05, h);
  float n = vnoise3(q * vec3(90.0, 45.0, 90.0)) * 0.55 + vnoise3(q * vec3(210.0, 100.0, 210.0) + 7.0) * 0.3 + vnoise3(q * vec3(480.0, 240.0, 480.0) + 3.0) * 0.15;
  float spread = R_IN * 0.85 + h * 0.4;
  float rad = 1.0 - smoothstep(spread * 0.5, spread, length(p.xz));
  float fade = smoothstep(0.0, 0.006, h) * exp(-h / 0.045);
  return max(n - 0.56, 0.0) * 5.0 * rad * fade;
}
void main() {
  vec3 ro = uCamPos - uCupPos;
  vec3 rd = normalize(vWorld - uCamPos);
  vec3 inv = 1.0 / (sign(rd) * max(abs(rd), vec3(1e-6)) + vec3(1e-12));
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float ta = max(max(max(tn.x, tn.y), tn.z), 0.0);
  float tb = min(min(tf.x, tf.y), tf.z);
  if (tb <= ta) discard;
  const int STEPS = 36;
  float dt = (tb - ta) / float(STEPS);
  float t = ta + dt * hash12(gl_FragCoord.xy + fract(uTime) * 100.0);
  float trans = 1.0;
  vec3 col = vec3(0.0);
  float mu = dot(rd, LW);
  float g = 0.55;
  float hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 lightCol = vec3(1.0, 0.97, 0.94) * WIN_E * hg * 2.5 + vec3(0.5, 0.48, 0.46) * 0.35;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float r = length(p.xz);
    // stop at the liquid and at the walls of the cup
    if (p.y < SURF_Y) break;
    if (r > R_IN && r < R_OUT + 0.0005 && p.y < RIM_Y) break;
    float d = density(p) * uSteam * 28.0;
    if (d > 0.0) {
      float a = 1.0 - exp(-d * dt);
      float lit = r < R_IN && p.y < INNER_TOP ? mix(0.35, 1.0, interiorShadow(p)) : 1.0;
      col += trans * a * lightCol * lit;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
    t += dt;
  }
  o = vec4(col, 1.0 - trans);
}
`;

// ---------------------------------------------------------------------------
// Post: bloom + filmic tonemap + grain.
export const brightFS = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 o;
void main() {
  // 4 bilinear taps cover the whole 4x4 block of full-res pixels behind each
  // quarter-res texel, so small highlights can't flicker in and out of bloom
  vec3 c = texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb + texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb
         + texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb + texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  c *= 0.25;
  // never let a stray NaN/Inf pixel get smeared into blocks by the blur
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = min(c, vec3(1e4));
  float l = max(max(c.r, c.g), c.b);
  o = vec4(c * smoothstep(2.5, 8.0, l), 1.0);
}
`;
export const blurFS = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;
in vec2 vUv;
out vec4 o;
void main() {
  float w[5] = float[](0.227, 0.1945, 0.1216, 0.054, 0.0162);
  vec3 c = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) c += (texture(uSrc, vUv + uDir * float(i)).rgb + texture(uSrc, vUv - uDir * float(i)).rgb) * w[i];
  o = vec4(c, 1.0);
}
`;
export const compositeFS = /* glsl */ `
uniform sampler2D uHdr, uBloom1, uBloom2;
uniform float uExposure;
uniform vec2 uRes;
in vec2 vUv;
out vec4 o;
vec3 aces(vec3 x) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 oM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = i * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(oM * (a / b), 0.0, 1.0);
}
void main() {
  vec3 c = texture(uHdr, vUv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  vec3 bl = texture(uBloom1, vUv).rgb * 0.05 + texture(uBloom2, vUv).rgb * 0.07;
  if (any(isnan(bl)) || any(isinf(bl))) bl = vec3(0.0);
  c += bl;
  c *= uExposure;
  vec2 d = vUv - 0.5;
  c *= 1.0 - 0.35 * dot(d, d) * 2.0;
  c = aces(c);
  // exact sRGB transfer (a plain 1/2.2 gamma crushes the near-blacks)
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  float n = hash12(vUv * uRes + fract(uTime * 7.1) * 500.0) - 0.5;
  c += n * 0.012;
  o = vec4(c, 1.0);
}
`;
