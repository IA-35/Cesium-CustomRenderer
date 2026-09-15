import { cloudShellGLSL } from './cloudShell143.js'

let nextId = 0

const depthFunctions = `
#ifdef CLOUD_SHELL
#define DEPTH_LIMIT 20000000.0
uniform bool shellEmptyScene;
#else
#define DEPTH_LIMIT 50000.0
#endif
uniform sampler2D depthTexture;
uniform highp sampler2D surfaceDepthTexture;
uniform bool surfaceDepthAvailable;
uniform vec2 sourceSize;

float depthDistance(vec2 uv, float rawDepth) {
  if (!(rawDepth > 0.0 && rawDepth < 1.0)) return DEPTH_LIMIT;
  // The builtin divides by this active viewport; normalize back to uv before
  // applying the unchanged main-camera inverseProjection, even in the half-size pass.
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth);
  if (abs(eye.w) < 1.0e-12) return DEPTH_LIMIT;
  return min(length(eye.xyz / eye.w), DEPTH_LIMIT);
}

float sceneDistance(vec2 uv) {
#ifdef CLOUD_SHELL
  if (shellEmptyScene) return DEPTH_LIMIT;
#endif
  float distance = depthDistance(uv, texture(depthTexture, uv).r);
  // With terrain depth testing disabled Cesium clears the hardware globe depth
  // and replaces it with a horizon plane. Its packed copy retains the visible
  // surface (including 3D Tiles). Never march fog/shadow samples behind it.
  if (surfaceDepthAvailable) {
    float surfaceDepth = czm_unpackDepth(texture(surfaceDepthTexture, uv));
    distance = min(distance, depthDistance(uv, surfaceDepth));
  }
  return distance;
}
`

