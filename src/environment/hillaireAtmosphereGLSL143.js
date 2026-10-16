/*
 * GLSL/WebGL2 adaptation of webgpu-cesium atmosphere shaders, Apache-2.0.
 * Upstream revision and required license: reference/hillaire/NOTICE.md.
 * Hillaire (2020): a scalable and production ready sky and atmosphere rendering technique.
 * The medium remains CCR's accepted wlBXWK density/coefficient model.
 */

export const hillaireCommonGLSL = `
precision highp sampler2D;
const float CCR_LUT_PI = 3.141592653589793;
uniform vec2 u_lutAtmosphereRadii; // metres: tangent-sphere bottom, top
uniform vec2 u_lutDensityScale; // inverse metres: Mie, Rayleigh
uniform vec2 u_lutMie; // aerosol density multiplier, phase g
uniform vec3 u_lutRayleighBeta;
uniform vec3 u_lutMieBeta;
uniform vec3 u_lutAbsorptionBeta;
uniform vec2 u_lutOzone; // metres: centre, width
uniform sampler2D u_atmosphereTransmittanceLut;
uniform sampler2D u_atmosphereMultipleScatteringLut;
uniform sampler2D u_atmosphereSkyViewLut;
uniform bool u_lutManualFiltering;

// Internal geometry uses kilometres for stable Earth-scale float32 subtraction.
float ccrLutBottom() { return u_lutAtmosphereRadii.x * 0.001; }
float ccrLutTop() { return u_lutAtmosphereRadii.y * 0.001; }
vec2 ccrLutSphere(vec3 p, vec3 d, float r) {
  float b = dot(p, d);
  float c = (length(p) - r) * (length(p) + r);
  float h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}
bool ccrLutGroundBlocked(vec3 p, vec3 d) {
  // Analytic horizon test avoids the root-sign ambiguity at sea level.
  float r = length(p), mu = dot(p, d) / max(r, 1e-6);
  return mu < -sqrt(max(0.0, (r - ccrLutBottom()) * (r + ccrLutBottom()))) / max(r, 1e-6);
}
vec3 ccrLutDensity(float heightKm) {
  float h = max(heightKm * 1000.0, 0.0);
  float rayleigh = exp(-h * u_lutDensityScale.y);
  float ozone = (u_lutOzone.x - h) / max(u_lutOzone.y, 1.0);
  return vec3(rayleigh, exp(-h * u_lutDensityScale.x) * u_lutMie.x,
    rayleigh / (1.0 + ozone * ozone));
}
void ccrLutMedium(vec3 p, out vec3 rayleigh, out vec3 mie, out vec3 extinction) {
  vec3 density = ccrLutDensity(length(p) - ccrLutBottom());
  rayleigh = u_lutRayleighBeta * density.x * 1000.0;
  mie = u_lutMieBeta * density.y * 1000.0;
  extinction = rayleigh + mie + u_lutAbsorptionBeta * density.z * 1000.0;
}
float ccrLutRayleighPhase(float mu) {
  return 3.0 * (1.0 + mu * mu) / (16.0 * CCR_LUT_PI);
}
float ccrLutMiePhase(float mu) {
  float g = u_lutMie.y, gg = g * g;
  return 3.0 * (1.0 - gg) * (1.0 + mu * mu) /
    (8.0 * CCR_LUT_PI * (2.0 + gg) * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5));
}
vec3 ccrLutIntegralWeight(vec3 extinction, float dt) {
  vec3 opticalDepth = extinction * dt;
  // Taylor form avoids cancellation for clear/high-altitude segments.
  return vec3(opticalDepth.x < 1e-3 ? dt * (1.0 - opticalDepth.x * 0.5) : (1.0 - exp(-opticalDepth.x)) / extinction.x,
    opticalDepth.y < 1e-3 ? dt * (1.0 - opticalDepth.y * 0.5) : (1.0 - exp(-opticalDepth.y)) / extinction.y,
    opticalDepth.z < 1e-3 ? dt * (1.0 - opticalDepth.z * 0.5) : (1.0 - exp(-opticalDepth.z)) / extinction.z);
}
// Concentrate quadrature where density is greatest: at the segment's closest
// approach to the planet. Orbital downward rays need dense samples at the end;
// grazing rays need both halves concentrated around their tangent point.
float ccrLutPathDistance(float u, float distance, vec3 origin, vec3 direction) {
  float closest = clamp(-dot(origin, direction), 0.0, distance);
  if (closest <= 0.0) return u * u * distance;
  if (closest >= distance) return (1.0 - (1.0 - u) * (1.0 - u)) * distance;
  if (u < 0.5) return closest * (1.0 - (1.0 - 2.0 * u) * (1.0 - 2.0 * u));
  float t = 2.0 * u - 1.0;
  return closest + (distance - closest) * t * t;
}
vec2 ccrLutUnitToSubUv(vec2 uv, vec2 size) { return (clamp(uv, 0.0, 1.0) * (size - 1.0) + 0.5) / size; }
vec2 ccrLutSubToUnitUv(vec2 uv, vec2 size) { return clamp((uv * size - 0.5) / (size - 1.0), 0.0, 1.0); }
vec3 ccrLutFetch(sampler2D lut, vec2 uv) {
  if (!u_lutManualFiltering) return texture(lut, uv).rgb;
  ivec2 size = textureSize(lut, 0);
  vec2 texel = uv * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(texel));
  vec2 f = fract(texel);
  ivec2 last = size - 1;
  return mix(mix(texelFetch(lut, clamp(base, ivec2(0), last), 0).rgb,
    texelFetch(lut, clamp(base + ivec2(1, 0), ivec2(0), last), 0).rgb, f.x),
    mix(texelFetch(lut, clamp(base + ivec2(0, 1), ivec2(0), last), 0).rgb,
    texelFetch(lut, clamp(base + ivec2(1), ivec2(0), last), 0).rgb, f.x), f.y);
}
vec2 ccrLutTransmittanceUv(float r, float mu) {
  float rg = ccrLutBottom(), rt = ccrLutTop();
  float H = sqrt((rt - rg) * (rt + rg));
  float rho = sqrt(max((r - rg) * (r + rg), 0.0));
  float d = max(0.0, -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + rt * rt, 0.0)));
  return ccrLutUnitToSubUv(vec2((d - (rt - r)) / max(rho + H - (rt - r), 1e-5), rho / H), vec2(256.0, 64.0));
}
vec2 ccrLutUvToRMu(vec2 uv) {
  float rg = ccrLutBottom(), rt = ccrLutTop();
  float H = sqrt((rt - rg) * (rt + rg)), rho = H * uv.y;
  float r = sqrt(rg * rg + rho * rho);
  float d = mix(rt - r, rho + H, uv.x);
  float mu = d > 1e-6 ? (H * H - rho * rho - d * d) / (2.0 * r * d) : 1.0;
  return vec2(r, clamp(mu, -1.0, 1.0));
}
vec3 ccrLutTransmittanceKm(vec3 p, vec3 d) {
  if (ccrLutGroundBlocked(p, d)) return vec3(0.0);
  float r = length(p);
  if (r >= ccrLutTop()) {
    vec2 hit = ccrLutSphere(p, d, ccrLutTop());
    if (hit.y <= 0.0 || hit.x >= hit.y) return vec3(1.0);
    p += d * max(hit.x, 0.0); r = length(p);
  }
  return ccrLutFetch(u_atmosphereTransmittanceLut, ccrLutTransmittanceUv(r, dot(p, d) / max(r, 1e-6)));
}
vec3 ccrLutMultipleScatteringKm(vec3 p, vec3 sun) {
  float r = length(p);
  vec2 uv = vec2(dot(p, sun) / max(r, 1e-6) * 0.5 + 0.5,
    (r - ccrLutBottom()) / (ccrLutTop() - ccrLutBottom()));
  return ccrLutFetch(u_atmosphereMultipleScatteringLut, ccrLutUnitToSubUv(uv, vec2(32.0)));
}
float ccrLutHorizonZenith(float r) {
  return acos(-sqrt(max(0.0, (r - ccrLutBottom()) * (r + ccrLutBottom()))) / max(r, 1e-6));
}
vec2 ccrLutSkyAngles(vec2 uv, float r) {
  float horizon = ccrLutHorizonZenith(r);
  float theta = uv.y < 0.5 ? horizon * (1.0 - (1.0 - 2.0 * uv.y) * (1.0 - 2.0 * uv.y))
    : horizon + (CCR_LUT_PI - horizon) * (2.0 * uv.y - 1.0) * (2.0 * uv.y - 1.0);
  return vec2(CCR_LUT_PI * uv.x * uv.x, theta);
}
vec2 ccrLutSkyUv(vec3 p, vec3 direction, vec3 sun) {
  float r = length(p);
  vec3 up = p / max(r, 1e-6);
  float mu = clamp(dot(direction, up), -1.0, 1.0);
  float theta = acos(mu), horizon = ccrLutHorizonZenith(r);
  float v = theta < horizon ? 0.5 * (1.0 - sqrt(max(0.0, 1.0 - theta / max(horizon, 1e-6))))
    : 0.5 + 0.5 * sqrt(max(0.0, (theta - horizon) / max(CCR_LUT_PI - horizon, 1e-6)));
  vec3 projectedView = direction - up * mu;
  vec3 projectedSun = sun - up * dot(sun, up);
  float product = length(projectedView) * length(projectedSun);
  float cosPhi = product > 1e-6 ? clamp(dot(projectedView, projectedSun) / product, -1.0, 1.0) : 1.0;
  return ccrLutUnitToSubUv(vec2(sqrt(acos(cosPhi) / CCR_LUT_PI), v), vec2(192.0, 108.0));
}
`

