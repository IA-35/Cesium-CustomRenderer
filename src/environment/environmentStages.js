/**
 * Environment stages: atmosphere scattering + volumetric clouds.
 *
 * Replaces the previous noise-integrated height fog and cloud solver. The rewrite follows the
 * reference article's approach:
 *   https://www.liaomz.top/2025/02/13/cesium-zhong-shi-xian-ti-ji-yun-he-da-qi-mei-hua-xiao-guo/
 *   https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/
 *
 * Atmosphere density is analytic; cloud view/light paths share prepared Perlin-Worley density.
 * Source radiance and spectral transmission are reconstructed separately from scene albedo.
 *
 * The returned shape is unchanged so EnvironmentRenderer and HdrEnvironmentPass143 keep working:
 *   { id, composite, raymarchStage, resolveStage, occlusionStage }
 * `occlusionStage` still publishes the B08/B09 contract:
 *   RGBA32F half-res, r = sun medium transmittance, g = sun visibility, b = view transmittance.
 */
import { atmosphereGLSL, ATMOSPHERE_RADIUS_M, PLANET_RADIUS_M, RAYLEIGH_SCALE_HEIGHT,
  MIE_SCALE_HEIGHT } from './atmosphereScattering143.js'
import { cloudGLSL } from './volumetricClouds143.js'
import { cloudShadowGLSL } from './cloudShadow143.js'
import { environmentFogGLSL } from './environmentFog143.js'
import { nightAtmosphereGLSL } from './nightLighting143.js'

let nextId = 0

const EARTH_RADIUS = 6371008.8

// Legacy diagnostic codec only. Production reconstructs a separate FLOAT RGB T
// target: 6.1% spacing between these optical-depth levels is visible at twilight.
// The existing RGBA32F target has room for RGB radiance plus one float. Encode
// three log-transmittance bytes in its exact 24-bit integer range; decode before
// filtering. Optical-depth quantization has <=3.2% relative transmission error.
export const transmittanceCodecGLSL = `
float ccrPackTransmittance(vec3 value) {
  vec3 q = floor(clamp(-log(max(value, vec3(1e-7))) * (254.0 / 16.0), vec3(0.0), vec3(254.0)) + 0.5);
  q = mix(q, vec3(255.0), lessThanEqual(value, vec3(1e-7)));
  return dot(q, vec3(65536.0, 256.0, 1.0));
}
vec3 ccrUnpackTransmittance(float packed) {
  vec3 q = vec3(floor(packed / 65536.0), floor(mod(packed, 65536.0) / 256.0), mod(packed, 256.0));
  return mix(exp(-q * (16.0 / 254.0)), vec3(0.0), greaterThanEqual(q, vec3(255.0)));
}
`

