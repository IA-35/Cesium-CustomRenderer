/**
 * Environment stages: atmosphere scattering + volumetric clouds.
 *
 * Replaces the previous noise-integrated height fog and cloud solver. The rewrite follows the
 * reference article's approach:
 *   https://www.liaomz.top/2025/02/13/cesium-zhong-shi-xian-ti-ji-yun-he-da-qi-mei-hua-xiao-guo/
 *   https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/
 *
 * What changed and why:
 * - The medium density is now analytic (Rayleigh / Mie / ozone profiles) instead of a per-sample
 *   noise lookup. The old path ran a full noise-based density four times per main step to build
 *   the sun transmittance; the new sun march is a binary inside/outside count.
 * - Sky colour comes from an explicit scattering integral, so it no longer has to be approximated
 *   by height fog and the cloud lighting reads a real sky radiance.
 *
 * The returned shape is unchanged so EnvironmentRenderer and HdrEnvironmentPass143 keep working:
 *   { id, composite, raymarchStage, resolveStage, occlusionStage }
 * `occlusionStage` still publishes the B08/B09 contract:
 *   RGBA32F half-res, r = sun medium transmittance, g = sun visibility, b = view transmittance.
 */
import { atmosphereGLSL, ATMOSPHERE_RADIUS_M, PLANET_RADIUS_M, RAYLEIGH_SCALE_HEIGHT,
  MIE_SCALE_HEIGHT } from './atmosphereScattering143.js'
import { cloudGLSL } from './volumetricClouds143.js'

let nextId = 0

const EARTH_RADIUS = 6371008.8

// Fraction of the frame the environment pass renders at. Clouds and atmosphere are low
// frequency compared with the scene, so half resolution plus the resolve upscale is enough and
// keeps the cost bounded independently of the viewport size.
const RENDER_SCALE = 0.5

const depthFunctions = `
#define CCR_EARTH_RADIUS ${EARTH_RADIUS.toFixed(1)}
#define DEPTH_LIMIT 20000000.0
uniform bool shellEmptyScene;
uniform sampler2D depthTexture;
uniform highp sampler2D surfaceDepthTexture;
uniform bool surfaceDepthAvailable;
uniform vec2 sourceSize;

// Distance to the scene surface for this pixel. The builtin divides by the active viewport, so
// the uv is normalised before applying the main-camera inverse projection in the half-size pass.
float depthDistance(vec2 uv, float rawDepth) {
  if (!(rawDepth > 0.0 && rawDepth < 1.0)) return DEPTH_LIMIT;
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth);
  if (abs(eye.w) < 1.0e-12) return DEPTH_LIMIT;
  return min(length(eye.xyz / eye.w), DEPTH_LIMIT);
}

float sceneDistance(vec2 uv) {
  if (surfaceDepthAvailable) {
    float raw = texture(surfaceDepthTexture, uv).r;
    float distance = depthDistance(uv, raw);
    if (distance < DEPTH_LIMIT) return distance;
  }
  return depthDistance(uv, texture(depthTexture, uv).r);
}
`

/**
 * Build the composite for one environment instance.
 *
 * @param C Cesium namespace
 * @param uniforms the uniform map EnvironmentRenderer supplies (see its createComposite)
 * @param quality 'performance' | 'balanced' | 'high'
 * @param geometry kept for interface compatibility; the rewrite always uses the ellipsoid shell
 * @param frameUbo whether the host packs per-frame inputs into a UBO
 */
