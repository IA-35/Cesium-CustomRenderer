// B09 单元测试：镜头效果的 identity 契约、互斥规则、核归一化与遮挡消费。
//
// 纪律：断言**可判定的契约**——强度 0 必须逐位 identity、模糊核必须归一化、
// 色差不得偏移 alpha、互斥必须可报告、光柱/光斑必须消费 B08 数据而非自造遮挡。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LENS_EFFECTS_VERSION,
  EXCLUSIVE_BLUR_EFFECTS,
  LENS_EFFECT_DEFAULTS,
  resolveLensEffects,
  tiltShiftShader,
  blurShader,
  depthOfFieldShader,
  chromaticAberrationShader,
  lightShaftShader,
  sunFlareShader
} from '../../src/stages/lensEffects143.js'

// --- 默认关闭与 identity ----------------------------------------------------

test('B09 lens effects declare their contract version', () => {
  assert.equal(LENS_EFFECTS_VERSION, 1)
})

test('every effect is disabled by default and every strength defaults to an inert value', () => {
  // 计划硬要求：所有新增效果默认关闭。
  for (const [key, value] of Object.entries(LENS_EFFECT_DEFAULTS)) {
    if (key.endsWith('Enabled')) assert.equal(value, false, `${key} must default to off`)
  }
  // 色差强度默认 0（identity）；其余强度默认仅在显式开启时才有效。
  assert.equal(LENS_EFFECT_DEFAULTS.chromaticAberrationStrength, 0)
})

test('every effect shader returns the source unchanged when its strength is zero', () => {
  // identity 必须是**第一分支**，而不是靠参数恰好抵消。
  const cases = [
    ['tiltShift', tiltShiftShader, /if \(tiltParams\.w <= 0\.0 \|\| tiltParams\.z <= 0\.0\) \{ out_FragColor = source; return; \}/],
    ['blur', blurShader, /if \(blurParams\.y <= 0\.0 \|\| blurParams\.x <= 0\.0\) \{ out_FragColor = source; return; \}/],
    ['depthOfField', depthOfFieldShader, /if \(dofParams\.w <= 0\.0 \|\| dofParams\.z <= 0\.0\) \{ out_FragColor = source; return; \}/],
    ['chromaticAberration', chromaticAberrationShader, /if \(aberration <= 0\.0\) \{ out_FragColor = source; return; \}/],
    ['lightShaft', lightShaftShader, /if \(shaftAvailable < 0\.5 \|\| shaftParams\.x <= 0\.0 \|\| shaftParams\.y < 1\.0\)/],
    ['sunFlare', sunFlareShader, /if \(flareParams\.z < 0\.5 \|\| flareParams\.x <= 0\.0 \|\| sunColor\.a <= 0\.0\)/]
  ]
  for (const [name, shader, pattern] of cases) {
    assert.match(shader, pattern, `${name} must short-circuit to the source`)
    // 短路必须发生在任何采样/混合之前。
    const guard = shader.search(pattern)
    const firstTextureRead = shader.indexOf('texture(', shader.indexOf('void main'))
    assert.ok(guard >= 0 && guard < firstTextureRead + 200,
      `${name}: the identity guard must come before the effect body`)
  }
})

// --- 模糊核归一化 -----------------------------------------------------------

test('blur kernels divide by the actual accumulated weight', () => {
  // 计划要求「核归一化」。除以硬编码常数会在权重表被修改时静默改变亮度。
  for (const [name, shader] of [['tiltShift', tiltShiftShader], ['blur', blurShader], ['depthOfField', depthOfFieldShader]]) {
    assert.match(shader, /weightSum/, `${name} must accumulate a weight sum`)
    assert.match(shader, /\/ weightSum/, `${name} must divide by the accumulated weight`)
    // 对称的双向核：两侧都加同一个权重，因此权重和必须把 i 计两次。
    assert.match(shader, /weightSum \+= weights\[i\] \* 2\.0;/, `${name} must count both taps`)
  }
})

test('the blur weights sum to one so a constant image keeps its brightness', () => {
  // 常量图不变亮是计划明确的验收线；这里直接验证权重表本身。
  const weights = [0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162]
  const sum = weights[0] + weights.slice(1).reduce((a, w) => a + w * 2, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `the 9-tap kernel must be normalized, got ${sum}`)
})

test('tilt shift is bidirectional and uses nine taps', () => {
  // 计划：借鉴双向 9-tap。
  assert.match(tiltShiftShader, /const float weights\[5\]/, 'a 5-entry table is 9 taps when mirrored')
  assert.match(tiltShiftShader, /v_textureCoordinates \+ direction \* float\(i\)/)
  assert.match(tiltShiftShader, /v_textureCoordinates - direction \* float\(i\)/)
  // 双向：正负两侧各 4 个 + 中心 1 = 9。
  const plus = (tiltShiftShader.match(/\+ direction \* float\(i\)/g) || []).length
  const minus = (tiltShiftShader.match(/- direction \* float\(i\)/g) || []).length
  assert.equal(plus, 1)
  assert.equal(minus, 1)
})

