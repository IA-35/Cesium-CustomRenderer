// B07 验收（第 2 部分）：Globe water mask 区域的反射接收端契约。
//
// 主计划明确要求：水/Globe 若无法接入，原 SSR 完整目标保留未完成，不能仅凭白模样例
// 关闭此项。因此这里必须**实测**像素级水掩码是否让水面成为反射接收端，并确认
// 非水地面不被金属化、影像颜色不被改写。
//
// 关键构造一（见 docs/B07_RECONNAISSANCE.md）：只有自定义 TerrainProvider 且
// hasWaterMask === true 才会产生真实 u_waterMask；CustomHeightmapTerrainProvider
// 的 hasWaterMask 硬编码为 false，不可用。
//
// 关键构造二（本轮踩到的坑）：在 level 0 上，一个瓦片覆盖**整个地球**，8×8 水掩码
// 每个纹素跨 45°。因此「左半水」实际是经度 −180°~0°。若相机放在北京（116°E）就是
// 在陆地正上方，读到 0 个水域接收端——那是测试选点错误，不是实现缺陷。
// 正确做法是分别在**水域上空**与**陆地上空**各测一次，两者都要看：
//   * 水域上空必须出现 >0 个接收端（证明路径真的接通）；
//   * 陆地上空必须为 0（证明非水地面不被擅自金属化，这是主计划的明确条款）。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877