export const hillaireRuntimeGLSL = `${hillaireCommonGLSL}
// Public coordinates are metres, in the same planet-centred tangent frame as CCR.
// All LUT radiance is per unit unattenuated incoming solar radiance.
vec3 ccrLutTransmittance(vec3 position, vec3 sun) {
  return ccrLutTransmittanceKm(position * 0.001, sun);
}
vec3 ccrLutMultipleScattering(vec3 position, vec3 sun) {
  return ccrLutMultipleScatteringKm(position * 0.001, sun);
}
vec3 ccrLutSkyView(vec3 origin, vec3 direction, vec3 sun) {
  return ccrLutFetch(u_atmosphereSkyViewLut, ccrLutSkyUv(origin * 0.001, direction, sun));
}
vec3 ccrLutSkyIrradiance(vec3 position, vec3 sun) {
  // Isotropic multiple-scattering radiance -> hemispherical irradiance. This
  // is deliberately approximate; direct sunlight is handled separately.
  return CCR_LUT_PI * ccrLutMultipleScattering(position, sun);
}
`

export const hillaireTransmittanceShader = `${hillaireCommonGLSL}
in vec2 v_textureCoordinates;
void main() {
  vec2 rMu = ccrLutUvToRMu(ccrLutSubToUnitUv(v_textureCoordinates, vec2(256.0, 64.0)));
  vec3 origin = vec3(0.0, 0.0, rMu.x);
  vec3 dir = vec3(sqrt(max(0.0, 1.0 - rMu.y * rMu.y)), 0.0, rMu.y);
  float distance = max(0.0, ccrLutSphere(origin, dir, ccrLutTop()).y);
  vec3 opticalDepth = vec3(0.0);
  for (int i = 0; i < 64; ++i) {
    float t0 = float(i) / 64.0, t1 = float(i + 1) / 64.0;
    t0 = ccrLutPathDistance(t0, distance, origin, dir); t1 = ccrLutPathDistance(t1, distance, origin, dir);
    vec3 rayleigh, mie, extinction;
    ccrLutMedium(origin + dir * (0.5 * (t0 + t1)), rayleigh, mie, extinction);
    opticalDepth += extinction * (t1 - t0);
  }
  out_FragColor = vec4(exp(-opticalDepth), 1.0);
}
`