// Fraction of the frame the environment pass renders at. Clouds and atmosphere are low
// frequency compared with the scene, so half resolution plus the resolve upscale is enough and
// keeps the cost bounded independently of the viewport size.
//
// Overridable from the page for diagnosis only (window.CCR_ENV_SCALE = 1 disables the downscale);
// the shipped value is 0.5.
export function environmentScale() {
  const override = Number(globalThis?.CCR_ENV_SCALE)
  return Number.isFinite(override) && override > 0 && override <= 1 ? override : 0.5
}

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
  if (shellEmptyScene) return DEPTH_LIMIT;
  // The packed globe copy is captured before independent OPAQUE GLBs. The
  // final scene depth contains those foreground buildings; compare both in
  // metres so distant terrain/Tiles cannot replace a nearer opaque receiver.
  float distance = depthDistance(uv, texture(depthTexture, uv).r);
  if (surfaceDepthAvailable) {
    float raw = czm_unpackDepth(texture(surfaceDepthTexture, uv));
    distance = min(distance, depthDistance(uv, raw));
  }
  return distance;
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
  const renderScale = environmentScale()
  const tier = quality === 'high' ? 'high' : quality === 'performance' ? 'performance' : 'balanced'

  // Cloud lighting reads the analytic sky and sun so the cloud colour tracks the atmosphere.
  const radianceHelpers = `
vec3 ccrSkyRadiance() { return skyRadiance; }
vec3 ccrSunRadiance() { return sunRadiance; }
`
  // Order matters: GLSL requires every uniform to be declared before use, so the shared
  // declarations come first and the scattering and cloud modules follow.
  const sharedDeclarations = `
precision highp sampler2D;
// Cesium post-process stages do not inject the texture coordinate varying; the stage must
// declare it. GLSL ES 3.00 uses the in qualifier for stage inputs, and the legacy varying
// qualifier is a reserved word there, so the WebGL2 build fails if it is used.
in vec2 v_textureCoordinates;

// Declared here rather than in the scattering/cloud modules because they are read directly by
// each stage's main(): eyeToLocal frames the ray, and the two radiance terms light the cloud.
uniform mat4 eyeToLocal;
uniform vec4 effectFlags;
uniform sampler2D originalHdr;
uniform vec3 skyRadiance;
uniform vec3 sunRadiance;
uniform float environmentSkyScale;

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
  const useLut=!!uniforms.atmosphereLutReady
  const shading = `${uboDefine}${sharedDeclarations}\n${atmosphereGLSL(tier,{lut:useLut})}\n${radianceHelpers}\n${cloudGLSL(tier)}\n${environmentFogGLSL}\n${nightAtmosphereGLSL}`

  const rayUniforms = {}
  for (const name of ['eyeToLocal', 'atmosphereOrigin', 'cloudNoiseOrigin', 'effectFlags', 'originalHdr', 'sunDirectionLocal', 'sunRadiance', 'skyRadiance',
    'atmosphereSunRadiance', 'atmosphereMieParameters', 'moonDirectionAtmo', 'moonRadiance', 'nightSkyRadiance', 'cloudParams', 'cloudModel', 'cloudFrame', 'cloudWind',
    'cloudWeatherOffset','cloudShapeOffset','cloudDetailOffset', 'cloudHorizonBlend', 'noiseTexture', 'sourceSize',
    'surfaceDepthTexture', 'surfaceDepthAvailable', 'shellEmptyScene', 'atmosphereParams', 'surfaceHeight',
    'fogParams','fogBaseHeight','atmosphereLutReady','environmentSkyScale',...Object.keys(uniforms).filter(name=>name.startsWith('u_lut')||name.startsWith('u_atmosphere'))]) {
    if (uniforms[name] !== undefined) rayUniforms[name] = uniforms[name]
  }
  rayUniforms.shellEmptyScene ||= () => false
  rayUniforms.cloudModel ||= () => 0
  rayUniforms.cloudFrame ||= () => new C.Cartesian2(0,0)
  rayUniforms.cloudHorizonBlend ||= () => 0
  rayUniforms.fogParams ||= () => C.Cartesian4?.ZERO || {x:0,y:1,z:0,w:0}
  rayUniforms.fogBaseHeight ||= () => 0
  rayUniforms.environmentSkyScale ||= () => 1
  rayUniforms.moonDirectionAtmo ||= () => C.Cartesian3.UNIT_Z
  rayUniforms.moonRadiance ||= () => C.Cartesian3.ZERO
  rayUniforms.nightSkyRadiance ||= () => C.Cartesian3.ZERO
  for(const name of ['cloudWeatherOffset','cloudShapeOffset','cloudDetailOffset']) rayUniforms[name] ||= () => new C.Cartesian3(0,0,0)
  // The cloud march reads its own wind offset; expose it under the name the shader declares.
  if (uniforms.windOffset !== undefined && rayUniforms.cloudWind === undefined) {
    rayUniforms.cloudWind = uniforms.windOffset
  }
  // The atmosphere and cloud marches both need the sun in the same local frame the ray uses.
  const sunSource = uniforms.sunDirectionLocal
  rayUniforms.sunDirectionAtmo = () => typeof sunSource === 'function' ? sunSource() : sunSource
  // Validate the shader's uniform contract up front. A missing binding would otherwise surface
  // as a driver compile error inside the render loop, where the cause is hard to see.
  const required = ['eyeToLocal', 'atmosphereOrigin', 'cloudNoiseOrigin', 'effectFlags', 'originalHdr', 'sunDirectionAtmo', 'atmosphereSunRadiance', 'atmosphereMieParameters', 'sunRadiance', 'skyRadiance', 'cloudParams', 'cloudWind', 'noiseTexture', 'atmosphereParams']
  const missing = required.filter(name => rayUniforms[name] === undefined)
  if (missing.length) throw new Error(`environment stages missing uniforms: ${missing.join(', ')}`)

  const floatStage = (name, fragmentShader, stageUniforms = rayUniforms, scale = renderScale) => new C.PostProcessStage({
    name: `environment_${name}_${id}`, fragmentShader, uniforms: stageUniforms, textureScale: scale,
    pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST
  })
  const cloudRay = `
  vec2 uv = v_textureCoordinates;
  vec3 direction = normalize((eyeToLocal * vec4(ccrViewDirection(uv), 0.0)).xyz);
  float distance = sceneDistance(uv);
  vec2 ground = ccrAtmosphereIntersect(atmosphereOrigin, direction, atmosphereParams.x);
  if (ground.y >= ground.x && ground.x > 0.0) distance = min(distance, ground.x);
