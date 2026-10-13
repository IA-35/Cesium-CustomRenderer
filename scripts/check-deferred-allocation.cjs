// Fixed-clock frame cadence and allocation regression. No synchronous GPU timer
// or pixel readback is performed inside the measured frame window.
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const args = process.argv.slice(2)
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const seconds = Number(arg('--seconds', '6'))
const warmupSeconds = Number(arg('--warmup', '10'))
const sizes = arg('--sizes', '1920x1080').split(',').map(s => s.split('x').map(Number))
const baseline = arg('--baseline', null), output = arg('--output', 'docs/verification/deferred-allocation.json')
const shadowBaseline = arg('--shadow-baseline', null), lightingMode = arg('--mode', 'deferred')
const environmentBaseline = arg('--environment-baseline', null)
const sceneKind = arg('--scene', 'synthetic'), preset = arg('--preset', 'combined')
const tracks = arg('--tracks', 'static,orbit,pitch').split(',')
const profilePath = arg('--profile', null)
const umd = args.includes('--umd')
const headless = !args.includes('--headed')
const hash = text => crypto.createHash('sha256').update(text).digest('hex')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless })
  const report = { browser: browser.version(), headless, seconds, warmupSeconds, baseline, shadowBaseline, environmentBaseline, lightingMode, sceneKind, preset,
    bundleHash: umd ? hash(fs.readFileSync('build/0.1.0/CCR.min.js')) : null,
    geometryHash: hash(fs.readFileSync(baseline || 'src/lighting/DeferredGeometry143.js')),
    shadowHash: hash(fs.readFileSync(shadowBaseline || 'src/shadows/DirectionalShadowPass.js')), runs: [] }
  try {
    for (const [width, height] of sizes) {
      const page = await browser.newPage({ viewport: { width, height } })
      const errors = []
      let environmentMapRequests = 0
      page.on('pageerror', e => errors.push(e.message))
      page.on('request', request => {
        if (request.url().includes('98_ibl.ktx2')) environmentMapRequests++
      })
      if (baseline) await page.route('**/src/lighting/DeferredGeometry143.js', route =>
        route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(baseline, 'utf8') }))
      if (shadowBaseline) await page.route('**/src/shadows/DirectionalShadowPass.js', route =>
        route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(shadowBaseline, 'utf8') }))
      if (environmentBaseline) await page.route('**/src/environment/EnvironmentLighting143.js', route =>
        route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(environmentBaseline, 'utf8') }))
      await page.goto(`http://127.0.0.1:${process.env.CCR_TEST_PORT || 8877}/tests/rendering/stage1-fixture.html${umd ? '?mode=umd' : ''}`)
      await page.waitForFunction(() => window.fixture)
      await page.bringToFront()
      const profiler = profilePath ? await page.context().newCDPSession(page) : null
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
      const result = await page.evaluate(async ({ seconds, warmupSeconds, lightingMode, sceneKind, preset, tracks }) => {
        const C = Cesium, f = fixture, s = f.viewer.scene
        // Noon at the load origin: shadows must actually execute in this test.
        f.viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T04:15:00Z')
        f.viewer.clock.shouldAnimate = false
        const { loadPerformanceScene, applyPerformanceTrack, readPerformanceLoad } = await import('/tests/rendering/performance-scene.js')
        let sharedTextures
        if (sceneKind === 'campus') {
          const manifest = await fetch('/examples/campus-glb-manifest.json').then(r => r.json())
          f.manifest = manifest
          const { loadCampusGlbs } = await import('/examples/campus-glb.js')
          f.origin = C.Cartesian3.fromDegrees(manifest.origin.longitude, manifest.origin.latitude, manifest.origin.height)
          f.models = []
          applyPerformanceTrack(f, 'orbit', 0)
          sharedTextures = await loadCampusGlbs(C, f.viewer, manifest, '/campus-mobile-glb', f.models, () => {})
          f.performanceOwners = new Set(f.models)
        } else await loadPerformanceScene(f)
        const p = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer, options: {
          environment: true, environmentPreset: 'clear', environmentQuality: 'balanced', clouds: true,
          volumetricFog: true, shadows: true, shadowMode: 'custom', fog: true, antialiasing: 'smaa',
          hdrBloomEnabled: preset === 'combined', materialChannelsEnabled: preset === 'combined', screenSpaceAoEnabled: preset === 'combined',
          screenSpaceAoAlgorithm: 'hbao', environmentReflectionEnabled: true, lightingMode,
          ...(sceneKind === 'campus' ? { environmentReflectionMap: '/assets/environment/98_ibl.ktx2' } : {}),
          ...(preset === 'isolated' ? { environment: false, clouds: false, volumetricFog: false,
            shadows: false, fog: false, antialiasing: 'off', environmentReflectionEnabled: false } : {})
        } })
        if (f.manifest) {
          const included = new Set(f.manifest.models.filter(m => m.environmentReflection).map(m => m.file))
          for (const model of f.models) if (included.has(model.id.file)) p.setEnvironmentReflectionIncluded(model, true)
        }
        p.setCampusOrigin(f.origin)
        const gl = s.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info')
        const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
        const creates = gl.createTexture, deletes = gl.deleteTexture
        let allocated = 0, released = 0
        const geometry = p.deferredLighting?.materials, allocate = geometry?.allocate
        let compactAllocations = 0
        if (geometry) geometry.allocate = function (...args) {
          const old = this.target
          const result = allocate.apply(this, args)
          if (this.target && this.target !== old) compactAllocations++
          return result
        }
        gl.createTexture = function (...a) { allocated++; return creates.apply(this, a) }
        gl.deleteTexture = function (...a) { released++; return deletes.apply(this, a) }
        const original = s.render
        let cpu = [], active = false
        s.render = function (...a) {
          const start = performance.now()
          try { return original.apply(this, a) }
          finally { if (active) cpu.push(performance.now() - start) }
        }
        const stats = a => {
          const sorted = a.slice().sort((x, y) => x - y)
          return { samples: a.length, meanMs: a.reduce((x, y) => x + y, 0) / a.length,
            p95Ms: sorted[Math.floor(a.length * .95)], maxMs: sorted.at(-1) }
        }
        const runs = []
        try {
          for (const track of tracks) {
            let start = performance.now()
            const off = s.preUpdate.addEventListener(() => applyPerformanceTrack(f, track === 'static' ? 'orbit' : track,
              track === 'static' ? 0 : (performance.now() - start) * .0005))
            await new Promise(r => setTimeout(r, warmupSeconds * 1000))
            allocated = released = compactAllocations = 0; cpu = []; active = true
            const shadowStart = { ...p.customShadow.stats }
            const intervals = [], animationIntervals = []; let previous, previousAnimation, focusLost = false
            let animationRequest
            const animationTick = time => {
              if (previousAnimation !== undefined) animationIntervals.push(time - previousAnimation)
              previousAnimation = time
              animationRequest = requestAnimationFrame(animationTick)
            }
            animationRequest = requestAnimationFrame(animationTick)
            const stop = performance.now() + seconds * 1000
            await new Promise(resolve => {
              const offFrame = s.postRender.addEventListener(() => {
                const now = performance.now()
                focusLost ||= !document.hasFocus() || document.visibilityState !== 'visible'
                if (previous !== undefined) intervals.push(now - previous)
                previous = now
                if (now >= stop) { offFrame(); resolve() }
              })
            })
            active = false; off(); cancelAnimationFrame(animationRequest)
            runs.push({ track, frames: stats(intervals), fps: 1000 / stats(intervals).meanMs, cpu: stats(cpu),
              animationFrames: stats(animationIntervals),
              animationFps: 1000 / stats(animationIntervals).meanMs,
              animationOver25ms: animationIntervals.filter(ms => ms > 25).length,
              targetFrameRate: f.viewer.targetFrameRate ?? null,
              focusLost,
              allocated, released, compactAllocations, load: readPerformanceLoad(f), lighting: p.getLightingDiagnostics(),
              shadow: { ...p.customShadow.stats }, hiz: p.getDepthPyramidDiagnostics(),
              shadowUpdates: p.customShadow.stats.updates - shadowStart.updates,
              shadowSkips: p.customShadow.stats.skippedFrames - shadowStart.skippedFrames,
              ao: p.getScreenSpaceAODiagnostics().valid, bloom: p.getHdrBloomDiagnostics().valid })
          }
          // Stable final view for image parity, outside the frame measurement.
          f.viewer.useDefaultRenderLoop = false
          applyPerformanceTrack(f, 'orbit', 0)
          p.invalidateShadows()
          for (let i = 0; i < 4; i++) f.viewer.render()
          const pixels = Array.from(s.context.readPixels({ x: 0, y: 0, width: s.drawingBufferWidth, height: s.drawingBufferHeight }))
          // Compare reuse with full redraw in the same scene, avoiding differing
          // async model insertion order between independent browser launches.
          const reuse = p.customShadow.shouldReuseShadowFrame
          p.customShadow.shouldReuseShadowFrame = () => false
          for (let i = 0; i < 4; i++) f.viewer.render()
          const full = s.context.readPixels({ x: 0, y: 0, width: s.drawingBufferWidth, height: s.drawingBufferHeight })
          p.customShadow.shouldReuseShadowFrame = reuse
          let changedChannels = 0, absoluteDifference = 0, maxDifference = 0
          for (let i = 0; i < full.length; i++) {
            const difference = Math.abs(full[i] - pixels[i])
            if (difference) changedChannels++
            absoluteDifference += difference; maxDifference = Math.max(maxDifference, difference)
          }
          const shadowParity = { changedChannels, meanAbsoluteDifference: absoluteDifference / full.length, maxDifference }
          return { renderer, size: [s.drawingBufferWidth, s.drawingBufferHeight], runs, pixels, shadowParity, errors: f.errors }
        } finally {
          s.render = original; gl.createTexture = creates; gl.deleteTexture = deletes
          p.destroy(); f.viewer.destroy(); sharedTextures?.destroy()
        }
      }, { seconds, warmupSeconds, lightingMode, sceneKind, preset, tracks })
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop')
        fs.writeFileSync(profilePath, JSON.stringify(profile))
        await profiler.detach()
      }
      const { pixels, ...measurement } = result
      report.runs.push({ ...measurement, imageHash: hash(Buffer.from(pixels)), pageErrors: errors })
      report.runs.at(-1).environmentMapRequests = environmentMapRequests
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, [])
      console.log(JSON.stringify({ size: measurement.size, renderer: measurement.renderer,
        runs: measurement.runs.map(r => ({ track: r.track, fps: r.fps, p95: r.frames.p95Ms,
          cpuP95: r.cpu.p95Ms, allocated: r.allocated, released: r.released,
          compactAllocations: r.compactAllocations, shadowUpdates: r.shadowUpdates, shadowSkips: r.shadowSkips })) }))
      await page.close()
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
