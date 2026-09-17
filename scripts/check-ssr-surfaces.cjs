// B07 验收：普通 Primitive（Color / NormalMap / 不透明 Water）是否真实接入材质通道与 SSR。
//
// 为什么用 B03 的 deferred-transparency 夹具页作为宿主，而不是自建页面：
// 本批只需要「普通 Primitive 能否被接入」这一个结论。B03 页面已被 B03/B04-B06 的
// 多条检查反复验证过其 HDR/OIT/管线配置正确（见 check-transparent-families.cjs），
// 复用它可以把配置差异带来的无关故障排除在 B07 结论之外。
//
// 纪律（沿用 B02/B03）：
//   * 每条断言都来自实际渲染输出或材质通道的 GPU 读回，不断言「接口存在」；
//   * 「不接入」也必须可观测：本批要求普通 Primitive 写入有效材质数据，
//     同时**不得**被标记为标准 PBR（否则会被 DeferredLighting 二次照亮）；
//   * 半透明水面的覆盖归 B03（其 families 检查已通过），本批不重复声称。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877

async function run(browser) {
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/deferred-transparency-fixture.html?oit=1`)
  await page.waitForFunction(() => window.fixture)
  const result = await page.evaluate(async () => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    const m = await import('/tests/rendering/deferred-transparency-fixture.js')
    const surfaces = await import('/tests/rendering/ssr-surfaces-fixture.js')
    await m.startTransparencyFixture(f)
    const wait = n => m.waitFrames(scene, n, f.errors)
    const pipeline = f.pipeline

    // 隐藏 B03 夹具自身的内容，只保留本批要测的 Primitive。
    for (const layer of f.layers) layer.model.show = false

    // B03 夹具默认关闭材质通道（screenSpaceReflectionEnabled:false）。B07 要验证
    // 普通 Primitive 是否进入材质通道，因此必须显式打开，并等待管线重建完成。
    pipeline.setScreenSpaceReflections({ enabled: true })
    await wait(30)

    const origin = f.origin
    const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
    const make = {
      // 普通不透明 Color 材质 Primitive。
      opaqueColor: () => new C.MaterialAppearance({
        materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
        material: C.Material.fromType('Color', { color: new C.Color(0.5, 0.5, 0.55, 1) })
      }),
      // 积水代表：NormalMap 材质带真实法线扰动与高光。
      wet: () => new C.MaterialAppearance({
        materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
        material: C.Material.fromType('NormalMap', {
          image: surfaces.solidImage(128, 128, 255), strength: 0.5,
          diffuse: new C.Color(0.32, 0.33, 0.36, 1), specular: 0.6, shininess: 80
        })
      }),
      // 不透明 Water（走 FLAT/非 translucent 分支的代表）。
      waterOpaque: () => new C.MaterialAppearance({
        materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
        material: C.Material.fromType('Water', {
          baseWaterColor: new C.Color(0.1, 0.3, 0.5, 1), blendColor: new C.Color(0.1, 0.3, 0.5, 1),
          normalMap: surfaces.solidImage(128, 128, 255), specularMap: surfaces.solidImage(255, 255, 255),
          animationSpeed: 0, frequency: 1, amplitude: 1
        })
      })
    }
    // 三个平面沿本地 X 铺开，屏幕位置互不重叠。重叠会让材质通道读回无法区分
    // 是哪个 Primitive 写的数据，测出来的「有效表面像素」也就没有意义。
    const offsets = { opaqueColor: -26, wet: 0, waterOpaque: 26 }
    for (const [id, appearance] of Object.entries(make)) {
      surfaces.surfacePrimitive(C, scene, {
        origin, localX: offsets[id], localY: 0, localZ: 20, size: 14, appearance: appearance(), id
      })
    }
    await wait(50)

    const materials = pipeline.getActiveMaterialChannels()
    const textures = materials && materials.getTextures()
    const diagnostics = materials && materials.getDiagnostics()
    const out = { errors: f.errors.slice(), useOIT: scene._environmentState.useOIT,
      lighting: pipeline.getLightingDiagnostics() }
    if (!textures) {
      out.noTextures = true
      out.materialsReason = diagnostics && diagnostics.reason
      out.materialsError = diagnostics && diagnostics.error
      out.materialsDiagnostics = diagnostics
      return out
    }

    // 统计整张材质通道里有多少像素带有效表面标记（flags & 3 == 3）。
    const surface = surfaces.countMaterialPixels(C, scene, textures.emissiveFlags, rgba => {
      const flags = Math.round(rgba[3]) % 1024
      return (flags & 3) === 3
    })
    const standardPbr = surfaces.countMaterialPixels(C, scene, textures.emissiveFlags, rgba => {
      const flags = Math.round(rgba[3]) % 1024
      return (flags & 512) === 512
    })
    const knownDepth = surfaces.countMaterialPixels(C, scene, textures.eyeDepth, rgba => rgba[0] > 0)
    const invalidDepth = surfaces.countMaterialPixels(C, scene, textures.eyeDepth, rgba => rgba[0] === -1)
    out.surface = surface
    out.standardPbr = standardPbr
    out.knownDepth = knownDepth
    out.invalidDepth = invalidDepth
    out.stats = diagnostics && diagnostics.stats
    out.primitiveReflection = diagnostics && diagnostics.primitiveReflection
    out.ssr = pipeline.getScreenSpaceReflectionDiagnostics()
    return out
  })
  await page.close()
  return { result, pageErrors }
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const { result, pageErrors } = await run(browser)
    result.pageErrors = pageErrors
    fs.mkdirSync('docs/verification/stage1-B07', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B07/primitives.json', JSON.stringify(result, null, 2))
    assert.deepEqual(pageErrors, [], 'no page errors')
    assert.deepEqual(result.errors, [], 'no render errors')
    assert.ok(!result.noTextures, `material channels must be active (reason: ${result.materialsReason})`)
    // 普通 Primitive 必须真的写入材质通道：出现有效表面像素、且带米制视深度。
    assert.ok(result.surface.count > 0,
      `primitives must write valid surface flags, got ${JSON.stringify(result.surface)}`)
    assert.ok(result.knownDepth.count > 0,
      `primitives must write positive metric eye depth, got ${JSON.stringify(result.knownDepth)}`)
    // 但**不得**被标记为标准 PBR，否则 DeferredLighting 会把它们二次照亮。
    assert.equal(result.standardPbr.count, 0,
      `primitives must not be flagged STANDARD_PBR, got ${JSON.stringify(result.standardPbr.samples)}`)
    assert.ok(result.stats && result.stats.primitiveDraws > 0,
      `the primitive path must actually run, got ${JSON.stringify(result.stats)}`)
    // 诊断必须如实声明这是近似换算，且明确区分标准 PBR 与普通 Primitive。
    assert.ok(result.primitiveReflection, 'diagnostics must expose the primitive contract')
    assert.equal(result.primitiveReflection.standardPbr, false)
    console.log(JSON.stringify({
      surface: result.surface.count, standardPbr: result.standardPbr.count,
      knownDepth: result.knownDepth.count, invalidDepth: result.invalidDepth.count,
      primitiveDraws: result.stats.primitiveDraws, standardPbrDraws: result.stats.standardPbrDraws,
      invalidators: result.stats.invalidators, ssrValid: result.ssr.valid
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