`
  const cloudStage = floatStage('clouds', `${shading}\n${depthFunctions}
void main() { ${cloudRay}
  out_FragColor = effectFlags.y > 0.5 ? ccrClouds(atmosphereOrigin,direction,distance) : vec4(0.0,0.0,0.0,1.0);
}`)
  const cloudDepthStage = floatStage('cloud_depth', `${shading}\n${depthFunctions}
uniform sampler2D cloudCurrent;
void main() { ${cloudRay}
  vec2 geometry = effectFlags.y > 0.5 ? ccrCloudGeometry(atmosphereOrigin,direction,distance) : vec2(DEPTH_LIMIT,1.0);
  // Use the authoritative current T. Separate lit/depth programs may lower
  // floating-point density arithmetic differently on long grazing rays.
  if(effectFlags.y>0.5) geometry.y=texture(cloudCurrent,uv).a;
  if(geometry.y >= 0.99999) geometry.x = DEPTH_LIMIT;
  out_FragColor = vec4(geometry,0.0,1.0);
}`,{...rayUniforms,cloudCurrent:()=>cloudStage.outputTexture})
  // Independent cloud data is rendered before atmosphere composition and scene TAA.
  const cloudComposite = new C.PostProcessStageComposite({ name:`environment_cloud_data_${id}`,
    stages:[cloudStage,cloudDepthStage],inputPreviousStageTexture:false })
  rayUniforms.cloudColor = uniforms.cloudColor || (() => cloudStage.outputTexture)
  rayUniforms.cloudDepth = uniforms.cloudDepth || (() => cloudDepthStage.outputTexture)
  const cloudInputs = `uniform sampler2D cloudColor; uniform sampler2D cloudDepth;`
  const fogHelpers = `
float ccrFogNoise(vec3 origin,vec3 direction,float distance) {
  if(effectFlags.w<0.5 || fogParams.z<=0.0) return 0.5;
  vec3 point=origin-atmosphereOrigin+cloudNoiseOrigin+direction*(distance*0.5);
  return ccrCloudNoise3D(point*(64.0/4000.0)).b;
}
vec4 ccrSegmentFog(vec3 origin,vec3 direction,float distance,float noiseSample) {
  vec3 source=skyRadiance;
#ifdef CCR_ATMOSPHERE_LUT
  if(atmosphereLutReady) source=ccrLutSkyIrradiance(origin,sunDirectionAtmo)
    *atmosphereSunRadiance*(environmentSkyScale/3.14159265359);
#endif
  source+=nightSkyRadiance;
  return ccrSphericalFogTransport(origin,direction,atmosphereParams.x,distance,source,noiseSample);
}
vec3 ccrSceneMedium(vec3 origin,vec3 direction,float distance,vec3 background,
    bool atmosphereEnabled,bool fogEnabled,float noiseSample,inout vec3 transmittance) {
  vec3 color=atmosphereEnabled?ccrAtmosphereScene(origin,direction,distance,background,transmittance):background;
  if(atmosphereEnabled) color+=ccrNightAtmosphere(origin,direction,distance);
  if(!atmosphereEnabled) transmittance=vec3(1.0);
  if(fogEnabled) {
    vec4 fog=ccrSegmentFog(origin,direction,distance,noiseSample);
    color=fog.rgb+fog.a*color;transmittance*=fog.a;
  }
  return color;
}
`

  const raymarchStage = new C.PostProcessStage({
    name: `environment_raymarch_${id}`,
    // Order matters: shading first, because depthFunctions references macros that the atmosphere
    // module defines (CCR_ATMOSPHERE_RAY_LIMIT) and GLSL preprocesses top to bottom.
    fragmentShader: `${shading}\n${depthFunctions}\n${cloudInputs}\n${fogHelpers}\n${transmittanceCodecGLSL}\n`
      + `