const raymarchShader = `
in vec2 v_textureCoordinates;
uniform mat4 eyeToLocal;
uniform vec3 sunDirectionLocal;
uniform vec3 sunRadiance;
uniform vec3 skyRadiance;
uniform vec4 fogParams;
uniform float fogBaseHeight;
uniform vec4 cloudParams;
uniform vec2 windOffset;
uniform float cloudModel;
uniform vec4 effectFlags;
uniform highp sampler2D noiseTexture;
uniform sampler2D shadowTexture;
uniform mat4 localToShadow;
uniform vec4 shadowInfo;
${depthFunctions}
#ifdef CLOUD_SHELL
${cloudShellGLSL}
#endif

float noiseVoxel(ivec3 p) {
  p = ivec3(mod(vec3(p), 64.0));
  ivec2 tile = ivec2(p.z % 8, p.z / 8) * 66;
  return texelFetch(noiseTexture, tile + p.xy + 1, 0).r;
}

float noise3D(vec3 point) {
#ifdef CLOUD_SHELL
  // Interpolate explicit lattice values. Atlas filtering at slice boundaries
  // must not introduce discontinuities amplified by long shell integrations.
  vec3 p = mod(point, 64.0);
  ivec3 base = ivec3(floor(p));
  vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(noiseVoxel(base), noiseVoxel(base + ivec3(1,0,0)), f.x);
  float b = mix(noiseVoxel(base + ivec3(0,1,0)), noiseVoxel(base + ivec3(1,1,0)), f.x);
  float c = mix(noiseVoxel(base + ivec3(0,0,1)), noiseVoxel(base + ivec3(1,0,1)), f.x);
  float d = mix(noiseVoxel(base + ivec3(0,1,1)), noiseVoxel(base + ivec3(1,1,1)), f.x);
  return mix(mix(a,b,f.y), mix(c,d,f.y), f.z);
#else
  vec3 p = mod(point, 64.0);
  vec3 fraction = fract(p);
  p = mod(floor(p) + fraction * fraction * (3.0 - 2.0 * fraction), 64.0);
  float slice = floor(p.z);
  float nextSlice = mod(slice + 1.0, 64.0);
  vec2 tile0 = vec2(mod(slice, 8.0), floor(slice / 8.0));
  vec2 tile1 = vec2(mod(nextSlice, 8.0), floor(nextSlice / 8.0));
  // The first interior lattice texel is centered at tile + 1.5.
  vec2 uv0 = (tile0 * 66.0 + p.xy + 1.5) / 528.0;
  vec2 uv1 = (tile1 * 66.0 + p.xy + 1.5) / 528.0;
  return mix(texture(noiseTexture, uv0).r, texture(noiseTexture, uv1).r, fract(p.z));
#endif
}

float phaseHG(float mu) {
  const float g = 0.55;
  return (1.0 - g * g) / (12.566370614 * pow(max(1.0 + g * g - 2.0 * g * mu, 0.01), 1.5));
}

float sunVisibility(vec3 p) {
  if (shadowInfo.x < 0.5) return 1.0;
  vec4 clip = localToShadow * vec4(p, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 uvz = clip.xyz / clip.w * 0.5 + 0.5;
  if (any(lessThan(uvz, vec3(0.0))) || any(greaterThan(uvz, vec3(1.0)))) return 1.0;
  float visibility = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 offset = (vec2(float(x), float(y)) - 0.5) * shadowInfo.y;
      float stored = texture(shadowTexture, uvz.xy + offset).r;
      visibility += step(uvz.z - shadowInfo.z, stored);
    }
  }
  return visibility * 0.25;
}

vec4 integrateFog(vec3 origin, vec3 direction, float limit, float phase) {
  vec4 integrated = vec4(0.0, 0.0, 0.0, 1.0);
  float start = max(fogParams.w, 0.0);
  if (effectFlags.x < 0.5 || fogParams.x <= 0.0 || limit <= start) return integrated;
  float previous = start;
  for (int i = 0; i < FOG_STEPS; i++) {
    float fraction = float(i + 1) / float(FOG_STEPS);
    float next = mix(start, limit, fraction * fraction);
    float stepLength = next - previous;
    vec3 p = origin + direction * (previous + next) * 0.5;
    float density = fogParams.x * exp(clamp(-(p.z - fogBaseHeight) / max(fogParams.y, 1.0), -30.0, 4.0));
    if (effectFlags.w > 0.5 && fogParams.z > 0.0) {
      float n = noise3D(vec3(p.xy + windOffset, p.z) / 250.0);
      density *= mix(1.0, n * 2.0, clamp(fogParams.z, 0.0, 1.0));
    }
    float transmission = exp(-density * stepLength);
    vec3 lighting = skyRadiance * 0.35 + sunRadiance * phase * effectFlags.z * sunVisibility(p);
    integrated.rgb += integrated.a * (1.0 - transmission) * lighting;
    integrated.a *= transmission;
    previous = next;
    if (integrated.a < 0.01) break;
  }
  return integrated;
}

float cloudDensity(vec3 p) {
  float coverage = cloudParams.x;
  float visibility = 1.0;
#ifdef CLOUD_SHELL
  float height = (shellAltitude(p) - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0);
  visibility = shellDistanceVisibility(p);
  coverage *= visibility;
#else
  float height = (p.z - cloudParams.y) / max(cloudParams.z - cloudParams.y, 1.0);
#endif
  if (height <= 0.0 || height >= 1.0 || coverage <= 0.0) return 0.0;
  vec3 q = vec3(p.xy + windOffset, p.z);
#ifdef CLOUD_SHELL
  q += shellNoiseOrigin;
#endif
  float large = noise3D(q / 1000.0);
  float detail = noise3D(q / 500.0);
  float shape;
  float profile;
  if (cloudModel < 0.5) {
    float threshold = mix(0.85, 0.22, clamp(coverage, 0.0, 1.0));
    shape = smoothstep(threshold, threshold + 0.24, large * 0.75 + detail * 0.25);
    profile = smoothstep(0.0, 0.15, height) * (1.0 - smoothstep(0.55, 1.0, height));
  } else {
    float threshold = mix(0.72, 0.08, clamp(coverage, 0.0, 1.0));
    shape = smoothstep(threshold, threshold + 0.35, 0.3 + large * 0.5 + detail * 0.2);
    profile = smoothstep(0.0, 0.10, height) * (1.0 - smoothstep(0.80, 1.0, height));
  }
  return max(cloudParams.w, 0.0) * shape * profile * visibility;
}

float cloudSunVisibility(vec3 p) {
#ifdef CLOUD_SHELL
  vec2 earth;
  if (shellRoots(p, sunDirectionShell, 0.0, earth) && earth.x > 0.0) return 0.0;
  vec2 exitRoots;
  float distanceToExit = 4000.0;
  if (shellRoots(p, sunDirectionShell, cloudParams.z, exitRoots)) distanceToExit = clamp(exitRoots.y, 0.0, 4000.0);
  vec3 lightDirection = sunDirectionShell;
#else
  float distanceToExit = 4000.0;
  if (abs(sunDirectionLocal.z) > 0.001) {
    float boundary = sunDirectionLocal.z > 0.0 ? cloudParams.z : cloudParams.y;
    distanceToExit = clamp((boundary - p.z) / sunDirectionLocal.z, 0.0, 4000.0);
  }
  vec3 lightDirection = sunDirectionLocal;
#endif
  float stepLength = distanceToExit / 4.0;
  float opticalDepth = 0.0;
  for (int j = 0; j < 4; j++) {
    opticalDepth += cloudDensity(p + lightDirection * (float(j) + 0.5) * stepLength) * stepLength;
  }
  return exp(-opticalDepth);
}

vec4 integrateClouds(vec3 origin, vec3 direction, float limit, float phase) {
  vec4 integrated = vec4(0.0, 0.0, 0.0, 1.0);
  if (effectFlags.y < 0.5 || cloudParams.x <= 0.0 || cloudParams.w <= 0.0) return integrated;
#ifdef CLOUD_SHELL
  float fadeEnd = shellFadeRange().y;
  vec4 intervals = shellIntervals(direction, cloudParams.y, cloudParams.z, min(limit, fadeEnd));
  float firstLength = intervals.y - intervals.x;
  float total = firstLength + intervals.w - intervals.z;
  if (total <= 0.0) return integrated;
  float stepLength = total / float(SHELL_STEPS);
  // Midpoint quadrature is deterministic across neighboring rays. Spatial dither
  // creates isolated bright samples in very thin shell wisps without temporal resolve.
  float jitter = 0.5;
  for (int i = 0; i < SHELL_STEPS; i++) {
    float offset = (float(i) + jitter) * stepLength;
    float distanceAlongRay = offset < firstLength ? intervals.x + offset : intervals.z + offset - firstLength;
    vec3 p = direction * distanceAlongRay;
    float density = cloudDensity(p);
    if (density <= 0.0) continue;
    float transmission = exp(-density * stepLength);
    vec3 lighting = skyRadiance * 0.7 + sunRadiance * phase * effectFlags.z * cloudSunVisibility(p);
    integrated.rgb += integrated.a * (1.0 - transmission) * lighting;
    integrated.a *= transmission;
    if (integrated.a < 0.01) break;
  }
#else
  float start = 0.0;
  float finish = min(limit, CLOUD_MAX_DISTANCE);
  if (abs(direction.z) < 0.00001) {
    if (origin.z < cloudParams.y || origin.z > cloudParams.z) return integrated;
  } else {
    float a = (cloudParams.y - origin.z) / direction.z;
    float b = (cloudParams.z - origin.z) / direction.z;
    start = max(min(a, b), 0.0);
    finish = min(max(a, b), finish);
  }
  if (finish <= start) return integrated;
  float stepLength = (finish - start) / float(CLOUD_STEPS);
  // Static spatial stratification breaks aligned altitude slices without a
  // frame-varying dither or temporal history. The resolve averages neighbouring rays.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < CLOUD_STEPS; i++) {
    float distanceAlongRay = start + (float(i) + jitter) * stepLength;
    vec3 p = origin + direction * distanceAlongRay;
    float density = cloudDensity(p) * (1.0 - smoothstep(CLOUD_MAX_DISTANCE * 0.75, CLOUD_MAX_DISTANCE, distanceAlongRay));
    if (density <= 0.0) continue;
    float transmission = exp(-density * stepLength);
    vec3 lighting = skyRadiance * 0.7 + sunRadiance * phase * effectFlags.z * cloudSunVisibility(p);
    integrated.rgb += integrated.a * (1.0 - transmission) * lighting;
    integrated.a *= transmission;
    if (integrated.a < 0.01) break;
  }
#endif
  return integrated;
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 eyeRay = czm_inverseProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 direction = normalize((eyeToLocal * vec4(eyeRay.xyz / eyeRay.w, 0.0)).xyz);
  vec3 origin = (eyeToLocal * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float distance = sceneDistance(uv);
  float phase = phaseHG(dot(direction, sunDirectionLocal));
  vec4 fog = integrateFog(origin, direction, min(distance, 50000.0), phase);
#ifdef CLOUD_SHELL
  vec3 shellRay = eyeToShell * normalize(eyeRay.xyz / eyeRay.w);
  float shellScale = length(shellRay);
  vec3 shellDirection = shellRay / shellScale;
  vec4 clouds = integrateClouds(vec3(0.0), shellDirection, distance * shellScale, phaseHG(dot(shellDirection, sunDirectionShell)));
  float cameraAltitude = shellRadiusHeight.y;
#else
  vec4 clouds = integrateClouds(origin, direction, distance, phase);
  float cameraAltitude = origin.z;
#endif
  // Separate height regions: order the two integrated layers by camera altitude.
  vec3 light = cameraAltitude < cloudParams.y ? fog.rgb + fog.a * clouds.rgb : clouds.rgb + clouds.a * fog.rgb;
  out_FragColor = vec4(light, fog.a * clouds.a);
}
`