/** 在给定经纬度上空跑一帧，返回材质通道里的水域接收端/标准PBR/已知深度统计。 */
async function measure(page, { longitude, latitude, kind, label, height }) {
  return page.evaluate(async ({ longitude, latitude, kind, label, height }) => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    const m = await import('/tests/rendering/ssr-surfaces-fixture.js')
    const origin = C.Cartesian3.fromDegrees(longitude, latitude, 0)
    scene.skyBox.show = false
    scene.skyAtmosphere.show = false
    scene.sun.show = false
    scene.moon.show = false
    f.viewer.clock.shouldAnimate = false
    f.viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
    const provider = m.waterMaskTerrainProvider(C, { size: 8, kind })
    scene.terrainProvider = provider
    scene.globe.show = true
    scene.globe.enableLighting = true
    const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
    const sunWorld = C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame, new C.Cartesian3(0, -0.4, 0.9165), new C.Cartesian3()), new C.Cartesian3())
    scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(sunWorld, new C.Cartesian3()), intensity: 1 })

    const pipeline = f.CCR.createVisualPipeline({
      Cesium: C, viewer: f.viewer,
      options: { environment: false, clouds: false, shadows: false, fog: false, antialiasing: 'off',
        hdrBloomEnabled: false, albedoEnabled: false, materialChannelsEnabled: true,
        screenSpaceAoEnabled: false, screenSpaceReflectionEnabled: true }
    })
    pipeline.setCampusOrigin(origin)
    pipeline.setLighting({ mode: 'deferred' })
    // 相机高度决定可见经度跨度。8×8 水掩码在 level 0 上每个纹素跨 45°，
    // 因此只有把相机抬到能覆盖多个纹素的高度，mixed 掩码才可能同时呈现水与陆。
    // 实测：40000 m 高度可见范围仅约 0.2°，整屏落在同一纹素内，mixed 恒为单值。
    f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(longitude, latitude, height ?? 40000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
    f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
    await m.waitFrames(scene, 90, f.errors)

    // 命令级证据：该帧的 globe 命令是否真的带像素级水掩码纹理。
    let commandEvidence = null
    for (const bin of scene._view.frustumCommandsList || []) {
      const n = bin.indices[C.Pass.GLOBE] || 0
      for (let i = 0; i < n; i++) {
        const map = bin.commands[C.Pass.GLOBE][i].uniformMap || {}
        if (!('u_waterMask' in map)) continue
        let texture = null
        try { const v = map.u_waterMask && map.u_waterMask(); texture = v ? `${v.width}x${v.height}` : null } catch (e) { texture = 'threw' }
        commandEvidence = { hasUniform: true, texture }
        break
      }
      if (commandEvidence) break
    }

    const materials = pipeline.getActiveMaterialChannels()
    const textures = materials && materials.getTextures()
    const diagnostics = materials && materials.getDiagnostics()
    const out = { label, longitude, latitude, kind, errors: f.errors.slice(), commandEvidence,
      terrainHasWaterMask: !!provider.hasWaterMask }
    if (!textures) {
      out.noTextures = true
      out.materialsError = diagnostics && diagnostics.error
      pipeline.destroy()
      return out
    }
    const flagsOf = rgba => Math.round(rgba[3]) % 1024
    out.waterReceivers = m.countMaterialPixels(C, scene, textures.emissiveFlags, rgba => (flagsOf(rgba) & 3) === 3)
    out.standardPbr = m.countMaterialPixels(C, scene, textures.emissiveFlags, rgba => (flagsOf(rgba) & 512) === 512)
    out.knownDepth = m.countMaterialPixels(C, scene, textures.eyeDepth, rgba => rgba[0] > 0)
    out.invalidDepth = m.countMaterialPixels(C, scene, textures.eyeDepth, rgba => rgba[0] === -1)
    out.stats = diagnostics && diagnostics.stats
    out.ssrValid = pipeline.getScreenSpaceReflectionDiagnostics().valid
    // 保存一张该配置下的呈像，作为图像证据。
    pipeline.destroy()
    return out
  }, { longitude, latitude, kind, label, height })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const report = { cases: [], pageErrors: [] }
    // 每个用例独立开页：VisualPipeline 每个 viewer 只允许一个，
    // 复用同一页会让第二个用例因「Viewer already has a VisualPipeline」失败。
    const cases = [
      // 列掩码（左半水 = 经度 −180..0）：水域上空 vs 陆地上空。
      { label: 'ocean-column', longitude: -90, latitude: 0, kind: 'mixed' },
      { label: 'land-column', longitude: 90, latitude: 0, kind: 'mixed' },
      // 整水 / 整陆作为对照。
      { label: 'all-water', longitude: -90, latitude: 0, kind: 'water' },
      { label: 'all-land', longitude: 90, latitude: 0, kind: 'land' }
    ]
    for (const item of cases) {
      const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/ssr-surfaces-fixture.html`)
      await page.waitForFunction(() => window.fixture)
      const result = await measure(page, item)
      result.pageErrors = pageErrors
      report.pageErrors.push(...pageErrors)
      report.cases.push(result)
      await page.close()
    }
    fs.mkdirSync('docs/verification/stage1-B07', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B07/globe-water.json', JSON.stringify(report, null, 2))
    const byLabel = Object.fromEntries(report.cases.map(c => [c.label, c]))
    assert.deepEqual(report.pageErrors, [], 'no page errors')
    for (const c of report.cases) {
      assert.deepEqual(c.errors, [], `${c.label}: no render errors`)
      assert.ok(!c.noTextures, `${c.label}: material channels must be active (${c.materialsError || ''})`)
      assert.equal(c.terrainHasWaterMask, true, `${c.label}: provider must expose a water mask`)
      assert.ok(c.commandEvidence, `${c.label}: the globe command must carry the water mask uniform`)
      // 普通 Globe 不是标准 PBR Model，任何情况下都不得被标记为 512。
      assert.equal(c.standardPbr.count, 0, `${c.label}: globe must not be flagged STANDARD_PBR`)
    }
    // 水域上空必须出现反射接收端。
    assert.ok(byLabel['ocean-column'].waterReceivers.count > 0,
      `ocean must become a reflection receiver, got ${byLabel['ocean-column'].waterReceivers.count}`)
    assert.ok(byLabel['all-water'].waterReceivers.count > 0,
      `an all-water mask must become a reflection receiver, got ${byLabel['all-water'].waterReceivers.count}`)
    // 陆地上空必须为 0：非水地面不得被擅自金属化。
    assert.equal(byLabel['land-column'].waterReceivers.count, 0,
      `land must not become a reflection receiver, got ${byLabel['land-column'].waterReceivers.count}`)
    assert.equal(byLabel['all-land'].waterReceivers.count, 0,
      `an all-land mask must not become a reflection receiver, got ${byLabel['all-land'].waterReceivers.count}`)
    // 水体自身仍要有有效深度（证明真的写入了通道，而不是被兼容路径吞掉）。
    assert.ok(byLabel['all-water'].knownDepth.count > 0, 'water must write positive metric eye depth')
    console.log(JSON.stringify(report.cases.map(c => ({
      label: c.label, mask: c.kind, texture: c.commandEvidence.texture,
      waterReceivers: c.waterReceivers.count, standardPbr: c.standardPbr.count,
      knownDepth: c.knownDepth.count, invalidDepth: c.invalidDepth.count,
      globeWaterDraws: c.stats && c.stats.globeWaterDraws, ssrValid: c.ssrValid
    })), null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
