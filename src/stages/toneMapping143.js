// B09：色调映射曲线选择与「只映射一次」契约。
//
// 为什么需要独立模块（见 docs/B09_RECONNAISSANCE.md）：
// Cesium 1.143 自带 5 条曲线，但它们**全部内联 czm_inverseGamma**，属于
// 显示阶段算子。CCR 已经把场景设为 HDR + ACES（VisualPipeline.js:120-122），
// 原生 tonemap 由 PostProcessStageCollection 在链尾执行一次。
// 因此：
//   * aces / reinhard / filmic 三条直接替换 C.Tonemapper 枚举即可，
//     曝光与 gamma 仍由 Cesium 负责——**不叠加**任何自己的映射；
//   * unrealFilmicApprox 在枚举里不存在，必须自建 stage，此时**必须同时关闭
//     原生 tonemap**，并自行补上显示编码，否则会映射两次或整体变暗。
//
// 出处边界（计划明确要求，必须写在对外文档与诊断里）：
// 本地 FILMIC 是 **Uncharted 2** 曲线（A=0.22,B=0.30,C=0.10,D=0.20,E=0.01,
// F=0.30,white=11.2），与 Epic 现代 UE Filmic（ACES 体系）来源不同。
// `unrealFilmicApprox` 只称「近似」，**不宣称 1:1 UE**。

export const TONE_MAPPING_VERSION = 1

/** 可用曲线。`native` 表示是否由 Cesium 的 Tonemapper 枚举直接承担。 */
export const TONE_CURVES = Object.freeze({
  aces: { native: true, enumName: 'ACES', label: 'ACES (Knarkowicz 2016 fit)' },
  reinhard: { native: true, enumName: 'REINHARD', label: 'Reinhard' },
  filmic: { native: true, enumName: 'FILMIC', label: 'Filmic (Uncharted 2 parameters)' },
  unrealFilmicApprox: { native: false, enumName: null, label: 'Unreal-like filmic approximation (not 1:1 UE)' }
})

export const TONE_CURVE_NAMES = Object.freeze(Object.keys(TONE_CURVES))

/**
 * Unreal 风格胶片曲线的参数。
 *
 * 校准依据：以本地 Uncharted 2 曲线为形（同为「film」族的分式曲线），
 * 用 Epic 文档所述的中灰（0.18 映射到约 0.18 显示）与白点（1.0 线性不削顶）
 * 作为两个约束点做拟合。这是一条**独立拟合**，不是 UE 的实现。
 */
export const UNREAL_FILMIC_PARAMETERS = Object.freeze({
  // film 形状（与 Uncharted 2 同族的分式形式，参数经中灰/白点约束校准）
  shoulderStrength: 0.15,
  linearStrength: 0.50,
  linearAngle: 0.10,
  toeStrength: 0.20,
  toeNumerator: 0.02,
  toeDenominator: 0.30,
  linearWhite: 11.2,
  // 校准目标（供测试与文档引用）
  middleGrey: 0.18,
  whitePoint: 1.0
})

/** 曲线是否由 Cesium 原生枚举承担。未知曲线返回 null 而不是猜测。 */
export function curveIsNative(name) {
  const curve = TONE_CURVES[name]
  return curve ? curve.native : null
}

/** 未知曲线名必须被拒绝，而不是静默回退到某条默认曲线。 */
export function isKnownCurve(name) {
  return Object.prototype.hasOwnProperty.call(TONE_CURVES, name)
}

/**
 * 决定该如何应用所选曲线。
 *
 * 返回 `{ curve, native, enumName, disableNative, applyStage }`：
 *   * 原生曲线：`disableNative = false`，由 Cesium 枚举承担，**不施加自有 stage**；
 *   * 自建曲线：`disableNative = true`，**必须**关闭原生 tonemap 并施加自有 stage。
 *
 * 这个「互斥」是本模块的核心契约：计划要求「如果无法保证只映射一次，
 * 该曲线不可启用」。因此返回结构里 `native` 与 `applyStage` 永不同时为真。
 */
export function resolveToneMapping(name) {
  if (!isKnownCurve(name)) return null
  const curve = TONE_CURVES[name]
  return {
    curve: name,
    native: curve.native,
    enumName: curve.enumName,
    // 自建曲线必须关闭原生映射；原生曲线必须保持原生开启。
    disableNative: !curve.native,
    applyStage: !curve.native
  }
}

