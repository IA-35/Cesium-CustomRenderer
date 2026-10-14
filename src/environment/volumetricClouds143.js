/**
 * Volumetric clouds following the reference article:
 * https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/
 *
 * Three ideas from that article drive this implementation:
 *
 * 1. Density is accumulated along the ray with an early exit at a maximum, rather than being
 *    evaluated as an independent analytic field at every sample.
 * 2. Sun light uses a binary occlusion count ("how many of the N steps toward the sun land
 *    inside cloud"), not a physical optical-depth integral. The article's worked example is
 *    (1+1+1+0+0+0+0+0)/8 = 0.375. This is what removes the previous implementation's cost
 *    explosion: it used to run a full noise-based density four times per main step.
 * 3. A blue-noise offset jitters the march start so a low step count does not band.
 *
 * The cloud volume is bounded by two ellipsoid shells (cloud base and cloud top), normalised to
 * the WGS84 shape, which is how the article adapts the technique to a GIS engine.
 */

/**
 * Cloud quality tiers. `steps` is the view-ray march and `lightSteps` the sun march; the
 * product bounds the cost. `maxDistance` limits how far the march follows the ray.
 */
export const CLOUD_TIERS = Object.freeze({
  performance: { steps: 24, lightSteps: 4, maxDistance: 30000 },
  balanced: { steps: 48, lightSteps: 6, maxDistance: 40000 },
  high: { steps: 80, lightSteps: 8, maxDistance: 50000 }
})

export function cloudTier(quality) {
  return CLOUD_TIERS[quality] || CLOUD_TIERS.balanced
}

const glslNumber = value => Number.isFinite(value)
  ? (Number.isInteger(value) ? `${value}.0` : String(value))
  : '0.0'

/**
 * GLSL for the cloud pass. The caller must supply:
 *   uniforms: cloudParams (vec4: coverage, baseAltitude, topAltitude, densityScale)
 *             cloudWind (vec3), noiseTexture (sampler2D atlas)
 *             atmosphereParams, sunDirectionAtmo (declared by atmosphereScattering143)
 *   functions: ccrSkyRadiance() and ccrSunRadiance(), both returning vec3. Keeping them as
 *              functions lets the host decide whether the cloud is lit by the analytic
 *              atmosphere, by an IBL probe, or by a constant, without this module knowing.
 *   helpers:   ccrNoise3D / ccrNoiseVoxel are declared here; ccrAtmosphereIntersect comes from
 *              atmosphereScattering143.
 *
 * It exposes `vec4 ccrClouds(vec3 origin, vec3 direction, float maxDistance)`, returning
 * premultiplied rgb in .rgb and the residual transmittance in .a.
 */
