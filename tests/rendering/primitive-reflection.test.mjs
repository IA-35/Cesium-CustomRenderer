// B07 单元测试：普通 Primitive / Globe water mask 的反射接入契约。
//
// 这些测试只断言**真实行为**（生成出的 GLSL 结构与判据），不断言「源码包含某字符串」
// 这类弱证据。每个判据都对应主计划 B07 的一条验收线，并在注释里写明它防的是什么缺陷。
//
// 重要边界：文本层面的测试**测不出编译失败**。本轮就有一个真实缺陷只在真实 GPU 编译时
// 暴露（helper 在 v_positionEC 声明之前引用它 → `undeclared identifier`）。
// 因此这里同时断言「被调用的符号已声明」「括号与预处理分支配对」，并在
// scripts/check-ssr-surfaces.cjs 里用真实 GPU 编译做端到端确认。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRIMITIVE_REFLECTION_VERSION,
  ROUGHNESS_FROM_SHININESS,
  F0_FROM_SPECULAR,
  primitiveReflectionSupport,
  primitiveReflectionSources,
  globeWaterSources,
  primitiveReflectionDiagnostics
} from '../../src/reflections/PrimitiveReflection143.js'

// Cesium 打包后的着色器名挂在全局 Cesium 对象上。这里的假实现**照抄引擎真实着色器
// 的声明与输出语句**（node_modules/@cesium/engine/Source/Shaders/Appearances/*.glsl），
// 因为被测代码正是按这些声明与语句做定位的。三个 stage 必须彼此**内容不同**：
// 真实引擎里 AllMaterialAppearanceFS 有切线插值、TexturedMaterialAppearanceFS 没有、
// EllipsoidSurfaceAppearanceFS 连 v_normalEC 都没有（法线由大地水面法线算出）。
// 若假实现让两个 stage 内容相同，实现会（正确地）因「stage 命中不唯一」而拒绝，
// 测试就变成在测夹具自己的错误。
const ALL_MATERIAL_FS = `in vec3 v_positionEC;
in vec3 v_normalEC;
in vec3 v_tangentEC;
in vec3 v_bitangentEC;
in vec2 v_st;
void main() {
    vec3 positionToEyeEC = -v_positionEC;
    mat3 tangentToEyeMatrix = czm_tangentToEyeSpaceMatrix(v_normalEC, v_tangentEC, v_bitangentEC);
    czm_materialInput materialInput;
    materialInput.normalEC = normalize(v_normalEC);
    czm_material material = czm_getMaterial(materialInput);
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
}`
const TEXTURED_FS = `in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
void main() {
    vec3 positionToEyeEC = -v_positionEC;
    czm_materialInput materialInput;
    materialInput.normalEC = normalize(v_normalEC);
    czm_material material = czm_getMaterial(materialInput);
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
}`
// EllipsoidSurfaceAppearanceFS 的真实特征：只用 v_positionMC / v_positionEC / v_st，
// 没有 v_normalEC 插值，靠 czm_materialInput 声明通过法线检查。
const ELLIPSOID_FS = `in vec3 v_positionMC;
in vec3 v_positionEC;
in vec2 v_st;
void main() {
    czm_materialInput materialInput;
    materialInput.normalEC = normalize(czm_normal3D * czm_geodeticSurfaceNormal(v_positionMC, vec3(0.0), vec3(1.0)));
    vec3 positionToEyeEC = -v_positionEC;
    czm_material material = czm_getMaterial(materialInput);
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
}`
// BasicMaterialAppearanceFS：只有 v_positionEC / v_normalEC，没有 v_st。
// 照抄 node_modules/@cesium/engine/Source/Shaders/Appearances/BasicMaterialAppearanceFS.glsl。
const BASIC_FS = `in vec3 v_positionEC;
in vec3 v_normalEC;

void main()
{
    vec3 positionToEyeEC = -v_positionEC;

    vec3 normalEC = normalize(v_normalEC);
#ifdef FACE_FORWARD
    normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
#endif

    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = positionToEyeEC;
    czm_material material = czm_getMaterial(materialInput);

#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
}`
// FLAT 的真实形态：**两个分支文本同时存在**，由 #ifdef 选择编译哪一个。
// 夹具必须照抄这一点，否则「按 FLAT define 选对改写目标」这个真实缺陷测不出来。
const FLAT_FS = `in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
void main() {
    vec3 positionToEyeEC = -v_positionEC;
    czm_materialInput materialInput;
    materialInput.normalEC = normalize(v_normalEC);
    czm_material material = czm_getMaterial(materialInput);
#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else
    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
#endif
}`
// GlobeFS 的真实关键点：两个空格、无条件存在的 v_normalEC / v_positionEC、
// 以及受 HAS_WATER_MASK 保护的 mask 采样块。
const GLOBE_FS = `in vec3 v_positionEC;
in vec3 v_normalEC;
in vec3 v_textureCoordinates;
#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
uniform sampler2D u_waterMask;
uniform vec4 u_waterMaskTranslationAndScale;
#endif
void main() {
    vec4 finalColor = vec4(1.0);
    out_FragColor =  finalColor;
}`

