// B11 单元测试：能力矩阵与默认策略。
//
// 纪律：断言**可判定的判定结果**，而不是「诊断里出现过某个字段」。
// 重点是把已知缺口（MSAA × 延迟几何未实现）做成**必须回退**的判定，
// 使缺口不能被静默当成已支持。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_MATRIX_VERSION,
  CCR_MANAGED_DEFAULTS,
  EXPLICIT_ONLY_EFFECTS,
  mrtCapability,
  floatAttachmentCapability,
  oitCapability,
  msaaCapability,
  sceneModeCapability,
  multiFrustumCapability,
  buildCapabilityMatrix,
  resolveDefaultPolicy,
  capabilityDiagnostics
} from '../../src/diagnostics/capabilityMatrix143.js'

// --- MRT 槽位 ---------------------------------------------------------------

test('B11 capability matrix declares its contract version', () => {
  assert.equal(CAPABILITY_MATRIX_VERSION, 1)
})

test('the four compact layouts map onto device slot counts', () => {
  // 基础 4 槽；反射 +2 = 6；反射 + 不透明色 = 7；再 +albedo = 8。
  const cases = [
    [4, true], [6, true], [7, true], [8, true]
  ]
  for (const [slots, supported] of cases) {
    const result = mrtCapability({ maxDrawBuffers: 8, maxColorAttachments: 8, attachmentsNeeded: slots })
    assert.equal(result.active, supported, `${slots} slots on an 8-slot device`)
    assert.equal(result.requested, true)
  }
})

test('a device with fewer slots than the layout needs is refused with the exact shortfall', () => {
  const result = mrtCapability({ maxDrawBuffers: 4, maxColorAttachments: 4, attachmentsNeeded: 6 })
  assert.equal(result.requested, true)
  assert.equal(result.active, false)
  // 原因必须给出「需要几个 / 设备给几个」，而不是含糊的「不支持」。
  assert.match(result.reason, /requires 6 slots/)
  assert.match(result.reason, /allows 4/)
})

test('the binding limit is the smaller of draw buffers and colour attachments', () => {
  // 两个限制取交集：只满足一个不算通过。
  assert.equal(mrtCapability({ maxDrawBuffers: 8, maxColorAttachments: 4, attachmentsNeeded: 6 }).active, false)
  assert.equal(mrtCapability({ maxDrawBuffers: 4, maxColorAttachments: 8, attachmentsNeeded: 6 }).active, false)
  assert.equal(mrtCapability({ maxDrawBuffers: 6, maxColorAttachments: 6, attachmentsNeeded: 6 }).active, true)
})

test('missing or nonsensical limits are treated as zero rather than passing', () => {
  for (const probe of [{}, { maxDrawBuffers: NaN, maxColorAttachments: NaN },
    { maxDrawBuffers: undefined, maxColorAttachments: 8 }, { maxDrawBuffers: -1, maxColorAttachments: 8 }]) {
    const result = mrtCapability({ ...probe, attachmentsNeeded: 4 })
    assert.equal(result.active, false, JSON.stringify(probe))
  }
})

test('no layout requested is reported as not requested rather than as a failure', () => {
  const result = mrtCapability({ maxDrawBuffers: 8, maxColorAttachments: 8, attachmentsNeeded: 0 })
  assert.equal(result.requested, false)
  assert.equal(result.active, false)
  assert.match(result.reason, /No material layout requested/)
})

// --- 浮点附件 ---------------------------------------------------------------

test('float attachments require both full and half float support', () => {
  // compact-v1 同时用 RGBA32F 与 RGBA16F，任一缺失都不成立。
  const complete = floatAttachmentCapability({ floatingPointTexture: true, colorBufferFloat: true,
    halfFloatingPointTexture: true, colorBufferHalfFloat: true })
  assert.equal(complete.active, true)
  for (const missing of ['floatingPointTexture', 'colorBufferFloat', 'halfFloatingPointTexture', 'colorBufferHalfFloat']) {
    const probe = { floatingPointTexture: true, colorBufferFloat: true,
      halfFloatingPointTexture: true, colorBufferHalfFloat: true, [missing]: false }
    const result = floatAttachmentCapability(probe)
    assert.equal(result.active, false, missing)
    assert.ok(result.reason.includes(missing), `${missing} must be named in the reason`)
  }
})

