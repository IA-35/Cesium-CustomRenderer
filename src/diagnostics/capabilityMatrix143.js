// B11：能力矩阵与默认策略。
//
// 目标（主计划 B11 第 1、2、3 条）：
//   * 对 4/6/8 MRT 槽、浮点附件不可用、OIT 两模式、MSAA 支持交集、非 3D、
//     多视锥建立**能力矩阵**，诊断含 requested / active / reason / generation；
//   * 默认仍由 CCR 管理天空、环境、阴影、HDR 与 SMAA；延迟模式只在
//     B01–B03 与覆盖矩阵全部通过后才进入候选默认，不支持时明确回退增强模式；
//   * HBAO / SSR / Bloom 按场景预设**显式开启**，不能「默认 CCR」就自动全开
//     高成本效果；镜头模糊/色差/光斑默认关闭。
//
// 本模块只做**判定与报告**，不创建 GPU 资源。这样能力矩阵可以被单元测试
// 直接覆盖（不需要 GPU），而真实能力由调用方把 context 探测结果传进来。

export const CAPABILITY_MATRIX_VERSION = 1

/** 各能力的「请求 → 生效 → 原因」记录。`generation` 用于识别陈旧报告。 */
function entry(requested, active, reason, generation) {
  return { requested: requested === true, active: active === true, reason: reason || null, generation }
}

/**
 * MRT 槽位能力矩阵。
 *
 * `attachmentsNeeded` 由各消费者按实际布局累加（见 MaterialTarget143）：
 * 基础 4 槽（法线/粗糙度/金属度、自发光/标志、视深度、透明覆盖），
 * 反射 +2，不透明色 +1，albedo +1。因此 4/6/7/8 四种布局。
 */
export function mrtCapability({ maxDrawBuffers, maxColorAttachments, attachmentsNeeded, generation = 0 } = {}) {
  const requested = Number.isFinite(attachmentsNeeded) && attachmentsNeeded > 0
  if (!requested) return entry(false, false, 'No material layout requested', generation)
  const drawBuffers = Number.isFinite(maxDrawBuffers) ? maxDrawBuffers : 0
  const colorAttachments = Number.isFinite(maxColorAttachments) ? maxColorAttachments : 0
  const limit = Math.min(drawBuffers, colorAttachments)
  if (limit >= attachmentsNeeded) {
    return entry(true, true, null, generation)
  }
  return entry(true, false,
    `Material target requires ${attachmentsNeeded} slots but the device allows ${limit}`, generation)
}

/**
 * 浮点附件能力。
 *
 * 计划要求覆盖「浮点附件不可用」：分别判定 float 与 half-float，
 * 因为 B02 的 compact-v1 布局同时用到两者（RGBA32F + RGBA16F）。
 * 任一缺失都必须**明确降级**而不是静默产生错误数据。
 */
export function floatAttachmentCapability({ floatingPointTexture, colorBufferFloat, halfFloatingPointTexture, colorBufferHalfFloat, generation = 0 } = {}) {
  const missing = []
  if (!floatingPointTexture) missing.push('floatingPointTexture')
  if (!colorBufferFloat) missing.push('colorBufferFloat')
  if (!halfFloatingPointTexture) missing.push('halfFloatingPointTexture')
  if (!colorBufferHalfFloat) missing.push('colorBufferHalfFloat')
  return missing.length === 0
    ? entry(true, true, null, generation)
    : entry(true, false, `Missing ${missing.join(', ')}`, generation)
}

/**
 * OIT 两模式能力。
 *
 * 计划要求覆盖 OIT 的两个实现：MRT（单遍多目标）与 multipass（多遍累积）。
 * `useOIT` 为场景实际选择；两者都必须可用才算完整覆盖，否则如实报告哪一侧缺失。
 */
