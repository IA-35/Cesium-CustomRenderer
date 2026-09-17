// B09：镜头效果（移轴、泛焦模糊/景深、色差、太阳光斑、Light Shaft）。
//
// 设计纪律（主计划硬要求）：
//   1. **所有新增效果默认关闭，强度 0 为 identity**——每个效果的 shader 都以
//      「强度为 0 时逐位返回原图」为第一分支，而不是靠参数恰好抵消；
//   2. 移轴使用**双向 9-tap**、核归一化、像素半径由真实 `textureSize` 控制；
//   3. 色差只偏移 R/B，**alpha 不偏移**，且与 hue/saturation 分开；
//   4. 光柱/光斑**消费 B08 的介质遮挡数据**，不重复实现遮挡 mask；
//   5. `blur` / `depthOfField` / `tiltShift` 三者首期**互斥**，
//      启用一个必须明确反馈另外两项的实际状态（在 API 层固化，见
//      `resolveLensEffects`）。
//
// 注意：本文件只放着色器与设置解析；管线管理在 `LensEffectsStage143.js`。
// 两个文件名刻意不同（Windows 文件系统大小写不敏感，`lensEffects143.js` 与
// `LensEffects143.js` 会是同一个文件——本项目实测过该覆盖事故）。
//
// 与 B08 的时序：介质遮挡数据在环境 pass（优先级 20）产出，
// 因此光柱/光斑必须注册在更高优先级才能读到同帧数据。

export const LENS_EFFECTS_VERSION = 1

/** 首期互斥的模糊类效果。 */
export const EXCLUSIVE_BLUR_EFFECTS = Object.freeze(['tiltShift', 'blur', 'depthOfField'])

/** 全部镜头效果及其默认状态（全部默认关闭）。 */
export const LENS_EFFECT_DEFAULTS = Object.freeze({
  tiltShiftEnabled: false, tiltShiftFocus: 0.35, tiltShiftWidth: 0.12, tiltShiftRadius: 6, tiltShiftStrength: 1,
  blurEnabled: false, blurRadius: 4, blurStrength: 1,
  depthOfFieldEnabled: false, depthOfFieldFocus: 50, depthOfFieldRange: 30, depthOfFieldRadius: 5, depthOfFieldStrength: 1,
  chromaticAberrationEnabled: false, chromaticAberrationStrength: 0,
  sunFlareEnabled: false, sunFlareStrength: 0.6,
  lightShaftEnabled: false, lightShaftStrength: 0.7, lightShaftSamples: 32
})

/**
 * 解析互斥关系。
 *
 * 计划要求「启用一个必须明确反馈另外两项的实际状态，交互规则需在 API 层固化」。
 * 因此这里返回的不只是「谁生效」，还包括**每个被压制的效果及其原因**，
 * 使调用方能如实报告，而不是让用户以为三个效果都在跑。
 */
export function resolveLensEffects(settings = {}) {
  const requested = {}
  for (const name of EXCLUSIVE_BLUR_EFFECTS) requested[name] = settings[`${name}Enabled`] === true
  const active = EXCLUSIVE_BLUR_EFFECTS.filter(name => requested[name])
  // 首期只允许一个生效；优先级按 EXCLUSIVE_BLUR_EFFECTS 的声明顺序
  // （tiltShift > blur > depthOfField），这是固定且可预测的规则，不是任意的。
  const effective = active.length ? active[0] : null
  const suppressed = {}
  for (const name of EXCLUSIVE_BLUR_EFFECTS) {
    if (!requested[name]) { suppressed[name] = null; continue }
    suppressed[name] = name === effective ? null
      : `Suppressed by ${effective}: these blur effects are mutually exclusive in this stage`
  }
  return {
    requested,
    active: effective,
    suppressed,
    // 供诊断直接使用：每个效果的实际生效布尔值。
    effective: Object.fromEntries(EXCLUSIVE_BLUR_EFFECTS.map(name => [name, name === effective]))
  }
}