test('all missing float capabilities are listed, not just the first', () => {
  const result = floatAttachmentCapability({})
  assert.equal(result.active, false)
  for (const name of ['floatingPointTexture', 'colorBufferFloat', 'halfFloatingPointTexture', 'colorBufferHalfFloat']) {
    assert.ok(result.reason.includes(name), `${name} must be reported`)
  }
})

// --- OIT --------------------------------------------------------------------

test('OIT off is reported as off rather than as a capability failure', () => {
  // 场景选择排序透明时不需要 OIT 纹理；把它报成「缺失」会误导排查。
  const result = oitCapability({ useOIT: false })
  assert.equal(result.requested, false)
  assert.equal(result.active, true)
  assert.match(result.reason, /sorted translucency/)
})

test('OIT on requires an implementation and both textures', () => {
  assert.equal(oitCapability({ useOIT: true, hasMrt: true, hasMultipass: false,
    accumulationTexture: true, revealageTexture: true }).active, true)
  assert.equal(oitCapability({ useOIT: true, hasMrt: false, hasMultipass: true,
    accumulationTexture: true, revealageTexture: true }).active, true)
  const none = oitCapability({ useOIT: true, hasMrt: false, hasMultipass: false })
  assert.equal(none.active, false)
  assert.match(none.reason, /No OIT implementation/)
  const noTextures = oitCapability({ useOIT: true, hasMrt: true, hasMultipass: false })
  assert.equal(noTextures.active, false)
  assert.match(noTextures.reason, /accumulation or revealage/)
})

// --- MSAA（已知缺口的可判定化）---------------------------------------------

test('MSAA combined with deferred geometry must fall back, not claim support', () => {
  // 这是 B02 公开的缺口：多采样下的延迟几何接管未实现。
  // 本测试把它锁成**必须回退**的判定，防止日后被静默当成已支持。
  const result = msaaCapability({ requestedSamples: 4, selectedSamples: 4, deferredGeometryActive: true })
  assert.equal(result.requested, true)
  assert.equal(result.active, false)
  assert.match(result.reason, /not implemented/)
  assert.match(result.reason, /enhanced/)
})

test('MSAA alone is active when the device grants the samples', () => {
  assert.equal(msaaCapability({ requestedSamples: 4, selectedSamples: 4 }).active, true)
  const denied = msaaCapability({ requestedSamples: 4, selectedSamples: 1 })
  assert.equal(denied.active, false)
  assert.match(denied.reason, /not granted/)
})

test('no MSAA requested is not a failure', () => {
  const result = msaaCapability({ requestedSamples: 1, selectedSamples: 1 })
  assert.equal(result.requested, false)
  assert.equal(result.active, true)
})

// --- 场景模式与多视锥 -------------------------------------------------------

test('non-3D scene modes are refused with a clear reason', () => {
  const result = sceneModeCapability({ mode: 'SCENE2D', scene3D: 'SCENE3D' })
  assert.equal(result.active, false)
  assert.match(result.reason, /3D scene mode/)
  assert.equal(sceneModeCapability({ mode: 'SCENE3D', scene3D: 'SCENE3D' }).active, true)
})

test('a non-perspective camera is refused', () => {
  const result = sceneModeCapability({ perspectiveCamera: false })
  assert.equal(result.active, false)
  assert.match(result.reason, /perspective camera/)
})

test('multi-frustum reports the current frustum count', () => {
  assert.equal(multiFrustumCapability({ frustumCount: 6 }).active, true)
  assert.equal(multiFrustumCapability({ frustumCount: 6 }).requested, true)
  // 单视锥不是「多视锥」，但仍然是有效状态。
  const single = multiFrustumCapability({ frustumCount: 1 })
  assert.equal(single.requested, false)
  assert.equal(single.active, true)
  const none = multiFrustumCapability({ frustumCount: 0 })
  assert.equal(none.active, false)
  assert.match(none.reason, /No current frusta/)
})