void main() {
  vec2 uv = v_textureCoordinates;
  vec3 eyeDirection = ccrViewDirection(uv);
  vec3 direction = normalize((eyeToLocal * vec4(eyeDirection, 0.0)).xyz);
  vec3 origin = atmosphereOrigin;
  float distance = sceneDistance(uv);
  bool finiteSurface = distance < DEPTH_LIMIT;
  // Clip to the ground and top shell in the integral, not to twice the shell thickness:
  // a near-horizontal sky ray can travel over 1000 km through a 100 km atmosphere.
  vec2 ground = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x);
  if (ground.y >= ground.x && ground.x > 0.0) distance = min(distance, ground.x);
  // Integrate source radiance without scene albedo. The full-resolution scene is
  // attenuated later; its colour must not contaminate a low-resolution medium sample.
  vec3 sceneColor = vec3(0.0);
  float cloudDistance = distance;
  vec4 clouds = vec4(0.0, 0.0, 0.0, 1.0);
  if (effectFlags.y > 0.5) {
    clouds = texture(cloudColor,uv);
    cloudDistance = min(texture(cloudDepth,uv).r,distance);
  }
  bool atmosphereEnabled = effectFlags.z > 0.5;
  bool fogEnabled=finiteSurface&&(effectFlags.x>0.5||effectFlags.w>0.5);
  float noiseSample=fogEnabled?ccrFogNoise(origin,direction,distance):0.5;
  vec3 transmittance = vec3(1.0);
  vec3 sceneTransmittance = vec3(1.0);
  vec3 color = sceneColor;
  if (clouds.a < 1.0) {
    // Approximate the integrated cloud as a layer at its weighted extinction depth. Haze behind
    // the cloud is occluded by its T; haze in front attenuates its radiance separately.
    vec3 background = ccrSceneMedium(origin + direction * cloudDistance,
      direction, max(distance - cloudDistance, 0.0), sceneColor,atmosphereEnabled,fogEnabled,noiseSample,transmittance);
    sceneTransmittance = clouds.a * transmittance;
    color = clouds.rgb + clouds.a * background;
    color = ccrSceneMedium(origin,direction,cloudDistance,color,atmosphereEnabled,fogEnabled,noiseSample,transmittance);
    sceneTransmittance *= transmittance;
  } else if (atmosphereEnabled || fogEnabled) {
    color = ccrSceneMedium(origin,direction,distance,sceneColor,atmosphereEnabled,fogEnabled,noiseSample,transmittance);
#ifdef CCR_ATMOSPHERE_LUT
    // SkyView is generated for this camera altitude. Cloud-split segments above
    // use the short view integral because their origins have different heights.
    if(!finiteSurface && atmosphereEnabled && atmosphereLutReady) color=ccrLutSkyView(origin,direction,sunDirectionAtmo)*atmosphereSunRadiance
      +ccrNightAtmosphere(origin,direction,distance);
#endif
    sceneTransmittance = transmittance;
  }
  out_FragColor = vec4(color, ccrPackTransmittance(sceneTransmittance));
}
`,
    uniforms: rayUniforms,
    textureScale: renderScale,
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(0, 0, 0, 0)
  })

  const transmissionStage = floatStage('transmission', `${shading}\n${depthFunctions}\n${cloudInputs}\n${fogHelpers}