export function oitCapability({ useOIT, hasMrt, hasMultipass, accumulationTexture, revealageTexture, generation = 0 } = {}) {
  if (useOIT !== true) {
    // 场景选择排序透明：不需要 OIT 纹理，但必须报告这是**关闭**而非缺失。
    return entry(false, true, 'Order-independent translucency is off; sorted translucency is used', generation)
  }
  if (!hasMrt && !hasMultipass) return entry(true, false, 'No OIT implementation available', generation)
  if (!accumulationTexture || !revealageTexture) return entry(true, false, 'Missing OIT accumulation or revealage texture', generation)
  return entry(true, true, null, generation)
}

/**
 * MSAA 支持交集。
 *
 * 计划 B02 已公开记录「MSAA 延迟几何接管尚未实现」。因此这里的契约是：
 * **凡是与延迟几何组合的 MSAA 请求都必须明确回退**，而不是声称支持。
 * 这是把已知缺口做成可判定判定，避免它被静默当成已支持。
 */
export function msaaCapability({ requestedSamples, selectedSamples, deferredGeometryActive, generation = 0 } = {}) {
  const requested = Number.isFinite(requestedSamples) && requestedSamples > 1
  const selected = Number.isFinite(selectedSamples) ? selectedSamples : 1
  if (!requested) return entry(false, true, null, generation)
  // 延迟几何接管在多采样下未实现：必须回退，并说明原因。
  if (deferredGeometryActive) {
    return entry(true, false,
      'Deferred geometry takeover under MSAA is not implemented; enhanced path is used', generation)
  }
  if (selected < 2) return entry(true, false, 'MSAA samples were not granted by the device', generation)
  return entry(true, true, null, generation)
}

/** 非 3D 场景模式能力：2D/CV/Columbus 视图不具备本管线所需的三维几何。 */
export function sceneModeCapability({ mode, scene3D, perspectiveCamera, generation = 0 } = {}) {
  if (mode !== undefined && scene3D !== undefined && mode !== scene3D) {
    return entry(true, false, 'Requires 3D scene mode', generation)
  }
  if (perspectiveCamera === false) return entry(true, false, 'Requires a perspective camera', generation)
  return entry(true, true, null, generation)
}

/** 多视锥能力：B02/B04 已在多视锥下验证，这里只报告当前帧的视锥数。 */
export function multiFrustumCapability({ frustumCount, generation = 0 } = {}) {
  const count = Number.isFinite(frustumCount) ? frustumCount : 0
  if (count <= 0) return entry(false, false, 'No current frusta', generation)
  return entry(count > 1, true, null, generation)
}

/**
 * 汇总能力矩阵。
 *
 * 返回值刻意做成**声明式**：调用方只提供探测结果，矩阵只做判定，
 * 因此可以被单元测试完整覆盖（不需要 GPU）。
 */
export function buildCapabilityMatrix(probe = {}, generation = 0) {
  const g = Number.isFinite(probe.generation) ? probe.generation : generation
  return {
    version: CAPABILITY_MATRIX_VERSION,
    generation: g,
    mrt: mrtCapability({ ...probe, generation: g }),
    floatAttachments: floatAttachmentCapability({ ...probe, generation: g }),
    oit: oitCapability({ ...probe, generation: g }),
    msaa: msaaCapability({ ...probe, generation: g }),
    sceneMode: sceneModeCapability({ ...probe, generation: g }),
    multiFrustum: multiFrustumCapability({ ...probe, generation: g })
  }
}

/** 计划 B11 明确要求默认由 CCR 管理的能力（这些默认开启）。 */
export const CCR_MANAGED_DEFAULTS = Object.freeze(['sky', 'environment', 'shadows', 'hdr', 'smaa'])

/**
 * 计划 B11 明确要求**不默认开启**的高成本效果。
 *
 * 「不能『默认CCR』就自动全开高成本效果」——因此这些必须由预设显式开启。
 * 延迟模式也在其中：它只有在覆盖矩阵全部通过后才进入**候选**默认。
 */
