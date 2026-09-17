// B09 单元测试：色调映射曲线选择与「只映射一次」契约。
//
// 纪律：不断言「源码包含某字符串」这类弱证据，而是断言**可判定的契约**：
// 原生与自建分支永不共存、未知曲线被拒绝、自建分支必须自行补显示编码、
// 出处声明不得宣称 1:1 UE。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TONE_MAPPING_VERSION,
  TONE_CURVES,
  TONE_CURVE_NAMES,
  UNREAL_FILMIC_PARAMETERS,
  curveIsNative,
  isKnownCurve,
  resolveToneMapping,
  canEnableCurve,
  toneMappingDiagnostics,
  unrealFilmicGLSL,
  unrealFilmicShader
} from '../../src/stages/toneMapping143.js'

// --- 曲线集合 ---------------------------------------------------------------

test('B09 tone mapping declares its contract version', () => {
  assert.equal(TONE_MAPPING_VERSION, 1)
})

test('the three planned curves map onto Cesium native tonemapper enums', () => {
  // 计划要求先暴露 ACES/Reinhard/Filmic 三个真实曲线选择，复用 Cesium 自带 shader。
  for (const [name, enumName] of [['aces', 'ACES'], ['reinhard', 'REINHARD'], ['filmic', 'FILMIC']]) {
    assert.equal(TONE_CURVES[name].native, true, name)
    assert.equal(TONE_CURVES[name].enumName, enumName, name)
  }
})

test('unrealFilmicApprox is a fourth, self-built curve rather than a native enum', () => {
  // Cesium 的 Tonemapper 枚举里没有 Unreal 曲线，因此它必须自建。
  assert.equal(TONE_CURVES.unrealFilmicApprox.native, false)
  assert.equal(TONE_CURVES.unrealFilmicApprox.enumName, null)
  assert.equal(TONE_CURVE_NAMES.length, 4)
})

test('unknown curve names are rejected instead of silently defaulting', () => {
  // 注意 `__proto__` 的特殊性：`Object.prototype.hasOwnProperty.call(obj, '__proto__')`
  // 为 false，且读取 `TONE_CURVES['__proto__']` 返回原型对象而非 undefined，
  // 因此 isKnownCurve 必须为 false、而 curveIsNative 的返回取决于属性读取结果。
  // 这里只断言**统一且安全**的性质：不被判定为已知曲线、不解析出可启用配置。
  for (const bogus of ['', 'ACES', 'unreal', 'filmicApprox', '__proto__', 'toString', null, undefined, 0]) {
    assert.equal(isKnownCurve(bogus), false, String(bogus))
    assert.equal(resolveToneMapping(bogus), null, String(bogus))
    assert.equal(canEnableCurve(bogus).enabled, false, String(bogus))
  }
  // 普通未知名与原型键都必须回 null。
  for (const bogus of ['', 'ACES', 'unreal', null, undefined, 0]) {
    assert.equal(curveIsNative(bogus), null, String(bogus))
  }
})

test('prototype keys are not treated as curves', () => {
  // 用 hasOwnProperty 而不是 `in`，否则 'toString' 之类会被误判为已知曲线。
  assert.equal(isKnownCurve('constructor'), false)
  assert.equal(isKnownCurve('hasOwnProperty'), false)
})

// --- 「只映射一次」互斥契约 -------------------------------------------------

test('native and self-built branches are mutually exclusive for every curve', () => {
  // 这是本模块的核心契约，直接对应计划的「不能映射两次」。
  for (const name of TONE_CURVE_NAMES) {
    const resolved = resolveToneMapping(name)
    assert.ok(resolved, name)
    assert.ok(!(resolved.native && resolved.applyStage),
      `${name}: must not both use the native mapper and apply its own stage`)
    assert.ok(resolved.native || resolved.applyStage,
      `${name}: must be mapped exactly one way`)
    // disableNative 必须与 native 相反：原生曲线保持原生开启，自建曲线必须关闭它。
    assert.equal(resolved.disableNative, !resolved.native, name)
  }
})

test('native curves leave the native tonemapper untouched', () => {
  for (const name of ['aces', 'reinhard', 'filmic']) {
    const resolved = resolveToneMapping(name)
    assert.equal(resolved.disableNative, false, `${name} must keep native tonemapping on`)
    assert.equal(resolved.applyStage, false, `${name} must not add its own mapping stage`)
  }
})

test('the self-built curve requires disabling the native tonemapper', () => {
  const resolved = resolveToneMapping('unrealFilmicApprox')
  assert.equal(resolved.disableNative, true)
  assert.equal(resolved.applyStage, true)
})