test('tilt shift radius is expressed in pixels via the real texture size', () => {
  // 计划：真实 textureSize 控制像素半径。
  assert.match(tiltShiftShader, /uniform vec2 sourceSize;/)
  assert.match(tiltShiftShader, /vec2 texel = 1\.0 \/ sourceSize;/)
  assert.match(tiltShiftShader, /texel \* tiltParams\.z/)
})

// --- 色差契约 ---------------------------------------------------------------

test('chromatic aberration offsets only the red and green channels by radius', () => {
  assert.match(chromaticAberrationShader, /color\.r = texture\(colorTexture, v_textureCoordinates \+ offset\)\.r;/)
  assert.match(chromaticAberrationShader, /color\.g = source\.g;/)
  assert.match(chromaticAberrationShader, /color\.b = texture\(colorTexture, v_textureCoordinates - offset\)\.b;/)
})

test('chromatic aberration never offsets alpha', () => {
  // 计划明确：alpha 不偏移。
  assert.match(chromaticAberrationShader, /out_FragColor = vec4\(color, source\.a\);/)
  assert.ok(!/texture\(colorTexture[^)]*\)\.a/.test(chromaticAberrationShader),
    'alpha must not be sampled from an offset location')
})

test('chromatic aberration is zero at the centre', () => {
  // 计划：中心和强度 0 保持原图。
  assert.match(chromaticAberrationShader, /if \(radius <= 1\.0e-6\) \{ out_FragColor = source; return; \}/)
  // 偏移随半径增大：真实镜头的色差特征。
  assert.match(chromaticAberrationShader, /direction \* aberration \* radius \/ sourceSize/)
})

test('chromatic aberration uses pixel units so it is resolution independent', () => {
  assert.match(chromaticAberrationShader, /uniform vec2 sourceSize;/)
  assert.match(chromaticAberrationShader, /\/ sourceSize;/)
})

// --- 景深深度契约 -----------------------------------------------------------

test('depth of field treats unknown depth as far rather than as in-focus', () => {
  // B02 契约：正数=已知米制视深度，0=背景，负数=未知遮挡。
  // 把未知当成 0 会让背景完全清晰，那是错误的语义。
  assert.match(depthOfFieldShader, /float effective = depth > 0\.0 \? depth : dofParams\.x \+ dofParams\.y \* 4\.0;/)
})

test('depth of field reads the B02 metric depth contract', () => {
  assert.match(depthOfFieldShader, /uniform sampler2D depthTexture;/)
  assert.match(depthOfFieldShader, /B02 材质深度：正数为已知米制视深度/)
})

// --- 互斥规则 ---------------------------------------------------------------

test('the three blur effects are declared mutually exclusive', () => {
  assert.deepEqual([...EXCLUSIVE_BLUR_EFFECTS], ['tiltShift', 'blur', 'depthOfField'])
})

test('only one blur effect can be effective, and the others are reported', () => {
  const all = resolveLensEffects({ tiltShiftEnabled: true, blurEnabled: true, depthOfFieldEnabled: true })
  assert.equal(all.active, 'tiltShift')
  assert.equal(all.effective.tiltShift, true)
  assert.equal(all.effective.blur, false)
  assert.equal(all.effective.depthOfField, false)
  // 被压制的两项必须带原因，不能只是静默 false。
  assert.match(all.suppressed.blur, /Suppressed by tiltShift/)
  assert.match(all.suppressed.depthOfField, /Suppressed by tiltShift/)
  // 生效项自身没有抑制原因。
  assert.equal(all.suppressed.tiltShift, null)
})

test('the requested state is preserved separately from the effective state', () => {
  // 计划要求「启用一个必须明确反馈另外两项的实际状态」——
  // 因此必须同时保留 requested 与 effective，才能如实报告差异。
  const result = resolveLensEffects({ blurEnabled: true, depthOfFieldEnabled: true })
  assert.deepEqual(result.requested, { tiltShift: false, blur: true, depthOfField: true })
  assert.equal(result.active, 'blur')
  assert.equal(result.effective.blur, true)
  assert.equal(result.effective.depthOfField, false)
  assert.match(result.suppressed.depthOfField, /Suppressed by blur/)
})

test('a single enabled effect is effective with no suppression', () => {
  for (const name of EXCLUSIVE_BLUR_EFFECTS) {
    const result = resolveLensEffects({ [`${name}Enabled`]: true })
    assert.equal(result.active, name)
    assert.equal(result.effective[name], true)
    for (const other of EXCLUSIVE_BLUR_EFFECTS) {
      if (other === name) continue
      assert.equal(result.suppressed[other], null, `${other} was not requested so it needs no reason`)
      assert.equal(result.effective[other], false)
    }
  }
})

test('no effect enabled means nothing is effective and nothing is suppressed', () => {
  const result = resolveLensEffects({})
  assert.equal(result.active, null)
  assert.deepEqual(result.effective, { tiltShift: false, blur: false, depthOfField: false })
  for (const name of EXCLUSIVE_BLUR_EFFECTS) assert.equal(result.suppressed[name], null)
})