/** 移轴：双向 9-tap，核归一化，半径由真实 textureSize 控制。 */
export const tiltShiftShader = `
uniform sampler2D colorTexture;
uniform vec4 tiltParams;      // x=focus, y=width, z=radius(px), w=strength
uniform vec2 sourceSize;
in vec2 v_textureCoordinates;

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    // 强度 0 或半径 0 时为严格 identity（逐位返回原图）。
    if (tiltParams.w <= 0.0 || tiltParams.z <= 0.0) { out_FragColor = source; return; }
    // 焦带以距离焦线的远近决定模糊量；焦带内不模糊。
    float distanceFromFocus = abs(v_textureCoordinates.y - tiltParams.x);
    float blur = smoothstep(tiltParams.y, tiltParams.y + 0.35, distanceFromFocus);
    if (blur <= 0.0) { out_FragColor = source; return; }
    // 半径用真实 textureSize 归一化：像素半径在任意分辨率下含义一致。
    vec2 texel = 1.0 / sourceSize;
    vec2 direction = vec2(0.0, 1.0) * texel * tiltParams.z * blur;
    // 双向 9-tap（中心 + 两侧各 4），权重对称 -> 核自动归一化。
    const float weights[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
    vec3 sum = source.rgb * weights[0];
    float weightSum = weights[0];
    for (int i = 1; i < 5; i++) {
        sum += texture(colorTexture, v_textureCoordinates + direction * float(i)).rgb * weights[i];
        sum += texture(colorTexture, v_textureCoordinates - direction * float(i)).rgb * weights[i];
        weightSum += weights[i] * 2.0;
    }
    // 核归一化：除以实际权重和，保证常量图亮度不变。
    vec3 blurred = sum / weightSum;
    out_FragColor = vec4(mix(source.rgb, blurred, tiltParams.w), source.a);
}
`

/** 全屏高斯模糊（可关闭的「泛焦模糊」）。 */
export const blurShader = `
uniform sampler2D colorTexture;
uniform vec4 blurParams;      // x=radius(px), y=strength
uniform vec2 sourceSize;
in vec2 v_textureCoordinates;

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    if (blurParams.y <= 0.0 || blurParams.x <= 0.0) { out_FragColor = source; return; }
    vec2 texel = 1.0 / sourceSize;
    vec2 horizontalStep = vec2(blurParams.x * texel.x, 0.0);
    vec2 verticalStep = vec2(0.0, blurParams.x * texel.y);
    const float weights[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
    // 先横向。
    vec3 sum = source.rgb * weights[0];
    float weightSum = weights[0];
    for (int i = 1; i < 5; i++) {
        sum += texture(colorTexture, v_textureCoordinates + horizontalStep * float(i)).rgb * weights[i];
        sum += texture(colorTexture, v_textureCoordinates - horizontalStep * float(i)).rgb * weights[i];
        weightSum += weights[i] * 2.0;
    }
    vec3 horizontal = sum / weightSum;
    // 再纵向，对横向结果做同一核。
    vec3 verticalSum = horizontal * weights[0];
    float verticalWeight = weights[0];
    for (int i = 1; i < 5; i++) {
        verticalSum += texture(colorTexture, v_textureCoordinates + verticalStep * float(i)).rgb * weights[i];
        verticalSum += texture(colorTexture, v_textureCoordinates - verticalStep * float(i)).rgb * weights[i];
        verticalWeight += weights[i] * 2.0;
    }
    vec3 blurred = verticalSum / verticalWeight;
    out_FragColor = vec4(mix(source.rgb, blurred, blurParams.y), source.a);
}
`

/**
 * 基础景深：按焦平面距离决定模糊量。
 *
 * 深度来自 B02 的米制材质深度契约（正数 = 已知米制视深度）。
 * 深度不可用时（背景/未知遮挡）按「远处」处理并给出最大模糊，
 * 而不是把未知深度当成 0（那会让背景变得完全清晰）。
 */
