const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const url = process.env.CCR_CAMPUS_TRAFFIC_URL || 'http://127.0.0.1:8766/examples/campus.html'
const folder = path.join(__dirname, '../docs/verification/campus-traffic-integration')
fs.mkdirSync(folder, { recursive: true })
async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CCR_BROWSER_EXECUTABLE ? { executablePath: process.env.CCR_BROWSER_EXECUTABLE } : { channel: 'chrome' }) })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Shanghai' })
    const errors = [], failed = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('response', r => { if (r.status() >= 400) failed.push({ url: r.url(), status: r.status() }) })
    await page.goto(url)
    try {
      await page.waitForFunction(() => window.campus?.traffic?.state === 'ready', null, { timeout: 180000 })
    } catch (error) {
      const state = await page.evaluate(() => ({ status: document.querySelector('#status').textContent,
        models: window.campus?.models.length, errors: window.campus?.errors,
        placement: window.campus?.trafficPlacement, traffic: window.campus?.traffic?.getDiagnostics() }))
      fs.writeFileSync(path.join(folder, 'failure.json'), JSON.stringify({ state, errors, failed }, null, 2))
      throw error
    }
    await page.evaluate(() => campus.lookAtTraffic(160))
    await page.waitForTimeout(300)
    const start = await page.evaluate(() => ({ clock: Cesium.JulianDate.toIso8601(campus.viewer.clock.currentTime),
      elapsed: campus.traffic.elapsedSeconds, distance: campus.traffic.vehicles[0].distance,
      position: { ...campus.traffic.vehicles[0].position }, rendered: campus.traffic.vehicles.map(v => ({ id: v.id,
        position: Cesium.Matrix4.getTranslation(v.model.modelMatrix, new Cesium.Cartesian3()) })) }))
    await page.waitForFunction(time => campus.traffic.elapsedSeconds > time + 1, start.elapsed)
    await page.screenshot({ path: path.join(folder, 'campus-traffic-closeup.png') })
    const result = await page.evaluate(async () => {
      const C = Cesium
      campus.traffic.pause()
      let car, picked
      for (const candidate of campus.traffic.vehicles.filter(v => v.state === 'driving')) {
        const world = C.Matrix4.multiplyByPoint(candidate.model.modelMatrix, new C.Cartesian3(0,0,1), new C.Cartesian3())
        const pixel = C.SceneTransforms.worldToWindowCoordinates(campus.viewer.scene, world)
        if (!pixel || pixel.x < 0 || pixel.y < 0 || pixel.x > campus.viewer.canvas.clientWidth || pixel.y > campus.viewer.canvas.clientHeight) continue
        const id = campus.viewer.scene.pick(pixel)?.id
        if (id?.type === 'traffic' && id.id === candidate.id) { car = candidate; picked = id; break }
      }
      car ||= campus.traffic.vehicles.find(v => v.state === 'driving')
      const height = C.Cartographic.fromCartesian(car.position).height
      return { url: location.href, models: campus.models.length, traffic: campus.traffic.getDiagnostics(),
        placement: campus.trafficPlacement, height, picked, clock: C.JulianDate.toIso8601(campus.viewer.clock.currentTime),
        errors: campus.errors, trees: campus.trees?.getDiagnostics(), water: campus.water?.getDiagnostics(),
        id: car.id, position: { ...car.position }, expectedMatrix: C.Matrix4.toArray(car.model.modelMatrix),
        movement: campus.traffic.vehicles.map(v => ({ id: v.id, distance: v.distance, speed: v.currentSpeed, routeId: v.route.id,
          renderedPosition: C.Matrix4.getTranslation(v.model.modelMatrix, new C.Cartesian3()) })),
        controls: document.body.textContent.includes('道路车流') && document.body.textContent.includes('车流近景') }
    })
    fs.writeFileSync(path.join(folder, 'observations.json'), JSON.stringify({ result, errors, failed }, null, 2))
    assert.equal(result.models, 70)
    assert.equal(result.traffic.vehicles, 60); assert.equal(result.traffic.readyModels, 60)
    assert.equal(result.clock, start.clock)
    assert.ok(result.traffic.elapsedSeconds > start.elapsed)
    assert.ok(result.movement.some(v => v.speed > .1), 'cars must actually move after ground placement')
    result.renderedDisplacements = result.movement.map(v => {
      const before = start.rendered.find(car => car.id === v.id).position
      return { id: v.id, metres: Math.hypot(...['x','y','z'].map(axis => v.renderedPosition[axis] - before[axis])) }
    })
    assert.ok(result.renderedDisplacements.some(v => v.metres > 1), 'rendered car matrices must move')
    assert.ok(result.height > 1)
    assert.equal(result.controls, true)
    assert.ok(result.placement.measuredSamples > 0)
    assert.equal(result.picked?.type, 'traffic')
    await page.waitForTimeout(200)
    assert.deepEqual(await page.evaluate(id => Cesium.Matrix4.toArray(campus.traffic.vehicles.find(v => v.id === id).model.modelMatrix), result.id), result.expectedMatrix)
    await page.evaluate(() => campus.traffic.setVisible(false))
    assert.equal(await page.evaluate(() => campus.traffic.vehicles.every(v => !v.model?.show)), true)
    await page.evaluate(() => { campus.traffic.setVisible(true); campus.traffic.setSpeed(2); campus.traffic.play(); campus.lookAtTraffic(1700, true) })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(folder, 'campus-traffic-overview.png') })
    assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(result.errors, [])
    result.pageErrors = errors; result.failed = failed
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ url, models: result.models, cars: result.traffic.vehicles, placement: result.placement,
      height: result.height, picked: result.picked, pageErrors: errors, failed }))
    await page.close()
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
