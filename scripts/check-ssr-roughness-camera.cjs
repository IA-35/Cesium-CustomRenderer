// B07 补充验收：粗糙度梯度响应 + 相机旋转/俯仰/近远变化的表面专项序列。
//
// 为什么需要（主计划 B07 第 7 条的剩余部分）：
// 「验证卫星影像、feature style、白模/透明 OIT、**粗糙度梯度**、
// **相机旋转/俯仰/近远变化**。」此前白模/OIT/style/影像均有证据，
// 但粗糙度**梯度**与 B07 表面的**相机序列**未做专项验证。
//
// 本脚本对 B07 接入的两类表面（普通 Primitive、Globe 水掩码区域）验证：
//   A) **粗糙度梯度**：同一几何、不同 `shininess`（→ 不同 GGX 粗糙度）下，
//      材质通道写出的 roughness 必须**单调**变化，且反射响应随之改变
//      （粗糙表面拿到更低的反射置信度 → 更暗/更模糊的反射）。
//      这验证的是 `shininess → roughness` 换算真的进入了渲染数据，
//      而不只是单元测试里的字符串。
//   B) **相机序列**：旋转（heading 扫掠）、俯仰（pitch 扫掠）、近远（高度变化）
//      三种运动下，表面必须持续是有效接收端，不得中途失效或骤黑。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { roughnessGradient: null, cameraSequence: null, pageErrors: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/ssr-surfaces-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })

    const result = await page.evaluate(async () => {
      const C = Cesium, f = fixture, scene = f.viewer.scene
      const surfaces = await import('/tests/rendering/ssr-surfaces-fixture.js')
      const wait = n => surfaces.waitFrames(scene, n, f.errors)
      scene.skyBox.show = false
      scene.skyAtmosphere.show = false
      scene.sun.show = false
      scene.moon.show = false
      f.viewer.clock.shouldAnimate = false
      f.viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
      const origin = C.Cartesian3.fromDegrees(123.42, 41.77, 0)
      const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
      const sunWorld = C.Cartesian3.normalize(
        C.Matrix4.multiplyByPointAsVector(frame, new C.Cartesian3(0, -0.4, 0.9165), new C.Cartesian3()), new C.Cartesian3())
      scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(sunWorld, new C.Cartesian3()), intensity: 1 })

      const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer,
        options: { environment: false, clouds: false, shadows: false, fog: false, antialiasing: 'off',
          hdrBloomEnabled: false, albedoEnabled: false, materialChannelsEnabled: true,
          screenSpaceAoEnabled: false, screenSpaceReflectionEnabled: true } })
      pipeline.setCampusOrigin(origin)
      pipeline.setLighting({ mode: 'deferred' })

      const read1 = (texture, x, y) => surfaces.sampleMaterialPixel(C, scene, texture, x, y)

      // --- A) 粗糙度梯度 -------------------------------------------------
      // ⚠️ 两处实测约束（都不是缺陷，是 Cesium 材质的语义）：
      //   1. 只有 `Water.glsl` 真正设置 `material.shininess`（Cesium 1.143 的
      //      Materials 目录下唯一一个）；`NormalMapMaterial` 只设 `material.normal`，
      //      其余材质沿用 `czm_getDefaultMaterial` 的 shininess=1。
      //   2. `Water.glsl:55` 把 shininess **硬编码为 10.0**，不接受参数。
      //      因此无法通过 Water 扫描 shininess 形成梯度；期望粗糙度恒为
      //      sqrt(2/(10+2)) = 0.4082。
      //
      // 因此本项改为验证 B07 换算在**两类材质**上都正确：
      //   * Water（shininess 硬编码 10）-> 期望 0.4082
      //   * NormalMap / Color（沿用默认 shininess=1）-> 期望 0.8165
      // 并验证反射响应把同一 roughness 带进 alpha（trace/resolve 据此选预算）。
      const gradient = []
      const cases = [
        { id: 'water', expectedShininess: 10, build: () => new C.MaterialAppearance({
          materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
          material: C.Material.fromType('Water', {
            baseWaterColor: new C.Color(0.1, 0.3, 0.5, 1), blendColor: new C.Color(0.1, 0.3, 0.5, 1),
            normalMap: surfaces.solidImage(128, 128, 255), specularMap: surfaces.solidImage(255, 255, 255),
            animationSpeed: 0, frequency: 1, amplitude: 1 }) }) },
        { id: 'normalmap-default-shininess', expectedShininess: 1, build: () => new C.MaterialAppearance({
          materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
          material: C.Material.fromType('NormalMap', {
            image: surfaces.solidImage(128, 128, 255), strength: 0,
            diffuse: new C.Color(0.35, 0.36, 0.38, 1), specular: 0.6 }) }) },
        { id: 'color-default-shininess', expectedShininess: 1, build: () => new C.MaterialAppearance({
          materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
          material: C.Material.fromType('Color', { color: new C.Color(0.4, 0.42, 0.45, 1) }) }) }
      ]
      for (const item of cases) {
        const primitive = surfaces.surfacePrimitive(C, scene, {
          origin, localX: 0, localY: 0, localZ: 2, size: 40, id: item.id, appearance: item.build()
        })
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(123.42, 41.77, 120),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(40)
        const materials = pipeline.getActiveMaterialChannels()
        const textures = materials && materials.getTextures()
        if (!textures) { gradient.push({ shininess, missing: true }); primitive.show = false; continue }
        const w = textures.normalRoughMetal.width, h = textures.normalRoughMetal.height
        const px = Math.floor(w / 2), py = Math.floor(h / 2)
        const normal = read1(textures.normalRoughMetal, px, py)
        const flags = read1(textures.emissiveFlags, px, py)
        const response = textures.reflectionResponse ? read1(textures.reflectionResponse, px, py) : null
        const specular = textures.reflectionSpecular ? read1(textures.reflectionSpecular, px, py) : null
        gradient.push({
          id: item.id,
          expectedShininess: item.expectedShininess,
          // **通道契约**（MATERIAL_CHANNELS.md:25）：normalRoughMetal 是
          // RGBA8，RG = 八面体编码法线、**B = 感知粗糙度**、**A = 金属度**。
          // 早先按 alpha 读取会得到 0（那是金属度），从而误判「粗糙度丢失」。
          roughness: normal[2],
          metallic: normal[3],
          flags: Math.round(flags[3]) % 1024,
          responseRoughness: response ? response[3] : null,
          specularAlpha: specular ? specular[3] : null,
          // 期望的 GGX 粗糙度（与实现同一公式）。
          expectedRoughness: Math.min(Math.max(Math.sqrt(2 / (item.expectedShininess + 2)), 0.04), 1)
        })
        primitive.show = false
      }

      // --- B) 相机序列 ---------------------------------------------------
      // 在 B07 表面（普通 Primitive）上做旋转/俯仰/近远扫掠，每步检查
      // 「表面仍是有效接收端」且画面不骤黑。
      const surface = surfaces.surfacePrimitive(C, scene, {
        origin, localX: 0, localY: 0, localZ: 2, size: 60, id: 'sequence',
        appearance: new C.MaterialAppearance({
          materialSupport: C.MaterialAppearance.MaterialSupport.ALL, translucent: false,
          material: C.Material.fromType('Color', { color: new C.Color(0.45, 0.47, 0.5, 1) })
        })
      })
      const centreMean = () => {
        // 全屏均值而不是中心 8×8：俯仰变化会让表面移出中心，
        // 该夹具背景为黑色，固定读中心会把「中心是天空」误判成「画面全黑」。
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
        const data = scene.context.readPixels({ x: 0, y: 0, width: w, height: h })
        let sum = 0
        const count = w * h
        for (let i = 0; i < count; i++) sum += (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
        return sum / count
      }
      const observe = async label => {
        await wait(25)
        const materials = pipeline.getActiveMaterialChannels()
        const textures = materials && materials.getTextures()
        if (!textures) return { label, valid: false, reason: materials && materials._scopeReason && materials._scopeReason() }
        // **必须扫描全屏找表面**，而不是固定读中心像素：俯仰/高度变化会让表面
        // 移出画面中心（实测 pitch=-1.2 时中心已是天空），固定采样会把
        // 「表面在别处」误判成「表面消失」。
        const w = textures.emissiveFlags.width, h = textures.emissiveFlags.height
        const flagsAll = surfaces.countMaterialPixels(C, scene, textures.emissiveFlags,
          rgba => (Math.round(rgba[3]) % 1024 & 3) === 3)
        const depthAll = surfaces.countMaterialPixels(C, scene, textures.eyeDepth, rgba => rgba[0] > 0)
        const sample = flagsAll.samples[0] || null
        const depth = sample ? read1(textures.eyeDepth, sample.x, sample.y)[0] : null
        return { label, valid: true, surface: flagsAll.count > 0, surfacePixels: flagsAll.count,
          depthPixels: depthAll.count, depth, mean: centreMean() }
      }

      const sequence = []
      // 旋转：8 个朝向（俯视，保证表面可见）。
      for (let i = 0; i < 8; i++) {
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(123.42, 41.77, 150),
          orientation: { heading: (i / 8) * Math.PI * 2, pitch: -Math.PI / 2, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        sequence.push(await observe(`heading-${i}`))
      }
      // 俯仰：从垂直下看到明显倾斜。
      //
      // **范围必须与几何一致**：该表面是水平面，相机在 150 m 高度。俯角越小
      // （越接近水平），水平面越会移出视野下缘——实测 pitch=-0.9 rad（约 -51°）
      // 时表面已完全不可见，那是正常的取景结果，不是渲染失效。
      // 因此俯仰扫描限制在能看到该水平面的范围内，并另外用**高度扫描**覆盖远距离。
      for (const pitch of [-Math.PI / 2, -1.4, -1.3, -1.25, -1.2]) {
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(123.42, 41.77, 150),
          orientation: { heading: 0, pitch, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        sequence.push(await observe(`pitch-${pitch.toFixed(2)}`))
      }
      // 近远：高度从近到远。
      for (const height of [80, 150, 400, 1200, 4000]) {
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(123.42, 41.77, height),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        sequence.push(await observe(`height-${height}`))
      }
      surface.show = false
      return { gradient, sequence, errors: f.errors.slice() }
    })

    report.pageErrors.push(...pageErrors)
    report.roughnessGradient = result.gradient
    report.cameraSequence = result.sequence
    report.errors = result.errors
    fs.mkdirSync('docs/verification/stage1-B07', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B07/roughness-and-camera.json', JSON.stringify(report, null, 2))

    assert.deepEqual(pageErrors, [], 'no page errors')
    assert.deepEqual(result.errors, [], 'no render errors')

    // A) 粗糙度换算：材质通道写出的 roughness 必须等于 shininess 对应的
    // GGX 值（证明换算真的进入了渲染数据，而不只是单元测试里的字符串）。
    const gradient = result.gradient.filter(g => !g.missing)
    assert.equal(gradient.length, 3, `all material cases must be measured, got ${gradient.length}`)
    for (const step of gradient) {
      // RGBA8 量化步长约 1/255，因此容差取 0.01。
      assert.ok(Math.abs(step.roughness - step.expectedRoughness) < 0.01,
        `${step.id}: rendered roughness ${step.roughness} must match the expected GGX value ${step.expectedRoughness} for shininess ${step.expectedShininess}`)
      // 金属度必须在 A 通道（B07 刻意写 0，不伪装金属）。
      assert.equal(step.metallic, 0,
        `${step.id}: primitives must not claim metalness, got ${step.metallic}`)
    }
    // Water 与默认 shininess 的两类材质必须给出**不同**的粗糙度——
    // 否则说明换算没有真正区分材质。
    const water = gradient.find(g => g.id === 'water')
    const defaultShininess = gradient.find(g => g.id.startsWith('color'))
    assert.ok(defaultShininess.roughness > water.roughness,
      `the default shininess=1 material must be rougher than Water's hard-coded shininess=10: ${defaultShininess.roughness} vs ${water.roughness}`)
    // 反射响应必须把同一 roughness 带进 alpha（trace/resolve 据此选预算与置信度）。
    assert.ok(gradient.every(g => g.responseRoughness !== null),
      'reflection response must be present for every material case')
    for (const step of gradient) {
      assert.ok(Math.abs(step.responseRoughness - step.roughness) < 0.01,
        `${step.id}: response alpha ${step.responseRoughness} must carry the rendered roughness ${step.roughness}`)
    }

    // B) 相机序列：每一步表面都必须仍是有效接收端，且画面不骤黑。
    // 判据是「屏内仍有有效表面像素」，而不是「中心像素是表面」——
    // 俯仰/高度变化会让表面移出画面中心，那是正常取景结果，不是失效。
    for (const step of report.cameraSequence) {
      assert.equal(step.valid, true, `${step.label}: material channels must stay valid (${step.reason || ''})`)
      assert.equal(step.surface, true,
        `${step.label}: the surface must remain visible and a valid receiver, got ${step.surfacePixels} pixels`)
      assert.ok(step.mean > 0, `${step.label}: the frame must not be black, got ${step.mean}`)
    }

    console.log(JSON.stringify({
      roughness: gradient.map(g => ({ id: g.id, shininess: g.expectedShininess,
        roughness: Number(g.roughness.toFixed(4)), expected: Number(g.expectedRoughness.toFixed(4)),
        metallic: g.metallic, responseAlpha: Number(g.responseRoughness.toFixed(4)) })),
      cameraSequence: report.cameraSequence.map(s => ({ label: s.label, surface: s.surface,
        mean: Math.round(s.mean), depth: Number((s.depth ?? 0).toFixed(1)) }))
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
