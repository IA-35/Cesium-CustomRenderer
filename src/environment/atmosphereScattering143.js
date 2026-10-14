/**
 * Atmospheric scattering, following the model the reference article recommends
 * (https://www.shadertoy.com/view/wlBXWK): two nested ray marches over an atmosphere shell,
 * with cheap analytic particle densities (exponential for Rayleigh, a sech-squared profile for
 * the ozone layer) instead of noise lookups.
 *
 * Why this replaces the previous height-fog integration:
 * - The old path accumulated per-sample noise for the medium, which put a full density
 *   evaluation on every ray step. An atmosphere does not need noise: its density is analytic.
 * - Doing the scattering explicitly gives Rayleigh and Mie their own phase functions, so the
 *   sky keeps a physically correct colour ramp between day and sunset.
 *
 * Cost per ray: OUTER_STEPS samples, each running INNER_STEPS light samples. Both are pure
 * arithmetic (exp / sech) with no texture fetches.
 */

// Planet and atmosphere radii in metres, matching the reference shader verbatim.
export const PLANET_RADIUS_M = 6371e3
export const ATMOSPHERE_RADIUS_M = 6471e3

// Scattering coefficients (per metre), copied from the reference shader lines 66-75.
//
// The previous implementation assumed the reference was written in unit-sphere space and
// rescaled these by the atmosphere thickness. That assumption was wrong: the reference uses
// real metres (PLANET_RADIUS 6371e3, HEIGHT_RAY 8e3). The rescaling happened to reproduce
// HEIGHT_RAY and HEIGHT_MIE while corrupting the absorption term, and ABSORPTION_BETA was
// rewritten into a different set of numbers altogether. These are now the reference values.
export const RAYLEIGH_BETA = [5.5e-6, 13.0e-6, 22.4e-6]
export const MIE_BETA = 21e-6
export const ABSORPTION_BETA = [2.04e-5, 4.97e-5, 1.95e-6]
export const RAYLEIGH_SCALE_HEIGHT = 8e3
export const MIE_SCALE_HEIGHT = 1.2e3
export const OZONE_CENTER_HEIGHT = 30e3
export const OZONE_FALLOFF = 4e3
export const MIE_G = 0.7

/**
 * Quality tiers. `outerSteps` is the view-ray march, `lightSteps` the per-sample sun march.
 * The product of the two is what actually costs, so the tiers are chosen to keep that product
 * in a controlled range instead of raising one side alone.
 */
export const ATMOSPHERE_TIERS = Object.freeze({
  performance: { outerSteps: 8, lightSteps: 4 },
  balanced: { outerSteps: 12, lightSteps: 6 },
  high: { outerSteps: 16, lightSteps: 8 }
})

export function atmosphereTier(quality) {
  return ATMOSPHERE_TIERS[quality] || ATMOSPHERE_TIERS.balanced
}

const glslNumber = value => Number.isFinite(value)
  ? (Number.isInteger(value) ? `${value}.0` : String(value))
  : '0.0'

const glslVec3 = values => `vec3(${values.map(glslNumber).join(', ')})`

/**
 * GLSL for the atmosphere. Expects the caller to have provided:
 *   uniforms: atmosphereParams (vec4: planetRadius, atmosphereRadius, planetRadius/mieScale,
 *             planetRadius/rayleighScale) and sunDirectionAtmo (vec3, local space)
 * It exposes `ccrAtmosphere(vec3 origin, vec3 direction, inout vec3 transmittance)`.
 *
 * Deliberate differences from the reference implementation:
 * - No night-sky term: CCR composites over a real Cesium globe and sky box, so adding a
 *   synthetic star field would fight the engine's own rendering.
 * - Radii are metres rather than unit-sphere values, so heights stay meaningful next to the
 *   cloud altitudes that share these uniforms.
 */
