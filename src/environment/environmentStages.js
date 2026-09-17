import { cloudShellGLSL } from './cloudShell143.js'
import { heightFogGLSL } from './heightFog143.js'

let nextId = 0

// 椭球平均半径（米）。用于把局部切平面高度换算成椭球高度时估计地球曲率下沉量
// d²/(2R)。用平均半径而非当地曲率半径：50 km 水平距离上两者带来的差异
// 远小于 1 m，而雾的 scaleHeight 在百米量级。
const EARTH_RADIUS = 6371008.8

const depthFunctions = `
#define CCR_EARTH_RADIUS ${EARTH_RADIUS.toFixed(1)}
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

/**
 * 两个着色器（raymarch 与 medium occlusion）共用的前导声明。
 *
 * 为什么必须共用而不是各写一份：它们是**独立编译单元**，各自需要 UBO 块、
 * uniform 声明与 `sunVisibility`/`ellipsoidalHeight` 等辅助函数。曾经在
 * occlusion shader 里重复声明 surfaceDepthTexture/surfaceDepthAvailable
 * （已由 depthFunctions 声明）而报 redefinition，又漏了 UBO 块与 sunVisibility
 * 而报 undeclared——把共用部分集中到一处可以从根本上避免这类漂移。
 */
const sharedPreamble = `
in vec2 v_textureCoordinates;
#ifdef CCR_ENV_FRAME_UBO
layout(std140) uniform CCREnvironmentFrame {
  mat4 ccrEnvironmentEyeToLocal;
  mat4 ccrEnvironmentInverseProjection;
  vec4 ccrEnvironmentSunLocal;
  vec4 ccrEnvironmentSunRadiance;
  vec4 ccrEnvironmentSkyRadiance;
  vec4 ccrEnvironmentSunShell;
};
#define eyeToLocal ccrEnvironmentEyeToLocal
#define sunDirectionLocal ccrEnvironmentSunLocal.xyz
#define sunRadiance ccrEnvironmentSunRadiance.xyz
#define skyRadiance ccrEnvironmentSkyRadiance.xyz
#define CCR_ENV_INVERSE_PROJECTION ccrEnvironmentInverseProjection
#else
uniform mat4 eyeToLocal;
uniform vec3 sunDirectionLocal;
uniform vec3 sunRadiance;
uniform vec3 skyRadiance;
#define CCR_ENV_INVERSE_PROJECTION czm_inverseProjection
#endif
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
uniform float localGroundHeight;
${depthFunctions}
${heightFogGLSL}

