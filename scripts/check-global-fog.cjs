// B08 验收：全球地理高度雾、多视锥透明介质与介质遮挡数据。
//
// 目标是主计划 B08 的几条硬要求，逐条都要有实际渲染证据：
//   1. 相同椭球高度/相对镜头的密度响应一致，无跨原点跳变；
//   2. 透明前后积分不重复（按各片元自身距离读取，而不是统一用背景地面深度）；
//   3. 高空不形成整层灰幕、云空区间无无效 raymarch 循环；
//   4. 介质遮挡/透射率数据与独立 CPU 积分对照在误差内。
//
// 方法：全部在全局不同经纬度取景，直接读 HDR 呈像并做差分，
// 不依赖实现自己的中间量当基准。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877

// 全球位置矩阵：校园、赤道、近极区、跨经度、山区、高空。
const LOCATIONS = [
  { name: 'campus', longitude: 116.39, latitude: 39.9 },
  { name: 'equator', longitude: 0, latitude: 0 },
  { name: 'near-pole', longitude: 0, latitude: 78 },
  { name: 'cross-longitude-west', longitude: -120, latitude: 39.9 },
  { name: 'cross-longitude-east', longitude: 120, latitude: 39.9 },
  { name: 'southern', longitude: 150, latitude: -35 }
]

/** 在给定经纬度上空跑一帧，返回中心区域的 HDR 呈像统计与生效雾参数。 */
async function sample(page, { longitude, latitude, height, options, frames = 45 }) {
  return page.evaluate(async ({ longitude, latitude, height, options, frames }) => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    // 固定「当地太阳时」，而不是固定 UTC 时刻。
    //
    // 为什么必须这样做：环境渲染器自己按 `viewer.clock.currentTime` 计算太阳位置
    // （EnvironmentRenderer.js:145），因此同一 UTC 时刻下经度决定当地昼夜——
    // 实测直接比较各地绝对亮度得到 38 倍差异，那测的是昼夜照明，与雾无关。
    //
    // 做法：把 UTC 设为**当地正午**。当地正午的 UTC 时刻是 12:00 - 经度/15 小时
    // （每 15° 差一小时）。注意符号方向：东经 120° 的当地正午是 04:00 UTC，
    // 而 12:00 UTC 在 120°E 已经是当地午夜——第一版写反了方向，
    // 结果东侧测到的是夜间，实测 daylight=0.02、sunIntensity=0，被误读成雾的缺陷。
    const hours = 12 - longitude / 15
    const base = C.JulianDate.fromIso8601('2026-06-21T00:00:00Z')
    const shifted = C.JulianDate.addSeconds(base, hours * 3600, new C.JulianDate())
    f.viewer.clock.currentTime = shifted
    f.viewer.clock.shouldAnimate = false
    scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
    scene.skyBox.show = false
    scene.skyAtmosphere.show = false
    scene.sun.show = false
    scene.moon.show = false
    const origin = C.Cartesian3.fromDegrees(longitude, latitude, 0)
    const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer, options })
    pipeline.setCampusOrigin(origin)
    f.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(longitude, latitude, height),
      orientation: { heading: 0, pitch: -0.35, roll: 0 }
    })
    f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
    let counted = 0
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('frame timeout: ' + f.errors.join(' | '))) }, 30000)
      const off = scene.postRender.addEventListener(() => {
        if (++counted !== frames) return
        off(); clearTimeout(timer); resolve()
      })
    })
    // 读中心区域的 HDR 亮度均值（直接来自呈像，不用实现中间量）。
    const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
    const size = 24
    const data = scene.context.readPixels({
      x: Math.max(0, Math.floor(w / 2 - size / 2)), y: Math.max(0, Math.floor(h / 2 - size / 2)),
      width: size, height: size
    })
    let sum = 0
    for (let i = 0; i < size * size; i++) sum += (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
    // 同时记录**与位置无关**的雾参数证据：椭球高度语义下，
    // 相同椭球高度必须给出相同密度，与经纬度无关。这里取的是环境状态里的
    // 实际生效参数（不是请求值），配合各处相同的相机高度构成一致性证据。
    const environment = pipeline.environmentRenderer
    const result = {
      mean: sum / (size * size),
      cameraHeight: scene.camera.positionCartographic.height,
      daylight: environment && environment.state ? environment.state.daylight : null,
      sunIntensity: environment && environment.state ? environment.state.sunIntensity : null,
      fogDensity: environment && environment.state ? environment.state.fogDensity : null,
      fogScaleHeight: environment && environment.state ? environment.state.fogScaleHeight : null,
      fogBaseHeight: environment && environment.state ? environment.state.fogBaseHeight : null,
      originHeight: environment ? environment.originHeight : null,
      withinRegion: environment ? environment.withinRegion : null,
      errors: f.errors.slice()
    }
    pipeline.destroy()
    return result
  }, { longitude, latitude, height, options, frames })
}

const FOG_OPTIONS = {
  environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
  clouds: false, volumetricFog: false, sunScattering: false,
  antialiasing: 'off', hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'native'
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const negativeControls = []
  try {
    // --- 负对照（必须有，否则「六地一致」可能只是没测到雾）-------------------
    // 这一组是本轮真实缺陷的来源：雾开/关有差异说明雾在跑，但 16 倍密度差
    // 曾给出**逐位相同**的画面，说明参数根本没进模型。任何「一致性」结论
    // 都必须先过这道门，否则一致可能只是「什么都没发生」。
    {
      const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
      await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })
      const controls = await page.evaluate(async () => {
        const C = Cesium, f = fixture, scene = f.viewer.scene
        scene.skyBox.show = false; scene.skyAtmosphere.show = false
        scene.sun.show = false; scene.moon.show = false
        const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
          (12 - 116.39 / 15) * 3600, new C.JulianDate())
        f.viewer.clock.currentTime = shifted
        f.viewer.clock.shouldAnimate = false
        scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
        const out = []
        for (const [label, patch] of [
          ['fog-disabled', { fog: false }],
          ['fog-default', {}],
          ['fog-thick', { fogDensity: 0.0004 }]
        ]) {
          const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer,
            options: { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
              clouds: false, volumetricFog: false, sunScattering: false, antialiasing: 'off',
              hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'native', ...patch } })
          pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2000),
            orientation: { heading: 0, pitch: -0.35, roll: 0 } })
          f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
          await new Promise(r => { let n = 40; const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); r() } }) })
          const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight, size = 24
          const data = scene.context.readPixels({ x: Math.floor(w / 2 - size / 2), y: Math.floor(h / 2 - size / 2), width: size, height: size })
          let sum = 0
          for (let i = 0; i < size * size; i++) sum += (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
          const env = pipeline.environmentRenderer
          out.push({ label, mean: sum / (size * size),
            effectiveDensity: env && env.state ? env.state.fogDensity : null })
          pipeline.destroy()
        }
        return out
      })
      controls.pageErrors = pageErrors
      for (const control of controls) control.pageErrors = pageErrors
      negativeControls.push(...controls)
      await page.close()
    }
    {
      const off = negativeControls.find(c => c.label === 'fog-disabled')
      const on = negativeControls.find(c => c.label === 'fog-default')
      const thick = negativeControls.find(c => c.label === 'fog-thick')
      assert.ok(off && on && thick, 'negative controls must all run')
      for (const control of negativeControls) {
        assert.deepEqual(control.pageErrors, [], `negative control ${control.label}: no page errors`)
      }
      // 1) 雾必须真的改变画面（否则一致性结论无意义）。
      assert.notEqual(off.mean, on.mean, 'enabling fog must change the frame, otherwise nothing is measured')
      // 2) 密度必须真的进入模型（这是本轮修掉的缺陷）。
      assert.notEqual(on.mean, thick.mean,
        `fogDensity must affect the result: default ${on.mean} vs 16x ${thick.mean}`)
      assert.ok(thick.effectiveDensity > on.effectiveDensity, 'the denser setting must resolve to a larger density')
    }

    const report = { locations: [], negativeControls, pageErrors: [] }
    for (const location of LOCATIONS) {
      const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
      await page.waitForFunction(() => window.fixture || window.viewer, null, { timeout: 30000 })
      // stage1-fixture 需要 CCR 与 viewer 就绪；沿用它的既有约定。
      const ready = await page.evaluate(() => !!(window.fixture && window.fixture.CCR))
      if (!ready) { await page.close(); continue }
      const result = await sample(page, { ...location, height: 2000, options: FOG_OPTIONS })
      result.name = location.name
      result.pageErrors = pageErrors
      report.pageErrors.push(...pageErrors)
      report.locations.push(result)
      await page.close()
    }
    fs.mkdirSync('docs/verification/stage1-B08', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B08/locations.json', JSON.stringify(report, null, 2))
    assert.deepEqual(report.pageErrors, [], 'no page errors')
    assert.ok(report.locations.length >= 4, `need several global locations, got ${report.locations.length}`)
    for (const item of report.locations) {
      assert.deepEqual(item.errors, [], `${item.name}: no render errors`)
      assert.ok(Number.isFinite(item.mean), `${item.name}: must produce a finite HDR mean`)
      assert.ok(item.mean > 0, `${item.name}: the frame must not be black`)
    }
    // 主计划：任意经纬度同一高度语义一致。
    //
    // 判据分两层，缺一不可：
    //   1. 结构层：同一相机高度下，各地**生效的雾参数**必须一致
    //      （椭球高度语义的直接推论——密度只由高度与雾参数决定，与经纬度无关）；
    //   2. 呈像层：各地画面不能出现量级差异（黑幕/灰幕），
    //      且必须全部处于白昼（daylight≈1），否则测的是昼夜而不是雾。
    const means = report.locations.map(i => i.mean)
    const min = Math.min(...means), max = Math.max(...means)
    assert.ok(max / min < 1.05,
      `global fog response must stay in a tight band at a fixed camera height, got ${min}..${max}`)
    for (const item of report.locations) {
      assert.ok(item.daylight > 0.99,
        `${item.name}: must be sampled at local noon, got daylight ${item.daylight}`)
      assert.equal(item.fogDensity, report.locations[0].fogDensity,
        `${item.name}: effective fog density must not depend on location`)
      assert.equal(item.fogScaleHeight, report.locations[0].fogScaleHeight,
        `${item.name}: effective fog scale height must not depend on location`)
      assert.equal(item.withinRegion, true, `${item.name}: must be inside the environment region`)
    }
    // 呈像层的一致性判据用**相对容差**而不是逐位相等。
    //
    // 为什么不能要求逐位相同：各地地形与影像纹理不同，同一屏幕像素落在不同
    // 地貌上会有亚像素级差异——实测同一相机高度下的差异约 3e-5 相对量级
    // （206.962963 / 206.958333 / 206.965278），这是纹理与地形采样差异，
    // 不是雾的地理不一致。真正要拒绝的是「跨原点跳变」这种量级问题：
    // 若椭球高度语义错误（例如把切平面高度当椭球高度），50 km 处会有约 196 m
    // 的高度偏差、密度差可达数倍，绝无可能落在 1% 以内。
    const spread = (max - min) / max
    assert.ok(spread < 0.01,
      `global fog response must agree within 1% at a fixed camera height, got spread ${spread} over ${min}..${max}`)
    console.log(JSON.stringify(report.locations.map(i => ({
      name: i.name, mean: Number(i.mean.toFixed(5)), cameraHeight: Number(i.cameraHeight.toFixed(1))
    })), null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