export const hillaireMultipleScatteringShader = `${hillaireCommonGLSL}
uniform vec3 u_lutGroundAlbedo;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = ccrLutSubToUnitUv(v_textureCoordinates, vec2(32.0));
  float radius = mix(ccrLutBottom() + 0.001, ccrLutTop() - 0.001, uv.y);
  float muSun = uv.x * 2.0 - 1.0;
  vec3 origin = vec3(0.0, 0.0, radius);
  vec3 sun = vec3(sqrt(max(0.0, 1.0 - muSun * muSun)), 0.0, muSun);
  vec3 secondOrder = vec3(0.0), transfer = vec3(0.0);
  for (int directionIndex = 0; directionIndex < 64; ++directionIndex) {
    float z = 1.0 - 2.0 * (float(directionIndex) + 0.5) / 64.0;
    float phi = (sqrt(5.0) - 1.0) * CCR_LUT_PI * float(directionIndex);
    float r = sqrt(max(0.0, 1.0 - z * z));
    vec3 dir = vec3(cos(phi) * r, sin(phi) * r, z);
    float distance = ccrLutSphere(origin, dir, ccrLutTop()).y;
    vec2 ground = ccrLutSphere(origin, dir, ccrLutBottom());
    bool hitsGround = ground.x > 0.0 && ground.y >= ground.x;
    if (hitsGround) distance = min(distance, ground.x);
    vec3 throughput = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    float pr = ccrLutRayleighPhase(dot(dir, sun)), pm = ccrLutMiePhase(dot(dir, sun));
    for (int stepIndex = 0; stepIndex < 32; ++stepIndex) {
      float t0 = float(stepIndex) / 32.0, t1 = float(stepIndex + 1) / 32.0;
      t0 = ccrLutPathDistance(t0, distance, origin, dir); t1 = ccrLutPathDistance(t1, distance, origin, dir);
      float dt = t1 - t0;
      vec3 p = origin + dir * (0.5 * (t0 + t1));
      vec3 rayleigh, mie, extinction;
      ccrLutMedium(p, rayleigh, mie, extinction);
      vec3 weight = throughput * ccrLutIntegralWeight(extinction, dt);
      L += weight * (rayleigh * pr + mie * pm) * ccrLutTransmittanceKm(p, sun);
      // Scattering response to a unit isotropic radiance field, integrated
      // over the ray. The sphere average below supplies its 1/(4*pi).
      F += weight * (rayleigh + mie);
      throughput *= exp(-extinction * dt);
    }
    if (hitsGround) {
      vec3 p = origin + dir * distance;
      float NoL = max(0.0, dot(normalize(p), sun));
      L += throughput * u_lutGroundAlbedo / CCR_LUT_PI * NoL *
        ccrLutTransmittanceKm(p + normalize(p) * 0.001, sun);
      F += throughput * u_lutGroundAlbedo;
    }
    secondOrder += L / 64.0;
    transfer += F / 64.0;
  }
  // Hillaire's infinite isotropic multiple-scattering series Psi = L2/(1-fms).
  // The bound only protects float round-off close to a conservative medium.
  out_FragColor = vec4(secondOrder / max(vec3(1.0) - transfer, vec3(0.0001)), 1.0);
}
`

export const hillaireSkyViewShader = `${hillaireCommonGLSL}
uniform vec2 u_lutSkyParameters; // radius km, sun zenith cosine
in vec2 v_textureCoordinates;
void main() {
  vec2 angles = ccrLutSkyAngles(ccrLutSubToUnitUv(v_textureCoordinates, vec2(192.0, 108.0)), u_lutSkyParameters.x);
  vec3 origin = vec3(0.0, 0.0, u_lutSkyParameters.x);
  vec3 dir = vec3(cos(angles.x) * sin(angles.y), sin(angles.x) * sin(angles.y), cos(angles.y));
  float muSun = u_lutSkyParameters.y;
  vec3 sun = vec3(sqrt(max(0.0, 1.0 - muSun * muSun)), 0.0, muSun);
  vec2 atmosphereHit = ccrLutSphere(origin, dir, ccrLutTop());
  if (atmosphereHit.y <= 0.0 || atmosphereHit.x > atmosphereHit.y) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;
  }
  float entry = max(0.0, atmosphereHit.x);
  float distance = atmosphereHit.y;
  vec2 ground = ccrLutSphere(origin, dir, ccrLutBottom());
  if (ground.x >= 0.0 && ground.y >= ground.x) distance = min(distance, ground.x);
  distance = max(0.0, distance - entry);
  origin += dir * entry;
  float pr = ccrLutRayleighPhase(dot(dir, sun)), pm = ccrLutMiePhase(dot(dir, sun));
  vec3 luminance = vec3(0.0), throughput = vec3(1.0);
  for (int i = 0; i < 40; ++i) {
    float t0 = float(i) / 40.0, t1 = float(i + 1) / 40.0;
    t0 = ccrLutPathDistance(t0, distance, origin, dir); t1 = ccrLutPathDistance(t1, distance, origin, dir);
    float dt = t1 - t0;
    vec3 p = origin + dir * (0.5 * (t0 + t1));
    vec3 rayleigh, mie, extinction;
    ccrLutMedium(p, rayleigh, mie, extinction);
    vec3 source = (rayleigh * pr + mie * pm) * ccrLutTransmittanceKm(p, sun)
      + (rayleigh + mie) * ccrLutMultipleScatteringKm(p, sun);
    luminance += throughput * source * ccrLutIntegralWeight(extinction, dt);
    throughput *= exp(-extinction * dt);
  }
  // No ground colour: Cesium owns the visible ground. Downward sky texels
  // still integrate their finite atmosphere segment continuously to horizon.
  out_FragColor = vec4(max(luminance, vec3(0.0)), 1.0);
}
`