// --- 汇总与 generation ------------------------------------------------------

test('every capability entry carries requested, active, reason and generation', () => {
  const matrix = buildCapabilityMatrix({
    maxDrawBuffers: 8, maxColorAttachments: 8, attachmentsNeeded: 6,
    floatingPointTexture: true, colorBufferFloat: true, halfFloatingPointTexture: true, colorBufferHalfFloat: true,
    useOIT: true, hasMrt: true, accumulationTexture: true, revealageTexture: true,
    requestedSamples: 1, selectedSamples: 1, mode: 'SCENE3D', scene3D: 'SCENE3D',
    perspectiveCamera: true, frustumCount: 3, generation: 7
  })
  assert.equal(matrix.generation, 7)
  for (const key of ['mrt', 'floatAttachments', 'oit', 'msaa', 'sceneMode', 'multiFrustum']) {
    const entry = matrix[key]
    assert.ok('requested' in entry, `${key}.requested`)
    assert.ok('active' in entry, `${key}.active`)
    assert.ok('reason' in entry, `${key}.reason`)
    assert.equal(entry.generation, 7, `${key}.generation must carry the probe generation`)
  }
})

test('generation propagates so a stale report can be identified', () => {
  const first = buildCapabilityMatrix({ attachmentsNeeded: 4, maxDrawBuffers: 8, maxColorAttachments: 8, generation: 1 })
  const second = buildCapabilityMatrix({ attachmentsNeeded: 4, maxDrawBuffers: 8, maxColorAttachments: 8, generation: 2 })
  assert.equal(first.generation, 1)
  assert.equal(second.generation, 2)
  assert.notEqual(first.generation, second.generation)
})

// --- 默认策略 ---------------------------------------------------------------

test('CCR manages sky, environment, shadows, HDR and SMAA by default', () => {
  assert.deepEqual([...CCR_MANAGED_DEFAULTS], ['sky', 'environment', 'shadows', 'hdr', 'smaa'])
  const policy = resolveDefaultPolicy({})
  for (const name of CCR_MANAGED_DEFAULTS) assert.equal(policy.managed[name], true, name)
})

test('expensive effects are explicit-only and never default on', () => {
  // 计划：「不能『默认CCR』就自动全开高成本效果」。
  for (const name of ['hbao', 'ssr', 'bloom', 'deferredLighting', 'tiltShift', 'blur',
    'depthOfField', 'chromaticAberration', 'sunFlare', 'lightShaft']) {
    assert.ok(EXPLICIT_ONLY_EFFECTS.includes(name), `${name} must be explicit-only`)
  }
  const policy = resolveDefaultPolicy({ options: {} })
  for (const name of EXPLICIT_ONLY_EFFECTS) {
    assert.equal(policy.explicitOnly[name].requested, false, `${name} must default to not requested`)
    assert.equal(policy.explicitOnly[name].active, false, `${name} must default to inactive`)
  }
})

test('deferred lighting is not a candidate default until coverage is complete', () => {
  // 计划：「延迟模式仅在 B01–B03/覆盖矩阵全部通过后进入候选默认」。
  const policy = resolveDefaultPolicy({
    options: { lightingMode: 'deferred' },
    capability: { mrt: { active: true }, floatAttachments: { active: true } },
    coverage: { opaqueLoop: true, transparentLoop: true, ssr: false, msaa: false }
  })
  assert.equal(policy.deferred.requested, true)
  assert.equal(policy.deferred.candidates, false)
  assert.equal(policy.deferred.active, false)
  // 不支持时必须**明确**回退增强模式。
  assert.equal(policy.deferred.effectiveMode, 'enhanced')
  assert.match(policy.deferred.reason, /not a candidate default yet/)
  assert.match(policy.deferred.reason, /ssr/)
  assert.match(policy.deferred.reason, /msaa/)
})