// --- 真实命令结构（浏览器 dump 得到，见 docs/B07_RECONNAISSANCE.md）-----------
// 这是本轮修复的最重要一处认知偏差。真实命令的 sources 是**两段**，且
// appearance 主体并不单独成段：Cesium 把材质定义与 appearance 主体拼进同一段，
// 并把 main 改名为 czm_log_depth_main（log-depth 变体）。
//
//   source 0 = [材质定义] + [appearance 主体，main -> czm_log_depth_main]
//   source 1 = void main(){ czm_log_depth_main(); czm_writeLogDepth(); }
//
// 若实现要求「整段等于 appearance 模板」，真实命令会被全部拒绝，B07 一条都不生效；
// 这类缺陷在只看模板的假夹具下测不出来，因此这里复刻真实两段结构。
const MATERIAL_PREFIX = `in vec4 v_pickColor;
#define FACE_FORWARD
uniform vec4 color_0;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = czm_gammaCorrect(color_0.rgb);
    material.alpha = color_0.a;
    return material;
}
`
const LOG_DEPTH_TAIL = `
void main()
{
    czm_log_depth_main();
    czm_writeLogDepth();
}
`

/** 构造一个与真实命令同构的程序：材质前缀 + 改名后的 appearance 主体 + log-depth 尾段。 */
function realShapeProgram(C, { defines = ['LOG_DEPTH'], stage = null } = {}) {
  const template = stage || C._shadersAllMaterialAppearanceFS.trim()
  // Cesium 用 replaceMain 把 main 改成 czm_log_depth_main。
  const renamed = template.replace(/\bvoid\s+main\s*\(/, 'void czm_log_depth_main(')
  const sources = [MATERIAL_PREFIX + renamed, LOG_DEPTH_TAIL]
  const fs = {
    sources, defines: defines.slice(),
    clone() { return { sources: this.sources.slice(), defines: this.defines.slice(), clone: this.clone } }
  }
  return { vertexShaderSource: { sources: ['void main(){}'], defines: defines.slice() }, fragmentShaderSource: fs }
}

function Cesium(overrides = {}) {
  return {
    _shadersAllMaterialAppearanceFS: ALL_MATERIAL_FS,
    _shadersEllipsoidSurfaceAppearanceFS: ELLIPSOID_FS,
    _shadersTexturedMaterialAppearanceFS: TEXTURED_FS,
    // BasicMaterialAppearanceFS 确实存在于打包构建中（已核对 Cesium.js），
    // 且它是最常见的 Primitive 外观之一，必须可被接入。
    _shadersBasicMaterialAppearanceFS: BASIC_FS,
    _shadersGlobeFS: GLOBE_FS,
    ...overrides
  }
}

/** 构造一个像 Cesium ShaderSource 那样的对象：sources 数组 + defines 数组 + clone()。 */
function program(C, { sources = [ALL_MATERIAL_FS], defines = [], vsDefines = [], vs = 'void main(){}' } = {}) {
  const fs = {
    sources: sources.slice(), defines: defines.slice(),
    clone() {
      const copy = { sources: this.sources.slice(), defines: this.defines.slice(), clone: this.clone }
      return copy
    }
  }
  return { vertexShaderSource: { sources: [vs], defines: vsDefines }, fragmentShaderSource: fs }
}

const hasSource = (result, needle) => result.fragmentShaderSource.sources.some(source => source.includes(needle))
const CALL = 'ccr_primitiveOutputs(material, ccr_primitiveColor, -v_positionEC.z);'

// --- 版本与支持判据 ---------------------------------------------------------

test('B07 primitive reflection declares its contract version', () => {
  assert.equal(PRIMITIVE_REFLECTION_VERSION, 1)
})

test('support accepts a real AllMaterialAppearance phong program', () => {
  const C = Cesium()
  const support = primitiveReflectionSupport(C, program(C))
  assert.equal(support.supported, true)
  assert.equal(support.family, 'appearance')
})

test('support accepts the FLAT branch because it still has real normal and depth', () => {
  const C = Cesium()
  const support = primitiveReflectionSupport(C, program(C, { sources: [FLAT_FS], defines: ['FLAT'] }))
  assert.equal(support.supported, true)
  assert.equal(support.family, 'appearanceFlat')
})

test('support rejects derived wrappers so picking and shadow casting keep their own output', () => {
  const C = Cesium()
  for (const marker of ['czm_non_pick_main', 'czm_shadow_cast_main', 'czm_translucent_main', 'czm_out_FragColor']) {
    const source = `${ALL_MATERIAL_FS} void czm_wrapper(){ ${marker}(); }`
    const support = primitiveReflectionSupport(C, program(C, { sources: [source] }))
    assert.equal(support.supported, false, `${marker} must be rejected`)
    assert.equal(support.reason, 'derived wrapper')
  }
})

test('support rejects programs another adapter already redirected', () => {
  const C = Cesium()
  const redirected = primitiveReflectionSupport(C, program(C, { defines: ['CESIUM_REDIRECTED_COLOR_OUTPUT'] }))
  assert.equal(redirected.supported, false)
  assert.equal(redirected.reason, 'already redirected')
  const mrt = primitiveReflectionSupport(C, program(C, { sources: [ALL_MATERIAL_FS, 'layout(location = 1) out vec4 other;'] }))
  assert.equal(mrt.supported, false)
  assert.equal(mrt.reason, 'already redirected')
})

test('support rejects picking, shadow and OIT variants by their defines', () => {
  const C = Cesium()
  for (const define of ['METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT']) {
    const support = primitiveReflectionSupport(C, program(C, { defines: [define] }))
    assert.equal(support.supported, false, define)
    assert.equal(support.reason, 'picking/shadow/OIT variant')
  }
})

test('support rejects an unmapped appearance and reports why', () => {
  const C = Cesium()
  const support = primitiveReflectionSupport(C, program(C, { sources: ['void main(){ out_FragColor = vec4(1.0); }'] }))
  assert.equal(support.supported, false)
  assert.equal(support.reason, 'not a supported appearance')
})

test('support rejects an appearance without eye-space position so depth cannot be produced', () => {
  const C = Cesium()
  // 只提供 v_normalEC（满足法线检查），但不含 v_positionEC / materialInput：
  // 无法产出米制视深度，必须拒绝而不是写出一个错误的深度。
  const noPosition = `in vec3 v_normalEC;
void main() {
    czm_material material;
    out_FragColor = czm_phong(normalize(v_normalEC), material, czm_lightDirectionEC);
}`
  const support = primitiveReflectionSupport(C, program(C, { sources: [noPosition] }))
  assert.equal(support.supported, false)
})

test('support rejects a program whose stage appears more than once instead of guessing', () => {
  const C = Cesium()
  const support = primitiveReflectionSupport(C, program(C, { sources: [ALL_MATERIAL_FS, ALL_MATERIAL_FS] }))
  assert.equal(support.supported, false)
})

// --- 真实两段命令结构 -------------------------------------------------------

test('real two-segment command shape is recognised (material prefix + renamed main)', () => {
  const C = Cesium()
  const support = primitiveReflectionSupport(C, realShapeProgram(C))
  assert.equal(support.supported, true, `real commands must be supported, got ${support.reason}`)
  // 主体必须是段内子区间，而不是整段。
  assert.equal(support.stage.index, 0)
  assert.ok(support.stage.start > 0, 'the appearance body starts after the material definition')
  assert.ok(support.stage.end > support.stage.start)
})

test('real two-segment command patches only the appearance body, leaving the material definition intact', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, realShapeProgram(C))
  assert.ok(result, 'real-shaped command must be patchable')
  const patched = result.fragmentShaderSource.sources[1]
  // 材质定义必须原样保留（它定义了 czm_getMaterial，动它就等于换了材质）。
  assert.ok(patched.includes('material.diffuse = czm_gammaCorrect(color_0.rgb);'), 'material definition must survive')
  assert.ok(patched.includes('czm_material czm_getMaterial(czm_materialInput materialInput)'))
  // 主体被改写。
  assert.ok(patched.includes(CALL))
  // 且仍保留 log-depth 的函数名与尾段调用。
  assert.ok(patched.includes('void czm_log_depth_main()'), 'the renamed entry point must survive')
  assert.ok(result.fragmentShaderSource.sources[2].includes('czm_log_depth_main();'), 'the tail must still call the renamed main')
})

