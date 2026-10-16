#!/usr/bin/env node
// Immutable SDK, real campus GLBs, and in-frame depth evidence; not a benchmark.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

async function main() {
  const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'after'
  const critical = process.argv.includes('--critical')
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid label')
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const directory = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  fs.mkdirSync(directory, { recursive: true })
  const sdk = fs.readFileSync(path.resolve(__dirname, '../../build/0.1.0/CCR.min.js'))
  const sdkHash = crypto.createHash('sha256').update(sdk).digest('hex')
  const url = 'http://127.0.0.1:8979/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&assets=http://localhost:8083/Dongda&glbAssets=http://localhost:8083/Dongda/DongdaModel_PBR/SM_NH/'
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8979'], { stdio: 'ignore' })
  const cases = [], errors = [], failures = []
  let browser
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } })
    await page.route('**/build/0.1.0/CCR.min.js', route => route.fulfill({ body: sdk, contentType: 'application/javascript' }))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.models?.length === 70 && campus.models.every(model => model.ready), null, { timeout: 180000 })
    await page.evaluate(() => {
      const { viewer, pipeline } = campus, C = Cesium
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelectorAll('.lil-gui').forEach(element => element.style.setProperty('display', 'none'))
      if (campus.stats?.dom) campus.stats.dom.style.setProperty('display', 'none')
      viewer.clock.shouldAnimate = false
      viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
      viewer.useDefaultRenderLoop = false
      pipeline.setOptions({ environmentAnimation: false, environment: true, clouds: true, fog: true, volumetricFog: true })
      const model = campus.models.find(model => model.id?.file === 'SM_NH_JZXG.glb') || campus.models.find(model => model.id?.file === 'SM_NH_ZHL.glb')
      if (!model) throw new Error('Building fixture missing')
      window.occlusionBuilding = model
      viewer.camera.lookAt(model.boundingSphere.center, new C.HeadingPitchRange(Math.PI, -.08, model.boundingSphere.radius * 4))
      viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
      viewer.camera.frustum.near = 1
      viewer.camera.frustum.far = 1e6
      window.settleBuildingFrames = async (count = 24) => {
        for (let i = 0; i < count; i++) { viewer.render(); await new Promise(resolve => requestAnimationFrame(resolve)) }
      }
      window.captureBuildingDepth = () => {
        const e = pipeline.environmentRenderer, context = viewer.scene.context, gl = context._gl
        if (!e.environmentGraph) { viewer.render(); return { records: {}, hdr: e.hdr?.getDiagnostics?.() || { valid: false }, environmentDisabled: true } }
        const graph = e.environmentGraph, run = graph.run, records = {}, readErrors = []
        const read = (fb, width, height) => {
          const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
          const pixels = new Float32Array(width * height * 4)
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb._framebuffer)
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels)
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw)
          const error = gl.getError(); if (error) readErrors.push(error)
          return pixels
        }
        const quantiles = values => {
          values.sort((a, b) => a - b)
          const q = f => values.length ? values[Math.floor((values.length - 1) * f)] : null
          return { count: values.length, min: q(0), p50: q(.5), p90: q(.9), p99: q(.99), max: q(1) }
        }
        graph.run = function(key, invoke) { return run.call(this, key, () => {
          const result = invoke()
          if (key === 'environment.composite') {
            const C = Cesium, stage = e.stages.resolveStage, source = stage.fragmentShader
            const depth = stage._command.uniformMap.depthTexture(), surface = stage._command.uniformMap.surfaceDepthTexture()
            records.depthTexture = { id: depth.id, format: depth.pixelFormat, datatype: depth.pixelDatatype, width: depth.width, height: depth.height,
              surfaceId: surface.id, surfaceFormat: surface.pixelFormat, surfaceDatatype: surface.pixelDatatype, useLogDepth: viewer.scene.frameState.useLogDepth,
              currentFrustum: context.uniformState.currentFrustum }
            const mainIndex = source.lastIndexOf('void main()')
            if (mainIndex < 0) throw new Error('Depth probe main missing')
            const shader = source.slice(0, mainIndex) + `void main() {
              vec2 uv=v_textureCoordinates;
              float s=depthDistance(uv,texture(depthTexture,uv).r);
              float g=surfaceDepthAvailable?depthDistance(uv,czm_unpackDepth(texture(surfaceDepthTexture,uv))):DEPTH_LIMIT;
              out_FragColor=vec4(s,g,sceneDistance(uv),(s<DEPTH_LIMIT?1.0:0.0)+(g<DEPTH_LIMIT?2.0:0.0));
            }`
            const target = new C.Texture({ context, width: viewer.canvas.width, height: viewer.canvas.height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
            const fb = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
            const state = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, target.width, target.height), depthTest: { enabled: false }, depthMask: false })
            const command = context.createViewportQuadCommand(new C.ShaderSource({ defines: viewer.scene.frameState.useLogDepth ? ['LOG_DEPTH'] : [], sources: [shader] }), { framebuffer: fb, renderState: state, uniformMap: stage._command.uniformMap })
            try {
              const originalViewport = C.BoundingRectangle.clone(context.uniformState.viewport)
              command.execute(context)
              const pixels = read(fb, target.width, target.height), errors = [], samples = [], candidateSamples = []
              let candidateCount = 0, wrongCount = 0, maxAbsolute = 0, finite = true, validScenePixels = 0, validGlobePixels = 0, tooNearCount = 0, emptyDepthPixels = 0, invalidEmptyDepthPixels = 0
              const synthetic = { pixels: 0, wrongCount: 0, maxErrorMeters: 0 }
              for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
                const i = (y * target.width + x) * 4, s = pixels[i], g = pixels[i + 1], chosen = pixels[i + 2]
                for (let c = 0; c < 4; c++) finite = finite && Number.isFinite(pixels[i + c])
                if (s < 2e7) validScenePixels++
                if (g < 2e7) validGlobePixels++
                if (chosen < Math.min(s, g) - 1) tooNearCount++
                if (s === 2e7 && g === 2e7) { emptyDepthPixels++; if (chosen !== 2e7) invalidEmptyDepthPixels++ }
                maxAbsolute = Math.max(maxAbsolute, Math.abs(s), Math.abs(g), Math.abs(chosen))
                if (s < 2e7 && g - s > 5) {
                  const error = Math.abs(chosen - s)
                  candidateCount++; if (error > 1) wrongCount++
                  errors.push(error)
                  if (candidateSamples.length < 30 && x % 40 === 0 && y % 40 === 0) candidateSamples.push({ x, yFromTop: target.height - 1 - y, rgba: Array.from(pixels.subarray(i, i + 4)) })
                }
                if (window.syntheticBuildingFixture && s > 150 && s < 240 && x > target.width * .25 && x < target.width * .75 && y > target.height * .25 && y < target.height * .75) {
                  synthetic.pixels++; synthetic.maxErrorMeters = Math.max(synthetic.maxErrorMeters, Math.abs(chosen - s))
                  if (chosen > s + 1 || chosen < Math.min(s, g) - 1) synthetic.wrongCount++
                }
              }
              for (const [u, v] of [[.25, .25], [.5, .25], [.75, .25], [.25, .5], [.5, .5], [.75, .5], [.25, .75], [.5, .75], [.75, .75]]) {
                const i = (Math.floor(target.height * v) * target.width + Math.floor(target.width * u)) * 4
                samples.push({ uvBottomLeft: [u, v], rgba: Array.from(pixels.subarray(i, i + 4)) })
              }
              records.depth = { size: [target.width, target.height], finite, maxAbsolute, validScenePixels, validGlobePixels,
                foregroundDefinition: 'sceneDistance < 20,000,000m and packedGlobeDistance - rawSceneDistance > 5m',
                candidateCount, wrongCount, tooNearCount, emptyDepthPixels, invalidEmptyDepthPixels, productionErrorMeters: quantiles(errors), samples, candidateSamples,
                ...(window.syntheticBuildingFixture ? { syntheticFrontOpaque: synthetic } : {}) }
              context.uniformState.viewport = originalViewport
            } finally { command.shaderProgram.destroy(); fb.destroy(); target.destroy(); C.RenderState.removeFromCache(state) }
            const native = e.hdr.inputColor, nativeFb = new C.Framebuffer({ context, colorTextures: [native], destroyAttachments: false })
            try {
              const values = read(nativeFb, native.width, native.height)
              let maximum = 0, mean = 0, finite = true
              for (let i = 0; i < values.length; i += 4) {
                const l = values[i] * .2126 + values[i + 1] * .7152 + values[i + 2] * .0722
                maximum = Math.max(maximum, l); mean += l; finite = finite && Number.isFinite(l)
              }
              records.nativeScene = { maximumLuminance: maximum, meanLuminance: mean / (values.length / 4), finite }
            } finally { nativeFb.destroy() }
          }
          return result
        }) }
        try { viewer.render() } finally { graph.run = run }
        const camera = viewer.camera
        return { records, readErrors, glError: gl.getError(), hdr: e.hdr.getDiagnostics(),
          model: { name: occlusionBuilding.name, id: occlusionBuilding.id, radius: occlusionBuilding.boundingSphere.radius, center: occlusionBuilding.boundingSphere.center },
          modelsReady: campus.models.filter(model => model.ready).length, contextTiles: campus.contextTiles.length,
          camera: { position: camera.positionWC, direction: camera.directionWC, up: camera.upWC, near: camera.frustum.near, far: camera.frustum.far },
          renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
          sceneErrors: campus.errors.slice() }
      }
    })
    for (const near of [1, 10, 100]) {
      await page.evaluate(near => { campus.viewer.camera.frustum.near = near }, near)
      await page.evaluate(() => settleBuildingFrames())
      const hdr = await page.evaluate(() => campus.pipeline.environmentRenderer.hdr.getDiagnostics())
      if (hdr.valid && hdr.frustumCount === 1) break
    }
    for (const variant of critical ? ['normal'] : ['normal', 'cloudsOff', 'fogOff', 'envOff', 'synthetic-normal', 'synthetic-cloudsOff', 'synthetic-envOff']) {
      await page.evaluate(variant => {
        const { viewer, pipeline } = campus, C = Cesium
        if (variant === 'synthetic-normal') {
          window.syntheticBuildingFixture = true
          const center = C.Cartographic.fromCartesian(occlusionBuilding.boundingSphere.center)
          viewer.camera.setView({ destination: C.Cartesian3.fromRadians(center.longitude, center.latitude, center.height + 400), orientation: { heading: 0, pitch: 0, roll: 0 } })
          const position = C.Cartesian3.add(viewer.camera.positionWC, C.Cartesian3.multiplyByScalar(viewer.camera.directionWC, 200, new C.Cartesian3()), new C.Cartesian3())
          const primitive = new C.Primitive({ asynchronous: false,
            geometryInstances: new C.GeometryInstance({ id: 'diagnostic-opaque-box', geometry: C.BoxGeometry.fromDimensions({ dimensions: new C.Cartesian3(90, 60, 90), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
              modelMatrix: C.Transforms.eastNorthUpToFixedFrame(position), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.WHITE) } }),
            appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }) })
          viewer.scene.primitives.add(primitive)
          const behind = C.Cartesian3.add(viewer.camera.positionWC, C.Cartesian3.multiplyByScalar(viewer.camera.directionWC, 600, new C.Cartesian3()), new C.Cartesian3())
          viewer.scene.primitives.add(new C.Primitive({ asynchronous: false,
            geometryInstances: new C.GeometryInstance({ id: 'diagnostic-behind-plane', geometry: C.BoxGeometry.fromDimensions({ dimensions: new C.Cartesian3(350, 5, 350), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
              modelMatrix: C.Transforms.eastNorthUpToFixedFrame(behind), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.CORNFLOWERBLUE) } }),
            appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }) }))
          viewer.camera.frustum.near = 1; viewer.camera.frustum.far = 1e6
        }
        const mode = variant.replace('synthetic-', '')
        pipeline.setOptions({ environment: mode !== 'envOff', clouds: mode !== 'cloudsOff' && mode !== 'envOff', fog: mode !== 'fogOff', volumetricFog: mode !== 'fogOff' })
      }, variant)
      await page.evaluate(() => settleBuildingFrames())
      const result = await page.evaluate(() => captureBuildingDepth())
      const depth = result.records.depth, issues = []
      if (!variant.endsWith('envOff')) {
        if (!result.hdr.valid || result.hdr.frustumCount !== 1) issues.push('HDR requires one valid frustum')
        if (!depth?.finite || !depth.candidateCount) issues.push('Missing finite foreground depth fixture')
        if (depth?.wrongCount || depth?.tooNearCount) issues.push('Production chosen depth violates scene/globe minimum within 1m')
        if (depth?.invalidEmptyDepthPixels) issues.push('Empty scene and globe require the exact 20,000,000m sentinel')
        if (result.readErrors?.length || result.glError || result.sceneErrors?.length) issues.push('Runtime/WebGL error')
        if (result.modelsReady !== 70) issues.push('Campus GLBs not ready')
      }
      if (issues.length) failures.push({ variant, issues })
      const file = `building-occlusion-${label}-${variant}.png`
      await page.screenshot({ path: path.join(directory, file) })
      cases.push({ variant, file, issues, ...result })
      fs.writeFileSync(path.join(directory, `building-occlusion-${label}.json`), JSON.stringify({ label, url, sdkHash, immutableSdkResponse: true,
        generatedAt: new Date().toISOString(), time: '2026-09-08T11:00:00+08:00', critical,
        acceptance: 'At actual foreground pixels where raw scene is over 5m nearer than packed globe: chosen <= scene + 1m; everywhere chosen >= min(scene, globe) - 1m.', cases, errors, failures }, null, 2))
      console.log(JSON.stringify({ variant, hdr: result.hdr.valid, depth: result.records.depth ? { candidates: result.records.depth.candidateCount, wrong: result.records.depth.wrongCount, errors: result.records.depth.productionErrorMeters, center: result.records.depth.samples[4] } : null }))
    }
    if (errors.length || failures.length) throw new Error(JSON.stringify({ errors, failures }))
  } finally { if (browser) await browser.close(); server.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