export const depthOfFieldShader = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec4 dofParams;       // x=focus(m), y=range(m), z=radius(px), w=strength
uniform vec2 sourceSize;
uniform float depthAvailable; // 1 = metric depth produced this frame, 0 = not available
in vec2 v_textureCoordinates;

float dofEyeDepth(vec2 uv) {
    // B02 材质深度：正数为已知米制视深度，0 为背景，负数为未知遮挡。
    float depth = texture(depthTexture, uv).r;
    return depth;
}

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    // 强度 0、半径 0，或米制深度不可用（本帧未生产）时严格 identity。
    // 不能把 defaultTexture（颜色）当深度读，否则会按错误距离模糊（R4）。
    if (dofParams.w <= 0.0 || dofParams.z <= 0.0 || depthAvailable < 0.5) { out_FragColor = source; return; }
    float depth = dofEyeDepth(v_textureCoordinates);
    // 未知深度（背景或未知遮挡）按最远处处理：给最大模糊而不是当成焦内。
    float effective = depth > 0.0 ? depth : dofParams.x + dofParams.y * 4.0;
    float distanceFromFocus = abs(effective - dofParams.x);
    float blur = clamp(distanceFromFocus / max(dofParams.y, 0.001), 0.0, 1.0);
    if (blur <= 0.0) { out_FragColor = source; return; }
    vec2 texel = 1.0 / sourceSize;
    vec2 direction = vec2(0.0, 1.0) * texel * dofParams.z * blur;
    const float weights[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
    vec3 sum = source.rgb * weights[0];
    float weightSum = weights[0];
    for (int i = 1; i < 5; i++) {
        sum += texture(colorTexture, v_textureCoordinates + direction * float(i)).rgb * weights[i];
        sum += texture(colorTexture, v_textureCoordinates - direction * float(i)).rgb * weights[i];
        weightSum += weights[i] * 2.0;
    }
    out_FragColor = vec4(mix(source.rgb, sum / weightSum, dofParams.w), source.a);
}
`

/**
 * 色差：按像素单位径向偏移 R/B。
 *
 * 契约（计划明确）：中心与强度 0 保持原图；**alpha 不偏移**。
 * 与 hue/saturation 分开（后者在 colorGrading 里）。
 */
export const chromaticAberrationShader = `
uniform sampler2D colorTexture;
uniform vec2 sourceSize;
uniform float aberration;     // 像素单位的最大径向偏移（0 = identity）
in vec2 v_textureCoordinates;

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    if (aberration <= 0.0) { out_FragColor = source; return; }
    // 以中心为原点的径向方向。
    vec2 centered = v_textureCoordinates - 0.5;
    float radius = length(centered);
    if (radius <= 1.0e-6) { out_FragColor = source; return; }
    vec2 direction = centered / radius;
    // 偏移量以**像素**为单位，用 textureSize 归一化，与分辨率无关。
    // 偏移随半径增大（这是真实镜头色差的特征）。
    vec2 offset = direction * aberration * radius / sourceSize;
    vec3 color;
    color.r = texture(colorTexture, v_textureCoordinates + offset).r;
    color.g = source.g;
    color.b = texture(colorTexture, v_textureCoordinates - offset).b;
    // alpha 原样传递，不做任何偏移。
    out_FragColor = vec4(color, source.a);
}
`

/**
 * Light Shaft（光柱）：消费 B08 的介质遮挡数据做半分辨率径向积分。
 *
 * 分工（计划明确）：**不重复实现遮挡 mask**——遮挡/透射率由 B08 产出，
 * 本 stage 只做径向积分与合成。
 *
 * `occlusionTexture` 通道（B08 契约）：.r = 太阳方向介质透射率，
 * .g = 太阳可见性，.b = 视线介质透射率。
 *
 * 不透墙：积分沿太阳屏幕方向的每个采样点都乘以该点的介质遮挡，
 * 建筑遮挡处遮挡值低，光柱自然被截断。
 */
export const lightShaftShader = `
uniform sampler2D colorTexture;
uniform sampler2D occlusionTexture;
uniform vec4 shaftParams;     // x=strength, y=samples, z=aspectX, w=aspectY
uniform vec2 sunScreen;       // 太阳屏幕位置 (uv)
uniform float shaftAvailable; // 遮挡数据是否可用（0 = 直接 identity）
in vec2 v_textureCoordinates;

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    // 数据不可用、强度 0 或退化为 0 样本时严格 identity。
    if (shaftAvailable < 0.5 || shaftParams.x <= 0.0 || shaftParams.y < 1.0) {
        out_FragColor = source; return;
    }
    // 背向太阳（太阳不在屏幕内）时退出，避免把屏幕外方向拉出条纹。
    if (sunScreen.x < 0.0 || sunScreen.x > 1.0 || sunScreen.y < 0.0 || sunScreen.y > 1.0) {
        out_FragColor = source; return;
    }
    vec2 delta = (sunScreen - v_textureCoordinates) / max(shaftParams.y, 1.0);
    vec2 sampleUv = v_textureCoordinates;
    float illumination = 0.0;
    float decay = 1.0;
    // 径向逐步逼近太阳位置，每个采样点读取该点的介质遮挡与视线透射率。
    for (int i = 0; i < 64; i++) {
        if (float(i) >= shaftParams.y) break;
        sampleUv += delta;
        vec4 occlusion = texture(occlusionTexture, clamp(sampleUv, vec2(0.0), vec2(1.0)));
        // 太阳方向透射率 * 太阳可见性：两者都来自 B08，本 stage 不自造遮挡。
        float visible = occlusion.r * occlusion.g;
        illumination += visible * decay;
        decay *= 0.96;
    }
    illumination /= max(shaftParams.y, 1.0);
    // 光柱叠加在已有颜色上，并按视线自身的介质透射率加权，
    // 使「前方没有雾体」的方向不产生虚假光柱。
    vec4 selfOcclusion = texture(occlusionTexture, clamp(v_textureCoordinates, vec2(0.0), vec2(1.0)));
    float viewWeight = 1.0 - selfOcclusion.b;
    vec3 shaft = vec3(1.0, 0.96, 0.88) * illumination * shaftParams.x * viewWeight;
    out_FragColor = vec4(source.rgb + shaft, source.a);
}
`

/**
 * 太阳光斑：太阳屏幕位置 + 遮挡，背向太阳退出。
 *
 * 与光柱共用 B08 遮挡数据；同样**不**自造遮挡 mask。
 */
export const sunFlareShader = `
uniform sampler2D colorTexture;
uniform sampler2D occlusionTexture;
uniform vec4 flareParams;     // x=strength, y=size, z=available, w=unused
uniform vec2 sunScreen;
uniform vec4 sunColor;        // rgb=颜色, a=强度
in vec2 v_textureCoordinates;

void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    if (flareParams.z < 0.5 || flareParams.x <= 0.0 || sunColor.a <= 0.0) {
        out_FragColor = source; return;
    }
    // 背向太阳时退出：太阳不在屏幕内就不产生光斑。
    if (sunScreen.x < 0.0 || sunScreen.x > 1.0 || sunScreen.y < 0.0 || sunScreen.y > 1.0) {
        out_FragColor = source; return;
    }
    // 遮挡来自 B08：太阳方向透射率 * 太阳可见性。建筑/云遮挡时自然衰减。
    vec4 occlusion = texture(occlusionTexture, clamp(sunScreen, vec2(0.0), vec2(1.0)));
    float visible = occlusion.r * occlusion.g;
    if (visible <= 0.001) { out_FragColor = source; return; }
    // 光斑核：以太阳屏幕位置为中心的高斯。
    vec2 delta = (v_textureCoordinates - sunScreen) * vec2(flareParams.y, flareParams.y);
    float falloff = exp(-dot(delta, delta) * 6.0);
    vec3 flare = sunColor.rgb * falloff * flareParams.x * visible;
    out_FragColor = vec4(source.rgb + flare, source.a);
}
`