test('a command whose appearance body appears twice is rejected instead of guessed', () => {
  const C = Cesium()
  const template = C._shadersAllMaterialAppearanceFS.trim()
  const doubled = `${MATERIAL_PREFIX}${template}\n${template}`
  const fs = { sources: [doubled], defines: [], clone() { return { sources: this.sources.slice(), defines: this.defines.slice(), clone: this.clone } } }
  const support = primitiveReflectionSupport(C, { vertexShaderSource: { sources: ['v'], defines: [] }, fragmentShaderSource: fs })
  assert.equal(support.supported, false)
})

test('a material whose own text contains no appearance body is never claimed', () => {
  const C = Cesium()
  const onlyMaterial = `${MATERIAL_PREFIX}\nvoid main(){ out_FragColor = vec4(1.0); }`
  const fs = { sources: [onlyMaterial], defines: [], clone() { return { sources: this.sources.slice(), defines: this.defines.slice(), clone: this.clone } } }
  const support = primitiveReflectionSupport(C, { vertexShaderSource: { sources: ['v'], defines: [] }, fragmentShaderSource: fs })
  assert.equal(support.supported, false)
  assert.equal(support.reason, 'not a supported appearance')
})

test('BasicMaterialAppearance is recognised as a supported appearance', () => {
  const C = Cesium()
  // 必须用夹具自己的 BASIC_FS：被测代码是按 C._shadersBasicMaterialAppearanceFS
  // 去匹配的，若测试另写一份近似文本，匹配的就不是同一个东西。
  const support = primitiveReflectionSupport(C, realShapeProgram(C, { stage: C._shadersBasicMaterialAppearanceFS }))
  assert.equal(support.supported, true, `BasicMaterialAppearance must be supported, got ${support.reason}`)
})