const resolveShader = `
in vec2 v_textureCoordinates;
uniform sampler2D colorTexture;
uniform sampler2D originalHdr;
uniform vec2 effectSize;
${depthFunctions}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 original = texture(originalHdr, uv);
  float centerDistance = sceneDistance(uv);
  vec2 grid = uv * effectSize - 0.5;
  vec2 base = floor(grid);
  vec2 fraction = fract(grid);
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  vec4 closest = vec4(0.0, 0.0, 0.0, 1.0);
  float closestDifference = 1.0e20;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 sampleUv = (clamp(base + offset, vec2(0.0), effectSize - 1.0) + 0.5) / effectSize;
      float sampleDistance = sceneDistance(sampleUv);
      float difference = abs(sampleDistance - centerDistance);
      vec4 value = texture(colorTexture, sampleUv);
      if (difference < closestDifference) { closestDifference = difference; closest = value; }
      vec2 axisWeight = mix(1.0 - fraction, fraction, offset);
      float weight = axisWeight.x * axisWeight.y * exp(-difference / max(2.0, centerDistance * 0.015));
      sum += value * weight;
      weightSum += weight;
    }
  }
  // Thin foreground geometry may have no matching half-size sample. Keep it clear
  // rather than importing a distant cloud sample across that depth discontinuity.
  vec4 fallback = closestDifference < max(4.0, centerDistance * 0.05)
    ? closest : vec4(0.0, 0.0, 0.0, 1.0);
  vec4 integrated = weightSum > 0.00001 ? sum / weightSum : fallback;
  out_FragColor = vec4(original.rgb * integrated.a + integrated.rgb, original.a);
}
`

