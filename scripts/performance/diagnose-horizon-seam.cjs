#!/usr/bin/env node
// Diagnose the visible sky/surface seam with immutable SDK and in-frame probes.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

async function main() {
  const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'diagnose'
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid label')
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const directory = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  fs.mkdirSync(directory, { recursive: true })
  // Pin response bytes before starting Chrome, including when another task rebuilds.
  const sdk = fs.readFileSync(path.resolve(__dirname, '../../build/0.1.0/CCR.min.js'))
  const sdkHash = crypto.createHash('sha256').update(sdk).digest('hex')
  const url = 'http://127.0.0.1:8976/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets'
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8976'], { stdio: 'ignore' })
  const cases = [], errors = []
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
          orientation: { heading: Math.atan2(sun.x, sun.y) + Cesium.Math.toRadians(view.offset), pitch: Cesium.Math.toRadians(view.pitch), roll: 0 } })
        viewer.camera.frustum.near = near
        viewer.camera.frustum.far = view.orbit ? 2e7 : 1e6
        viewer.camera.frustum.fov = Cesium.Math.toRadians(view.orbit ? 75 : 60)
        for (let i = 0; i < 24; i++) {
          viewer.render()
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      }
      window.captureSeam = () => {
        const { viewer, pipeline } = campus, C = Cesium, e = pipeline.environmentRenderer
        const context = viewer.scene.context, gl = context._gl, adapter = e.environmentGraph, run = adapter.run
        const records = {}, readErrors = [], keys = { 'cloud.march': 'cloudStage', 'cloud.depth': 'cloudDepthStage',
          'atmosphere.raymarch': 'raymarchStage', 'atmosphere.transmission': 'transmissionStage', 'environment.composite': 'resolveStage' }
        const scan = (pixels, width, height) => {
          const columns = [.35, .5, .65].map(u => {
            const values = []
            for (let y = height - 1; y >= 0; y--) {
              const i = (y * width + Math.floor(width * u)) * 4
              values.push(Array.from(pixels.subarray(i, i + 4)))
            }
            const jumps = []
            for (let y = Math.floor(height * .2); y < height * .65; y++) {
              const delta = values[y].slice(0, 3).map((v, c) => v - values[y - 1][c])
              jumps.push({ yFromTop: y, delta, magnitude: Math.hypot(...delta), above: values[y - 1], below: values[y] })
            }
            return { u, values, largestJumps: jumps.sort((a, b) => b.magnitude - a.magnitude).slice(0, 5) }
          })
          return { size: [width, height], finite: pixels.every(Number.isFinite), columns }
        }
        const read = fb => {
          const texture = fb.getColorTexture(0), pixels = new Float32Array(texture.width * texture.height * 4)
          const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb._framebuffer)
          gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.FLOAT, pixels)
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
          const error = gl.getError(); if (error) readErrors.push(error)
          return scan(pixels, texture.width, texture.height)
        }
        adapter.run = function(key, invoke) {
          return run.call(this, key, () => {
            const value = invoke(), stage = e.stages[keys[key]], fb = stage?._command?.framebuffer
            if (fb) records[key] = read(fb)
            if (key === 'atmosphere.raymarch') {
              const original = 'out_FragColor = vec4(color, ccrPackTransmittance(sceneTransmittance));'
              if (!stage.fragmentShader.includes(original)) throw new Error('Probe target missing from pinned raymarch shader')
              const texture = fb.getColorTexture(0)
              const target = new C.Texture({ context, width: texture.width, height: texture.height,
                pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
              const targetFb = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
              const state = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, target.width, target.height),
                depthTest: { enabled: false }, depthMask: false })
              try {
                for (const [name, replacement] of [
                  ['geometry', 'out_FragColor=vec4(distance,finiteSurface?1.0:0.0,clouds.a,1.0);'],
                  ['rawSceneDistance', 'out_FragColor=vec4(sceneDistance(uv),ground.x,finiteSurface?1.0:0.0,1.0);'],
                  ['viewIntegrator', 'transmittance=vec3(1.0);out_FragColor=vec4(ccrAtmosphereScene(origin,direction,distance,vec3(0.0),transmittance),1.0);'],
                  ['skyView', 'out_FragColor=vec4(ccrLutSkyView(origin,direction,sunDirectionAtmo)*atmosphereSunRadiance,1.0);']
                ]) {
                  const shader = stage.fragmentShader.replace(original, replacement)
                  const command = context.createViewportQuadCommand(new C.ShaderSource({
                    defines: viewer.scene.frameState.useLogDepth ? ['LOG_DEPTH'] : [], sources: [shader] }), {
                    framebuffer: targetFb, renderState: state, uniformMap: stage._command.uniformMap })
                  try { command.execute(context); records['probe.' + name] = read(targetFb) }
                  finally { command.shaderProgram.destroy() }
                }
              } finally { targetFb.destroy(); target.destroy(); C.RenderState.removeFromCache(state) }
            }
            if (key === 'environment.composite') {
              const nativeFb = new C.Framebuffer({ context, colorTextures: [e.hdr.inputColor], destroyAttachments: false })
              try { records.nativeOriginalHDR = read(nativeFb) } finally { nativeFb.destroy() }
            }
            return value
          })
        }
        try { viewer.render() } finally { adapter.run = run }
        const display = new Uint8Array(viewer.canvas.width * viewer.canvas.height * 4)
        const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.readPixels(0, 0, viewer.canvas.width, viewer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, display)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
        records.display = scan(display, viewer.canvas.width, viewer.canvas.height)
        const boundaryPoints = []
        for (const column of records['probe.geometry'].columns) {
          for (let y = 1; y < column.values.length; y++) {
            if (column.values[y][1] === column.values[y - 1][1]) continue
            const points = []
            for (let dy = -4; dy <= 4; dy++) {
              const iy = Math.max(0, Math.min(column.values.length - 1, y + dy)), uv = (iy + .5) / column.values.length
              const values = {}
              for (const [key, record] of Object.entries(records)) {
                const source = record.columns.find(c => c.u === column.u).values
                values[key] = source[Math.min(source.length - 1, Math.floor(uv * source.length))]
              }
              points.push({ yFromTop: iy, values })
            }
            const jumps = {}
            for (const [key, record] of Object.entries(records)) {
              const source = record.columns.find(c => c.u === column.u).values
              const center = Math.floor(y * source.length / column.values.length), candidates = []
              for (let iy = Math.max(1, center - 2); iy <= Math.min(source.length - 1, center + 2); iy++) {
                const delta = source[iy].slice(0, 3).map((v, c) => v - source[iy - 1][c])
                candidates.push({ yFromTop: iy, delta, magnitude: Math.hypot(...delta), above: source[iy - 1], below: source[iy] })
              }
              jumps[key] = candidates.sort((a, b) => b.magnitude - a.magnitude)[0]
            }
            boundaryPoints.push({ u: column.u, yFromTop: y, points, jumps })
          }
        }
        return { records, boundaryPoints, readErrors, glError: gl.getError(), hdr: e.hdr.getDiagnostics(),
          environment: e.getDiagnostics(), camera: { height: viewer.camera.positionCartographic.height,
            heading: C.Math.toDegrees(viewer.camera.heading), pitch: C.Math.toDegrees(viewer.camera.pitch),
            near: viewer.camera.frustum.near, far: viewer.camera.frustum.far, fovy: viewer.camera.frustum.fovy },
          options: { clouds: pipeline.options.clouds, fog: pipeline.options.fog, volumetricFog: pipeline.options.volumetricFog,
            skyLightIntensity: pipeline.options.skyLightIntensity, sunIntensity: pipeline.options.sunIntensity,
            cloudCoverage: pipeline.options.cloudCoverage, cloudBaseHeight: pipeline.options.cloudBaseHeight, cloudThickness: pipeline.options.cloudThickness } }
      }
    })
    const views = [
      { name: 'high-side', height: 12000, pitch: -8, offset: 90 },
      { name: 'high-away', height: 12000, pitch: -8, offset: 180 },
      { name: 'above-side', height: 3500, pitch: -10, offset: 90 },
      { name: 'above-away', height: 3500, pitch: -10, offset: 180 }
    ]
    const originalFog = await page.evaluate(() => ({ fog: campus.pipeline.options.fog, volumetricFog: campus.pipeline.options.volumetricFog }))
    for (const view of views) for (const mode of ['normal', 'clouds-off', 'fog-off', 'both-off']) {
      await page.evaluate(({ mode, originalFog }) => campus.pipeline.setOptions({
        clouds: mode !== 'clouds-off' && mode !== 'both-off',
        fog: mode === 'fog-off' || mode === 'both-off' ? false : originalFog.fog,
        volumetricFog: mode === 'fog-off' || mode === 'both-off' ? false : originalFog.volumetricFog
      }), { mode, originalFog })
      await page.evaluate(view => window.setCloudView(view, 1000), view)
      // Screenshot the normal renderer before executing any diagnostic shader.
      const file = `horizon-seam-${label}-${view.name}-${mode}.png`
      await page.screenshot({ path: path.join(directory, file) })
      const result = await page.evaluate(() => window.captureSeam())
      cases.push({ view, mode, file, ...result })
      console.log(JSON.stringify({ view: view.name, mode, hdr: result.hdr.valid, readErrors: result.readErrors,
        boundary: result.boundaryPoints.map(b => ({ u: b.u, y: b.yFromTop })),
        displayJumps: result.records.display.columns.map(c => ({ u: c.u, jump: c.largestJumps[0] })) }))
      fs.writeFileSync(path.join(directory, `horizon-seam-${label}.json`), JSON.stringify({ label, url, generatedAt: new Date().toISOString(),
        sdkSha256: sdkHash, immutableSdkResponse: true, date: '2026-09-08T11:00:00+08:00', fixedPosition: [123.42, 41.77],
        viewport: [1200, 720], originalFog, cases, errors }, null, 2))
      if (!result.hdr.valid || result.glError || result.readErrors.length) throw new Error('Diagnostic capture invalid')
    }
    if (errors.length) throw new Error(errors.join('\n'))
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