// --- 生成结果的正确性 -------------------------------------------------------

test('generated sources never set STANDARD_PBR_VALID so deferred lighting cannot relight primitives', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C), { reflection: true, opaqueColor: true })
  assert.ok(result)
  // flags 字面量为 11 = SURFACE(1) | NORMAL_VALID(2) | EMISSIVE_VALID(8)。
  // 关键在于**没有** 512：DeferredLighting143 的片元着色器以 flags & 512 为
  // discard 判据（deferredLightingShader143.js:36），不设置即不会被延迟着色接管。
  assert.ok(hasSource(result, 'float campus_primitiveFlags = 11.0;'))
  assert.ok(!hasSource(result, '512.0'))
})

test('generated sources write eye-space normal, metric depth and zero coverage to the shared attachments', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C))
  assert.ok(result)
  assert.ok(hasSource(result, 'out_FragColor = vec4(ccr_primitiveOctNormal(ccr_primitiveNormal), ccr_primitiveRoughness(material.shininess), 0.0);'))
  // 深度必须是米制正视深度：取 -v_positionEC.z，而不是 window depth 或 gl_FragCoord.z。
  // 注意它由**调用点**传入 helper（helper 在 v_positionEC 声明之前，不能直接引用它）。
  assert.ok(hasSource(result, CALL))
  assert.ok(hasSource(result, 'ccr_primitiveDepth = eyeDepth;'))
  assert.ok(hasSource(result, 'ccr_primitiveCoverage = 0.0;'))
  assert.ok(result.fragmentShaderSource.defines.includes('CESIUM_REDIRECTED_COLOR_OUTPUT'))
})

test('generated sources keep the native phong result when opaque color is requested', () => {
  const C = Cesium()
  const withColor = primitiveReflectionSources(C, program(C), { opaqueColor: true })
  assert.ok(withColor)
  assert.ok(hasSource(withColor, 'ccr_primitiveOpaqueColor = nativeColor;'))
  // 授权 opaqueColor 时才声明该附件。
  assert.ok(withColor.fragmentShaderSource.sources.some(source => source.includes('layout(location = 6) out vec4 ccr_primitiveOpaqueColor;')))
  const without = primitiveReflectionSources(C, program(C), { opaqueColor: false })
  assert.ok(without)
  assert.ok(!without.fragmentShaderSource.sources.some(source => source.includes('ccr_primitiveOpaqueColor')))
})