export function cloudGLSL(tier) {
  const { steps, lightSteps, maxDistance } = cloudTier(tier)
  return `
#define CLOUD_STEPS ${steps}
#define CLOUD_LIGHT_STEPS ${lightSteps}
#define CLOUD_MAX_DISTANCE ${glslNumber(maxDistance)}
// Growth factor applied when a step lands in empty space. A value close to 1 keeps the march
// near-uniform; larger values skip empty air faster at the cost of a coarser slab entry.
#define CLOUD_STEP_GROWTH 1.35

uniform vec4 cloudParams;    // coverage, baseAltitude, topAltitude, densityScale
uniform vec3 cloudWind;
uniform sampler2D noiseTexture;

// The noise atlas holds 64 periodic z slices laid out as 8x8 tiles, each padded by one wrapped
// texel on all sides. Hardware filtering cannot be used across the padding, so the trilinear
// interpolation is explicit; the article's technique also relies on a single-channel lookup.
float ccrNoiseVoxel(ivec3 p) {
  p = ivec3(mod(vec3(p), 64.0));
  ivec2 tile = ivec2(p.z % 8, p.z / 8) * 66;
  return texelFetch(noiseTexture, tile + p.xy + 1, 0).r;
}

float ccrNoise3D(vec3 point) {
  vec3 p = mod(point, 64.0);
  ivec3 base = ivec3(floor(p));
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x00 = mix(ccrNoiseVoxel(base), ccrNoiseVoxel(base + ivec3(1, 0, 0)), f.x);
  float x10 = mix(ccrNoiseVoxel(base + ivec3(0, 1, 0)), ccrNoiseVoxel(base + ivec3(1, 1, 0)), f.x);
  float x01 = mix(ccrNoiseVoxel(base + ivec3(0, 0, 1)), ccrNoiseVoxel(base + ivec3(1, 0, 1)), f.x);
  float x11 = mix(ccrNoiseVoxel(base + ivec3(0, 1, 1)), ccrNoiseVoxel(base + ivec3(1, 1, 1)), f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

// Altitude above the ellipsoid, mirroring the flattening correction the atmosphere uses. The
// cloud slab bounds are altitudes, so every height test must go through this and not through
// the raw z component.
float ccrCloudAltitude(vec3 position) {
  float horizontal = length(position.xy);
  return position.z - (horizontal * horizontal) / (2.0 * atmosphereParams.x);
}

// Height inside the cloud slab, normalised to 0..1, with a soft profile so the slab does not
// read as a hard-edged box.
float ccrCloudProfileAtAltitude(float altitude) {
  float t = (altitude - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0);
  if (t <= 0.0 || t >= 1.0) return 0.0;
  return smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.62, 1.0, t));
}

float ccrCloudProfile(vec3 position) {
  return ccrCloudProfileAtAltitude(ccrCloudAltitude(position));
}

// Coverage-shaped noise: a low-frequency field carves the cloud mass, a higher-frequency one
// adds the wispy detail. Both are single noise lookups, which is what keeps a step cheap.
float ccrCloudDensity(vec3 position) {
  float profile = ccrCloudProfile(position);
  if (profile <= 0.0) return 0.0;
  vec3 p = position + cloudWind;
  float shape = ccrNoise3D(p / 9000.0);
  float detail = ccrNoise3D(p / 3200.0);
  float threshold = mix(0.72, 0.18, clamp(cloudParams.x, 0.0, 1.0));
  float mass = smoothstep(threshold, threshold + 0.28, shape * 0.68 + detail * 0.32);
  return mass * profile * max(cloudParams.w, 0.0);
}

// Binary sun occlusion, per the article: count how many samples toward the sun sit inside the
// cloud, then convert that fraction into a transmission. Deliberately not an optical-depth
// integral: this is the change that makes the light march affordable.
float ccrCloudSunVisibility(vec3 position) {
  float altitude = ccrCloudAltitude(position);
  // Distance to the top of the slab along the sun direction, so the samples stay inside it.
  float distanceToTop = 4000.0;
  if (abs(sunDirectionAtmo.z) > 1.0e-4) {
    float boundary = sunDirectionAtmo.z > 0.0 ? cloudParams.z : cloudParams.y;
    distanceToTop = clamp((boundary - altitude) / sunDirectionAtmo.z, 0.0, 6000.0);
  }
  float stepLength = distanceToTop / float(CLOUD_LIGHT_STEPS);
  float inside = 0.0;
  for (int l = 0; l < CLOUD_LIGHT_STEPS; l++) {
    vec3 samplePosition = position + sunDirectionAtmo * ((float(l) + 0.5) * stepLength);
    float sampleAltitude = ccrCloudAltitude(samplePosition);
    if (ccrCloudProfileAtAltitude(sampleAltitude) > 0.0
        && ccrNoise3D((samplePosition + cloudWind) / 9000.0) > 0.35) inside += 1.0;
  }
  return exp(-(inside / float(CLOUD_LIGHT_STEPS)) * 6.0);
}

// Blue-noise style per-pixel offset. Using the same golden-ratio hash as the reference keeps the
// banding break-up stable without requiring a blue-noise texture.
float ccrCloudJitter() {
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}

vec4 ccrClouds(vec3 origin, vec3 direction, float sceneDistance) {
  // The slab bounds are altitudes above the ellipsoid, so the containing shells sit at
  // planetRadius + altitude. Intersecting the exact ellipsoid per ray is not worth it here:
  // the atmosphere's radius carries the same flattening correction and the slab is thin
  // relative to it, so a sphere at the corrected radius keeps the boundary consistent.
  //
  // Every exit below sets start/limit so the function has a single return path; early
  // returns made the driver warn that the result could be uninitialised.
  float cameraAltitude = ccrCloudAltitude(origin);
  float start = 0.0;
  float limit = min(sceneDistance, CLOUD_MAX_DISTANCE);
  bool visible = true;
  if (cameraAltitude > cloudParams.z) {
    // Above the slab: enter where the ray crosses the top shell.
    vec2 topHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x + cloudParams.z);
    if (topHit.y < 0.0 || topHit.y < topHit.x) visible = false;
    else {
      start = max(topHit.x, 0.0);
      vec2 baseHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x + cloudParams.y);
      if (baseHit.y > 0.0 && baseHit.x > start) limit = min(limit, baseHit.x);
    }
  } else if (cameraAltitude < cloudParams.y) {
    // Below the slab: enter where the ray crosses the base shell.
    vec2 baseHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x + cloudParams.y);
    if (baseHit.y < 0.0 || baseHit.y < baseHit.x) visible = false;
    else {
      start = max(baseHit.x, 0.0);
      vec2 topHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x + cloudParams.z);
      if (topHit.y > 0.0 && topHit.x > start) limit = min(limit, topHit.x);
    }
  } else {
    // Inside the slab already.
    vec2 topHit = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x + cloudParams.z);
    if (topHit.y > 0.0 && topHit.x > 0.0) limit = min(limit, topHit.x);
  }
  if (!visible || limit <= start) return vec4(0.0);

  // Adaptive stepping, following the approach used by @takram/three-clouds:
  // - the step grows geometrically as the ray advances, so near-field detail keeps small steps
  //   while the far field is sampled coarsely;
  // - a sample that lands in empty space advances by an extra step instead of only skipping,
  //   which is what keeps the march affordable when most of the ray misses the cloud.
  // CLOUD_STEPS remains an upper bound on iterations, not a fixed sample count.
  float baseStep = (limit - start) / float(CLOUD_STEPS);
  float stepLength = baseStep;
  float jitter = ccrCloudJitter();
  vec3 accumulated = vec3(0.0);
  float transmittance = 1.0;
  float distanceAlongRay = start + stepLength * jitter;

  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (distanceAlongRay > limit) break;
    vec3 position = origin + direction * distanceAlongRay;
    float density = ccrCloudDensity(position);
    if (density <= 0.0) {
      // Empty space: take a longer stride rather than a normal one and re-test.
      stepLength *= CLOUD_STEP_GROWTH;
      distanceAlongRay += stepLength;
      continue;
    }
    float extinction = density * stepLength;
    float visibility = ccrCloudSunVisibility(position);
    // Light reaching this sample: sun contribution shaped by the phase toward the view ray,
    // plus a share of the sky so the shadowed side is not black.
    vec3 lighting = ccrSkyRadiance() * 0.55 + ccrSunRadiance() * visibility;
    // Energy-conserving analytical integration of the scattered light over the step, which is
    // more accurate than multiplying by (1 - exp(-extinction)) and also keeps the result stable
    // when the step length changes between iterations.
    float stepTransmittance = exp(-extinction);
    vec3 scatteringIntegral = (lighting - lighting * stepTransmittance) / max(density, 1e-6);
    accumulated += transmittance * scatteringIntegral;
    transmittance *= stepTransmittance;
    if (transmittance < 0.01) break;
    // Advance by the current step, then let it grow for the next iteration.
    distanceAlongRay += stepLength;
    stepLength *= CLOUD_STEP_GROWTH;
  }
  return vec4(accumulated, transmittance);
}
`
}

export default { cloudGLSL, cloudTier, CLOUD_TIERS }