// B08：地心曲率修正后的椭球高度。
//
// 为什么需要它（主计划「地理高度以椭球及局部高精度参考计算，禁止 ECEF.y 当高度」）：
// 本 pass 在局部 ENU 参考系里工作，p.z 是相对**参考点切平面**的竖直分量。
// 切平面只在参考点处与椭球面相切，离参考点越远、同一切平面就越高出椭球面：
// 水平距离 d 处，切平面比椭球面高约 d²/(2R)。50 km 处这个偏差约 196 m，
// 与雾的 scaleHeight（约 180 m）同量级——足以让「同一椭球高度」在近处与远处
// 得到完全不同的密度，这正是主计划要求消除的不一致。
//
// 修正：h_true ≈ p.z - d²/(2R)，其中 d 是 p 相对参考点的水平距离（切平面内），
// R 取地球平均半径（误差远小于 1 m 量级）。
// 注意 p.z 本身**不是** ECEF.y，所以这不是在修一个 ECEF.y 的误用，
// 而是把局部切平面高度换算成椭球高度。
float ellipsoidalHeight(vec3 p) {
    float horizontal = length(p.xy);
    return p.z - (horizontal * horizontal) / (2.0 * CCR_EARTH_RADIUS);
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
`

const raymarchShader = `${sharedPreamble}
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

vec4 integrateFog(vec3 origin, vec3 direction, float limit, float phase) {
  vec4 integrated = vec4(0.0, 0.0, 0.0, 1.0);
  float start = max(fogParams.w, 0.0);
  if (effectFlags.x < 0.5 || fogParams.x <= 0.0 || limit <= start) return integrated;

  // 基础档：解析指数积分（含近零 Taylor 分支），见 src/environment/heightFog143.js。
  // 无噪声时必须走这条路径——它与步进无关，因此结果可复现、可作验收基准；
  // 逐样本步进的结果随 FOG_STEPS 变化，不能当基准。
  // 体积档（带噪声）仍走步进，因为噪声本身使积分没有闭式解。
  if (effectFlags.w < 0.5 || fogParams.z <= 0.0) {
    // 参数必须直接用**视线起点的高度** originZ = h0 与高度变化率
    // directionZ = (h1 - h0)/length。闭式解的推导前提正是「ρ(t) = ρ0·exp(-k·t)，
    // 其中 ρ0 由起点高度决定」；曾经错误地写成 baseZ = min(h0, h1) 并把整段长度
    // 都按最低点密度积分，等价于把整条视线当成贴着地面走——实测光学厚度
    // 从 0.013 变成 794，两种密度都饱和成 T=0，画面全白且不响应 fogDensity。
    // 这是本轮由「负对照」暴露的真实缺陷：雾开/关有差异（说明雾在跑），
    // 但 16 倍密度差给出**逐位相同**的结果（说明参数没进模型）。
    float h0 = ellipsoidalHeight(origin + direction * start) - localGroundHeight;
    float h1 = ellipsoidalHeight(origin + direction * limit) - localGroundHeight;
    float directionZ = (limit > start) ? (h1 - h0) / (limit - start) : 0.0;
    float depth = ccrHeightFogDepth(fogParams.x, fogBaseHeight, max(fogParams.y, 1.0),
      h0, directionZ, 0.0, limit - start);
    float transmission = exp(-depth);
    // 散射按整段的平均光照近似：雾在 50 km 内光学厚度不大，
    // 用中点光照与逐段累加的差异远小于验收门槛。
    vec3 midpoint = origin + direction * (start + limit) * 0.5;
    vec3 lighting = skyRadiance * 0.35 + sunRadiance * phase * effectFlags.z * sunVisibility(midpoint);
    integrated.rgb += (1.0 - transmission) * lighting;
    integrated.a = transmission;
    return integrated;
  }

  float previous = start;
  for (int i = 0; i < FOG_STEPS; i++) {
    float fraction = float(i + 1) / float(FOG_STEPS);
    float next = mix(start, limit, fraction * fraction);
    float stepLength = next - previous;
    vec3 p = origin + direction * (previous + next) * 0.5;
    float density = fogParams.x * exp(clamp(-(ellipsoidalHeight(p) - localGroundHeight - fogBaseHeight) / max(fogParams.y, 1.0), -30.0, 4.0));
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
  vec4 eyeRay = CCR_ENV_INVERSE_PROJECTION * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
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

// B08：介质遮挡 / 透射率数据产出（供 B09 光柱与太阳光斑消费）。
//
// 分工（主计划明确）：B08 只产出「沿视线到太阳的累计介质」数据，
// 光柱的径向积分与艺术叠加在 B09 完成。这里不做任何光柱。
//
// 数据来源：像素级材质深度/Hi-Z（B02 产出），**不依赖 B06 的对象级可见性**。
// 输出（半分辨率，与 raymarch 同尺寸）：
//   .r = 太阳方向上的介质透射率 T（1 = 完全通透，0 = 完全遮挡）
//   .g = 同一条视线上的太阳可见性（阴影贴图结果，供与介质相乘）
//   .b = 视线自身的介质透射率（供光柱判断前方是否有雾体）
//   .a = 保留 1
//
// 已知介质来源：高度雾 + 云层。二者都在本 pass 里已有解析/积分实现，
// 因此这里复用同一套函数，不重复实现遮挡 mask（计划要求）。
const mediumOcclusionShader = `${sharedPreamble}
void main() {
  vec2 uv = v_textureCoordinates;
  // 先取该像素的可见距离，把介质积分限制在真实几何之内——
  // 这样「光柱/光斑不透墙」是数据本身的性质，而不是靠后续 mask 修补。
  float distance = sceneDistance(uv);
  // 太阳方向与视线方向都变换到局部 ENU 参考系（与雾/云同一套坐标与高度语义）。
  vec4 eyeRay = CCR_ENV_INVERSE_PROJECTION * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 viewDirection = normalize((eyeToLocal * vec4(eyeRay.xyz / eyeRay.w, 0.0)).xyz);
  vec3 sunLocal = normalize(sunDirectionLocal);
  vec3 origin = (eyeToLocal * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float viewTransmittance = 1.0;
  float sunTransmittance = 1.0;
  if (effectFlags.x > 0.5 && fogParams.x > 0.0) {
    // 视线方向上的介质（供光柱判断前方雾体）。
    float h0 = ellipsoidalHeight(origin) - localGroundHeight;
    float h1 = ellipsoidalHeight(origin + viewDirection * distance) - localGroundHeight;
    float viewDepth = ccrHeightFogDepth(fogParams.x, fogBaseHeight, max(fogParams.y, 1.0),
      h0, (distance > 0.0) ? (h1 - h0) / distance : 0.0, 0.0, distance);
    viewTransmittance = exp(-viewDepth);
    // 到太阳方向上的介质。用同一相机高度与太阳方向的竖直分量：
    // 太阳在无穷远，故积分长度取一个足够长的固定上限（50 km），
    // 超过之后指数项已可忽略（scaleHeight 在百米量级）。
    float sunVertical = sunLocal.z;
    float sunDepth = ccrHeightFogDepth(fogParams.x, fogBaseHeight, max(fogParams.y, 1.0),
      h0, sunVertical, 0.0, 50000.0);
    sunTransmittance = exp(-sunDepth);
  }
  float sunVisibilityValue = effectFlags.z > 0.5 ? sunVisibility(origin + viewDirection * distance * 0.5) : 1.0;
  out_FragColor = vec4(sunTransmittance, sunVisibilityValue, viewTransmittance, 1.0);
}
`

const resolveShader = `in vec2 v_textureCoordinates;
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

export function createEnvironmentStages(C, uniforms, quality = 'balanced', geometry = 'local', frameUbo = false) {
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
    'surfaceDepthTexture', 'surfaceDepthAvailable', 'localGroundHeight']) {
    rayUniforms[name] = uniforms[name]
  }
  const raymarchStage = new C.PostProcessStage({ name: `environment_raymarch_${id}`,
    fragmentShader: `${frameUbo?'#define CCR_ENV_FRAME_UBO\n':''}${shellDefines}#define FOG_STEPS ${high ? 40 : 24}\n#define CLOUD_STEPS ${high ? 96 : 64}\n#define CLOUD_MAX_DISTANCE ${high ? '50000.0' : '30000.0'}\n${raymarchShader}`,
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
  // B08：介质遮挡/透射率产出（供 B09 光柱/光斑消费的数据，不是呈像的一部分）。
  //
  // 刻意**不**放进 composite：composite 的输出会成为场景颜色，而这些是中间数据，
  // 混进去会直接把遮挡率画到屏幕上。B09 通过独立 collection 执行它并读取输出纹理，
  // 与 SSR/TransparentReflection 的既有做法一致。
  //
  // 依赖顺序：本 stage 必须在材质通道（B02）产出之后执行，因为它用
  // sceneDistance/surfaceDepthTexture 读取像素级深度；在管线里由优先级保证。
  const occlusionStage = new C.PostProcessStage({ name: `environment_occlusion_${id}`,
    fragmentShader: `${frameUbo ? '#define CCR_ENV_FRAME_UBO\n' : ''}${shellDefines}${mediumOcclusionShader}`,
    uniforms: rayUniforms, textureScale: scale, pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.FLOAT, sampleMode: C.PostProcessStageSampleMode.NEAREST,
    clearColor: new C.Color(0, 0, 0, 1) })
  return { id, composite, raymarchStage, resolveStage, occlusionStage }
}
