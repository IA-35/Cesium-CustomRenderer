const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const base = process.env.CCR_TRAFFIC_URL || 'http://127.0.0.1:8766'
const schoolMode = process.argv.includes('--school')
const folder = path.join(__dirname, schoolMode ? '../docs/verification/campus-traffic' : '../docs/verification/traffic-network')
fs.mkdirSync(folder, { recursive: true })
async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CCR_BROWSER_EXECUTABLE ? { executablePath: process.env.CCR_BROWSER_EXECUTABLE } : { channel: 'chrome' }) })
  const report = { runs: [], scope: schoolMode
    ? 'Provided school GeoJSON compiled into uniform two-lane roads (3 metres per direction), ignoring source WIDTH; flat height and assumed same-level intersections. Actual campus-model alignment and target throughput not validated.'
    : 'Synthetic directed lanes; school GIS topology/alignment and target-device throughput are not validated.' }
  try {
    for (const sdk of process.argv.includes('--source-only') ? ['source'] : ['source', 'umd']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
      const errors = [], failed = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('response', r => { if (r.status() >= 400) failed.push({ url: r.url(), status: r.status() }) })
      await page.goto(`${base}/examples/traffic.html?mode=${schoolMode ? 'campus' : 'sample'}${sdk === 'umd' ? '&sdk=umd' : ''}`)
      await page.waitForFunction(() => window.trafficDemo?.traffic?.state === 'ready', null, { timeout: 90000 })
      await page.evaluate(() => {
        const C = Cesium, { viewer, traffic } = trafficDemo
        window.networkInitialModels = traffic.vehicles.map(v => v.model)
        const inverse = C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(trafficDemo.center), new C.Matrix4())
        const evidence = window.networkEvidence = { samples: 0, minimumGap: Infinity, gapErrors: [], bodyOverlaps: [], turns: 0,
          followingObserved: false, junctionWaitingObserved: false, maxModels: 0, previous: {}, clock: C.JulianDate.toIso8601(viewer.clock.currentTime) }
        const overlaps = (a, b) => {
          const delta = [b.p.x - a.p.x, b.p.y - a.p.y]
          for (const axis of [a.f, a.r, b.f, b.r]) {
            const dot = vector => vector[0] * axis[0] + vector[1] * axis[1]
            const ra = Math.abs(dot(a.f)) * a.length / 2 + Math.abs(dot(a.r)) * a.width / 2
            const rb = Math.abs(dot(b.f)) * b.length / 2 + Math.abs(dot(b.r)) * b.width / 2
            if (Math.abs(dot(delta)) >= ra + rb - .03) return false
          }
          return true
        }
        window.networkObserveOff = viewer.scene.postRender.addEventListener(() => {
          evidence.samples++
          const groups = new Map(), active = []
          for (const car of traffic.vehicles) {
            if (car.state === 'driving' || car.state === 'spawning') {
              if (!groups.has(car.route.id)) groups.set(car.route.id, [])
              groups.get(car.route.id).push(car)
            }
            const previous = evidence.previous[car.id]
            if (previous && previous.generation === car.generation && previous.state === 'driving' && car.state === 'driving' && previous.routeId !== car.route.id) evidence.turns++
            evidence.previous[car.id] = { generation: car.generation, state: car.state, routeId: car.route.id }
            if (car.state !== 'driving' || !car.model?.ready || !car.model.show) continue
            const matrix = C.Matrix4.multiply(inverse, car.model.modelMatrix, new C.Matrix4())
            const p = C.Matrix4.getTranslation(matrix, new C.Cartesian3()), f = [matrix[0], matrix[1]], r = [matrix[4], matrix[5]]
            active.push({ id: car.id, routeId: car.route.id, p, f, r, length: car.length, width: car.width })
          }
          for (const [id, cars] of groups) {
            cars.sort((a, b) => a.distance - b.distance)
            for (let i = 1; i < cars.length; i++) {
              const gap = cars[i].distance - cars[i - 1].distance - (cars[i].length + cars[i - 1].length) / 2
              evidence.minimumGap = Math.min(evidence.minimumGap, gap)
              if (gap < 1.99 && evidence.gapErrors.length < 8) evidence.gapErrors.push({ id, gap, cars: [cars[i - 1].id, cars[i].id] })
            }
          }
          for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
            if (overlaps(active[i], active[j]) && evidence.bodyOverlaps.length < 8) evidence.bodyOverlaps.push({ frame: evidence.samples, a: active[i], b: active[j] })
          }
          const diagnostics = traffic.getDiagnostics()
          evidence.followingObserved ||= diagnostics.following > 0
          evidence.junctionWaitingObserved ||= diagnostics.junctionWaiting > 0
          evidence.maxModels = Math.max(evidence.maxModels, traffic.vehicles.filter(v => v.model).length)
        })
      })
      await page.locator('#speed').evaluate(input => { input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true })) })
      await page.waitForFunction(school => trafficDemo.traffic.elapsedSeconds > (school ? 20 : 8) &&
        trafficDemo.traffic.getDiagnostics().despawned >= (school ? 1 : 4), schoolMode, { timeout: 60000 })
      await page.locator('#play').click()
      const before = await page.evaluate(() => trafficDemo.traffic.vehicles.map(v => ({ id: v.id, generation: v.generation, routeId: v.route.id, distance: v.distance })))
      await page.waitForTimeout(250)
      const after = await page.evaluate(() => trafficDemo.traffic.vehicles.map(v => ({ id: v.id, generation: v.generation, routeId: v.route.id, distance: v.distance })))
      assert.deepEqual(after, before)
      await page.locator('#visible').uncheck()
      assert.equal(await page.evaluate(() => trafficDemo.traffic.vehicles.every(v => !v.model?.show)), true)
      await page.locator('#visible').check()
      assert.equal(await page.evaluate(() => trafficDemo.traffic.vehicles.filter(v => v.state !== 'driving').every(v => !v.model?.show)), true)
      await page.screenshot({ path: path.join(folder, `${sdk}-network.png`) })
      if (schoolMode) {
        await page.locator('#closeup').click()
        await page.waitForTimeout(100)
        await page.screenshot({ path: path.join(folder, `${sdk}-closeup.png`) })
      }
      const result = await page.evaluate(() => {
        networkObserveOff()
        const { traffic, viewer } = trafficDemo
        return { evidence: networkEvidence, diagnostics: traffic.getDiagnostics(),
          destroyedOriginalModels: networkInitialModels.filter(model => model.isDestroyed()).length,
          clockUnchanged: networkEvidence.clock === Cesium.JulianDate.toIso8601(viewer.clock.currentTime), errors: trafficDemo.errors,
          routeCount: traffic.routes.size, nodeCount: traffic.network.nodes.size }
      })
      report.runs.push({ sdk, ...result, pageErrors: errors, failed })
      fs.writeFileSync(path.join(folder, 'observations.json'), JSON.stringify(report, null, 2))
      assert.equal(result.routeCount, schoolMode ? 286 : 10); assert.equal(result.nodeCount, schoolMode ? 97 : 6)
      assert.deepEqual(result.evidence.gapErrors, []); assert.deepEqual(result.evidence.bodyOverlaps, [])
      assert.ok(result.evidence.turns > 0); assert.ok(result.evidence.followingObserved)
      assert.ok(result.evidence.junctionWaitingObserved); assert.ok(result.destroyedOriginalModels >= (schoolMode ? 1 : 4))
      assert.ok(result.diagnostics.spawned >= (schoolMode ? 1 : 4)); assert.ok(result.evidence.maxModels <= (schoolMode ? 60 : 24))
      assert.equal(result.clockUnchanged, true); assert.deepEqual(result.diagnostics.respawnErrors, [])
      assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(result.errors, [])
      const cleanup = await page.evaluate(() => {
        const { traffic, viewer } = trafficDemo
        traffic.destroy(); traffic.destroy()
        return { models: traffic.vehicles.length, reservations: traffic.simulation.getDiagnostics().reservations, primitives: viewer.scene.primitives.length }
      })
      assert.equal(cleanup.models, 0); assert.equal(cleanup.reservations, 0); assert.equal(cleanup.primitives, 2)
      report.runs.at(-1).cleanup = cleanup
      await page.close()
    }
    report.passed = true
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report.runs.map(run => ({ sdk: run.sdk, samples: run.evidence.samples,
      minimumGap: run.evidence.minimumGap, turns: run.evidence.turns, despawned: run.diagnostics.despawned,
      spawned: run.diagnostics.spawned, originalModelsDestroyed: run.destroyedOriginalModels, cleanup: run.cleanup }))))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