export function atmosphereGLSL(tier) {
  const { outerSteps, lightSteps } = atmosphereTier(tier)
  return `
#define CCR_PLANET_RADIUS ${glslNumber(PLANET_RADIUS_M)}
#define ATMOS_OUTER_STEPS ${outerSteps}
#define ATMOS_LIGHT_STEPS ${lightSteps}
#define ATMOS_RAYLEIGH_SCALE ${glslNumber(RAYLEIGH_SCALE_HEIGHT)}
#define ATMOS_MIE_SCALE ${glslNumber(MIE_SCALE_HEIGHT)}
#define ATMOS_OZONE_CENTER ${glslNumber(OZONE_CENTER_HEIGHT)}
#define ATMOS_OZONE_FALLOFF ${glslNumber(OZONE_FALLOFF)}
#define ATMOS_MIE_G ${glslNumber(MIE_G)}
// Reference line 72 is vec3(0.0); kept as a named constant so the source of the value is clear.
#define CCR_PLANET_POS vec3(0.0)
const vec3 CCR_RAYLEIGH_BETA = ${glslVec3(RAYLEIGH_BETA)};
const vec3 CCR_MIE_BETA = vec3(${glslNumber(MIE_BETA)});
// Reference line 69. The reference uses this only through the ambient term, which is zero, so the
// constant is carried for parity rather than used in the composite.
const vec3 CCR_ABSORPTION_BETA = ${glslVec3(ABSORPTION_BETA)};
// Reference line 456 applies a fixed exposure inside the shader. CCR tone-maps later in its own
// HDR chain, so the same scalar cannot be copied verbatim; this is the calibration point recorded
// as an open item in reference/PORTING_DIFFERENCES.md.
#define CCR_ATMOSPHERE_LIGHT_INTENSITY 1.0

uniform vec4 atmosphereParams;   // planetRadius, atmosphereRadius, 1/mieScale, 1/rayleighScale
uniform vec3 sunDirectionAtmo;

// Phase functions, copied from the reference (lines 164-170).
float ccrPhaseRayleigh(float mu) {
  return 3.0 / (16.0 * 3.14159265358979) * (1.0 + mu * mu);
}

float ccrPhaseMie(float mu) {
  float g = ATMOS_MIE_G;
  float gg = g * g;
  float mumu = mu * mu;
  return 3.0 / (8.0 * 3.14159265358979) * ((1.0 - gg) * (mumu + 1.0))
    / (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));
}

// Analytic particle density at a given altitude above the planet surface.
void ccrAtmosphereDensity(float height, out vec3 density) {
  float rayleigh = exp(-max(height, 0.0) * atmosphereParams.w);
  float mie = exp(-max(height, 0.0) * atmosphereParams.z);
  // Ozone peaks at a fixed altitude rather than at the ground, so it uses a sech-shaped bell.
  float denom = (ATMOS_OZONE_CENTER - height) / ATMOS_OZONE_FALLOFF;
  float ozone = rayleigh / (denom * denom + 1.0);
  density = vec3(rayleigh, mie, ozone);
}

// Intersection of a ray with a sphere centred at the origin. Returns (near, far); far < near
// means the ray misses.
vec2 ccrAtmosphereIntersect(vec3 origin, vec3 direction, float radius) {
  float a = dot(direction, direction);
  float b = 2.0 * dot(direction, origin);
  float c = dot(origin, origin) - radius * radius;
  float d = b * b - 4.0 * a * c;
  if (d < 0.0) return vec2(1e9, -1e9);
  float sqrtD = sqrt(d);
  return vec2(-b - sqrtD, -b + sqrtD) / (2.0 * a);
}

// Sun transmittance along a short light ray, sampled inside the atmosphere.
vec3 ccrAtmosphereLightTransmittance(vec3 position, vec3 lightDirection, float stepLength) {
  vec3 opticalDepth = vec3(0.0);
  for (int l = 0; l < ATMOS_LIGHT_STEPS; l++) {
    vec3 samplePosition = position + lightDirection * ((float(l) + 0.5) * stepLength);
    vec3 density;
    ccrAtmosphereDensity(length(samplePosition) - atmosphereParams.x, density);
    opticalDepth += density * stepLength;
  }
  return exp(-(opticalDepth.x * CCR_RAYLEIGH_BETA + opticalDepth.y * CCR_MIE_BETA + opticalDepth.z * CCR_ABSORPTION_BETA));
}

// Integrate in-scattered light along the view ray.
//
// Structure follows the reference shader's calculate_scattering (lines 97-268) with the three
// adaptations listed in reference/PORTING_DIFFERENCES.md:
//   - the caller supplies a planet-centred origin, so the reference's planet_position offset is
//     a no-op here but the structure is kept;
//   - max_dist comes from the Cesium scene depth instead of the reference's built-in sphere;
//   - the returned value is the composited colour rather than a background-blended one, because
//     CCR applies the exposure and tone mapping later in its own HDR chain.
//
// the scene extinction term (reference line 267) is deliberately part of this function, not the
// caller: the previous implementation added the atmosphere on top of the scene and dropped
// sceneColor * opacity, which let an integral out to infinity brighten nearby buildings.
vec3 ccrAtmosphere(vec3 origin, vec3 direction, float maxDist, vec3 sceneColor, inout vec3 transmittance) {
  // Reference line 120: positions are planet-centred, so the offset is applied here.
  vec3 start = origin - CCR_PLANET_POS;

  vec3 radiance = vec3(0.0);
  transmittance = vec3(1.0);

  float a = dot(direction, direction);
  float b = 2.0 * dot(direction, start);
  float c = dot(start, start) - (atmosphereParams.y * atmosphereParams.y);
  float d = (b * b) - 4.0 * a * c;
  // Reference line 129: no atmosphere intersection returns the scene unchanged.
  if (d < 0.0) return sceneColor;

  // Reference lines 132-137: clip the ray to the shell and to max_dist.
  vec2 rayLength = vec2(max((-b - sqrt(d)) / (2.0 * a), 0.0), min((-b + sqrt(d)) / (2.0 * a), maxDist));
  if (rayLength.x > rayLength.y) return sceneColor;

  // Reference line 140: suppress the mie glow when an object sits in front of the camera. This
  // is the reference's approximation, not a general occlusion fix: for a pixel whose ray is cut
  // short by geometry the condition is false, so the whole Mie term (including the medium
  // between the camera and that object) is zeroed. Kept for parity; the near-field fog and
  // occlusion edges need their own validation before this is treated as production behaviour.
  bool allowMie = maxDist > rayLength.y;

  float mu = dot(direction, sunDirectionAtmo);
  float phaseRayleigh = ccrPhaseRayleigh(mu);
  float phaseMie = allowMie ? ccrPhaseMie(mu) : 0.0;

  float stepLength = (rayLength.y - rayLength.x) / float(ATMOS_OUTER_STEPS);
  vec3 opticalDepth = vec3(0.0);
  // Reference lines 154-155: both totals are RGB, because attn is the spectral extinction.
  vec3 totalRayleigh = vec3(0.0);
  vec3 totalMie = vec3(0.0);

  for (int i = 0; i < ATMOS_OUTER_STEPS; i++) {
    vec3 position = start + direction * (rayLength.x + (float(i) + 0.5) * stepLength);
    float height = length(position) - atmosphereParams.x;
    vec3 density;
    ccrAtmosphereDensity(height, density);
    vec3 currentDepth = density * stepLength;
    opticalDepth += currentDepth;

    // Sun march: the reference integrates the same density along the light direction, from the
    // sample to the top of the shell.
    vec2 sunHit = ccrAtmosphereIntersect(position, sunDirectionAtmo, atmosphereParams.y);
    float sunStepLength = max(sunHit.y, 0.0) / float(ATMOS_LIGHT_STEPS);
    vec3 sunTransmittance = ccrAtmosphereLightTransmittance(position, sunDirectionAtmo, sunStepLength);

    // Reference line 248: light lost on the sun path and on the view path so far.
    vec3 attn = exp(-CCR_RAYLEIGH_BETA * opticalDepth.x
      - CCR_MIE_BETA * opticalDepth.y
      - CCR_ABSORPTION_BETA * opticalDepth.z) * sunTransmittance;
    // Reference lines 251-252.
    totalRayleigh += currentDepth.x * attn;
    totalMie += currentDepth.y * attn;
  }

  transmittance = exp(-(CCR_RAYLEIGH_BETA * opticalDepth.x + CCR_MIE_BETA * opticalDepth.y
    + CCR_ABSORPTION_BETA * opticalDepth.z));

  // Reference lines 264-267. The ambient term is omitted because the reference sets
  // AMBIENT_BETA to zero.
  radiance = phaseRayleigh * CCR_RAYLEIGH_BETA * totalRayleigh
    + phaseMie * CCR_MIE_BETA * totalMie;
  return radiance * CCR_ATMOSPHERE_LIGHT_INTENSITY + sceneColor * transmittance;
}
`
}

export default { atmosphereGLSL, atmosphereTier, ATMOSPHERE_TIERS }
