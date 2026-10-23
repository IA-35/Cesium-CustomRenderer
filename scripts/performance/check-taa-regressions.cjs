// Real WebGL checks for picking continuity, subpixel coverage, and actual reveals.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
const root = path.resolve(__dirname, '../..'), port = 8996
const out = path.join(root, 'docs/verification/rendering-performance/traa-r186-2026-10-16/fixes-20261019')
async function main() {
  fs.mkdirSync(out, { recursive: true })
  const server = spawn(process.execPath, ['scripts/dev-server.cjs', '--port', String(port)], { cwd: root, windowsHide: true, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11'] })
    const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
    if (process.argv.includes('--bundle')) await page.route('**/__r186-sdk.js', route => route.fulfill({ body: fs.readFileSync(path.join(root, 'build/0.1.0/CCR.min.js')), contentType: 'application/javascript' }))
    await page.goto(`http://127.0.0.1:${port}/tests/rendering/taa-r186-fixture.html${process.argv.includes('--bundle') ? '?bundle=1' : ''}`)
    await page.waitForFunction(() => window.fixture)
    const report = await page.evaluate(async noRhi => {
      const f = fixture, C = Cesium, s = f.viewer.scene, lib = await import('/tests/rendering/taa-r186-fixture.js')
      await lib.startR186Fixture(f)
      await f.configure(8)
      if (noRhi) { f.pipeline.setAntiAliasing('fxaa'); f.pipeline.taa.rhi = null; await f.configure(8) }
      await f.steps(256)
      const t = f.pipeline.taa, result = { noRhi, gpu: f.gpu, picks: [], reveals: [], coverage: [] }
      const require = (value, message) => { if (!value) throw Error(message) }
      for (const pick of ['model', 'empty', 'position', 'drill']) {
        const age = t.historyAge
        if (pick === 'position') s.pickPosition(new C.Cartesian2(320, 210))
        else if (pick === 'drill') s.drillPick(new C.Cartesian2(2, 2))
        else s.pick(new C.Cartesian2(pick === 'model' ? 320 : 2, pick === 'model' ? 210 : 2))
        for (let i = 0; i < 3; i++) {
          f.step()
          require(t.historyAge === age + i + 1 && t.historyValid, `${pick}: history restarted`)
          require(t.motion.active && t.motion.stats.newSurfaces === 0, `${pick}: motion snapshots lost`)
        }
        result.picks.push({ pick, ageBefore: age, ageAfter: t.historyAge })
      }
      let current, resolved
      for (const frame of t.frames) {
        const execute = frame.collection.execute
        frame.collection.execute = function (context, color, depth, id) {
          current = f.read(color)
          const value = execute.call(this, context, color, depth, id)
          resolved = f.read(frame.resolve.outputTexture)
          return value
        }
      }
      // Keep one unrelated surface visible so disappearing onto sky still has a
      // colour frustum and exercises resolve rather than the empty-scene bypass.
      const anchor = await f.addPlane('sky-frustum-anchor', -20, 20, 2, 1, 1, [.2,.2,.2])
      for (const sky of [false, true]) {
        f.backdrop.show = !sky; f.geometry.forEach(m => { m.show = m === anchor }); f.moving.show = true
        await f.steps(64); f.moving.show = false; f.step()
        const i = (210 * 640 + 320) * 4, error = Math.max(...[0, 1, 2].map(c => Math.abs(current[i + c] - resolved[i + c])))
        require(t.stableCoverage && t.motion.stats.previousFootprints > 0 && error < 1e-4, `disappearance: ${JSON.stringify({sky,error,stable:t.stableCoverage,changed:t.motion.changed,submitted:t.motion.submitted.size,previous:t.motion.previousSubmitted.size,stats:t.motion.stats})}`)
        result.reveals.push({ sky, error, age: resolved[i + 3] })
      }
      const tiny = await f.addPlane('coverage-regression', 20, 0, 12, .045, .045, [.95, .95, .95], { emissive: [1, 1, 1] })
      for (let i = 0; i < 120 && !tiny.ready; i++) { f.step(); await new Promise(requestAnimationFrame) }
      require(tiny.ready, 'tiny geometry failed to load')
      const windowPoint = C.SceneTransforms.worldToWindowCoordinates(s, C.Matrix4.multiplyByPoint(f.frame, new C.Cartesian3(20, 0, 12), new C.Cartesian3()))
      const cx = Math.floor(windowPoint.x), cy = Math.floor(420 - windowPoint.y)
      for (const sky of [false, true]) {
        f.backdrop.show = !sky; tiny.show = false; await f.steps(8)
        const background = current.slice(), mean = new Float64Array(640 * 420 * 3), square = new Float64Array(mean.length)
        tiny.show = true; t.resetHistory(); await f.steps(640)
        const historyMean = new Float64Array(mean.length)
        for (let frame = 0; frame < 64; frame++) {
          f.step(); require(t.stableCoverage, 'stationary scene failed coverage gate')
          for (let p = 0; p < 640 * 420; p++) for (let c = 0; c < 3; c++) { const j = p * 3 + c, v = resolved[p * 4 + c]; mean[j] += current[p * 4 + c]; historyMean[j] += v; square[j] += v * v }
          if (frame % 16 === 15) await new Promise(requestAnimationFrame)
        }
        let signal = 0, accumulated = 0, maxStd = 0
        for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) for (let c = 0; c < 3; c++) {
          const p = y * 640 + x
          const j = p * 3 + c, value = mean[j] / 64 - background[p * 4 + c]
          if (value > .001) { signal += value; accumulated += historyMean[j] / 64 - background[p * 4 + c]; maxStd = Math.max(maxStd, Math.sqrt(Math.max(0, square[j] / 64 - (historyMean[j] / 64) ** 2))) }
        }
        const retained = accumulated / signal
        require(signal > .01 && retained > .65 && retained < 1.35 && maxStd < .02, `coverage lost or flickered: ${JSON.stringify({ sky, signal, retained, maxStd })}`)
        const opacity = f.read(t.output)[(cy * 640 + cx) * 4 + 3]
        require(Math.abs(opacity - 1) < 1e-6, 'private coverage metadata leaked into displayed opacity')
        result.coverage.push({ sky, signal, retained, maxStd })
      }
      f.moving.show = true
      f.moving.modelMatrix = f.place(-50, 20, 12, 1, 1); await f.steps(8)
      const staticIndex = (cy * 640 + cx) * 4, staticColor = resolved.slice(staticIndex, staticIndex + 3)
      let remoteColorError = 0
      for (let i = 0; i < 16; i++) {
        f.moving.modelMatrix = f.place(-50 + (i + 1) * .03, 20, 12, 1, 1); f.step()
        require(t.stableCoverage && t.motion.stats.draws > 0, 'moving neighbour disabled static background accumulation')
        for (let c = 0; c < 3; c++) remoteColorError = Math.max(remoteColorError, Math.abs(resolved[staticIndex+c] - staticColor[c]))
      }
      require(remoteColorError < .005, `remote motion changed a stationary detail: ${remoteColorError}`)
      result.remoteColorError = remoteColorError
      result.remoteMotionFrames = 16
      f.moving.modelMatrix = f.place(0, 0, 12, 5.5, 5.5); await f.steps(8)
      f.moving.modelMatrix = f.place(1, 0, 12, 5.5, 5.5); f.step()
      require(t.stableCoverage && t.motion.stats.draws > 0, 'rigid motion incorrectly disabled unrelated static coverage')
      require(resolved[(210 * 640 + 320) * 4 + 3] < 0, 'moving surface did not mark its history footprint')
      await f.steps(8)
      const beforeDeparture = resolved.slice()
      f.moving.modelMatrix = f.place(30, 0, 12, 5.5, 5.5); f.step()
      const revealed = (210 * 640 + 320) * 4
      require(Math.max(...[0, 1, 2].map(c => Math.abs(current[revealed+c] - resolved[revealed+c]))) < 1e-4,
        'a vacated moving footprint retained stale RGB')
      let boundaryError = 0, revealedPixels = 0
      for (let y = 185; y <= 235; y++) for (let x = 295; x <= 345; x++) {
        const i = (y * 640 + x) * 4
        // Only pixels containing the departed object must reject history. Forcing
        // the entire bounding rectangle to equal the current sample causes a flashing ring.
        if (Math.max(...[0, 1, 2].map(c => Math.abs(beforeDeparture[i+c] - current[i+c]))) < .01) continue
        revealedPixels++
        for (let c = 0; c < 3; c++) boundaryError = Math.max(boundaryError, Math.abs(current[i+c] - resolved[i+c]))
      }
      require(revealedPixels > 100, 'departure check did not cover the old visible silhouette')
      result.boundaryError = boundaryError
      result.revealedPixels = revealedPixels
      require(boundaryError < 1e-4, `motion from rest left stale silhouette colour: ${boundaryError}`)
      f.viewer.camera.moveRight(.1); f.step()
      require(!t.stableCoverage, 'camera movement did not restore clipping')
      result.motionProtection = true
      require(f.errors.length === 0 && t.historyValid, 'render errors or invalid TAA')
      result.final = t.getDiagnostics()
      return result
    }, process.argv.includes('--no-rhi'))
    assert.equal(report.picks.length, 4); assert.equal(report.coverage.length, 2)
    fs.writeFileSync(path.join(out, `regressions${process.argv.includes('--bundle') ? '-bundle' : ''}${report.noRhi ? '-no-rhi' : ''}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ picks: report.picks, reveals: report.reveals, coverage: report.coverage, bytes: report.final.bytes }))
  } finally { await browser?.close(); server.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