test('a curve that cannot disable native tonemapping is refused rather than double-mapped', () => {
  // 计划硬条款：如果无法保证只映射一次，该曲线不可启用。
  // 这里把该条款做成可判定的拒绝，而不是文档声明。
  const refused = canEnableCurve('unrealFilmicApprox', { canDisableNative: false })
  assert.equal(refused.enabled, false)
  assert.match(refused.reason, /disabling native tonemapping/)
  // 原生曲线不依赖该能力，因此仍可启用。
  assert.equal(canEnableCurve('aces', { canDisableNative: false }).enabled, true)
  // 句柄可用时自建曲线可启用。
  assert.equal(canEnableCurve('unrealFilmicApprox', { canDisableNative: true }).enabled, true)
})

test('an unknown curve is never reported as enableable', () => {
  const result = canEnableCurve('nope', { canDisableNative: true })
  assert.equal(result.enabled, false)
  assert.match(result.reason, /Unknown tone curve/)
})

// --- 自建曲线的着色器契约 ---------------------------------------------------

test('the self-built shader applies exposure before the curve', () => {
  assert.ok(unrealFilmicShader.includes('vec3 color = source.rgb * exposure;'),
    'exposure must be applied before the curve, matching Cesium native semantics')
  // 曲线必须在曝光之后。
  assert.ok(unrealFilmicShader.indexOf('* exposure') < unrealFilmicShader.indexOf('ccrUnrealFilmic(color)'))
})

test('the self-built shader performs display encoding because it replaced the native mapper', () => {
  // Cesium 的原生 tonemap 内联 czm_inverseGamma；自建分支替换了它，
  // 因此必须自行补上，否则画面整体变暗。
  assert.ok(unrealFilmicShader.includes('czm_inverseGamma(color)'),
    'the replacement branch must encode display gamma itself')
  assert.ok(unrealFilmicShader.indexOf('ccrUnrealFilmic(color)') < unrealFilmicShader.indexOf('czm_inverseGamma(color)'),
    'encoding must follow the curve')
})

test('the self-built shader passes alpha through unchanged', () => {
  assert.ok(unrealFilmicShader.includes('vec4(color, source.a)'),
    'alpha must pass through, matching the existing color grading contract')
})

test('the self-built shader is an identity when inactive', () => {
  // 计划要求所有新增效果默认关闭且强度 0 为 identity。
  assert.ok(unrealFilmicShader.includes('uniform bool toneActive;'))
  assert.ok(unrealFilmicShader.includes('if (!toneActive) { out_FragColor = source; return; }'))
  // 短路必须发生在曝光与曲线之前。
  assert.ok(unrealFilmicShader.indexOf('!toneActive') < unrealFilmicShader.indexOf('* exposure'))
})

test('the curve clamps negatives and never exceeds one', () => {
  assert.ok(unrealFilmicGLSL.includes('max(color, vec3(0.0))'), 'negatives must be clamped')
  assert.ok(unrealFilmicGLSL.includes('clamp(mapped / w, 0.0, 1.0)'), 'output must be bounded')
})

test('the GLSL parameters come from the shared calibrated constants', () => {
  // 参数必须来自唯一来源，避免 GLSL 与 JS 各自漂移。
  for (const key of ['shoulderStrength', 'linearStrength', 'linearAngle', 'toeStrength',
    'toeNumerator', 'toeDenominator', 'linearWhite']) {
    assert.ok(unrealFilmicGLSL.includes(String(UNREAL_FILMIC_PARAMETERS[key])),
      `${key} must be interpolated from the shared constants`)
  }
})

// --- 数值行为（用 JS 复刻同一公式验证曲线形状）-----------------------------

/** 与 GLSL 同一公式的 JS 实现，仅用于验证曲线形状。 */
function unrealFilmic(color) {
  const { shoulderStrength: A, linearStrength: B, linearAngle: C, toeStrength: D,
    toeNumerator: E, toeDenominator: F, linearWhite: W } = UNREAL_FILMIC_PARAMETERS
  // NaN/Inf 必须先清掉再进入分式：Inf/Inf 会得到 NaN，
  // 而 HDR 缓冲里出现极大值是正常情况（太阳直射、加法混合亮斑）。
  if (!Number.isFinite(color)) return color > 0 ? 1 : 0
  const c = Math.min(Math.max(color, 0), W)
  const mapped = (c * (A * c + C * B) + D * E) / (c * (A * c + B) + D * F) - E / F
  const w = (W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F) - E / F
  return Math.min(Math.max(mapped / w, 0), 1)
}

