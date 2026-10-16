#!/usr/bin/env node
// Fixed-view visual/transport evidence only; this is not a timing benchmark.
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
  const url = 'http://127.0.0.1:8971/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets'
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8971'], { stdio: 'ignore' })
  const cases = [], errors = [], failures = []
  // Serve one immutable SDK snapshot even while another task rebuilds the workspace.
  const sdk = fs.readFileSync(path.resolve(__dirname,'../../build/0.1.0/CCR.min.js'))
  const sdkHash = crypto.createHash('sha256').update(sdk).digest('hex')
  const fullResolution=process.argv.includes('--full-resolution')
  const extinctionOverride=Number(process.argv.find(arg=>arg.startsWith('--extinction='))?.slice(13))
  const onlyCase=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)
  let browser
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } })
    await page.route('**/build/0.1.0/CCR.min.js',route=>route.fulfill({body:sdk,contentType:'application/javascript'}))
    if(fullResolution) await page.addInitScript(()=>{window.CCR_ENV_SCALE=1})
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid, null, { timeout: 120000 })
    await page.waitForTimeout(7000)
    await page.evaluate(extinctionOverride => {
      const { viewer, pipeline } = campus
      if(Number.isFinite(extinctionOverride)&&extinctionOverride>0) {
        const renderer=pipeline.environmentRenderer,update=renderer.update
        renderer.update=function(...args){const result=update.apply(this,args);this.state.cloudExtinction=extinctionOverride;return result}
      }
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelectorAll('.lil-gui').forEach(element => element.style.setProperty('display', 'none'))
      if (campus.stats?.dom) campus.stats.dom.style.setProperty('display', 'none')
      viewer.clock.shouldAnimate = false
      viewer.useDefaultRenderLoop = false
      pipeline.setOptions({ environmentAnimation: false, clouds: true, cloudCoverage: .42, cloudBaseHeight: 1600, cloudThickness: 1200 })
      window.settleCloudFrames = async () => {
        for (let i = 0; i < 24; i++) {
          viewer.render()
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      }
      window.captureCloudStructure = () => {
        const e = pipeline.environmentRenderer, context = viewer.scene.context, gl = context._gl
        const adapter = e.environmentGraph, run = adapter.run, records = {}, arrays = {}, readErrors = []
        const stages = { 'cloud.march': 'cloudStage', 'cloud.depth': 'cloudDepthStage',
          'atmosphere.raymarch': 'raymarchStage', 'environment.composite': 'resolveStage' }
        const luma = (p, i) => p[i] * .2126 + p[i + 1] * .7152 + p[i + 2] * .0722
        const distribution = values => {
          values.sort((a, b) => a - b)
          const q = f => values.length ? values[Math.floor((values.length - 1) * f)] : null
          return { count: values.length, min: q(0), p10: q(.1), p50: q(.5), p90: q(.9), max: q(1),
            mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
        }
        const summarize = (pixels, width, height, display = false) => {
          const rgb = [0, 0, 0], topRgb = [0, 0, 0], luminance = [], top = [], alpha = []
          let finite = true, visible = 0, clippedWhite = 0
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4, L = luma(pixels, i)
            for (let c = 0; c < 4; c++) finite = finite && Number.isFinite(pixels[i + c])
            for (let c = 0; c < 3; c++) rgb[c] += pixels[i + c]
            luminance.push(L); alpha.push(pixels[i + 3])
            if (display && L > 3) visible++
            if (display && pixels[i] >= 250 && pixels[i + 1] >= 250 && pixels[i + 2] >= 250) clippedWhite++
            if (y >= Math.floor(height * .75)) {
              top.push(L)
              for (let c = 0; c < 3; c++) topRgb[c] += pixels[i + c]
            }
          }
          const count = width * height
          return { size: [width, height], finite, rgb: rgb.map(v => v / count), luminance: distribution(luminance),
            alpha: distribution(alpha), topScreen: { rgb: topRgb.map(v => v / top.length), luminance: distribution(top) },
            ...(display ? { visibleRatio: visible / count, clippedWhiteRatio: clippedWhite / count } : {}) }
        }
        const read = (framebuffer, width, height) => {
          const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING)
          const pixels = new Float32Array(width * height * 4)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer._framebuffer)
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels)
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
          const error = gl.getError()
          if (error) readErrors.push(error)
          return pixels
        }
        // Graph transients may be aliased/released when run() returns. Read inside invoke().
        adapter.run = function(key, invoke) {
          return run.call(this, key, () => {
            const result = invoke(), fb = e.stages[stages[key]]?._command?.framebuffer
            if (fb) {
              const texture = fb.getColorTexture(0), pixels = read(fb, texture.width, texture.height)
              records[key] = { textureId: texture.id, ...summarize(pixels, texture.width, texture.height) }
              if (key.startsWith('cloud.')) arrays[key] = pixels
            }
            if (key === 'environment.composite') {
              const texture = e.hdr.inputColor, fb = new Cesium.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
              try { records.nativeScene = summarize(read(fb, texture.width, texture.height), texture.width, texture.height) }
              finally { fb.destroy() }
              records.graph = e.environmentGraph.getDiagnostics()
            }
            return result
          })
        }
        try { viewer.render() } finally { adapter.run = run }
        const cloud = arrays['cloud.march'], depth = arrays['cloud.depth']
        if (cloud) {
          const T = [], L = [], sourceL = [], rgb = [0, 0, 0], sourceRgb = [0, 0, 0]
          const bins = [0, 0, 0, 0, 0], samples = []
          let maxDepthTError = 0, badT = 0, negativeRGB = 0
          for (let i = 0; i < cloud.length; i += 4) {
            const t = cloud[i + 3]
            if (t < 0 || t > 1) badT++
            if (Math.min(cloud[i], cloud[i + 1], cloud[i + 2]) < -1e-6) negativeRGB++
            if (depth) maxDepthTError = Math.max(maxDepthTError, Math.abs(t - depth[i + 1]))
            if (t >= .95) continue
            const l = luma(cloud, i), opacity = 1 - t
            T.push(t); L.push(l); sourceL.push(l / opacity)
            bins[t < .05 ? 0 : t < .25 ? 1 : t < .5 ? 2 : t < .75 ? 3 : 4]++
            for (let c = 0; c < 3; c++) { rgb[c] += cloud[i + c]; sourceRgb[c] += cloud[i + c] / opacity }
          }
          const source = distribution(sourceL)
          for (const [u, v] of [[.25, .25], [.5, .25], [.75, .25], [.25, .5], [.5, .5], [.75, .5], [.25, .75], [.5, .75], [.75, .75]]) {
            const texture = records['cloud.march'].size, i = (Math.floor(texture[1] * v) * texture[0] + Math.floor(texture[0] * u)) * 4
            samples.push({ uv: [u, v], rgba: Array.from(cloud.subarray(i, i + 4)), distanceT: depth ? Array.from(depth.subarray(i, i + 4)) : null })
          }
          records.cloudOccupied = { threshold: 'T < 0.95', pixels: T.length, fraction: T.length / (cloud.length / 4),
            transmittance: distribution(T), transmittanceBins: { edges: [0, .05, .25, .5, .75, .95], counts: bins },
            luminance: distribution(L), sourceLuminance: { definition: 'linear luminance / (1 - T)', ...source,
              contrast: source.count && source.p90 + source.p10 > 0 ? (source.p90 - source.p10) / (source.p90 + source.p10) : null },
            rgb: rgb.map(v => T.length ? v / T.length : 0), sourceRgb: sourceRgb.map(v => T.length ? v / T.length : 0),
            maxDepthTError, badT, negativeRGB, samples }
        }
        const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
        const display = new Uint8Array(viewer.canvas.width * viewer.canvas.height * 4)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.readPixels(0, 0, viewer.canvas.width, viewer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, display)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
        const displayStats = summarize(display, viewer.canvas.width, viewer.canvas.height, true)
        const raw = {}
        for (const [key, values] of Object.entries(arrays)) {
          const bytes = new Uint8Array(values.buffer), chunks = []
          for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)))
          raw[key] = btoa(chunks.join(''))
        }
        const camera = viewer.camera, options = pipeline.options
        return { records, display: displayStats, raw, readErrors, glError: gl.getError(), hdr: e.hdr.getDiagnostics(),
          lut: e.atmosphereLut.getDiagnostics(), lighting: e.lighting.getDiagnostics(), environment: e.getDiagnostics(),
          camera: { longitude: Cesium.Math.toDegrees(camera.positionCartographic.longitude), latitude: Cesium.Math.toDegrees(camera.positionCartographic.latitude),
            height: camera.positionCartographic.height, heading: Cesium.Math.toDegrees(camera.heading), pitch: Cesium.Math.toDegrees(camera.pitch),
            near: camera.frustum.near, far: camera.frustum.far, fov: camera.frustum.fov },
          scene: { frustumCount: viewer.scene._view.frustumCommandsList.length, frameNumber: viewer.scene.frameState.frameNumber,
            tilesLoaded: viewer.scene.globe.tilesLoaded, highDynamicRange: viewer.scene.highDynamicRange, gamma: viewer.scene.gamma,
            skyBox: viewer.scene.skyBox?.show, skyAtmosphere: viewer.scene.skyAtmosphere?.show, moon: viewer.scene.moon?.show,
            exposure: viewer.scene.postProcessStages.exposure, drawingBuffer: [viewer.canvas.width, viewer.canvas.height] },
          options: { environmentAnimation: options.environmentAnimation, cloudCoverage: options.cloudCoverage,
            cloudBaseHeight: options.cloudBaseHeight, cloudThickness: options.cloudThickness, environmentQuality: options.environmentQuality,
            skyLightIntensity: options.skyLightIntensity, sunIntensity: options.sunIntensity, antialiasing: options.antialiasing } }
      }
    },extinctionOverride)
    const matrix = ['1100', '1600'].flatMap(time => [
      { time, name: 'above-sun', height: 3500, pitch: -15, offset: 0 },
      { time, name: 'above-side', height: 3500, pitch: -15, offset: Math.PI / 2 },
      { time, name: 'below', height: 300, pitch: 20, offset: 0 },
      { time, name: 'overhead', height: 5000, pitch: -90, heading: 0 }
    ])
    matrix.push({ time: '1745', name: 'above-sun', height: 3500, pitch: -15, offset: 0 })
    for (const view of matrix) {
      if(onlyCase&&onlyCase!==`${view.time}-${view.name}`)continue
      const attempts = []
      let result
      for (const near of view.name === 'below' ? [100, 1000] : [1000]) {
        await page.evaluate(({ view, near }) => {
          const { viewer, pipeline } = campus
          viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(`2026-09-08T${view.time.slice(0, 2)}:${view.time.slice(2)}:00+08:00`)
          pipeline.environmentRenderer.update()
          const sun = pipeline.environmentRenderer.sunLocal
          viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(123.42, 41.77, view.height),
            orientation: { heading: view.heading ?? Math.atan2(sun.x, sun.y) + view.offset, pitch: Cesium.Math.toRadians(view.pitch), roll: 0 } })
          viewer.camera.frustum.near = near
          viewer.camera.frustum.far = 1000000
        }, { view, near })
        await page.evaluate(() => window.settleCloudFrames())
        result = await page.evaluate(() => window.captureCloudStructure())
        attempts.push({ near, hdr: result.hdr })
        if (result.hdr.valid && result.hdr.frustumCount === 1) break
      }
      const base = `cloud-structure-${label}-${view.time}-${view.name}`
      result.rawFiles = {}
      for (const [key, value] of Object.entries(result.raw)) {
        const file = `${base}-${key.replace('.', '-')}.f32`
        fs.writeFileSync(path.join(directory, file), Buffer.from(value, 'base64'))
        result.rawFiles[key] = { file, format: 'little-endian Float32 RGBA, WebGL bottom-left origin', size: result.records[key].size }
      }
      delete result.raw
      await page.screenshot({ path: path.join(directory, base + '.png') })
      const occupied = result.records.cloudOccupied
      const issues = []
      if (!result.hdr.valid || result.hdr.frustumCount !== 1) issues.push('HDR must be valid with exactly one frustum')
      if (!result.hdr.cloudTemporal.valid || result.hdr.cloudTemporal.age < 16) issues.push('Cloud temporal history did not settle for 16 frames')
      if (!result.lut.ready) issues.push('Atmosphere LUT not ready')
      if (result.glError || result.readErrors.length) issues.push('WebGL error')
      if (!occupied || !result.records['cloud.depth']) issues.push('Cloud passes missing')
      if (occupied && !occupied.pixels) issues.push('Cloud fixture is empty')
      if (occupied && (occupied.maxDepthTError > 1e-5 || occupied.badT || occupied.negativeRGB)) issues.push('Cloud transport invariant failed')
      if (Object.values(result.records).some(record => record.finite === false)) issues.push('Nonfinite texture')
      cases.push({ time: view.time, view: view.name, file: base + '.png', settledFrames: 24, attempts, issues, ...result })
      if (issues.length) failures.push({ time: view.time, view: view.name, issues })
      console.log(JSON.stringify({ time: view.time, view: view.name, issues, cloudFraction: occupied?.fraction,
        sourceLuminance: occupied?.sourceLuminance, hdr: result.hdr.valid, temporalAge: result.hdr.cloudTemporal.age }))
    }
    if(!cases.length)throw new Error('No matching cloud fixture: '+onlyCase)
    const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('/build/')))
    const bundles = scripts.map(resource => {
      return { resource, sha256: new URL(resource).pathname.endsWith('/CCR.min.js')?sdkHash:null }
    })
    fs.writeFileSync(path.join(directory, `cloud-structure-${label}.json`), JSON.stringify({ label, url, generatedAt: new Date().toISOString(),
      viewport: [1200, 720], environmentScale:fullResolution?1:.5, immutableSdkResponse:true,
      extinctionOverride:Number.isFinite(extinctionOverride)?extinctionOverride:null,
      date: '2026-09-08', timezone: '+08:00', fixedPosition: [123.42, 41.77],
      definition: 'Cloud contrast uses occupied-pixel linear L/(1-T); inspect p10/p50/p90 and mean alongside contrast to avoid treating darkening as improvement.',
      skyDefinition: 'topScreen is the actual top quarter of each output, including clouds if present; nativeScene records the pre-environment scene sky.',
      bundles, cases, errors, failures }, null, 2))
    if (errors.length || failures.length) throw new Error(JSON.stringify({ errors, failures }))
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