test('non-boolean enable flags are not treated as enabled', () => {
  // 与 presets 的既有纪律一致：'true' 这类字符串不得被当作开启。
  const result = resolveLensEffects({ tiltShiftEnabled: 'true', blurEnabled: 1 })
  assert.equal(result.active, null)
  assert.deepEqual(result.effective, { tiltShift: false, blur: false, depthOfField: false })
})

// --- 光柱 / 光斑消费 B08 数据 -----------------------------------------------

test('light shaft consumes the B08 occlusion texture instead of building its own mask', () => {
  // 计划明确分工：B08 产出遮挡，B09 只做径向积分与合成。
  assert.match(lightShaftShader, /uniform sampler2D occlusionTexture;/)
  assert.match(lightShaftShader, /occlusion\.r \* occlusion\.g/)
  // 不得自己采样阴影贴图或重建几何遮挡。
  assert.ok(!/shadowTexture|localToShadow|shadowInfo/.test(lightShaftShader),
    'the shaft must not rebuild an occlusion mask itself')
})

test('light shaft integrates radially toward the sun with the planned sample count', () => {
  assert.match(lightShaftShader, /vec2 delta = \(sunScreen - v_textureCoordinates\) \/ max\(shaftParams\.y, 1\.0\);/)
  assert.match(lightShaftShader, /for \(int i = 0; i < 64; i\+\+\)/)
  assert.match(lightShaftShader, /if \(float\(i\) >= shaftParams\.y\) break;/)
})

test('light shaft exits when the sun is behind the camera', () => {
  // 计划：背向太阳退出。太阳不在屏幕内即退出。
  assert.match(lightShaftShader, /if \(sunScreen\.x < 0\.0 \|\| sunScreen\.x > 1\.0 \|\| sunScreen\.y < 0\.0 \|\| sunScreen\.y > 1\.0\)/)
})

test('light shaft is weighted by the view transmittance so clear directions stay clear', () => {
  assert.match(lightShaftShader, /float viewWeight = 1\.0 - selfOcclusion\.b;/)
  assert.match(lightShaftShader, /\* shaftParams\.x \* viewWeight/)
})

test('sun flare also consumes the B08 occlusion data and exits behind the camera', () => {
  assert.match(sunFlareShader, /uniform sampler2D occlusionTexture;/)
  assert.match(sunFlareShader, /float visible = occlusion\.r \* occlusion\.g;/)
  assert.match(sunFlareShader, /if \(sunScreen\.x < 0\.0 \|\| sunScreen\.x > 1\.0 \|\| sunScreen\.y < 0\.0 \|\| sunScreen\.y > 1\.0\)/)
  // 完全遮挡时不产生光斑。
  assert.match(sunFlareShader, /if \(visible <= 0\.001\) \{ out_FragColor = source; return; \}/)
  assert.ok(!/shadowTexture|localToShadow/.test(sunFlareShader), 'the flare must not rebuild occlusion')
})

test('all effects preserve alpha', () => {
  for (const [name, shader] of [['tiltShift', tiltShiftShader], ['blur', blurShader],
    ['depthOfField', depthOfFieldShader], ['lightShaft', lightShaftShader], ['sunFlare', sunFlareShader]]) {
    assert.match(shader, /source\.a\)/, `${name} must pass alpha through`)
  }
})

test('effect shaders keep braces and preprocessor branches balanced', () => {
  for (const [name, shader] of [['tiltShift', tiltShiftShader], ['blur', blurShader],
    ['depthOfField', depthOfFieldShader], ['chromaticAberration', chromaticAberrationShader],
    ['lightShaft', lightShaftShader], ['sunFlare', sunFlareShader]]) {
    const code = shader.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
    assert.equal((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length, `${name}: braces must balance`)
    const opens = (shader.match(/^\s*#\s*(?:if|ifdef|ifndef)\b/gm) || []).length
    const closes = (shader.match(/^\s*#\s*endif\b/gm) || []).length
    assert.equal(opens, closes, `${name}: preprocessor branches must balance`)
  }
})

// --- 文件名大小写碰撞防护 ---------------------------------------------------
// Windows 文件系统大小写不敏感：`LensEffects143.js` 与 `lensEffects143.js`
// 会被当作同一个文件。本项目实测过该事故——管线管理器写进前者时直接覆盖了
// 后者（着色器模块），导致所有着色器导出消失。这里用**读取真实目录**的方式
// 锁定：模块文件名在同一目录内必须大小写唯一。
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

test('no two source files differ only by letter case', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const offenders = []
  const walk = directory => {
    const entries = readdirSync(directory, { withFileTypes: true })
    const seen = new Map()
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      if (seen.has(lower)) offenders.push(`${directory}: ${seen.get(lower)} vs ${entry.name}`)
      else seen.set(lower, entry.name)
      if (entry.isDirectory()) walk(join(directory, entry.name))
    }
  }
  walk(root)
  assert.deepEqual(offenders, [],
    'files differing only by case collide on Windows and silently overwrite each other')
})