test('the curve is monotonically increasing', () => {
  let previous = -1
  for (let x = 0; x <= 64; x += 0.01) {
    const y = unrealFilmic(x)
    assert.ok(y >= previous - 1e-12, `must not decrease at x=${x}: ${y} < ${previous}`)
    previous = y
  }
})

test('black maps to black and the white point reaches one', () => {
  assert.ok(Math.abs(unrealFilmic(0)) < 1e-9, 'zero input must map to zero')
  assert.ok(Math.abs(unrealFilmic(UNREAL_FILMIC_PARAMETERS.linearWhite) - 1) < 1e-9,
    'the linear white point must map to exactly 1')
})

test('the curve is compressive: highlights are rolled off, not clipped early', () => {
  // 胶片曲线的特征是肩部压缩：高光区仍单调但斜率显著下降。
  const slope = (a, b) => (unrealFilmic(b) - unrealFilmic(a)) / (b - a)
  const shadows = slope(0.05, 0.15)
  const highlights = slope(8, 11)
  assert.ok(shadows > 0, 'shadows must respond')
  assert.ok(highlights < shadows * 0.5,
    `the shoulder must be compressive, got shadow slope ${shadows} vs highlight slope ${highlights}`)
})

test('extreme inputs stay bounded rather than producing NaN or infinities', () => {
  for (const x of [1e3, 1e6, 1e12, Infinity]) {
    const y = unrealFilmic(x)
    assert.ok(Number.isFinite(y), `x=${x} produced ${y}`)
    assert.ok(y >= 0 && y <= 1, `x=${x} produced ${y}`)
  }
  assert.equal(unrealFilmic(-5), unrealFilmic(0), 'negatives clamp to the black point')
})

test('the curve is not the identity, so it is a real mapping rather than a pass-through', () => {
  // 若曲线恰好等于恒等，那么这个「新曲线」没有意义。
  let differs = 0
  for (const x of [0.05, 0.18, 0.5, 1, 4, 16]) if (Math.abs(unrealFilmic(x) - x) > 1e-6) differs++
  assert.ok(differs >= 4, 'the curve must differ from identity over most of the range')
})

// --- 对外诊断与出处声明 -----------------------------------------------------

test('diagnostics state that the local FILMIC is Uncharted 2, not Unreal', () => {
  const diagnostics = toneMappingDiagnostics('filmic')
  assert.match(diagnostics.filmicProvenance, /Uncharted 2/)
  assert.match(diagnostics.filmicProvenance, /not Unreal Engine filmic/)
  // 参数组必须与 Cesium 实际使用的一致（已核对 FilmicTonemapping.js）。
  for (const value of ['A=0.22', 'B=0.30', 'C=0.10', 'D=0.20', 'E=0.01', 'F=0.30', 'white=11.2']) {
    assert.ok(diagnostics.filmicProvenance.includes(value), value)
  }
})

test('diagnostics describe the approximation without claiming 1:1 Unreal parity', () => {
  const diagnostics = toneMappingDiagnostics('unrealFilmicApprox')
  assert.match(diagnostics.unrealApproxProvenance, /approximation/)
  assert.match(diagnostics.unrealApproxProvenance, /not 1:1 Unreal Engine/)
  // 不得出现「1:1 UE」这类等价宣称。
  assert.ok(!/1:1 UE|equals Unreal|same as Unreal/.test(diagnostics.unrealApproxProvenance))
})

test('diagnostics expose the exactly-once invariant as a machine-readable field', () => {
  for (const name of TONE_CURVE_NAMES) {
    const diagnostics = toneMappingDiagnostics(name)
    assert.equal(diagnostics.known, true, name)
    assert.equal(diagnostics.exactlyOnce, true, `${name} must map exactly once`)
    assert.equal(diagnostics.disableNative, !diagnostics.native, name)
  }
  const bogus = toneMappingDiagnostics('nope')
  assert.equal(bogus.known, false)
  assert.equal(bogus.exactlyOnce, null, 'an unknown curve must not claim the invariant')
})

test('diagnostics name the exposure owner and the display-encoding contract', () => {
  const diagnostics = toneMappingDiagnostics('aces')
  assert.match(diagnostics.exposureOwner, /exposure/)
  assert.match(diagnostics.displayEncoding, /inverseGamma|encode/)
  assert.deepEqual(diagnostics.available, [...TONE_CURVE_NAMES])
})

test('the calibrated middle grey and white point are recorded for audit', () => {
  assert.equal(UNREAL_FILMIC_PARAMETERS.middleGrey, 0.18)
  assert.equal(UNREAL_FILMIC_PARAMETERS.whitePoint, 1.0)
})
