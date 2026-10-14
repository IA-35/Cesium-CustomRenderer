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

// Planet and atmosphere radii in metres. The atmosphere shell sits just above the ellipsoid.
export const PLANET_RADIUS_M = 6371000
export const ATMOSPHERE_RADIUS_M = 6471000

// Scattering coefficients (per metre). Values follow the reference model, which is written in a
// unit-sphere space and then rescaled here to metres by dividing by the atmosphere thickness.
const MODEL_SCALE = ATMOSPHERE_RADIUS_M - PLANET_RADIUS_M

export const RAYLEIGH_BETA = [5.5e-6, 13.0e-6, 22.4e-6]
export const MIE_BETA = 21e-6
export const ABSORPTION_BETA = [2.04e-6, 4.89e-6, 1.2e-5]
export const RAYLEIGH_SCALE_HEIGHT = 8.0 * MODEL_SCALE / 100 // ≈ 8 km in metres
export const MIE_SCALE_HEIGHT = 1.2 * MODEL_SCALE / 100 // ≈ 1.2 km in metres
export const OZONE_CENTER_HEIGHT = 25.0 * MODEL_SCALE / 100 // ≈ 25 km in metres
export const OZONE_FALLOFF = 15.0 * MODEL_SCALE / 100 // ≈ 15 km in metres
export const MIE_G = 0.8

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
const vec3 CCR_RAYLEIGH_BETA = ${glslVec3(RAYLEIGH_BETA)};
const vec3 CCR_MIE_BETA = vec3(${glslNumber(MIE_BETA)});
const vec3 CCR_ABSORPTION_BETA = ${glslVec3(ABSORPTION_BETA)};

uniform vec4 atmosphereParams;   // planetRadius, atmosphereRadius, 1/mieScale, 1/rayleighScale
uniform vec3 sunDirectionAtmo;

// Rayleigh and Mie phase functions. Mie uses the Henyey-Greenstein approximation, which is what
// gives the forward-scattering glow around the sun.
float ccrPhaseRayleigh(float mu) {
  return 3.0 / (16.0 * 3.14159265358979) * (1.0 + mu * mu);
}

float ccrPhaseMie(float mu) {
  float g = ATMOS_MIE_G;
  float g2 = g * g;
  float denom = pow(1.0 + g2 - 2.0 * g * mu, 1.5) * (2.0 + g2);
  return 3.0 / (8.0 * 3.14159265358979) * ((1.0 - g2) * (1.0 + mu * mu)) / max(denom, 1e-6);
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

// Integrate in-scattered light along the view ray. The transmittance output is the fraction
// of background light that survives the atmosphere, so the caller can composite the scene.
vec3 ccrAtmosphere(vec3 origin, vec3 direction, inout vec3 transmittance) {
  vec3 radiance = vec3(0.0);
  transmittance = vec3(1.0);
  vec2 atmosphereHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.y);
  if (atmosphereHit.y < 0.0 || atmosphereHit.y < atmosphereHit.x) return radiance;
  float start = max(atmosphereHit.x, 0.0);
  // Stop at the ground so the atmosphere does not scatter light through the planet.
  vec2 groundHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x);
  float limit = atmosphereHit.y;
  if (groundHit.y > 0.0 && groundHit.x > 0.0) limit = min(limit, groundHit.x);
  if (limit <= start) return radiance;

  float mu = dot(direction, sunDirectionAtmo);
  float phaseRayleigh = ccrPhaseRayleigh(mu);
  float phaseMie = ccrPhaseMie(mu);
  float stepLength = (limit - start) / float(ATMOS_OUTER_STEPS);
  vec3 opticalDepth = vec3(0.0);

  // Deterministic stratification: a frame-varying dither would need temporal resolve, and the
  // resolve stage already averages neighbouring rays.
  for (int i = 0; i < ATMOS_OUTER_STEPS; i++) {
    vec3 position = origin + direction * (start + (float(i) + 0.5) * stepLength);
    float height = length(position) - atmosphereParams.x;
    vec3 density;
    ccrAtmosphereDensity(height, density);
    vec3 currentDepth = density * stepLength;
    opticalDepth += currentDepth;

    // Distance from this sample to the top of the atmosphere along the sun direction.
    vec2 sunHit = ccrAtmosphereIntersect(position, sunDirectionAtmo, atmosphereParams.y);
    float sunStepLength = max(sunHit.y, 0.0) / float(ATMOS_LIGHT_STEPS);
    vec3 sunTransmittance = ccrAtmosphereLightTransmittance(position, sunDirectionAtmo, sunStepLength);

    // Light lost on the way in (sun path) and on the way out (view path so far).
    vec3 attenuation = exp(-(CCR_RAYLEIGH_BETA * (opticalDepth.x + 0.0)
      + CCR_MIE_BETA * opticalDepth.y
      + CCR_ABSORPTION_BETA * opticalDepth.z)) * sunTransmittance;
    radiance += currentDepth.x * CCR_RAYLEIGH_BETA * phaseRayleigh * attenuation;
    radiance += currentDepth.y * CCR_MIE_BETA * phaseMie * attenuation;
  }

  transmittance = exp(-(CCR_RAYLEIGH_BETA * opticalDepth.x + CCR_MIE_BETA * opticalDepth.y
    + CCR_ABSORPTION_BETA * opticalDepth.z));
  return radiance;
}
`
}

export default { atmosphereGLSL, atmosphereTier, ATMOSPHERE_TIERS }