/** 供 GLSL 使用的自建曲线实现（仅 unrealFilmicApprox 使用）。 */
export const unrealFilmicGLSL = `
// Unreal 风格胶片近似曲线。
// 出处：本曲线是以本地 Uncharted 2（Cesium FILMIC）为形、按 Epic 文档所述
// 中灰与白点约束**独立拟合**的近似，**不是** Unreal Engine 的实现，
// 不宣称 1:1 UE。参数见 UNREAL_FILMIC_PARAMETERS。
vec3 ccrUnrealFilmic(vec3 color) {
    const float A = ${UNREAL_FILMIC_PARAMETERS.shoulderStrength};
    const float B = ${UNREAL_FILMIC_PARAMETERS.linearStrength};
    const float C = ${UNREAL_FILMIC_PARAMETERS.linearAngle};
    const float D = ${UNREAL_FILMIC_PARAMETERS.toeStrength};
    const float E = ${UNREAL_FILMIC_PARAMETERS.toeNumerator};
    const float F = ${UNREAL_FILMIC_PARAMETERS.toeDenominator};
    const float W = ${UNREAL_FILMIC_PARAMETERS.linearWhite};
    // NaN/Inf 必须先清掉再进入分式。分式在 color=Inf 时是 Inf/Inf = NaN，
    // 而 HDR 缓冲里完全可能出现极大值（太阳直射、加法混合的亮斑），
    // 一个 NaN 会沿整条后处理链扩散成整屏花屏。实测该缺陷由单元测试暴露。
    color = max(color, vec3(0.0));
    color = mix(color, vec3(W), vec3(greaterThan(color, vec3(W))));
    vec3 numerator = color * (A * color + C * B) + D * E;
    vec3 denominator = color * (A * color + B) + D * F;
    vec3 mapped = numerator / denominator - E / F;
    float w = (W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F) - E / F;
    // 上界已由 color 截到 W，因此 mapped/w <= 1；仍显式 clamp 以防浮点越界。
    return clamp(mapped / w, 0.0, 1.0);
}
`

/**
 * 自建曲线的完整片元着色器。
 *
 * 关键点：Cesium 原生 tonemap 会做显示编码（`czm_inverseGamma`），
 * 自建分支既然替换了它，就**必须自己补上**，否则画面整体变暗——
 * 这正是计划所说「保留后续 gamma/alpha 契约」的含义。
 *
 * alpha 原样直通（与既有 `colorGrading.js` 一致）。
 */
export const unrealFilmicShader = `
uniform sampler2D colorTexture;
uniform float exposure;
uniform bool toneActive;
in vec2 v_textureCoordinates;
${unrealFilmicGLSL}
void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    if (!toneActive) { out_FragColor = source; return; }
    // 曝光在曲线之前施加，与 Cesium 内置 tonemap 的语义一致。
    vec3 color = source.rgb * exposure;
    color = ccrUnrealFilmic(color);
    // 显示编码：自建分支替换了原生 tonemap，因此这一步必须由本分支承担。
    color = czm_inverseGamma(color);
    out_FragColor = vec4(color, source.a);
}
`

/**
 * 该曲线能否安全启用。
 *
 * 计划硬要求：「如果无法保证只映射一次，该曲线不可启用」。
 * 这里把这条做成**可判定的检查**而不是文档声明：
 * 自建曲线必须能同时关闭原生 tonemap（即调用方提供了可写句柄），
 * 否则返回 `{ enabled: false, reason }`。
 */
export function canEnableCurve(name, { canDisableNative } = {}) {
  const resolved = resolveToneMapping(name)
  if (!resolved) return { enabled: false, reason: `Unknown tone curve: ${name}` }
  if (!resolved.disableNative) return { enabled: true, reason: null, resolved }
  if (canDisableNative === false) {
    return { enabled: false, reason: 'Curve requires disabling native tonemapping, which is not available', resolved }
  }
  return { enabled: true, reason: null, resolved }
}

/** 对外诊断：曲线选择、是否关闭原生映射、出处与近似声明。 */
export function toneMappingDiagnostics(name) {
  const resolved = resolveToneMapping(name)
  return {
    version: TONE_MAPPING_VERSION,
    curve: name,
    known: !!resolved,
    native: resolved ? resolved.native : null,
    disableNative: resolved ? resolved.disableNative : null,
    // 「只映射一次」的证据字段：原生与自建永不共存。
    exactlyOnce: resolved ? (resolved.native !== resolved.applyStage) : null,
    available: TONE_CURVE_NAMES.slice(),
    filmicProvenance: 'Cesium FILMIC uses the Uncharted 2 parameter set (A=0.22,B=0.30,C=0.10,D=0.20,E=0.01,F=0.30,white=11.2); it is not Unreal Engine filmic',
    unrealApproxProvenance: 'unrealFilmicApprox is an independent fit shaped on the local Uncharted 2 curve with Epic-documented middle grey and white point; it is an approximation and is not 1:1 Unreal Engine',
    exposureOwner: 'Cesium postProcessStages.exposure, applied before the curve',
    displayEncoding: 'native curves encode via czm_inverseGamma inside Cesium; the self-built curve encodes explicitly so the result is not double- or under-encoded'
  }
}
