// B12 逐条画质验收：主计划列出的 9 项，逐条取实际渲染证据。
//
// 主计划的通过条件是「验收报告对每条目标有证据链接，无未解释画质缺陷」。
// 因此本脚本对每一条都产出一个**可判定的测量**，而不是主观描述：
//   1. 卫星底图可见        -> 影像图层就绪 + 中心区域非纯色
//   2. 天空不漂白          -> 天空区域亮度上限与饱和像素比例
//   3. 树荫明显且稳定      -> 有/无阴影的亮度差 + 连续帧稳定性
//   4. 无阴影浮空/重影    -> 阴影边缘邻域与接地点的像素一致性
//   5. SSR 旋转不骤黑      -> 连续旋转下的最大帧间亮度跌落
//   6. 高空云不扩距        -> 高空视角下的云覆盖率不随高度异常上升
//   7. AA 不模糊抖动       -> 边缘梯度保持 + 连续帧抖动
//   8. 玻璃水与雾正确排序  -> 由 B03 的透明检查覆盖（此处交叉引用）
//   9. 拾取/交互           -> 由 B03/B07 覆盖（此处交叉引用）
//
// 无法在本夹具下判定的条目会**显式标注为未覆盖并给出原因**，而不是含糊通过。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto')

const PORT = process.env.CCR_TEST_PORT || 8877

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { checks: {}, pageErrors: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })

    const result = await page.evaluate(async () => {
      const C = Cesium, f = fixture, scene = f.viewer.scene
      // 复用仓库既有的程序化几何工具，避免重复实现。
      const { cubeUrl } = await import('/tests/rendering/stage1-scene.js')
      const { planeGlb } = await import('/tests/rendering/deferred-transparency-fixture.js')
      const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
        (12 - 116.39 / 15) * 3600, new C.JulianDate())
      f.viewer.clock.currentTime = shifted
      f.viewer.clock.shouldAnimate = false
      scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
      const wait = frames => new Promise(resolve => {
        let n = frames
        const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); resolve() } })
      })
      const grab = () => {
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
        const data = scene.context.readPixels({ x: 0, y: 0, width: w, height: h })
        return { data, w, h }
      }
      /** 区域统计：均值、上限、饱和像素（>=250）比例。 */
      const region = (frame, x0, y0, x1, y1) => {
        let sum = 0, count = 0, max = 0, saturated = 0
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * frame.w + x) * 4
            const v = (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3
            sum += v; count++
            if (v > max) max = v
            if (v >= 250) saturated++
          }
        }
        return { mean: sum / count, max, saturatedRatio: saturated / count, count }
      }
      /** 中心 8×8 均值。 */
      const centre = frame => region(frame, Math.floor(frame.w / 2) - 4, Math.floor(frame.h / 2) - 4,
        Math.floor(frame.w / 2) + 4, Math.floor(frame.h / 2) + 4)
      /** 梯度能量：相邻像素差的平均值，用于衡量边缘锐度。 */
      const gradient = frame => {
        let sum = 0, count = 0
        for (let y = 0; y < frame.h; y++) {
          for (let x = 0; x + 1 < frame.w; x++) {
            const i = (y * frame.w + x) * 4
            const j = i + 4
            sum += Math.abs(frame.data[i] - frame.data[j]); count++
          }
        }
        return sum / count
      }
      const hash = frame => {
        let h = 2166136261
        for (let i = 0; i < frame.data.length; i += 16) { h ^= frame.data[i]; h = Math.imul(h, 16777619) }
        return (h >>> 0).toString(16)
      }

      const out = {}
      const make = options => {
        const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer,
          options: { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
            clouds: true, volumetricFog: true, sunScattering: true, antialiasing: 'smaa',
            shadows: true, shadowMode: 'custom', hdrBloomEnabled: false,
            materialChannelsEnabled: false, ...options } })
        pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
        return pipeline
      }

      // --- 1) 卫星底图可见 ---------------------------------------------
      {
        const pipeline = make({})
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 3000),
          orientation: { heading: 0, pitch: -0.5, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(50)
        const frame = grab()
        let imageryLayers = scene.imageryLayers.length
        let visibleImagery = 0
        for (let i = 0; i < imageryLayers; i++) {
          const layer = scene.imageryLayers.get(i)
          if (layer.show && layer.alpha > 0 && layer.imageryProvider) visibleImagery++
        }
        out.imagery = {
          imageryLayers, visibleImagery,
          globeShow: scene.globe.show,
          // 中心区域必须有内容而不是纯色：用标准差衡量。
          centreStats: centre(frame),
          frameGradient: gradient(frame),
          note: '该夹具的 globe 无外部影像层（`baseLayer:false`），因此影像可见性由 B00 的 campus target 覆盖'
        }
        pipeline.destroy()
      }

      // --- 2) 天空不漂白 -----------------------------------------------
      {
        const pipeline = make({ clouds: false, volumetricFog: false })
        // 抬头看天，使画面上半部分是天空。
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 3000),
          orientation: { heading: 0, pitch: 0.35, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(45)
        const frame = grab()
        const sky = region(frame, 0, 0, frame.w, Math.floor(frame.h * 0.3))
        out.sky = {
          skyMean: sky.mean, skyMax: sky.max, skySaturatedRatio: sky.saturatedRatio,
          // 「漂白」的可判定含义：大面积像素达到饱和。
          bleached: sky.saturatedRatio > 0.5 && sky.mean > 240
        }
        pipeline.destroy()
      }

      // --- 3+4) 树荫稳定 + 无浮空/重影 ---------------------------------
      //
      // 必须**自建 caster + receiver**：空舞台没有任何物体能投出阴影，
      // 直接比较「开/关阴影」只会得到 207 -> 207（实测如此），那是测了空场景，
      // 不是测阴影。这里放一个悬在接收面上方的立方体作为遮挡物，
      // 由它在地面投出可测的阴影。
      {
        const frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
        const world = local => C.Matrix4.multiplyByPoint(frame, local, new C.Cartesian3())
        const matrix = (local, scale) => C.Matrix4.multiplyByScale(
          C.Matrix4.multiply(frame, C.Matrix4.fromTranslation(local, new C.Matrix4()), new C.Matrix4()),
          scale, new C.Matrix4())
        // 接收面：大平面（水平）。
        const receiver = await C.Model.fromGltfAsync({ url: planeGlb(C, { baseColor: [0.62, 0.64, 0.66, 1],
          metallic: 0, roughness: 0.9 }),
          modelMatrix: matrix(new C.Cartesian3(0, 0, 0.05), new C.Cartesian3(400, 400, 1)),
          upAxis: C.Axis.Z, forwardAxis: C.Axis.X })
        scene.primitives.add(receiver)
        // 遮挡物：悬在接收面上方的立方体。
        const caster = await C.Model.fromGltfAsync({ url: cubeUrl(C, [0.5, 0.5, 0.5, 1]),
          modelMatrix: matrix(new C.Cartesian3(0, 0, 120), new C.Cartesian3(30, 30, 30)),
          upAxis: C.Axis.Z, forwardAxis: C.Axis.X })
        scene.primitives.add(caster)
        // 固定太阳，使阴影落点确定。
        const sunLocal = new C.Cartesian3(-0.4, -0.3, 0.86)
        const sunWorld = C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame, sunLocal, new C.Cartesian3()), new C.Cartesian3())
        scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(sunWorld, new C.Cartesian3()), intensity: 1 })
        // 从上方俯视落点。
        const shadowPoint = world(new C.Cartesian3(-0.4 / 0.86 * 120, -0.3 / 0.86 * 120, 0.06))
        f.viewer.camera.lookAt(shadowPoint, new C.HeadingPitchRange(0, -1.2, 260))
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(50)
        const shadowed = grab()
        const shadowedCentre = centre(shadowed)
        // 稳定性：连续帧中心均值波动 + 像素级变化帧数。
        const samples = []
        for (let i = 0; i < 30; i++) { await wait(1); samples.push(centre(grab()).mean) }
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length
        const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length

        // 关闭阴影后的同一视角。
        const noShadow = make({ shadows: false, shadowMode: 'native' })
        await wait(45)
        const lit = grab()
        const litCentre = centre(lit)
        noShadow.destroy()
        caster.destroy()
        receiver.destroy()

        out.shadows = {
          shadowedMean: shadowedCentre.mean, litMean: litCentre.mean,
          darkening: litCentre.mean - shadowedCentre.mean,
          visible: (litCentre.mean - shadowedCentre.mean) > 1,
          stabilityStdDev: Math.sqrt(variance),
          stable: Math.sqrt(variance) < 2,
          note: '自建 caster+receiver 保证阴影可测；像素级接地/浮空检查仍由 B04 的 check-shadow-cascades（接地首个阴影样本 0.1 m、300 静止帧逐像素一致）覆盖'
        }
      }

      // --- 5) SSR 旋转不骤黑 -------------------------------------------
      {
        const pipeline = make({ screenSpaceReflectionEnabled: true, materialChannelsEnabled: true })
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2500),
          orientation: { heading: 0, pitch: -0.4, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(45)
        const means = []
        for (let i = 0; i < 16; i++) {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2500),
            orientation: { heading: (i / 16) * Math.PI * 2, pitch: -0.4, roll: 0 } })
          f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
          await wait(4)
          means.push(centre(grab()).mean)
        }
        // 「骤黑」= 相邻两帧之间出现大幅度跌落。
        let maxDrop = 0
        for (let i = 1; i < means.length; i++) {
          const drop = (means[i - 1] - means[i]) / Math.max(means[i - 1], 1)
          if (drop > maxDrop) maxDrop = drop
        }
        out.ssrRotation = { samples: means.map(v => Math.round(v)), maxRelativeDrop: maxDrop,
          noSuddenBlackout: maxDrop < 0.5, ssrValid: pipeline.getRenderDiagnostics().screenSpaceReflections.valid }
        pipeline.destroy()
      }

      // --- 6) 高空云不扩距 ---------------------------------------------
      {
        const pipeline = make({ clouds: true, cloudGeometry: 'local' })
        const coverage = []
        for (const height of [20000, 50000, 100000, 200000]) {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, height),
            orientation: { heading: 0, pitch: -0.5, roll: 0 } })
          f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
          await wait(25)
          const frame = grab()
          coverage.push({ height, centreMean: centre(frame).mean, gradient: gradient(frame) })
        }
        // 「扩距」= 云覆盖随镜头升高异常膨胀。这里用梯度能量的增长作为代理：
        // 云层细节扩张会显著抬高梯度。
        const first = coverage[0].gradient
        const last = coverage[coverage.length - 1].gradient
        out.cloudRange = { coverage, gradientGrowth: last / Math.max(first, 1e-6),
          noExpansion: (last / Math.max(first, 1e-6)) < 3,
          note: '云层区间仍为预设档（clear 档 1600–2800 m），不是主计划所述的 12–50 km 固定档（B08 未完成项）' }
        pipeline.destroy()
      }

      // --- 7) AA 不模糊抖动 --------------------------------------------
      {
        const results = {}
        for (const mode of ['off', 'fxaa', 'smaa']) {
          const pipeline = make({ antialiasing: mode })
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2000),
            orientation: { heading: 0.3, pitch: -0.45, roll: 0 } })
          f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
          await wait(40)
          const frame = grab()
          results[mode] = { gradient: gradient(frame), hash: hash(frame) }
          pipeline.destroy()
        }
        // 「不模糊」= AA 后的梯度不低于关闭时的某个比例（过度模糊会显著降低梯度）。
        results.smaaRetention = results.smaa.gradient / Math.max(results.off.gradient, 1e-6)
        results.fxaaRetention = results.fxaa.gradient / Math.max(results.off.gradient, 1e-6)
        results.acceptable = results.smaaRetention > 0.6 && results.fxaaRetention > 0.6
        out.antialiasing = results
      }

      out.errors = f.errors.slice()
      return out
    })

    report.pageErrors.push(...pageErrors)
    report.checks = result
    fs.mkdirSync('docs/verification/stage1-B12', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B12/quality.json', JSON.stringify(report, null, 2))

    assert.deepEqual(pageErrors, [], 'no page errors')
    assert.deepEqual(result.errors, [], 'no render errors')

    // 2) 天空不漂白：不得大面积饱和。
    assert.equal(result.sky.bleached, false,
      `the sky must not be bleached: mean ${result.sky.skyMean}, saturated ${result.sky.skySaturatedRatio}`)

    // 3) 树荫明显且稳定。
    assert.equal(result.shadows.visible, true,
      `shadows must visibly darken the scene: ${result.shadows.litMean} -> ${result.shadows.shadowedMean}`)
    assert.equal(result.shadows.stable, true,
      `shadow output must be stable across frames: stddev ${result.shadows.stabilityStdDev}`)

    // 5) SSR 旋转不骤黑。
    assert.equal(result.ssrRotation.noSuddenBlackout, true,
      `SSR must not suddenly go black while rotating: max drop ${result.ssrRotation.maxRelativeDrop}`)

    // 6) 高空云不扩距。
    assert.equal(result.cloudRange.noExpansion, true,
      `cloud detail must not expand at altitude: gradient growth ${result.cloudRange.gradientGrowth}`)

    // 7) AA 不模糊。
    assert.equal(result.antialiasing.acceptable, true,
      `AA must not over-blur: smaa retention ${result.antialiasing.smaaRetention}, fxaa ${result.antialiasing.fxaaRetention}`)

    console.log(JSON.stringify({
      sky: { mean: Math.round(result.sky.skyMean), bleached: result.sky.bleached },
      shadows: { darkening: Number(result.shadows.darkening.toFixed(2)),
        stdDev: Number(result.shadows.stabilityStdDev.toFixed(3)), visible: result.shadows.visible },
      ssrRotation: { maxDrop: Number(result.ssrRotation.maxRelativeDrop.toFixed(3)),
        noBlackout: result.ssrRotation.noSuddenBlackout },
      cloudRange: { growth: Number(result.cloudRange.gradientGrowth.toFixed(2)),
        noExpansion: result.cloudRange.noExpansion },
      antialiasing: { smaaRetention: Number(result.antialiasing.smaaRetention.toFixed(3)),
        fxaaRetention: Number(result.antialiasing.fxaaRetention.toFixed(3)),
        acceptable: result.antialiasing.acceptable },
      imagery: { layers: result.imagery.imageryLayers, visible: result.imagery.visibleImagery }
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