test('deferred lighting becomes active only with full coverage and a supported layout', () => {
  const full = { opaqueLoop: true, transparentLoop: true, ssr: true, msaa: true }
  const active = resolveDefaultPolicy({
    options: { lightingMode: 'deferred' },
    capability: { mrt: { active: true }, floatAttachments: { active: true } },
    coverage: full
  })
  assert.equal(active.deferred.candidates, true)
  assert.equal(active.deferred.active, true)
  assert.equal(active.deferred.effectiveMode, 'deferred')
  assert.equal(active.deferred.reason, null)
  // 覆盖齐全但设备布局不支持时仍必须回退。
  const unsupported = resolveDefaultPolicy({
    options: { lightingMode: 'deferred' },
    capability: { mrt: { active: false }, floatAttachments: { active: true } },
    coverage: full
  })
  assert.equal(unsupported.deferred.active, false)
  assert.equal(unsupported.deferred.effectiveMode, 'enhanced')
  assert.match(unsupported.deferred.reason, /supported material layout/)
})

test('enhanced lighting is the default and needs no coverage', () => {
  const policy = resolveDefaultPolicy({ options: { lightingMode: 'enhanced' } })
  assert.equal(policy.deferred.requested, false)
  assert.equal(policy.deferred.active, false)
  assert.equal(policy.deferred.effectiveMode, 'enhanced')
  assert.equal(policy.deferred.reason, null)
})

test('material-dependent effects are gated on the layout and float attachments', () => {
  const blocked = resolveDefaultPolicy({
    options: { screenSpaceReflectionEnabled: true, screenSpaceAoEnabled: true, screenSpaceAoAlgorithm: 'hbao' },
    capability: { mrt: { active: false }, floatAttachments: { active: true } }
  })
  assert.equal(blocked.explicitOnly.ssr.requested, true)
  assert.equal(blocked.explicitOnly.ssr.active, false, 'ssr must not claim to be active without a layout')
  assert.equal(blocked.explicitOnly.hbao.active, false)
})

test('non-material effects only need float attachments', () => {
  const policy = resolveDefaultPolicy({
    options: { hdrBloomEnabled: true, chromaticAberrationEnabled: true },
    capability: { mrt: { active: false }, floatAttachments: { active: true } }
  })
  assert.equal(policy.explicitOnly.bloom.requested, true)
  assert.equal(policy.explicitOnly.bloom.active, true, 'bloom does not depend on the material layout')
  assert.equal(policy.explicitOnly.chromaticAberration.active, true)
})

test('screen-space AO with the hbao algorithm is distinguished from plain AO', () => {
  const ssao = resolveDefaultPolicy({ options: { screenSpaceAoEnabled: true, screenSpaceAoAlgorithm: 'ssao' },
    capability: { mrt: { active: true }, floatAttachments: { active: true } } })
  assert.equal(ssao.explicitOnly.hbao.requested, false, 'plain AO is not HBAO')
  const hbao = resolveDefaultPolicy({ options: { screenSpaceAoEnabled: true, screenSpaceAoAlgorithm: 'hbao' },
    capability: { mrt: { active: true }, floatAttachments: { active: true } } })
  assert.equal(hbao.explicitOnly.hbao.requested, true)
})

test('string or numeric enable flags are not treated as enabled', () => {
  const policy = resolveDefaultPolicy({ options: { screenSpaceReflectionEnabled: 'true', hdrBloomEnabled: 1 } })
  assert.equal(policy.explicitOnly.ssr.requested, false)
  assert.equal(policy.explicitOnly.bloom.requested, false)
})

test('the combined diagnostics expose both the matrix and the policy', () => {
  const diagnostics = capabilityDiagnostics({ attachmentsNeeded: 4, maxDrawBuffers: 8, maxColorAttachments: 8 },
    { lightingMode: 'deferred' }, { opaqueLoop: true })
  assert.equal(diagnostics.capability.version, CAPABILITY_MATRIX_VERSION)
  assert.equal(diagnostics.defaults.deferred.effectiveMode, 'enhanced')
  assert.equal(diagnostics.capability.mrt.active, true)
})