test('generated sources declare reflection attachments only when reflection is requested', () => {
  const C = Cesium()
  const on = primitiveReflectionSources(C, program(C), { reflection: true })
  assert.ok(on)
  assert.ok(on.fragmentShaderSource.sources.some(source => source.includes('layout(location = 4) out vec4 ccr_primitiveSpecular;')))
  assert.ok(hasSource(on, 'ccr_primitiveResponse = vec4(ccr_primitiveF0(material.specular), ccr_primitiveRoughness(material.shininess));'))
  const off = primitiveReflectionSources(C, program(C), { reflection: false })
  assert.ok(off)
  assert.ok(!off.fragmentShaderSource.sources.some(source => source.includes('ccr_primitiveSpecular')))
})

test('reflection response carries roughness in alpha so the shared confidence path applies', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C), { reflection: true })
  // traceReflection 以 response.a 选预算与半径，reflectionHitConfidence 以 roughness
  // 做 smoothstep 衰减。alpha 必须承载 roughness，否则粗糙表面会拿到镜面级反射。
  assert.match(ROUGHNESS_FROM_SHININESS, /sqrt\(2\.0\/\(max\(shininess,0\.0\)\+2\.0\)\)/)
  assert.ok(hasSource(result, ', ccr_primitiveRoughness(material.shininess));'))
})

test('roughness mapping matches the B03 water forward path to avoid two scales for one surface', async () => {
  // B03 的 ccr_waterLighting 使用 clamp(sqrt(2.0/(water.shininess+2.0)),0.04,1.0)。
  // 两处必须同式，否则同一水面在照明与反射之间出现两套粗糙度尺度。
  const { readFileSync } = await import('node:fs')
  const forward = readFileSync(new URL('../../src/pipeline/transparentForwardShader143.js', import.meta.url), 'utf8')
  assert.match(forward, /sqrt\(2\.0\/\(water\.shininess\+2\.0\)\)/)
  assert.match(ROUGHNESS_FROM_SHININESS, /sqrt\(2\.0\/\(max\(shininess,0\.0\)\+2\.0\)\)/)
})

test('generated sources preserve the native material evaluation at the call site', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C))
  assert.ok(result)
  // 原生 czm_phong 必须在调用点真的被调用，不能只写我们的输出而丢掉原生求值。
  assert.ok(hasSource(result, 'vec4 ccr_primitiveColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);'))
  // 且必须把求值结果传下去（关闭 opaqueColor 时也不允许被当作死代码删除）。
  assert.ok(hasSource(result, CALL))
  assert.ok(hasSource(result, 'if (nativeColor.a < -1.0) out_FragColor.a = 0.0;'))
})

test('material normal is used so NormalMap perturbation reaches the reflection receiver', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C))
  assert.ok(result)
  // czm_getDefaultMaterial 把 material.normal 初始化为 materialInput.normalEC，
  // NormalMapMaterial 会把它改写为切线空间扰动结果。用 material.normal 才能拿到
  // 「同一次材质求值」的法线；用调用点的裸 normalEC 会丢掉法线贴图。
  assert.ok(hasSource(result, 'vec3 ccr_primitiveNormal = material.normal;'))
})

test('the eye-depth parameter is passed in rather than referenced inside the helper', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C))
  assert.ok(result)
  // helper 被插在整份着色器最前面，而 `in vec3 v_positionEC;` 由后面的 appearance
  // 段声明。若 helper 函数体里直接引用 v_positionEC，会编译失败
  // （实测：`'v_positionEC' : undeclared identifier`）。
  const helper = result.fragmentShaderSource.sources
    .find(source => /void\s+ccr_primitiveOutputs\s*\(/.test(source))
  assert.ok(helper, 'the helper must be emitted')
  assert.ok(/void\s+ccr_primitiveOutputs\s*\(\s*czm_material\s+\w+,\s*vec4\s+\w+,\s*float\s+\w+\s*\)/.test(helper),
    'the helper must take eye depth as a parameter')
  const body = helper.slice(helper.indexOf('void ccr_primitiveOutputs'))
  assert.ok(!/\bv_positionEC\b/.test(body),
    'the helper body must not reference v_positionEC — it is declared later and would not compile')
})

test('an unpatched program returns null rather than a silently unchanged source', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C, { sources: ['void main(){ out_FragColor = vec4(1.0); }'] }))
  assert.equal(result, null)
})

test('the original program is not mutated by patching', () => {
  const C = Cesium()
  const original = program(C)
  const before = original.fragmentShaderSource.sources.slice()
  primitiveReflectionSources(C, original, { reflection: true })
  assert.deepEqual(original.fragmentShaderSource.sources, before)
  assert.deepEqual(original.fragmentShaderSource.defines, [])
})