export function createEnvironmentStages(C, uniforms, quality = 'balanced', geometry = 'shell', frameUbo = false) {
  const id = ++nextId
  const tier = quality === 'high' ? 'high' : quality === 'performance' ? 'performance' : 'balanced'

  // Cloud lighting reads the analytic sky and sun so the cloud colour tracks the atmosphere.
  const radianceHelpers = `
vec3 ccrSkyRadiance() { return skyRadiance; }
vec3 ccrSunRadiance() { return sunRadiance; }
`
  // Order matters: GLSL requires every uniform to be declared before use, so the shared
  // declarations come first and the scattering and cloud modules follow.
  const sharedDeclarations = `
// Cesium post-process stages do not inject the texture coordinate varying; the stage must
// declare it. GLSL ES 3.00 uses the in qualifier for stage inputs, and the legacy varying
// qualifier is a reserved word there, so the WebGL2 build fails if it is used.
in vec2 v_textureCoordinates;

// Declared here rather than in the scattering/cloud modules because they are read directly by
// each stage's main(): eyeToLocal frames the ray, and the two radiance terms light the cloud.
uniform mat4 eyeToLocal;
// ENU-to-ECEF. The atmosphere integral is written for a planet-centred frame, so the ray must be
// transformed before it is integrated; see the porting notes for the measured error this avoids.
uniform mat4 enuToEcef;
uniform sampler2D originalHdr;
uniform vec3 skyRadiance;
uniform vec3 sunRadiance;

// Rebuild the view ray through the Cesium reconstruction builtin rather than a raw
// inverseProjection multiply: the builtin applies the log-depth transform when the scene uses
// it, so the ray stays correct in both depth modes.
vec3 ccrViewDirection(vec2 uv) {
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, 0.0);
  if (abs(eye.w) < 1.0e-12) return vec3(0.0, 0.0, 1.0);
  return normalize(eye.xyz / eye.w);
}
`
  const uboDefine = frameUbo ? '#define CCR_ENV_FRAME_UBO\n' : ''
  const shading = `${uboDefine}${sharedDeclarations}\n${atmosphereGLSL(tier)}\n${radianceHelpers}\n${cloudGLSL(tier)}`

  const rayUniforms = {}
  for (const name of ['eyeToLocal', 'enuToEcef', 'originalHdr', 'sunDirectionLocal', 'sunRadiance', 'skyRadiance',
    'cloudParams', 'cloudWind', 'noiseTexture', 'sourceSize',
    'surfaceDepthTexture', 'surfaceDepthAvailable', 'atmosphereParams', 'surfaceHeight']) {
    if (uniforms[name] !== undefined) rayUniforms[name] = uniforms[name]
  }
  // The cloud march reads its own wind offset; expose it under the name the shader declares.
  if (uniforms.windOffset !== undefined && rayUniforms.cloudWind === undefined) {
    rayUniforms.cloudWind = uniforms.windOffset
  }
  // The atmosphere and cloud marches both need the sun in the same local frame the ray uses.
  rayUniforms.sunDirectionAtmo = () => typeof uniforms.sunDirectionLocal === 'function'
    ? uniforms.sunDirectionLocal() : uniforms.sunDirectionLocal
  // Validate the shader's uniform contract up front. A missing binding would otherwise surface
  // as a driver compile error inside the render loop, where the cause is hard to see.
  const required = ['eyeToLocal', 'enuToEcef', 'originalHdr', 'sunDirectionAtmo', 'sunRadiance', 'skyRadiance', 'cloudParams', 'cloudWind', 'noiseTexture', 'atmosphereParams']
  const missing = required.filter(name => rayUniforms[name] === undefined)
  if (missing.length) throw new Error(`environment stages missing uniforms: ${missing.join(', ')}`)

  const raymarchStage = new C.PostProcessStage({
    name: `environment_raymarch_${id}`,
    fragmentShader: `${depthFunctions}\n${shading}\n`
      + `
void main() {
  vec2 uv = v_textureCoordinates;
  // The ray is rebuilt in the local frame so the atmosphere and cloud integrals share one
  // origin; eyeToLocal is the atmosphere's local frame supplied by EnvironmentRenderer.
  vec3 eyeDirection = ccrViewDirection(uv);
  vec3 localDirection = normalize((eyeToLocal * vec4(eyeDirection, 0.0)).xyz);
  vec3 localOrigin = (eyeToLocal * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  float distance = sceneDistance(uv);
  vec3 sceneColor = texture(originalHdr, uv).rgb;

  // The reference integrates in a planet-centred frame and derives altitude as
  // length(position) - planetRadius. eyeToLocal produces an ENU frame whose origin sits on the
  // ellipsoid, so feeding it in directly measures the distance from the planet centre to a point
  // near the surface (measured: -2205 m at the campus latitude, +7237 m at the equator). The
  // ENU-to-ECEF transform is applied here to put both the origin and the direction in the frame
  // the integral expects.
  vec3 ecefOrigin = (enuToEcef * vec4(localOrigin, 1.0)).xyz;
  vec3 ecefDirection = normalize((enuToEcef * vec4(localDirection, 0.0)).xyz);

  vec3 transmittance = vec3(1.0);
  // ccrAtmosphere already composites the scene extinction, so it returns the scene colour for a
  // miss and L_scatter + L_scene * T otherwise. Only the cloud layer is composited here.
  vec3 atmosphere = ccrAtmosphere(ecefOrigin, ecefDirection, distance, sceneColor, transmittance);
  vec4 clouds = ccrClouds(ecefOrigin, ecefDirection, distance);

  // Composite the cloud over the atmosphere-composited background, then apply atmospheric
  // extinction to the cloud contribution so the haze sits in front of both.
  vec3 color = atmosphere + clouds.rgb * transmittance;
  float alpha = clouds.a;
  out_FragColor = vec4(color, alpha);
}
`,
    uniforms: rayUniforms,
    textureScale: RENDER_SCALE,
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(0, 0, 0, 0)
  })

  const effectSize = new C.Cartesian2()
  const resolveStage = new C.PostProcessStage({
    name: `environment_resolve_${id}`,
    fragmentShader: `
in vec2 v_textureCoordinates;
uniform sampler2D originalHdr;
uniform sampler2D environmentColor;
uniform bool shellEmptyScene;
uniform vec2 sourceSize;
uniform vec2 effectSize;

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 original = texture(originalHdr, uv);
  // environmentColor is rendered at RENDER_SCALE, so sample it with the unscaled uv.
  vec4 environment = texture(environmentColor, uv);
  // The march already applied atmospheric extinction to the scene, so the environment colour is
  // additive over the original scene colour.
  out_FragColor = vec4(original.rgb + environment.rgb * original.a, original.a);
}
`,
    uniforms: {
      originalHdr: uniforms.originalHdr,
      environmentColor: () => raymarchStage.outputTexture,
      sourceSize: uniforms.sourceSize,
      shellEmptyScene: uniforms.shellEmptyScene,
      effectSize: () => {
        const size = typeof uniforms.sourceSize === 'function' ? uniforms.sourceSize() : uniforms.sourceSize
        effectSize.x = Math.ceil(size.x * RENDER_SCALE)
        effectSize.y = Math.ceil(size.y * RENDER_SCALE)
        return effectSize
      }
    },
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST
  })

  const composite = new C.PostProcessStageComposite({
    name: `environment_${id}`,
    stages: [raymarchStage, resolveStage],
    inputPreviousStageTexture: true
  })

  // B08/B09 medium data. Contract: RGBA32F half-res with
  //   r = sun medium transmittance, g = sun visibility, b = view medium transmittance.
  // It stays outside the composite: its output is intermediate data, not scene colour.
  const occlusionStage = new C.PostProcessStage({
    name: `environment_occlusion_${id}`,
    fragmentShader: `${depthFunctions}\n${shading}\n`
      + `
void main() {
  vec2 uv = v_textureCoordinates;
  vec3 eyeDirection = ccrViewDirection(uv);
  vec3 direction = normalize((eyeToLocal * vec4(eyeDirection, 0.0)).xyz);
  vec3 origin = (eyeToLocal * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  float distance = min(sceneDistance(uv), 50000.0);
  // View transmittance: march a coarse set of samples and accumulate the analytic medium only.
  vec3 viewDepth = vec3(0.0);
  float steps = 24.0;
  for (int i = 0; i < 24; i++) {
    vec3 position = origin + direction * ((float(i) + 0.5) / steps * distance);
    vec3 density;
    ccrAtmosphereDensity(length(position) - atmosphereParams.x, density);
    viewDepth += density * (distance / steps);
  }
  vec3 viewTransmittance = exp(-(viewDepth.x * CCR_RAYLEIGH_BETA + viewDepth.y * CCR_MIE_BETA
    + viewDepth.z * CCR_ABSORPTION_BETA));

  // Sun transmittance and the cloud's shadowing of the sun, which B09 consumes for light shafts.
  vec3 sunTransmittance = vec3(1.0);
  vec2 sunHit = ccrAtmosphereIntersect(origin, sunDirectionAtmo, atmosphereParams.y);
  float sunDistance = max(sunHit.y, 0.0);
  vec3 sunDepth = vec3(0.0);
  float sunSteps = 12.0;
  for (int i = 0; i < 12; i++) {
    vec3 position = origin + sunDirectionAtmo * ((float(i) + 0.5) / sunSteps * sunDistance);
    vec3 density;
    ccrAtmosphereDensity(length(position) - atmosphereParams.x, density);
    sunDepth += density * (sunDistance / sunSteps);
  }
  sunTransmittance = exp(-(sunDepth.x * CCR_RAYLEIGH_BETA + sunDepth.y * CCR_MIE_BETA
    + sunDepth.z * CCR_ABSORPTION_BETA));
  float cloudShadow = ccrCloudSunVisibility(origin);

  out_FragColor = vec4(sunTransmittance.r * cloudShadow, cloudShadow, viewTransmittance.r, 1.0);
}
`,
    uniforms: rayUniforms,
    textureScale: RENDER_SCALE,
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(1, 1, 1, 1)
  })

  return { id, composite, raymarchStage, resolveStage, occlusionStage }
}

export { ATMOSPHERE_RADIUS_M, PLANET_RADIUS_M, RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT }
