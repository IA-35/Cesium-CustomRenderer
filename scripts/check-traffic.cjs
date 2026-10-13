const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const base = process.env.CCR_TRAFFIC_URL || 'http://127.0.0.1:8766'
const folder = path.join(__dirname, '../docs/verification/traffic')
fs.mkdirSync(folder, { recursive: true })
async function main() {
  const launchOptions = { headless: true,
    ...(process.env.CCR_BROWSER_EXECUTABLE ? { executablePath: process.env.CCR_BROWSER_EXECUTABLE } : { channel: 'chrome' }) }
  let browser = await chromium.launch(launchOptions)
  const report = { url: `${base}/examples/traffic.html?mode=loop`, runs: [], performance: [],
    scope: 'Local synthetic closed roads, original demo cars, desktop Chrome. Short samples are observations, not target-device FPS acceptance.' }
  try {
    for (const sdk of ['source', 'umd']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
      const errors = [], failed = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('response', response => { if (response.status() >= 400) failed.push({ url: response.url(), status: response.status() }) })
      await page.goto(`${base}/examples/traffic.html?mode=loop${sdk === 'umd' ? '&sdk=umd' : ''}`)
      await page.waitForFunction(() => window.trafficDemo?.traffic?.state === 'ready', null, { timeout: 90000 })
      const snapshot = () => page.evaluate(() => {
        const { traffic, viewer, pipeline } = trafficDemo, C = Cesium
        return { ...traffic.getDiagnostics(), clock: C.JulianDate.toIso8601(viewer.clock.currentTime),
          shouldAnimate: viewer.clock.shouldAnimate, requestRenderMode: viewer.scene.requestRenderMode,
          positions: traffic.vehicles.map(v => C.Matrix4.getTranslation(v.model.modelMatrix, new C.Cartesian3())),
          pipelineEnabled: pipeline.enabled, errors: trafficDemo.errors }
      })
      const start = await snapshot()
      assert.equal(start.vehicles, 24); assert.equal(start.readyModels, 24)
      assert.equal(start.shouldAnimate, false); assert.equal(start.requestRenderMode, true)
      await page.waitForFunction(start => trafficDemo.traffic.elapsedSeconds > start + 1, start.elapsedSeconds)
      const moved = await snapshot()
      assert.equal(moved.clock, start.clock)
      assert.ok(Math.hypot(...['x', 'y', 'z'].map(axis => moved.positions[0][axis] - start.positions[0][axis])) > 5)
      await page.screenshot({ path: path.join(folder, `${sdk}-enhanced.png`) })
      await page.locator('#play').click()
      const paused = await snapshot()
      await page.waitForTimeout(350)
      assert.deepEqual((await snapshot()).positions, paused.positions)
      await page.locator('#speed').evaluate(input => { input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })) })
      assert.equal((await snapshot()).speedMultiplier, 2)
      await page.locator('#visible').uncheck()
      assert.equal(await page.evaluate(() => trafficDemo.traffic.vehicles.every(v => !v.model.show)), true)
      await page.locator('#visible').check()
      await page.locator('#enhanced').uncheck()
      assert.equal((await snapshot()).pipelineEnabled, false)
      await page.screenshot({ path: path.join(folder, `${sdk}-native.png`) })
      await page.locator('#enhanced').check()
      const picked = await page.evaluate(() => {
        const C = Cesium, { traffic, viewer } = trafficDemo
        const position = C.Matrix4.multiplyByPoint(traffic.vehicles[0].model.modelMatrix, new C.Cartesian3(0, 0, 1), new C.Cartesian3())
        const pixel = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, position)
        return viewer.scene.pick(pixel)?.id
      })
      assert.equal(picked?.type, 'traffic')
      await page.locator('#play').click()
      await page.waitForFunction(time => trafficDemo.traffic.elapsedSeconds > time + .3, paused.elapsedSeconds)
      const loop = await page.evaluate(async () => {
        const C = Cesium, traffic = trafficDemo.traffic, car = traffic.vehicles[0]
        traffic.pause(); traffic.setSpeed(1); car.distance = car.route.length - .1
        traffic._place(car)
        const previous = C.Cartesian3.clone(car.position)
        const time = traffic.elapsedSeconds; traffic.play()
        await new Promise(resolve => { const off = trafficDemo.viewer.scene.postRender.addEventListener(() => {
          if (traffic.elapsedSeconds > time + .15) { off(); resolve() }
        }) })
        traffic.pause()
        return { wrappedDistance: car.distance, displacement: C.Cartesian3.distance(previous, car.position) }
      })
      assert.ok(loop.wrappedDistance < 20); assert.ok(loop.displacement < 20)
      report.runs.push({ sdk, ...await snapshot(), loop, picked, pageErrors: errors, failed })
      assert.deepEqual(errors, []); assert.deepEqual(failed, [])
      assert.deepEqual((await snapshot()).errors, [])
      const cleaned = await page.evaluate(() => {
        const { traffic, viewer } = trafficDemo, before = viewer.scene.primitives.length, listeners = viewer.scene.preUpdate.numberOfListeners
        traffic.destroy(); traffic.destroy()
        return { before, after: viewer.scene.primitives.length, listeners, remainingListeners: viewer.scene.preUpdate.numberOfListeners }
      })
      assert.equal(cleaned.before - cleaned.after, 24)
      assert.equal(cleaned.listeners - cleaned.remainingListeners, 1)
      report.runs.at(-1).cleanup = cleaned
      if (sdk === 'source') {
        for (const count of [10, 50, 100]) {
          const measured = await page.evaluate(async count => {
            const response = await fetch('./traffic-assets/traffic.json'), data = await response.json(), { viewer, pipeline } = trafficDemo
            data.vehicles = Array.from({ length: count }, (_, index) => ({ ...data.vehicles[index % 24], id: `bench-${index}` }))
            const traffic = CCR.createTrafficSystem({ Cesium, viewer, pipeline, routes: data.routes,
              vehicles: data.vehicles.map(v => ({ ...v, url: new URL(`./traffic-assets/${v.url}`, location.href).href })) })
            await traffic.readyPromise
            const samples = []; let previous
            await new Promise(resolve => { const off = viewer.scene.postRender.addEventListener(() => {
              const now = performance.now(); if (previous !== undefined) samples.push(now - previous); previous = now
              if (samples.length >= 60) { off(); resolve() }
            }) })
            const sorted = [...samples].sort((a, b) => a - b), gl = viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info')
            const result = { count, readyModels: traffic.getDiagnostics().readyModels, frames: samples.length,
              meanFrameMs: samples.reduce((n, x) => n + x, 0) / samples.length,
              p95FrameMs: sorted[Math.floor(sorted.length * .95)],
              renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
              customShadow: { ...pipeline.customShadow.stats } }
            traffic.destroy(); return result
          }, count)
          assert.equal(measured.readyModels, count)
          report.performance.push(measured)
        }
      }
      await page.close()
    }
    // Campus acceptance is a cold launch, independent of synthetic scale runs.
    await browser.close()
    browser = await chromium.launch(launchOptions)
    const campusPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
    const campusErrors = [], campusFailed = []
    campusPage.on('pageerror', error => campusErrors.push(error.message))
    campusPage.on('response', response => { if (response.status() >= 400) campusFailed.push({ url: response.url(), status: response.status() }) })
    const campusUrl = process.env.CCR_TRAFFIC_CAMPUS_URL || `${base}/examples/campus.html?models=tiles&traffic=/examples/traffic-assets/network.json&imagery=none&trees=none&water=none&grass=none&contextTiles=none&assets=/assets/campus-assets`
    await campusPage.goto(campusUrl)
    try {
      await campusPage.waitForFunction(() => window.campus?.traffic?.state === 'ready' && campus.assetsReady(), null, { timeout: 120000 })
    } catch (error) {
      const state = await campusPage.evaluate(() => ({ status: document.querySelector('#status')?.textContent,
        traffic: window.campus?.traffic?.getDiagnostics(), assetsReady: window.campus?.assetsReady(),
        tiles: window.campus?.tiles.map(tile => ({ name: tile.name, loaded: tile.tilesLoaded })), errors: window.campus?.errors }))
      fs.writeFileSync(path.join(folder, 'campus-failure.json'), JSON.stringify({ state, pageErrors: campusErrors, failed: campusFailed }, null, 2))
      throw error
    }
    report.campus = await campusPage.evaluate(async () => {
      const initialClock = Cesium.JulianDate.toIso8601(campus.viewer.clock.currentTime), initial = campus.traffic.elapsedSeconds
      await new Promise(resolve => { const off = campus.viewer.scene.postRender.addEventListener(() => {
        if (campus.traffic.elapsedSeconds > initial + .3) { off(); resolve() }
      }) })
      return { traffic: campus.traffic.getDiagnostics(), networkLoaded: !!campus.traffic.network,
        models: campus.models.length, expectedModels: campus.expectedModels,
        tiles: campus.tiles.map(tile => ({ name: tile.name, loaded: tile.tilesLoaded })), assetsReady: campus.assetsReady(),
        clockUnchanged: initialClock === Cesium.JulianDate.toIso8601(campus.viewer.clock.currentTime),
        errors: campus.errors, controlsVisible: document.body.textContent.includes('道路车流') }
    })
    report.campus.url = campusUrl
    report.campus.scope = 'Cold-browser campus integration with synthetic demo network and configured assets only; real road alignment is not validated. Default check uses ground Tiles.'
    report.campus.pageErrors = campusErrors; report.campus.failed = campusFailed
    assert.equal(report.campus.traffic.vehicles, 24); assert.equal(report.campus.clockUnchanged, true)
    if (!process.env.CCR_TRAFFIC_CAMPUS_URL) assert.equal(report.campus.networkLoaded, true)
    assert.equal(report.campus.controlsVisible, true); assert.equal(report.campus.models, report.campus.expectedModels)
    assert.deepEqual(campusErrors, []); assert.deepEqual(campusFailed, []); assert.deepEqual(report.campus.errors, [])
    await campusPage.screenshot({ path: path.join(folder, 'campus-integration.png') })
    await campusPage.close()
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ runs: report.runs.map(r => ({ sdk: r.sdk, vehicles: r.vehicles, loop: r.loop, cleanup: r.cleanup })),
      performance: report.performance.map(p => ({ count: p.count, meanFrameMs: p.meanFrameMs, p95FrameMs: p.p95FrameMs, renderer: p.renderer })) }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