// --- FLAT 变体的改写目标 ----------------------------------------------------

test('FLAT variant patches the flat output, not the uncompiled phong branch', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C, { sources: [FLAT_FS], defines: ['FLAT'] }))
  assert.ok(result, 'FLAT variant must be patchable')
  // 定位**调用点所在的那个 source**。注意不能只找 'ccr_primitiveOutputs'：
  // helper 的声明里也有这个名字，会误命中 helper 自身。
  const patched = result.fragmentShaderSource.sources.find(source => source.includes(CALL))
  assert.ok(patched)
  assert.ok(patched.includes('vec4 ccr_primitiveColor = vec4(material.diffuse + material.emission, material.alpha);'))
  // #else 分支里的原生 phong 调用必须**保持原样**未被改写。
  assert.ok(patched.includes('out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);'),
    'the non-compiled phong branch must be left untouched')
  const callIndex = patched.indexOf(CALL)
  assert.ok(callIndex > patched.indexOf('#ifdef FLAT'), 'MRT outputs must live after #ifdef FLAT')
  assert.ok(callIndex < patched.indexOf('#else'), 'MRT outputs must live in the FLAT branch')
})

test('non-FLAT variant patches the phong output, not the uncompiled flat branch', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C))
  assert.ok(result)
  const patched = result.fragmentShaderSource.sources.find(source => source.includes(CALL))
  assert.ok(patched)
  assert.ok(patched.includes('vec4 ccr_primitiveColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);'))
  assert.ok(patched.includes('out_FragColor = vec4(material.diffuse + material.emission, material.alpha);'))
  assert.ok(patched.indexOf(CALL) > patched.indexOf('#else'), 'MRT outputs must live in the #else (non-FLAT) branch')
})

// --- 生成结果的完整性与可编译性 ---------------------------------------------

test('every helper the patched stage calls is declared before use', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C), { reflection: true, opaqueColor: true })
  assert.ok(result)
  const sources = result.fragmentShaderSource.sources
  const called = new Set()
  for (const match of sources.join('\n').matchAll(/\b(ccr_[A-Za-z0-9_]+)\s*\(/g)) called.add(match[1])
  for (const name of called) {
    const declared = sources.some(source => new RegExp(`\\b(?:void|float|vec[234]|mat[234])\\s+${name}\\s*\\(`).test(source))
    assert.ok(declared, `${name} is called but never declared — this would fail to compile`)
  }
})

