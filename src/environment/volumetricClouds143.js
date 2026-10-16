import { cloudTransportDensityGLSL } from './reference/three-clouds/cloudTransportDensity.js'
import { nightLightUniformsGLSL } from './nightLighting143.js'
import { cloudSpatialGLSL } from './cloudSpatial143.js'
import { cloudHorizonGLSL } from './cloudHorizon143.js'

/**
 * Volumetric clouds following the reference article:
 * https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/
 *
 * Perlin-Worley shape and Worley erosion are prepared from the pinned three-geospatial
 * reference. View and light rays sample the same density; dual HG phase and scattering
 * octaves follow its lighting formulation. Sources and licences: reference/three-clouds.
 * The host supplies a WGS84-height-corrected tangent sphere and stable ENU noise coordinates.
 */

/**
 * Cloud quality tiers. `steps` bounds view samples; `lightSteps` bounds each sun/ground
 * density march. Lit samples additionally evaluate atmosphere light transmittance.
 * `maxDistance` limits view rays, not the spherical sun optical-depth interval.
 */
export const CLOUD_TIERS = Object.freeze({
  performance: { steps: 24, lightSteps: 4, maxDistance: 30000 },
  balanced: { steps: 96, lightSteps: 6, maxDistance: 40000 },
  high: { steps: 128, lightSteps: 8, maxDistance: 50000 }
})

export function cloudTier(quality) {
  return CLOUD_TIERS[quality] || CLOUD_TIERS.balanced
}

// Fade optical density, not composited colour: L tends to zero and T to one.
// The zero endpoint slope also keeps the receiver shadow range continuous.
export const cloudDistanceFadeGLSL = `
float ccrCloudDistanceFade(float distance, float maxDistance) {
  return 1.0 - smoothstep(maxDistance * 0.7, maxDistance, distance);
}
`

const glslNumber = value => Number.isFinite(value)
  ? (Number.isInteger(value) ? `${value}.0` : String(value))
  : '0.0'

/**
 * GLSL for the cloud pass. The caller must supply:
 *   uniforms: cloudParams (vec4: coverage, baseAltitude, topAltitude, densityScale)
 *             cloudWeatherOffset, cloudShapeOffset, cloudDetailOffset (metric vec3 offsets)
 *             cloudFrame (vec2: frame, temporalActive)
 *             noiseTexture (sampler2D atlas), atmosphereOrigin, cloudNoiseOrigin (vec3)
 *             atmosphereParams, atmosphereSunRadiance, sunDirectionAtmo and
 *             ATMOS_LIGHT_STEPS (declared by atmosphereScattering143)
 *   functions: ccrSkyRadiance() returns representative sky radiance in the shared linear
 *              HDR scale. Directional sunlight uses the unattenuated atmosphereSunRadiance
 *              source and sample-altitude atmospheric transmittance, applied once.
 *   helpers:   ccrAtmosphereIntersect / ccrAtmosphereLightTransmittance come from
 *              atmosphereScattering143. ccrCloudNoise3D is declared here.
 *
 * It exposes `vec4 ccrClouds(vec3 origin, vec3 direction, float maxDistance)`, returning
 * premultiplied rgb in .rgb and the residual transmittance in .a.
 * The out-distance overload and ccrCloudGeometry return extinction-contribution-weighted
 * metric depth (sceneDistance on a miss); geometry.y is residual transmittance.
 */