void main() { ${cloudRay}
  bool finiteSurface=sceneDistance(uv)<DEPTH_LIMIT;
  bool atmosphereEnabled = effectFlags.z > 0.5;
  bool fogEnabled=finiteSurface&&(effectFlags.x>0.5||effectFlags.w>0.5);
  float noiseSample=fogEnabled?ccrFogNoise(atmosphereOrigin,direction,distance):0.5;
  vec3 transmission = vec3(1.0);
  vec4 clouds = effectFlags.y > 0.5 ? texture(cloudColor,uv) : vec4(0.0,0.0,0.0,1.0);
  if(atmosphereEnabled) {
    if(clouds.a < 1.0) {
      float cloudDistance = min(texture(cloudDepth,uv).r,distance);
      transmission = ccrAtmosphereViewTransmission(atmosphereOrigin,direction,cloudDistance)
        * ccrAtmosphereViewTransmission(atmosphereOrigin+direction*cloudDistance,direction,max(distance-cloudDistance,0.0));
    } else transmission = ccrAtmosphereViewTransmission(atmosphereOrigin,direction,distance);
  }
  if(fogEnabled) {
    if(clouds.a<1.0) {
      float cloudDistance=min(texture(cloudDepth,uv).r,distance);
      transmission*=ccrSegmentFog(atmosphereOrigin,direction,cloudDistance,noiseSample).a
        *ccrSegmentFog(atmosphereOrigin+direction*cloudDistance,direction,max(distance-cloudDistance,0.0),noiseSample).a;
    } else transmission*=ccrSegmentFog(atmosphereOrigin,direction,distance,noiseSample).a;
  }
  out_FragColor = vec4(transmission * clouds.a,1.0);
}`)

  const effectSize = new C.Cartesian2()
  const resolveStage = new C.PostProcessStage({
    name: `environment_resolve_${id}`,
    fragmentShader: `
${shading}
uniform sampler2D environmentColor;
uniform sampler2D environmentTransmission;
uniform vec2 effectSize;
${depthFunctions}
${cloudShadowGLSL()}

vec3 ccrReceiverPosition(vec2 uv) {
  vec3 direction = normalize((eyeToLocal * vec4(ccrViewDirection(uv),0.0)).xyz);
  return direction * min(sceneDistance(uv),100000.0);
}

// Hardware derivatives span 2x2 quads and can cross a roof/background depth
// discontinuity. Pick the closer surface neighbour on each axis so silhouettes
// retain their own normal and receive the same shadow as the rest of the face.
vec3 ccrCloudReceiverNormal(vec2 uv, vec3 center, vec3 viewDirection) {
  vec2 pixel = 1.0 / sourceSize;
  vec2 low = pixel * 0.5, high = 1.0 - low;
  vec3 left = center - ccrReceiverPosition(clamp(uv-vec2(pixel.x,0.0),low,high));
  vec3 right = ccrReceiverPosition(clamp(uv+vec2(pixel.x,0.0),low,high)) - center;
  vec3 down = center - ccrReceiverPosition(clamp(uv-vec2(0.0,pixel.y),low,high));
  vec3 up = ccrReceiverPosition(clamp(uv+vec2(0.0,pixel.y),low,high)) - center;
  vec3 dx = dot(left,left)<dot(right,right) ? left : right;
  vec3 dy = dot(down,down)<dot(up,up) ? down : up;
  vec3 normal = cross(dx,dy);
  normal = length(normal)>1e-6 ? normalize(normal) : normalize(atmosphereOrigin+center);
  return dot(normal,-viewDirection)<0.0 ? -normal : normal;
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 original = texture(originalHdr, uv);
  // Reconstruct radiance and spectral transmission separately, rejecting depth edges.
  vec2 grid = uv * effectSize - 0.5;
  vec2 base = floor(grid), f = fract(grid);
  float centerDepth = sceneDistance(uv);
  vec3 radiance = vec3(0.0), transmittance = vec3(0.0);
  float totalWeight = 0.0;
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    vec2 offset = vec2(float(x), float(y));
    vec2 sampleUv = clamp((base + offset + 0.5) / effectSize, vec2(0.0), vec2(1.0));
    float sampleDepth = sceneDistance(sampleUv);
    bool compatible = (centerDepth < DEPTH_LIMIT) == (sampleDepth < DEPTH_LIMIT);
    float depthWeight = compatible ? exp(-abs(centerDepth - sampleDepth) / max(25.0, centerDepth * 0.02)) : 0.0;
    vec2 weights = mix(1.0 - f, f, offset);
    float weight = weights.x * weights.y * depthWeight;
    vec4 sampleMedium = texture(environmentColor, sampleUv);
    radiance += sampleMedium.rgb * weight;
    transmittance += texture(environmentTransmission,sampleUv).rgb * weight;
    totalWeight += weight;
  }
  radiance = totalWeight > 1e-6 ? radiance / totalWeight : vec3(0.0);
  transmittance = totalWeight > 1e-6 ? transmittance / totalWeight : vec3(1.0);
  vec3 direction = normalize((eyeToLocal * vec4(ccrViewDirection(uv),0.0)).xyz);
  vec3 relativeSurface = direction * min(centerDepth,100000.0);
  vec3 normal = ccrCloudReceiverNormal(uv,relativeSurface,direction);
  vec3 surface = original.rgb;
  if(effectFlags.y > 0.5) surface *= ccrCloudSurfaceTransmission(atmosphereOrigin+relativeSurface,
    normal,centerDepth,50000.0,centerDepth<DEPTH_LIMIT,sunRadiance,3.14159265359*skyRadiance);
  out_FragColor = vec4(radiance + surface * transmittance, original.a);
}
`,
    uniforms: {
      ...rayUniforms,
      environmentColor: () => raymarchStage.outputTexture,
      environmentTransmission: () => transmissionStage.outputTexture,
      sourceSize: uniforms.sourceSize,
      shellEmptyScene: rayUniforms.shellEmptyScene,
      surfaceDepthTexture: uniforms.surfaceDepthTexture,
      surfaceDepthAvailable: uniforms.surfaceDepthAvailable,
      effectSize: () => {
        const texture = raymarchStage.outputTexture
        if (texture) { effectSize.x = texture.width; effectSize.y = texture.height; return effectSize }
        const size = typeof uniforms.sourceSize === 'function' ? uniforms.sourceSize() : uniforms.sourceSize
        effectSize.x = Math.ceil(size.x * renderScale)
        effectSize.y = Math.ceil(size.y * renderScale)
        return effectSize
      }
    },
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST
  })

  const composite = new C.PostProcessStageComposite({
    name: `environment_${id}`,
    stages: [raymarchStage, transmissionStage, resolveStage],
    inputPreviousStageTexture: true
  })

  // B08/B09 medium data. Contract: RGBA32F half-res with
  //   r = sun medium transmittance, g = sun visibility, b = view medium transmittance.
  // It stays outside the composite: its output is intermediate data, not scene colour.
  const occlusionStage = new C.PostProcessStage({
    name: `environment_occlusion_${id}`,
    fragmentShader: `${shading}\n${depthFunctions}\n${fogHelpers}\n`
      + `
