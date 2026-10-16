#!/usr/bin/env node
// Reproduce a cloud-range edge while rotating down through the horizon gate.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

async function main() {
  const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || (process.argv.includes('--quick') ? 'quick' : 'scan')
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid label')
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const directory = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  fs.mkdirSync(directory, { recursive: true })
  // Pin response bytes before starting Chrome, including when another task rebuilds.
  const sdk = fs.readFileSync(path.resolve(__dirname, '../../build/0.1.0/CCR.min.js'))
  const sdkHash = crypto.createHash('sha256').update(sdk).digest('hex')
  const expectedSdk = process.argv.find(arg => arg.startsWith('--sdk-sha='))?.slice(10)
    || 'c995eab35f690f1e05a165291ec7358073368d16c2d33a165de12e92f9909cb5'
  if (sdkHash !== expectedSdk) throw new Error('Expected pinned SDK ' + expectedSdk + ', got ' + sdkHash)
  const url = 'http://127.0.0.1:8976/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets'
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8976'], { stdio: 'ignore' })
  const cases = [], errors = []
  let browser
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
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
          orientation: { heading: Math.atan2(sun.x, sun.y) + Cesium.Math.toRadians(view.offset || 0), pitch: Cesium.Math.toRadians(view.pitch), roll: 0 } })
        viewer.camera.frustum.near = near
        viewer.camera.frustum.far = view.orbit ? 2e7 : 1e6
        viewer.camera.frustum.fov = Cesium.Math.toRadians(view.orbit ? 75 : 60)
        for (let i = 0; i < (view.quick ? 24 : 4); i++) {
          viewer.render()
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      }
      window.captureCloudHorizon = () => {
        const e = pipeline.environmentRenderer, context = viewer.scene.context, gl = context._gl
        const adapter = e.environmentGraph, run = adapter.run, records = {}, arrays = {}, readErrors = []
        let gpuGroundHorizon = null
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
              if (key === 'cloud.march') {
                const stage = e.stages.cloudStage, C = Cesium
                const output = 'out_FragColor = effectFlags.y > 0.5 ? ccrClouds(atmosphereOrigin,direction,distance) : vec4(0.0,0.0,0.0,1.0);'
                if (!stage.fragmentShader.includes(output)) throw new Error('GPU horizon probe target missing')
                const shader = stage.fragmentShader.replace(output, 'out_FragColor=vec4(ground,ground.x>0.0&&ground.y>=ground.x?1.0:0.0,1.0);')
                const target = new C.Texture({ context, width: texture.width, height: texture.height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
                const targetFb = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
                const command = context.createViewportQuadCommand(new C.ShaderSource({ defines: viewer.scene.frameState.useLogDepth ? ['LOG_DEPTH'] : [], sources: [shader] }),
                  { framebuffer: targetFb, renderState: stage._command.renderState, uniformMap: stage._command.uniformMap })
                try {
                  command.execute(context)
                  const values = new Float32Array(texture.width * texture.height * 4)
                  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
                  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb._framebuffer)
                  gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.FLOAT, values)
                  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw)
                  gpuGroundHorizon = [.1,.25,.5,.75,.9].map(u => {
                    const transitions = [], x = Math.floor(texture.width * u)
                    let previous = null, topGround = false, bottomGround = false
                    for (let y = texture.height - 1; y >= 0; y--) {
                      const i = (y * texture.width + x) * 4, groundHit = values[i + 2] > .5
                      if (previous !== null && previous !== groundHit) transitions.push({ yFromTop: texture.height - 1 - y, enteringGround: groundHit, distance: values[i] })
                      if (y === texture.height - 1) topGround = groundHit
                      if (y === 0) bottomGround = groundHit
                      previous = groundHit
                    }
                    return { u, topGround, bottomGround, transitions }
                  })
                } finally { command.shaderProgram.destroy(); targetFb.destroy(); target.destroy() }
              }

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
          const rowDepth = []
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
              occupied++; distances.push(d); rowDepth.push(d)
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
          scanlines.push({ yFromTop: textureHeight - 1 - y, occupied, occupiedFraction: occupied / width, farOccupied, meanOpacity: opacity / width, minT: rowTMin, weightedDepth: distribution(rowDepth) })
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
          horizon: environment.horizon ?? null, blend: environment.cloudHorizonBlend ?? null, gpuGroundHorizon,
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
    const quick = process.argv.includes('--quick')
    const fixed = label.startsWith('fixed')
    const critical = process.argv.includes('--critical')
    const views = quick ? [{ height: 3500, offset: 0 }] : (fixed ? [12000] : [3500, 12000]).flatMap(height => [0, 90].map(offset => ({ height, offset })))
    const pitches = critical ? [-21.5, -25] : quick ? [-15, -17, -19, -21, -23, -25, -27, -29] : fixed
      ? [-20, -21.5, -25, ...Array.from({ length: 31 }, (_, i) => -30 - i * .5), -60]
      : Array.from({ length: 71 }, (_, i) => -10 - i * .5)
    for (const view of views) for (const pitch of pitches) {
      await page.evaluate(view => window.setCloudView(view, 1000), { ...view, pitch, quick })
      const result = await page.evaluate(() => window.captureCloudHorizon())
      const takeScreenshot = quick || (result.blend > 0 && result.blend < 1) || [-10, -15, -20, -21.5, -25, -30, -35, -40, -45, -60].includes(pitch)
      const file = takeScreenshot ? `cloud-range-transition-${label}-h${view.height}-o${view.offset}-p${String(pitch).replace('.', 'd')}.png` : null
      if (file) await page.screenshot({ path: path.join(directory, file) })
      const rows = result.transport.scanlines
      const significantCloudRows = rows.filter(row => row.occupiedFraction >= .05)
      const border = significantCloudRows[0] || null
      const rowJumps = []
      for (let y = 1; y < rows.length; y++) rowJumps.push({ yFromTop: y,
        opacityDelta: rows[y].meanOpacity - rows[y - 1].meanOpacity,
        occupiedDelta: rows[y].occupiedFraction - rows[y - 1].occupiedFraction })
      result.rangeEdge = { firstSignificantCloudRow: border, largestOpacityJumps: rowJumps.sort((a, b) => Math.abs(b.opacityDelta) - Math.abs(a.opacityDelta)).slice(0, 8) }
      cases.push({ view: { ...view, pitch }, file, ...result })
      console.log(JSON.stringify({ height: view.height, offset: view.offset, pitch, blend: result.blend, file,
        horizon: result.gpuGroundHorizon, cloudEdge: border?.yFromTop, strongestJump: result.rangeEdge.largestOpacityJumps[0], hdr: result.hdr.valid }))
      fs.writeFileSync(path.join(directory, `cloud-range-transition-${label}.json`), JSON.stringify({ label, url,
        sdkSha256: sdkHash, immutableSdkResponse: true, generatedAt: new Date().toISOString(), viewport: [960, 540],
        date: '2026-09-08T11:00:00+08:00', fixedPosition: [123.42, 41.77], quick, cases, errors }, null, 2))
      if (!result.hdr.valid || result.glError || result.readErrors.length) throw new Error('Capture failed')
    }
    if (errors.length) throw new Error(errors.join('\n'))
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