export const EXPLICIT_ONLY_EFFECTS = Object.freeze([
  'hbao', 'ssr', 'bloom', 'deferredLighting', 'tiltShift', 'blur', 'depthOfField',
  'chromaticAberration', 'sunFlare', 'lightShaft'
])

/**
 * 默认策略判定。
 *
 * 返回每项的 `requested / active / reason`，使「为什么这项没开」总是可回答的。
 * 延迟模式的判定是重点：**只要覆盖矩阵未全部通过就必须回退增强模式并说明**，
 * 不允许静默进入。
 */
export function resolveDefaultPolicy({ options = {}, capability = {}, coverage = {} } = {}) {
  const reason = []
  // 延迟模式：候选默认的门槛是覆盖矩阵全部通过。
  const coverageChecks = {
    opaqueLoop: coverage.opaqueLoop === true,
    transparentLoop: coverage.transparentLoop === true,
    ssr: coverage.ssr === true,
    msaa: coverage.msaa === true
  }
  const coverageIncomplete = Object.keys(coverageChecks).filter(key => !coverageChecks[key])
  const deferredCandidates = coverageIncomplete.length === 0
  const deferredRequested = options.lightingMode === 'deferred'
  const deferredActive = deferredRequested && deferredCandidates && capability.mrt?.active !== false
  if (deferredRequested && !deferredActive) {
    if (!deferredCandidates) reason.push(`Deferred lighting is not a candidate default yet: incomplete coverage (${coverageIncomplete.join(', ')})`)
    if (capability.mrt?.active === false) reason.push('Deferred lighting requires a supported material layout')
  }
  return {
    version: CAPABILITY_MATRIX_VERSION,
    managed: Object.fromEntries(CCR_MANAGED_DEFAULTS.map(name => [name, true])),
    deferred: {
      requested: deferredRequested,
      active: deferredActive,
      // 不支持时必须明确回退增强模式，而不是含糊其辞。
      effectiveMode: deferredActive ? 'deferred' : 'enhanced',
      coverage: coverageChecks,
      candidates: deferredCandidates,
      reason: reason.length ? reason.join('; ') : null
    },
    explicitOnly: Object.fromEntries(EXPLICIT_ONLY_EFFECTS.map(name => [name, {
      requested: readRequested(name, options),
      // 这些效果只能由预设显式开启，默认值为假。
      active: readRequested(name, options) && capabilitySatisfied(name, capability)
    }])),
    reason
  }
}

function readRequested(name, options) {
  const map = {
    hbao: options.screenSpaceAoEnabled === true && options.screenSpaceAoAlgorithm === 'hbao',
    ssr: options.screenSpaceReflectionEnabled === true,
    bloom: options.hdrBloomEnabled === true || options.bloom === true,
    deferredLighting: options.lightingMode === 'deferred',
    tiltShift: options.tiltShiftEnabled === true,
    blur: options.blurEnabled === true,
    depthOfField: options.depthOfFieldEnabled === true,
    chromaticAberration: options.chromaticAberrationEnabled === true,
    sunFlare: options.sunFlareEnabled === true,
    lightShaft: options.lightShaftEnabled === true
  }
  return map[name] === true
}

function capabilitySatisfied(name, capability) {
  // 依赖材质通道的效果需要 MRT 与浮点附件都可用。
  const needsMaterial = ['hbao', 'ssr', 'deferredLighting'].includes(name)
  if (needsMaterial) return capability.mrt?.active !== false && capability.floatAttachments?.active !== false
  // 其余效果（含 Bloom 与镜头效果）只依赖浮点附件。
  return capability.floatAttachments?.active !== false
}

/** 对外诊断文本：能力矩阵与默认策略一起给出，便于定位「为什么没生效」。 */
export function capabilityDiagnostics(probe = {}, options = {}, coverage = {}) {
  const capability = buildCapabilityMatrix(probe)
  return { capability, defaults: resolveDefaultPolicy({ options, capability, coverage }) }
}