void main() {
  vec2 uv = v_textureCoordinates;
  vec3 eyeDirection = ccrViewDirection(uv);
  vec3 direction = normalize((eyeToLocal * vec4(eyeDirection, 0.0)).xyz);
  vec3 origin = atmosphereOrigin;

  bool finiteSurface=sceneDistance(uv)<DEPTH_LIMIT;
  float distance = min(sceneDistance(uv), 50000.0);
  vec2 ground = ccrAtmosphereIntersect(origin, direction, atmosphereParams.x);
  if (ground.x > 0.0) distance = min(distance, ground.x);
  vec2 shell = ccrAtmosphereIntersect(origin, direction, atmosphereParams.y);
  distance = min(distance, max(shell.y, 0.0));
  // The medium consumer reads the same committed gas as colour/T. In particular,
  // a failed LUT update must not mix new weather density into old published LUTs.
  vec3 viewTransmittance=ccrAtmosphereViewTransmission(origin,direction,distance);
  if(effectFlags.z<0.5)viewTransmittance=vec3(1.0);
  if(finiteSurface&&(effectFlags.x>0.5||effectFlags.w>0.5))viewTransmittance*=
    ccrSegmentFog(origin,direction,distance,ccrFogNoise(origin,direction,distance)).a;

  // Sun transmittance and the cloud's shadowing of the sun, which B09 consumes for light shafts.
  vec3 sunTransmittance = vec3(1.0);
  vec2 sunHit = ccrAtmosphereIntersect(origin, sunDirectionAtmo, atmosphereParams.y);
  float sunDistance = max(sunHit.y, 0.0);
  sunTransmittance = ccrAtmosphereLightTransmittance(origin, sunDirectionAtmo,
    sunDistance / float(ATMOS_LIGHT_STEPS));
  float cloudShadow = effectFlags.y > 0.5 ? ccrCloudSunVisibility(origin) : 1.0;

  out_FragColor = vec4(sunTransmittance.r * cloudShadow, cloudShadow, viewTransmittance.r, 1.0);
}
`,
    uniforms: rayUniforms,
    textureScale: renderScale,
    pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(1, 1, 1, 1)
  })

  return { id, composite, raymarchStage, transmissionStage, resolveStage, occlusionStage,
    cloudComposite, cloudStage, cloudDepthStage }
}

export { ATMOSPHERE_RADIUS_M, PLANET_RADIUS_M, RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT }
