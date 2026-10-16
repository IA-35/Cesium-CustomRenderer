#!/usr/bin/env node
// Fixed daytime views and transport evidence only; this is not a benchmark.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

async function main() {
  const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'after'
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid label')
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const directory = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  fs.mkdirSync(directory, { recursive: true })
  // Pin response bytes before starting Chrome, including when another task rebuilds.
  const sdk = fs.readFileSync(path.resolve(__dirname, '../../build/0.1.0/CCR.min.js'))
  const sdkHash = crypto.createHash('sha256').update(sdk).digest('hex')
  const url = 'http://127.0.0.1:8974/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets'
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8974'], { stdio: 'ignore' })
  const cases = [], transitions = [], errors = [], failures = []
  let browser
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } })
    await page.route('**/build/0.1.0/CCR.min.js', route => route.fulfill({ body: sdk, contentType: 'application/javascript' }))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid, null, { timeout: 120000 })
    await page.waitForTimeout(7000)
    await page.evaluate(() => {
      const { viewer, pipeline } = campus
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelectorAll('.lil-gui').forEach(element => element.style.setProperty('display', 'none'))
      if (campus.stats?.dom) campus.stats.dom.style.setProperty('display', 'none')
      viewer.clock.shouldAnimate = false
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
      viewer.useDefaultRenderLoop = false
      pipeline.setOptions({ environmentPreset: 'clear', environmentAnimation: false, clouds: true,
        cloudCoverage: .42, cloudBaseHeight: 1600, cloudThickness: 1200 })
      window.setCloudView = async (view, near) => {
        pipeline.environmentRenderer.update()
        const sun = pipeline.environmentRenderer.sunLocal
        viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(123.42, 41.77, view.height),
          orientation: { heading: Math.atan2(sun.x, sun.y), pitch: Cesium.Math.toRadians(view.pitch), roll: 0 } })
        viewer.camera.frustum.near = near
        viewer.camera.frustum.far = view.orbit ? 2e7 : 1e6
        viewer.camera.frustum.fov = Cesium.Math.toRadians(view.orbit ? 75 : 60)
        for (let i = 0; i < 24; i++) {
          viewer.render()
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      }
      window.captureCloudHorizon = () => {
        const e = pipeline.environmentRenderer, context = viewer.scene.context, gl = context._gl
        const adapter = e.environmentGraph, run = adapter.run, records = {}, arrays = {}, readErrors = []
        const stages = { 'cloud.march': 'cloudStage', 'cloud.depth': 'cloudDepthStage' }
        const distribution = values => {
          values.sort((a, b) => a - b)
          const q = f => values.length ? values[Math.floor((values.length - 1) * f)] : null
          return { count: values.length, min: q(0), p10: q(.1), p50: q(.5), p90: q(.9), max: q(1),
            mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
        }
        // Read inside invoke: graph resources may be aliased/released after run returns.
        adapter.run = function(key, invoke) {
          return run.call(this, key, () => {
            const result = invoke(), fb = e.stages[stages[key]]?._command?.framebuffer
            if (fb) {
              const texture = fb.getColorTexture(0), pixels = new Float32Array(texture.width * texture.height * 4)
              const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb._framebuffer)
              gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.FLOAT, pixels)
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
              const error = gl.getError()
              if (error) readErrors.push(error)
              arrays[key] = pixels
              records[key] = { textureId: texture.id, size: [texture.width, texture.height], frameNumber: viewer.scene.frameState.frameNumber }
            }
            return result
          })
        }
        try { viewer.render() } finally { adapter.run = run }
        const cloud = arrays['cloud.march'], depth = arrays['cloud.depth'], camera = viewer.camera
        const height = camera.positionCartographic.height, radius = 6371000, radialDistance = radius + height
        const up = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC, new Cesium.Cartesian3())
        const dot = (a, b) => Cesium.Cartesian3.dot(a, b)
        const axes = [dot(camera.directionWC, up), dot(camera.rightWC, up), dot(camera.upWC, up)]
        const tanY = Math.tan(camera.frustum.fovy * .5), tanX = tanY * camera.frustum.aspectRatio
        const T = [], distances = [], farDistances = [], samples = [], scanlines = []
        const rgb = [0, 0, 0], width = records['cloud.march']?.size[0], textureHeight = records['cloud.march']?.size[1]
        let finite = true, badT = 0, negativeRGB = 0, maxDepthTError = 0, farCloudPixels = 0
        let shellMissPixels = 0, shellMissCloudPixels = 0, shellMissMaxOpacity = 0, weightedDistanceSum = 0, totalOpacity = 0
        if (cloud && depth) for (let y = 0; y < textureHeight; y++) {
          let occupied = 0, farOccupied = 0, opacity = 0, rowTMin = 1
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4, t = cloud[i + 3], d = depth[i], a = 1 - t
            for (let c = 0; c < 4; c++) finite = finite && Number.isFinite(cloud[i + c]) && Number.isFinite(depth[i + c])
            if (t < 0 || t > 1) badT++
            if (Math.min(cloud[i], cloud[i + 1], cloud[i + 2]) < -1e-6) negativeRGB++
            maxDepthTError = Math.max(maxDepthTError, Math.abs(t - depth[i + 1]))
            rowTMin = Math.min(rowTMin, t); opacity += a
            for (let c = 0; c < 3; c++) rgb[c] += cloud[i + c]
            T.push(t)
            if (t < .99) {
              occupied++; distances.push(d)
              weightedDistanceSum += d * a; totalOpacity += a
              if (d > 40000) { farCloudPixels++; farOccupied++; farDistances.push(d) }
            }
            // Exact shader tangent-sphere frame: geodetic up and WGS84 camera height.
            // A ray outside the outer sphere by > 100 m is unambiguously clear sky.
            const sx = (2 * (x + .5) / width - 1) * tanX, sy = (2 * (y + .5) / textureHeight - 1) * tanY
            const radialDot = (axes[0] + axes[1] * sx + axes[2] * sy) / Math.sqrt(1 + sx * sx + sy * sy)
            const closestRadius = radialDot < 0 ? radialDistance * Math.sqrt(Math.max(0, 1 - radialDot * radialDot)) : radialDistance
            if (height > 2800 && closestRadius > radius + 2900) {
              shellMissPixels++; shellMissMaxOpacity = Math.max(shellMissMaxOpacity, a)
              if (t < .99) shellMissCloudPixels++
            }
          }
          if (y % 4 === 0) scanlines.push({ yFromTop: textureHeight - 1 - y, occupied, farOccupied, meanOpacity: opacity / width, minT: rowTMin })
        }
        if (cloud && depth) for (const [u, v] of [[.25, .1], [.5, .1], [.75, .1], [.5, .25], [.5, .4], [.5, .5], [.5, .6], [.5, .75], [.5, .9]]) {
          const i = (Math.min(textureHeight - 1, Math.floor(textureHeight * (1 - v))) * width + Math.floor(width * u)) * 4
          samples.push({ screenUV: [u, v], cloudHDR: Array.from(cloud.subarray(i, i + 4)), rawCloudDepth: Array.from(depth.subarray(i, i + 4)) })
        }
        const count = width * textureHeight
        const environment = e.getDiagnostics()
        return { records, transport: { definition: 'cloud HDR RGB and residual T; cloud.depth R is extinction-contribution-weighted distance in metres, G is the same-frame T',
          finite, badT, negativeRGB, maxDepthTError, rgbMean: rgb.map(value => value / count), transmittance: distribution(T),
          occupied: { threshold: 'T < 0.99', pixels: distances.length, fraction: distances.length / count,
            weightedDepth: distribution(distances), opacityWeightedDepthMean: totalOpacity ? weightedDistanceSum / totalOpacity : null },
          beyond40km: { threshold: 'T < 0.99 and raw cloud.depth R > 40000 m', pixels: farCloudPixels, fraction: farCloudPixels / count, weightedDepth: distribution(farDistances) },
          clearSky: { definition: 'camera above layer; closest ray radius > cloud top + 100 m in shader tangent sphere', pixels: shellMissPixels,
            cloudPixels: shellMissCloudPixels, maxOpacity: shellMissMaxOpacity }, samples, scanlines: scanlines.sort((a, b) => a.yFromTop - b.yFromTop) },
          readErrors, glError: gl.getError(), hdr: e.hdr.getDiagnostics(), lut: e.atmosphereLut.getDiagnostics(), environment,
          horizon: environment.horizon ?? null, blend: environment.cloudHorizonBlend ?? null,
          camera: { longitude: Cesium.Math.toDegrees(camera.positionCartographic.longitude), latitude: Cesium.Math.toDegrees(camera.positionCartographic.latitude),
            height, heading: Cesium.Math.toDegrees(camera.heading), pitch: Cesium.Math.toDegrees(camera.pitch), near: camera.frustum.near,
            far: camera.frustum.far, fov: camera.frustum.fov, fovy: camera.frustum.fovy },
          scene: { frustumCount: viewer.scene._view.frustumCommandsList.length, frameNumber: viewer.scene.frameState.frameNumber,
            drawingBuffer: [viewer.canvas.width, viewer.canvas.height] },
          options: { environmentPreset: pipeline.options.environmentPreset, environmentQuality: pipeline.options.environmentQuality,
            environmentAnimation: pipeline.options.environmentAnimation, cloudCoverage: pipeline.options.cloudCoverage,
            cloudBaseHeight: pipeline.options.cloudBaseHeight, cloudThickness: pipeline.options.cloudThickness } }
      }
    })
    const views = [
      { name: 'low-horizontal', height: 300, pitch: 0 },
      { name: 'low-downward-horizon', height: 300, pitch: -18 },
      { name: 'above-layer', height: 3500, pitch: -10 },
      { name: 'high-horizon', height: 12000, pitch: -8 },
      { name: 'downward', height: 12000, pitch: -90 },
      { name: 'orbit-downward', height: 8e6, pitch: -90, orbit: true },
      { name: 'orbit-oblique-40', height: 8e6, pitch: -40, orbit: true },
      { name: 'orbit-oblique-20', height: 8e6, pitch: -20, orbit: true },
      { name: 'orbit-oblique-5', height: 8e6, pitch: -5, orbit: true },
      { name: 'earth-edge-oblique-40', height: 1e6, pitch: -40, orbit: true, near: 10000 },
      { name: 'earth-edge-oblique-20', height: 1e6, pitch: -20, orbit: true, near: 10000 }
    ]
    for (const view of views) {
      let result
      const attempts = []
      for (const near of view.orbit ? [view.near || 20000] : [100, 1000]) {
        await page.evaluate(({ view, near }) => window.setCloudView(view, near), { view, near })
        result = await page.evaluate(() => window.captureCloudHorizon())
        attempts.push({ near, hdr: result.hdr })
        if (result.hdr.valid && (result.hdr.frustumCount === 1 || (view.orbit && result.hdr.frustumCount === 0 && result.scene.frustumCount === 0))) break
      }
      const file = `cloud-horizon-${label}-${view.name}.png`, issues = []
      await page.screenshot({ path: path.join(directory, file) })
      // An orbital camera facing away from Earth can have no scene commands.
      const validFrustum = result.hdr.frustumCount === 1 || (view.orbit && result.hdr.frustumCount === 0 && result.scene.frustumCount === 0)
      if (!result.hdr.valid || !validFrustum) issues.push('HDR must be valid with one frustum, or an empty orbital sky')
      if (!result.hdr.cloudTemporal.valid || result.hdr.cloudTemporal.age < 16) issues.push('Cloud temporal history did not settle for 16 frames')
      if (!result.lut.ready || result.glError || result.readErrors.length) issues.push('LUT/WebGL readiness failed')
      if (!result.records['cloud.march'] || !result.records['cloud.depth']) issues.push('Cloud passes missing')
      if (!result.transport.finite || result.transport.badT || result.transport.negativeRGB || result.transport.maxDepthTError > 1e-5) issues.push('Cloud transport invariant failed')
      if (result.transport.clearSky.cloudPixels) issues.push('Clouds leaked into rays missing the cloud shell')
      if (label === 'after') {
        if ((view.pitch === -90 || view.orbit) && result.blend !== 0) issues.push('Downward/orbit view must retain blend zero')
        if (!view.orbit && view.pitch !== -90 && !(result.blend > 0)) issues.push('Horizon view must enable range extension')
        if (!view.orbit && view.pitch !== -90 && !result.transport.beyond40km.pixels) issues.push('Horizon view has no occupied cloud beyond 40 km')
        if (view.orbit && (result.transport.occupied.pixels || result.transport.transmittance.min !== 1 || result.transport.transmittance.max !== 1)) issues.push('Orbit views must have no cloud contribution and T exactly one')
      }
      cases.push({ view, file, settledFrames: 24, attempts, issues, ...result })
      if (issues.length) failures.push({ view: view.name, issues })
      console.log(JSON.stringify({ view: view.name, blend: result.blend, issues, farPixels: result.transport.beyond40km.pixels,
        occupiedDepth: result.transport.occupied.weightedDepth, clearSky: result.transport.clearSky, hdr: result.hdr.valid }))
    }
    for (const pitch of [-60, -40, -30, -25, -20, -15, -10, 0]) {
      await page.evaluate(view => window.setCloudView(view, 1000), { height: 3500, pitch })
      const result = await page.evaluate(() => {
        const { viewer, pipeline } = campus, e = pipeline.environmentRenderer, diagnostics = e.getDiagnostics()
        return { pitch: Cesium.Math.toDegrees(viewer.camera.pitch), blend: diagnostics.cloudHorizonBlend ?? null,
          horizon: diagnostics.horizon ?? null, environment: diagnostics, hdr: e.hdr.getDiagnostics() }
      })
      transitions.push(result)
      console.log(JSON.stringify({ transitionPitch: pitch, blend: result.blend, hdr: result.hdr.valid }))
    }
    if (label === 'after' && transitions.some((item, index) => item.blend === null || (index && item.blend < transitions[index - 1].blend))) failures.push({ transition: 'Blend must be present and monotonic as the horizon enters the view' })
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('/build/')))
    fs.writeFileSync(path.join(directory, `cloud-horizon-${label}.json`), JSON.stringify({ label, url, generatedAt: new Date().toISOString(),
      viewport: [1200, 720], environmentScale: .5, immutableSdkResponse: true, sdkBytes: sdk.length, sdkSha256: sdkHash,
      bundles: resources.map(resource => ({ resource, sha256: new URL(resource).pathname.endsWith('/CCR.min.js') ? sdkHash : null })),
      date: '2026-09-08T11:00:00+08:00', fixedPosition: [123.42, 41.77], cases, transitions, errors, failures }, null, 2))
    if (errors.length || failures.length) throw new Error(JSON.stringify({ errors, failures }))
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