test('generated shader keeps preprocessor branches balanced', () => {
  const C = Cesium()
  for (const [label, options, defines] of [['phong', {}, []], ['flat', {}, ['FLAT']], ['reflection', { reflection: true }, []], ['opaque', { opaqueColor: true }, []]]) {
    const result = primitiveReflectionSources(C, program(C, { defines }), options)
    assert.ok(result, label)
    const text = result.fragmentShaderSource.sources.join('\n')
    const opens = (text.match(/^\s*#\s*(?:if|ifdef|ifndef)\b/gm) || []).length
    const closes = (text.match(/^\s*#\s*endif\b/gm) || []).length
    assert.equal(opens, closes, `${label}: #if/#endif must stay balanced`)
  }
})

test('generated shader keeps braces balanced', () => {
  const C = Cesium()
  const result = primitiveReflectionSources(C, program(C), { reflection: true, opaqueColor: true })
  assert.ok(result)
  const text = result.fragmentShaderSource.sources.join('\n')
  const code = text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
  const open = (code.match(/\{/g) || []).length
  const close = (code.match(/\}/g) || []).length
  assert.equal(open, close, 'braces must balance')
})

test('every declared MRT output is actually written on the active path', () => {
  const C = Cesium()
  for (const [label, options, expected] of [
    ['base', {}, ['ccr_primitiveEmissiveFlags', 'ccr_primitiveDepth', 'ccr_primitiveCoverage']],
    ['reflection', { reflection: true }, ['ccr_primitiveSpecular', 'ccr_primitiveResponse']],
    ['opaque', { opaqueColor: true }, ['ccr_primitiveOpaqueColor']],
  ]) {
    const result = primitiveReflectionSources(C, program(C), options)
    assert.ok(result, label)
    const declarations = result.fragmentShaderSource.sources.filter(source => /layout\s*\(\s*location/.test(source)).join('\n')
    const body = result.fragmentShaderSource.sources.filter(source => /void\s+ccr_primitiveOutputs\s*\(/.test(source)).join('\n')
    for (const name of expected) {
      assert.ok(new RegExp(`out\\s+\\w+\\s+${name}\\s*;`).test(declarations), `${label}: ${name} must be declared`)
      assert.ok(body.includes(`${name} =`), `${label}: ${name} must be written`)
    }
  }
})

// --- Globe water mask -------------------------------------------------------

test('globe water receiver requires HAS_WATER_MASK and reports nothing otherwise', () => {
  const C = Cesium()
  const without = globeWaterSources(C, program(C, { sources: [GLOBE_FS] }))
  assert.equal(without, null, 'a terrain source without a water mask must be reported as unavailable, not faked')
})

test('globe water receiver samples the mask exactly like GlobeFS including the y flip', () => {
  const C = Cesium()
  const result = globeWaterSources(C, program(C, { sources: [GLOBE_FS], defines: ['HAS_WATER_MASK'] }), { reflection: true, opaqueColor: true })
  assert.ok(result)
  // 与 GlobeFS.js:392-397 一致的 scale/translation 与 y 翻转；漏掉 y 翻转会让
  // 掩码上下颠倒，水面出现在错误半球。
  assert.ok(hasSource(result, 'v_textureCoordinates.xy * u_waterMaskTranslationAndScale.zw + u_waterMaskTranslationAndScale.xy'))
  assert.ok(hasSource(result, 'ccr_globeUv.y = 1.0 - ccr_globeUv.y;'))
  assert.ok(hasSource(result, 'texture(u_waterMask, ccr_globeUv).r'))
})

test('globe water receiver keeps imagery and only marks water as a reflection receiver', () => {
  const C = Cesium()
  const result = globeWaterSources(C, program(C, { sources: [GLOBE_FS], defines: ['HAS_WATER_MASK'] }), { reflection: true, opaqueColor: true })
  assert.ok(result)
  // 影像颜色原样进入 opaqueColor，不被改写。
  assert.ok(hasSource(result, 'ccr_primitiveOpaqueColor = ccr_globeColor;'))
  // 只有水域成为接收端；非水地面 flags 为 0，既不参与 SSR 也不被金属化。
  assert.ok(hasSource(result, 'ccr_primitiveEmissiveFlags = vec4(0.0, 0.0, 0.0, ccr_globeIsWater ? 3.0 : 0.0);'))
  assert.ok(hasSource(result, 'ccr_primitiveSpecular = vec4(ccr_globeIsWater ? vec3(0.02) : vec3(0.0), ccr_globeIsWater ? 1.0 : 0.0);'))
})

test('globe water receiver does not reference block-scoped or conditionally declared names', () => {
  const C = Cesium()
  const result = globeWaterSources(C, program(C, { sources: [GLOBE_FS], defines: ['HAS_WATER_MASK'] }), { reflection: true })
  assert.ok(result)
  // `mask` 声明在 GlobeFS.js:391 的 #if 块内，在 out_FragColor 处已超出作用域；
  // `normalEC` 由 SHOW_REFLECTIVE_OCEAN||ENABLE_DAYNIGHT_SHADING||HDR 保护
  // (GlobeFS.js:339-342)。引用它们会编译失败，必须用 v_normalEC 重新采样。
  const patched = result.fragmentShaderSource.sources.find(source => source.includes('ccr_globeIsWater'))
  assert.ok(patched)
  assert.ok(!/\bmask\b/.test(patched.replace(/u_waterMask/g, '')), 'must not reference the block-scoped mask')
  assert.ok(!/\bnormalEC\b/.test(patched), 'must not reference the conditionally declared normalEC')
  assert.ok(hasSource(result, 'normalize(v_normalEC)'))
})

test('globe water receiver declares every helper it calls', () => {
  const C = Cesium()
  const result = globeWaterSources(C, program(C, { sources: [GLOBE_FS], defines: ['HAS_WATER_MASK'] }), { reflection: true, opaqueColor: true })
  assert.ok(result)
  const sources = result.fragmentShaderSource.sources
  const called = new Set()
  for (const match of sources.join('\n').matchAll(/\b(ccr_[A-Za-z0-9_]+)\s*\(/g)) called.add(match[1])
  for (const name of called) {
    const declared = sources.some(source => new RegExp(`\\b(?:void|float|vec[234]|mat[234])\\s+${name}\\s*\\(`).test(source))
    assert.ok(declared, `${name} is called but never declared in the globe path`)
  }
  const text = sources.join('\n')
  assert.equal((text.match(/\{/g) || []).length, (text.match(/\}/g) || []).length, 'globe braces must balance')
})

test('globe water receiver rejects derived wrappers', () => {
  const C = Cesium()
  const source = `${GLOBE_FS} void czm_wrapper(){ czm_non_pick_main(); }`
  assert.equal(globeWaterSources(C, program(C, { sources: [source], defines: ['HAS_WATER_MASK'] })), null)
})

// 与普通 Primitive 同一类陷阱：log-depth 派生把入口函数改名，
// 模板原文在真实命令里不存在。实测 globe 的 direct 变体匹配、logDepth 变体不匹配，
// 而 _draw 实际选用的是 logDepth —— 若只按原文匹配，水面在 log-depth 下全部不接入。
test('globe water receiver also matches the log-depth renamed variant', () => {
  const C = Cesium()
  const renamed = GLOBE_FS.replace(/\bvoid\s+main\s*\(/, 'void czm_log_depth_main(')
  assert.notEqual(renamed, GLOBE_FS, 'the fixture must actually contain a main entry point')
  const tail = '\nvoid main() { czm_log_depth_main(); czm_writeLogDepth(); }\n'
  const result = globeWaterSources(C,
    program(C, { sources: [renamed, tail], defines: ['HAS_WATER_MASK'] }),
    { reflection: true, opaqueColor: true })
  assert.ok(result, 'the renamed log-depth globe command must still be recognised')
  assert.ok(hasSource(result, 'ccr_globeIsWater'))
  assert.ok(hasSource(result, 'texture(u_waterMask, ccr_globeUv).r'))
  // 尾段必须保持原样，主入口仍调用改名后的函数。
  assert.ok(result.fragmentShaderSource.sources.some(source => source.includes('czm_log_depth_main();')))
})

test('globe water receiver refuses a program whose matched chunk lacks the water mask uniform', () => {
  const C = Cesium()
  // 命中模板但该段没有 u_waterMask 声明：结构不符预期，必须拒绝而不是写出无效采样。
  const stripped = GLOBE_FS.replace(/uniform sampler2D u_waterMask;/, '').replace(/uniform vec4 u_waterMaskTranslationAndScale;/, '')
  const result = globeWaterSources(C, program(C, { sources: [stripped], defines: ['HAS_WATER_MASK'] }))
  assert.equal(result, null)
})

// 水掩码的取值判据必须与 GlobeFS 一致（非零即水）。这是本轮实测到的真实缺陷：
// 写成 > 0.5 时，逐像素掩码（Uint8Array 存 0/1，归一化后 0.0039）会被整片判成陆地，
// 而长度 1 的整水掩码（复用 allWaterTexture，值 255 -> 1.0）恰好通过，
// 造成「整水用例通过、逐像素用例失败」的假象，误导排查方向。
test('globe water threshold is non-zero like GlobeFS, not a 0.5 cut', () => {
  const C = Cesium()
  const result = globeWaterSources(C, program(C, { sources: [GLOBE_FS], defines: ['HAS_WATER_MASK'] }), { reflection: true })
  assert.ok(result)
  assert.ok(hasSource(result, 'bool ccr_globeIsWater = ccr_globeWater > 0.0;'),
    'the water test must be "non-zero", matching GlobeFS.js:400')
  assert.ok(!hasSource(result, 'ccr_globeWater > 0.5'),
    'a 0.5 cut would reject every per-pixel water mask')
})

// --- 对外诊断 ---------------------------------------------------------------

test('diagnostics state the approximation and the explicit compatibility boundary', () => {
  const diagnostics = primitiveReflectionDiagnostics()
  assert.equal(diagnostics.version, 1)
  assert.equal(diagnostics.standardPbr, false)
  // 必须显式声明这是近似换算，不能宣称与 Model 路径数值等价。
  assert.match(diagnostics.roughnessMapping, /近似/)
  assert.match(diagnostics.f0Mapping, /近似|非物理等价/)
  assert.match(diagnostics.standardPbrReason, /STANDARD_PBR_VALID/)
  // 支持与兼容边界都要出现，不能只写支持范围。
  assert.ok(diagnostics.supported.length > 0)
  assert.ok(diagnostics.compatibility.length > 0)
})

test('F0 mapping scales the dielectric base by the material specular strength', () => {
  assert.match(F0_FROM_SPECULAR, /vec3\(0\.02\)\*clamp\(specular,0\.0,1\.0\)/)
})