export function cloudGLSL(tier) {
  const { steps, lightSteps, maxDistance } = cloudTier(tier)
  return `
#define CLOUD_STEPS ${steps}
#define CLOUD_LIGHT_STEPS ${lightSteps}
#define CLOUD_MAX_DISTANCE ${glslNumber(maxDistance)}
#define CLOUD_SCATTERING_OCTAVES 8
${cloudSpatialGLSL}
${nightLightUniformsGLSL}
${cloudDistanceFadeGLSL}
uniform vec4 cloudParams;    // coverage, baseAltitude, topAltitude, densityScale
uniform vec3 cloudWind;
uniform vec3 cloudWeatherOffset;
uniform vec3 cloudShapeOffset;
uniform vec3 cloudDetailOffset;
uniform vec2 cloudFrame; // frameIndex, temporalActive; midpoint sampling while inactive
uniform sampler2D noiseTexture;
uniform vec3 atmosphereOrigin;
uniform vec3 cloudNoiseOrigin;
uniform int cloudModel;
${cloudHorizonGLSL}

// R=Perlin-Worley shape, G=Worley detail, B=weather. The 64 periodic Z slices
// have wrapped gutters, allowing bilinear XY filtering without bleeding between slices.
vec3 ccrCloudNoise3D(vec3 point) {
  vec3 p = mod(point, 64.0);
  ivec3 base = ivec3(floor(p));
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  // The wrapped gutter makes bilinear XY filtering safe, including x/y=63.
  // Interpolate only the two Z slices explicitly; this is the same trilinear field.
  ivec2 lower = ivec2(base.z % 8, base.z / 8) * 66;
  int nextZ = (base.z + 1) % 64;
  ivec2 upper = ivec2(nextZ % 8, nextZ / 8) * 66;
  vec2 xy = vec2(base.xy) + f.xy + 1.5;
  vec3 a = textureLod(noiseTexture, (vec2(lower) + xy) / 528.0, 0.0).rgb;
  vec3 b = textureLod(noiseTexture, (vec2(upper) + xy) / 528.0, 0.0).rgb;
  return mix(a, b, f.z);
}

// Altitude above the planet surface, in the planet-centred frame the caller now supplies.
// Using the sphere radius rather than an ellipsoid is deliberate: it matches the atmosphere
// module, with exact camera height supplied by the ellipsoid adapter.
float ccrCloudAltitude(vec3 position) {
  return length(position - CCR_PLANET_POS) - atmosphereParams.x;
}

${cloudTransportDensityGLSL}

// Retain the profile helpers for callers inspecting the cloud layer.
float ccrCloudProfileAtAltitude(float altitude) {
  float t = (altitude - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0);
  if (t <= 0.0 || t >= 1.0) return 0.0;
  return ccrCloudHeightScale(cloudModel==1?t:t*t);
}

float ccrCloudProfile(vec3 position) {
  return ccrCloudProfileAtAltitude(ccrCloudAltitude(position));
}

// Offsets evolve and wrap independently in cloudMotion143; deriving one field from
// another wrapped offset would reset its phase at nonmatching texture periods.
float ccrCloudDensity(vec3 position) {
  if (cloudParams.x <= 0.0 || cloudParams.w <= 0.0) return 0.0;
  float t = (ccrCloudAltitude(position) - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0);
  if (t <= 0.0 || t >= 1.0) return 0.0;
  vec3 p = (position - atmosphereOrigin) + cloudNoiseOrigin;
  vec3 weatherPosition = p + cloudWeatherOffset;
  float localWeather = ccrCloudNoise3D(vec3(weatherPosition.xy * (64.0 / CCR_CLOUD_WEATHER_PERIOD), 0.0)).b;
  // The reference's .35 bias peaks at 14% of the layer: with one low-coverage
  // layer it collapses cumulus into thin sheets. t^2 gives a .7 weather bias
  // (peak 37%) while media density and altitude still use the true height.
  // Preserve the low, broad stratus profile.
  float weatherHeight=cloudModel==1?t:t*t;
  float weather = ccrCloudWeatherDensity(weatherHeight, localWeather, clamp(cloudParams.x, 0.0, 1.0));
  if (weather <= 0.0) return 0.0;
  // Body offset includes vertical evolution, in the noise field's ENU frame.
  vec3 shapePosition = p + cloudShapeOffset;
  float shape = ccrCloudNoise3D(shapePosition * (64.0 / CCR_CLOUD_SHAPE_PERIOD)).r;
  // Restore upstream shapeAmount for a single cumulus layer: its prepared
  // shape field has mean .8, so amount=1 leaves nearly every vertical column
  // occupied. Strengthen carving without changing coverage or extinction.
  if(cloudModel!=1) shape=1.0-(1.0-shape)*1.25;
  float detail = ccrCloudNoise3D((p + cloudDetailOffset) * (64.0 / CCR_CLOUD_DETAIL_PERIOD)).g;
  float detailAmount = cloudModel == 1 ? 0.32 : 1.0;
  return ccrCloudMediaDensity(t, weather, shape, detail, detailAmount) * cloudParams.w;
}

// The forward shell can have two lobes at the limb. Keep both, clip against the
// first planet hit, and use this exact interval for view, depth, sun and ground rays.
// ccrAtmosphereIntersect uses the stable (r-R)*(r+R) quadratic constant.
vec4 ccrCloudShellIntervals(vec3 origin, vec3 direction, float distanceLimit) {
  vec3 centredOrigin = origin - CCR_PLANET_POS;
  vec2 outer = ccrAtmosphereIntersect(centredOrigin, direction, atmosphereParams.x + cloudParams.z);
  float start = max(outer.x, 0.0);
  float finish = min(outer.y, distanceLimit);
  vec2 ground = ccrAtmosphereIntersect(centredOrigin, direction, atmosphereParams.x);
  if (ground.x >= 0.0 && ground.y >= ground.x) finish = min(finish, ground.x);
  if (finish <= start) return vec4(0.0);
  vec2 inner = ccrAtmosphereIntersect(centredOrigin, direction, atmosphereParams.x + cloudParams.y);
  if (inner.y <= start || inner.x >= finish || inner.y < inner.x) return vec4(start, finish, 0.0, 0.0);
  vec4 intervals = vec4(0.0);
  if (inner.x > start) intervals.xy = vec2(start, min(finish, inner.x));
  if (inner.y < finish) intervals.zw = vec2(max(start, inner.y), finish);
  return intervals;
}

float ccrCloudIntervalLength(vec4 intervals) {
  return max(intervals.y - intervals.x, 0.0) + max(intervals.w - intervals.z, 0.0);
}

float ccrCloudIntervalDistance(vec4 intervals, float pathDistance) {
  float firstLength = max(intervals.y - intervals.x, 0.0);
  return pathDistance < firstLength ? intervals.x + pathDistance : intervals.z + pathDistance - firstLength;
}

float ccrCloudOpticalDepth(vec3 position, vec3 direction, vec4 intervals) {
  float stepLength = ccrCloudIntervalLength(intervals) / float(CLOUD_LIGHT_STEPS);
  if (stepLength <= 0.0) return 0.0;
  float opticalDepth = 0.0;
  for (int l = 0; l < CLOUD_LIGHT_STEPS; l++) {
    float distance = ccrCloudIntervalDistance(intervals, (float(l) + 0.5) * stepLength);
    vec3 samplePosition = position + direction * distance;
    opticalDepth += ccrCloudDensity(samplePosition) * stepLength;
  }
  return opticalDepth;
}

// No planar grazing-angle approximation or kilometre truncation: a horizontal
// sun ray can cross tens of kilometres of the spherical layer.
float ccrCloudLightOpticalDepth(vec3 position,vec3 lightDirection) {
  vec4 intervals = ccrCloudShellIntervals(position, lightDirection, 1.0e9);
  return ccrCloudOpticalDepth(position, lightDirection, intervals);
}
float ccrCloudSunOpticalDepth(vec3 position) {
  vec4 intervals = ccrCloudShellIntervals(position, sunDirectionAtmo, 1.0e9);
  return ccrCloudOpticalDepth(position, sunDirectionAtmo, intervals);
}

float ccrCloudSunVisibility(vec3 position) { return exp(-ccrCloudSunOpticalDepth(position)); }

vec3 ccrCloudLightTransmittance(vec3 position,vec3 lightDirection) {
  vec2 hit = ccrAtmosphereIntersect(position - CCR_PLANET_POS, lightDirection, atmosphereParams.y);
  float stepLength = max(hit.y, 0.0) / float(ATMOS_LIGHT_STEPS);
  return ccrAtmosphereLightTransmittance(position, lightDirection, stepLength);
}
vec3 ccrCloudAtmosphereSunTransmittance(vec3 position) {
  vec2 hit = ccrAtmosphereIntersect(position - CCR_PLANET_POS, sunDirectionAtmo, atmosphereParams.y);
  float stepLength = max(hit.y, 0.0) / float(ATMOS_LIGHT_STEPS);
  return ccrAtmosphereLightTransmittance(position, sunDirectionAtmo, stepLength);
}

vec3 ccrCloudGroundBounce(vec3 position, vec3 skyIrradiance, vec3 sunIrradiance) {
  vec3 up = normalize(position - CCR_PLANET_POS);
  vec4 intervals = ccrCloudShellIntervals(position, -up, 1.0e9);
  float opticalDepth = ccrCloudOpticalDepth(position, -up, intervals);
  // Upstream Lambertian albedo=0.3, with direct ground irradiance reduced by coverage.
  // skyIrradiance is an analytic hemispherical estimate (see TRANSPORT_PORT.md).
  vec3 groundIrradiance = skyIrradiance + (1.0 - clamp(cloudParams.x, 0.0, 1.0))
    * sunIrradiance * max(dot(up, sunDirectionAtmo), 0.0);
  vec3 bouncedRadiance = (0.3 / 3.14159265359) * groundIrradiance * exp(-opticalDepth);
  return bouncedRadiance * 0.0795774715459;
}

// Dual HG phase and bounded multiple-scattering octaves, following the reference's
// optical-depth formulation. Never treat radiance as independent of scattering density.
float ccrCloudPhase(float mu, float g) {
  return (1.0 - g * g) / (12.5663706144 * pow(max(1.0 + g * g - 2.0 * g * mu, 0.001), 1.5));
}
float ccrCloudScattering(float opticalDepth, float mu) {
  float result = 0.0, weight = 1.0, attenuation = 1.0;
  for (int i = 0; i < CLOUD_SCATTERING_OCTAVES; i++) {
    float phase = mix(ccrCloudPhase(mu, 0.7 * attenuation), ccrCloudPhase(mu, -0.2 * attenuation), 0.5);
    result += weight * exp(-opticalDepth * attenuation) * phase;
    weight *= 0.5; attenuation *= 0.5;
  }
  return result;
}

// Psi is already mean radiance: isotropic scattering integrates 4*pi*Psi
// against 1/(4*pi). The hemispherical pi*Psi used for ground/fog lighting
// cannot be fed through that same normalization or it loses a factor of four.
vec3 ccrCloudSkyScatteringSource(vec3 hemisphereIrradiance) {
#ifdef CCR_ATMOSPHERE_LUT
  if(atmosphereLutReady)return hemisphereIrradiance/3.14159265359;
#endif
  return hemisphereIrradiance*0.0795774715459;
}

// Two vertical rays represent the upper and lower 2*pi hemispheres. Retain
// indirect ambient penetration with the same bounded scattering octaves;
// normalize so an unobstructed environment stays exactly unchanged.
float ccrCloudAmbientVisibility(vec2 opticalDepth) {
  vec2 transmission=vec2(0.0);
  float weight=1.0,attenuation=1.0,totalWeight=0.0;
  for(int i=0;i<CLOUD_SCATTERING_OCTAVES;i++) {
    transmission+=weight*exp(-max(opticalDepth,vec2(0.0))*attenuation);
    totalWeight+=weight;
    weight*=0.5;attenuation*=0.5;
  }
  return 0.5*(transmission.x+transmission.y)/totalWeight;
}
vec2 ccrCloudAmbientOpticalDepth(vec3 position) {
  vec3 up=normalize(position-CCR_PLANET_POS);
  float above=ccrCloudOpticalDepth(position,up,ccrCloudShellIntervals(position,up,1.0e9));
  float below=ccrCloudOpticalDepth(position,-up,ccrCloudShellIntervals(position,-up,1.0e9));
  return vec2(above,below);
}

// Hash jitter is activated only when the cloud-specific reconstruction accepts history.
float ccrCloudJitter() {
  if (cloudFrame.y < 0.5) return 0.5;
  vec3 p = fract(vec3(gl_FragCoord.xy, cloudFrame.x) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Shared density quadrature gives the radiance and geometry passes identical depth/T.
// Geometry mode skips all atmospheric and secondary light marches.
vec4 ccrCloudMarch(vec3 origin, vec3 direction, float sceneDistance, bool integrateLighting, out float cloudDistance) {
  cloudDistance = sceneDistance;
  if (cloudParams.x <= 0.0 || cloudParams.w <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float viewRange = ccrCloudViewRange(origin);
  float limit = min(max(sceneDistance, 0.0), viewRange);
  vec4 intervals = ccrCloudShellIntervals(origin, direction, limit);
  float pathLength = ccrCloudIntervalLength(intervals);
  if (pathLength <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float sampleCount = float(CLOUD_STEPS) * (1.0 + cloudHorizonBlend * clamp(pathLength/CLOUD_MAX_DISTANCE-1.0,0.0,1.0));
  bool extendedSampling=cloudHorizonBlend>0.0&&pathLength>CLOUD_MAX_DISTANCE;
  float stepLength = pathLength / float(CLOUD_STEPS);
  float jitter = ccrCloudJitter();
  vec3 accumulated = vec3(0.0);
  float transmittance = 1.0;
  float weightedDistance = 0.0, weightSum = 0.0;
  for (int i = 0; i < CLOUD_STEPS * 2; i++) {
    if(float(i)>=ceil(sampleCount))break;
    float start=ccrCloudViewPathDistance(float(i)/ceil(sampleCount),pathLength);
    float finish=ccrCloudViewPathDistance(float(i+1)/ceil(sampleCount),pathLength);
    // Preserve the accepted uniform quadrature exactly while looking down.
    if(extendedSampling)stepLength=finish-start;
    float pathDistance=extendedSampling?mix(start,finish,jitter):(float(i)+jitter)*stepLength;
    float distanceAlongRay = ccrCloudIntervalDistance(intervals, pathDistance);
    vec3 position = origin + direction * distanceAlongRay;
    float density = ccrCloudDensity(position) * ccrCloudDistanceFade(distanceAlongRay, viewRange);
    if (density <= 0.0) continue;
    float stepTransmittance = exp(-density * stepLength);
    float sampleWeight = transmittance * (1.0 - stepTransmittance);
    weightedDistance += distanceAlongRay * sampleWeight;
    weightSum += sampleWeight;
    if (integrateLighting) {
      float sunDepth = ccrCloudSunOpticalDepth(position);
      float heightFraction = clamp((ccrCloudAltitude(position) - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0), 0.0, 1.0);
      // atmosphereSunRadiance is the unattenuated directional source used by the
      // atmosphere, never the camera-altitude ccrSunRadiance estimate. The sky input
      // is representative radiance: pi*L estimates hemispherical sky irradiance.
      vec3 sunIrradiance = atmosphereSunRadiance * ccrCloudAtmosphereSunTransmittance(position);
      vec3 skyIrradiance = ccrSkyRadiance() * 3.14159265359;
#ifdef CCR_ATMOSPHERE_LUT
      if(atmosphereLutReady) skyIrradiance=ccrLutSkyIrradiance(position,sunDirectionAtmo)
        *atmosphereSunRadiance*environmentSkyScale;
#endif
      vec3 lighting = sunIrradiance * ccrCloudScattering(sunDepth, dot(direction, sunDirectionAtmo));
      float skyGradient=heightFraction*0.5+0.5;
      float ambientVisibility=ccrCloudAmbientVisibility(ccrCloudAmbientOpticalDepth(position));
      lighting += ccrCloudSkyScatteringSource(skyIrradiance) * skyGradient * ambientVisibility;
#ifdef CCR_ATMOSPHERE_LUT
      // M already includes the ground hemisphere. Do not add a second diffuse
      // ground term to its full-sphere mean radiance.
      if(!atmosphereLutReady) lighting += ccrCloudGroundBounce(position, skyIrradiance, sunIrradiance);
#else
      lighting += ccrCloudGroundBounce(position, skyIrradiance, sunIrradiance);
#endif
      lighting += nightSkyRadiance * (heightFraction * 0.5 + 0.5);
      if(max(max(moonRadiance.r,moonRadiance.g),moonRadiance.b)>0.0) {
        vec3 moonIrradiance = moonRadiance * ccrCloudLightTransmittance(position, moonDirectionAtmo);
        float moonDepth = ccrCloudLightOpticalDepth(position, moonDirectionAtmo);
        lighting += moonIrradiance * ccrCloudScattering(moonDepth,dot(direction,moonDirectionAtmo));
#ifdef CCR_ATMOSPHERE_LUT
        if(atmosphereLutReady) lighting += ccrLutMultipleScattering(position,moonDirectionAtmo)
          * moonRadiance * (heightFraction * 0.5 + 0.5);
#endif
      }
      // Upstream powder defaults, extinction measured in inverse metres. This is
      // a local material term, independent of view step length or quality tier.
      lighting *= 1.0 - 0.8 * exp(-density * 150.0);
      // Unit scattering albedo: sigma_s cancels sigma_t in the analytical integral.
      // No division by density, which would turn low-density edges into speckles.
      accumulated += lighting * sampleWeight;
    }
    transmittance *= stepTransmittance;
    if (transmittance < 0.01) break;
  }
  cloudDistance = weightSum > 0.0 ? weightedDistance / weightSum : sceneDistance;
  return vec4(accumulated, transmittance);
}

vec2 ccrCloudGeometry(vec3 origin, vec3 direction, float sceneDistance) {
  float cloudDistance;
  vec4 transport = ccrCloudMarch(origin, direction, sceneDistance, false, cloudDistance);
  return vec2(cloudDistance, transport.a);
}

vec4 ccrClouds(vec3 origin, vec3 direction, float sceneDistance, out float cloudDistance) {
  return ccrCloudMarch(origin, direction, sceneDistance, true, cloudDistance);
}

vec4 ccrClouds(vec3 origin, vec3 direction, float sceneDistance) {
  float cloudDistance;
  return ccrClouds(origin, direction, sceneDistance, cloudDistance);
}
`
}

export default { cloudGLSL, cloudTier, CLOUD_TIERS }