export function createEnvironmentStages(C, uniforms, quality = 'balanced', geometry = 'local') {
  const id = ++nextId
  const high = quality === 'high'
  const scale = 0.5
  const rayUniforms = {}
  const shellDefines = geometry === 'shell' ? `#define CLOUD_SHELL\n#define SHELL_STEPS ${high ? 192 : 128}\n` : ''
  if (geometry === 'shell') {
    for (const name of ['eyeToShell', 'shellUp', 'shellRadiusHeight', 'shellNoiseOrigin', 'sunDirectionShell', 'shellEmptyScene']) rayUniforms[name] = uniforms[name]
  }
  for (const name of ['eyeToLocal', 'sunDirectionLocal', 'sunRadiance', 'skyRadiance',
    'fogParams', 'fogBaseHeight', 'cloudParams', 'windOffset', 'cloudModel', 'effectFlags',
    'noiseTexture', 'shadowTexture', 'localToShadow', 'shadowInfo', 'sourceSize',
    'surfaceDepthTexture', 'surfaceDepthAvailable']) {
    rayUniforms[name] = uniforms[name]
  }
  const raymarchStage = new C.PostProcessStage({ name: `environment_raymarch_${id}`,
    fragmentShader: `${shellDefines}#define FOG_STEPS ${high ? 40 : 24}\n#define CLOUD_STEPS ${high ? 96 : 64}\n#define CLOUD_MAX_DISTANCE ${high ? '50000.0' : '30000.0'}\n${raymarchShader}`,
    uniforms: rayUniforms, textureScale: scale, pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT, sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(0, 0, 0, 1) })
  const effectSize = new C.Cartesian2()
  const resolveStage = new C.PostProcessStage({ name: `environment_resolve_${id}`,
    fragmentShader: shellDefines + resolveShader,
    uniforms: { originalHdr: uniforms.originalHdr, sourceSize: uniforms.sourceSize,
      ...(geometry === 'shell' ? { shellEmptyScene: uniforms.shellEmptyScene } : {}),
      surfaceDepthTexture: uniforms.surfaceDepthTexture, surfaceDepthAvailable: uniforms.surfaceDepthAvailable,
      effectSize: () => {
        const size = typeof uniforms.sourceSize === 'function' ? uniforms.sourceSize() : uniforms.sourceSize
        effectSize.x = Math.ceil(size.x * scale)
        effectSize.y = Math.ceil(size.y * scale)
        return effectSize
      } },
    pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
    sampleMode: C.PostProcessStageSampleMode.NEAREST })
  const composite = new C.PostProcessStageComposite({ name: `environment_${id}`,
    stages: [raymarchStage, resolveStage], inputPreviousStageTexture: true })
  return { composite, raymarchStage, resolveStage }
}
