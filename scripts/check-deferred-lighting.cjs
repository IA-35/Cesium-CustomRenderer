// B02 acceptance: does CCR's deferred lighting reproduce Cesium's native PBR?
//
// The plan's gate: on interior pixels, absolute error <= 0.01 or relative error <= 2% in linear HDR,
// whichever is more permissive, excluding a 1px silhouette band.
//
// The comparison is done in *linear HDR*, not on the presented 8-bit sRGB image: tonemapping and
// gamma compress differences and would make a wrong implementation look acceptable. Both renders are
// read through the same path (the HDR scene colour before display encoding).
//
// Usage (dev server on CCR_TEST_PORT must already be running):
//   node scripts/check-deferred-lighting.cjs
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const port = process.env.CCR_TEST_PORT || 8877
const origin = `http://127.0.0.1:${port}`
const output = path.resolve(__dirname, '../docs/verification/stage1-B02-fixed')

/** Tolerance from the plan. Absolute wins when the reference sample is small. */
const ABSOLUTE_TOLERANCE = 0.01
const RELATIVE_TOLERANCE = 0.02

;(async () => {
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  const report = {
    batch: 'B02',
    generatedAt: new Date().toISOString(),
    scope: 'generated PBR planes facing the sun; generic scene, no campus assets or external imagery',
    tolerance: { absolute: ABSOLUTE_TOLERANCE, relative: RELATIVE_TOLERANCE },
    gate: '<= 0.01 absolute OR <= 2% relative, per channel, on the samples listed',
    cases: [],
    limitations: [],
  }
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    const pageErrors = []
    const httpErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() }) })
    await page.goto(`${origin}/tests/rendering/deferred-lighting-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 60000 })

    const result = await page.evaluate(async () => {
      const mod = await import('/tests/rendering/deferred-lighting-fixture.js')
      const f = window.fixture
      await mod.startDeferredFixture(f)
      const C = Cesium
      const scene = f.viewer.scene
      const pipeline = f.pipeline
      const frames = n => new Promise(res => {
        let k = n
        const off = scene.postRender.addEventListener(() => { if (--k === 0) { off(); res() } })
      })

      // Read the *linear HDR* scene colour, which is what the lighting maths produces, rather than the
      // tonemapped 8-bit presentation. Reading the displayed image would let a wrong implementation
      // pass behind the tonemapper's compression.
      const readHdr = (x, y) => {
        const colorTexture = scene._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0)
        const target = new C.Texture({
          context: scene.context, width: 1, height: 1,
          pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
        })
        const framebuffer = new C.Framebuffer({ context: scene.context, colorTextures: [target], destroyAttachments: false })
        const uv = new C.Cartesian2(x / scene.drawingBufferWidth, 1 - y / scene.drawingBufferHeight)
        const command = scene.context.createViewportQuadCommand(
          new C.ShaderSource({
            sources: [`uniform sampler2D u_t; uniform vec2 u_uv;
void main() { out_FragColor = texture(u_t, u_uv); }`],
          }),
          {
            framebuffer,
            renderState: C.RenderState.fromCache({
              viewport: new C.BoundingRectangle(0, 0, 1, 1), depthTest: { enabled: false }, depthMask: false,
            }),
            uniformMap: { u_t: () => colorTexture, u_uv: () => uv },
          },
        )
        let pixels
        try {
          command.execute(scene.context)
          pixels = Array.from(scene.context.readPixels({ framebuffer, width: 1, height: 1 }))
        } finally {
          command.shaderProgram.destroy()
          framebuffer.destroy()
          target.destroy()
        }
        return pixels.slice(0, 3)
      }

      const samplePoints = mod.samplePoints(f).points
      const width = scene.drawingBufferWidth
      const height = scene.drawingBufferHeight
      const uvOf = p => [p.x / width, 1 - p.y / height]

      // 1) Native reference. CCR lighting off; plain Cesium forward PBR.
      pipeline.setLighting({ mode: 'enhanced' })
      await frames(40)
      const nativeSamples = {}
      for (const point of samplePoints) nativeSamples[point.id] = { hdr: readHdr(point.x, point.y) }

      // 2) The same scene with CCR deferred lighting, each term isolated so a mismatch can be
      //    attributed instead of blamed on "the lighting".
      const channels = {}
      for (const [name, settings] of [
        ['all', { direct: true, indirect: true, emissive: true, shadow: false, ao: false }],
        ['directOnly', { direct: true, indirect: false, emissive: false, shadow: false, ao: false }],
        ['indirectOnly', { direct: false, indirect: true, emissive: false, shadow: false, ao: false }],
        ['emissiveOnly', { direct: false, indirect: false, emissive: true, shadow: false, ao: false }],
      ]) {
        pipeline.setLighting({ mode: 'deferred', ...settings })
        await frames(30)
        channels[name] = {}
        for (const point of samplePoints) {
          channels[name][point.id] = { hdr: readHdr(point.x, point.y), uv: uvOf(point) }
        }
      }

      // 3) G-buffer state per sample, so "not rasterised" is distinguishable from "black material".
      const textures = pipeline.deferredLighting.materials.getTextures()
      const gbuffer = textures
        ? mod.probeMaterialTextures(C, scene, textures, samplePoints.map(p => ({ id: p.id, uv: uvOf(p) })))
        : null

      return {
        samplePoints,
        nativeSamples,
        channels,
        gbuffer,
        diagnostics: {
          valid: pipeline.getLightingDiagnostics().valid,
          reason: pipeline.getLightingDiagnostics().reason,
          error: (pipeline.getLightingDiagnostics().error || '').split('\n')[0],
          stats: pipeline.getLightingDiagnostics().stats,
        },
        lightingEnvironment: {
          lightDirectionEC: [scene.context.uniformState.lightDirectionEC.x, scene.context.uniformState.lightDirectionEC.y, scene.context.uniformState.lightDirectionEC.z],
          lightColorHdr: [scene.context.uniformState.lightColorHdr.x, scene.context.uniformState.lightColorHdr.y, scene.context.uniformState.lightColorHdr.z],
          sphericalHarmonicsPresent: scene.context.uniformState.sphericalHarmonicCoefficients
            ? scene.context.uniformState.sphericalHarmonicCoefficients.length : 0,
        },
        errors: f.errors.slice(),
      }
    })

    await page.screenshot({ path: path.join(output, 'deferred.png') })

    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`)
    assert.deepEqual(httpErrors, [], 'http errors')
    assert.deepEqual(result.errors, [], 'render errors')
    assert.equal(result.diagnostics.valid, true, `deferred lighting not valid: ${result.diagnostics.reason} ${result.diagnostics.error}`)

    const comparison = []
    for (const point of result.samplePoints) {
      const g = result.gbuffer ? result.gbuffer[point.id] : null
      // A sample only participates when the G-buffer actually has a supported surface there.
      const supported = !!g && g.eyeDepth > 0 && (Math.floor((g.flags % 1024) / 512) % 2) === 1
      const nativeHdr = result.nativeSamples[point.id].hdr
      const deferredHdr = result.channels.all[point.id].hdr
      const directHdr = result.channels.directOnly[point.id].hdr
      const entry = {
        id: point.id,
        screen: [point.x, point.y],
        supported,
        eyeDepth: g ? g.eyeDepth : null,
        flags: g ? g.flags : null,
        nativeHdr,
        deferredHdr,
        directOnlyHdr: directHdr,
        perChannel: [],
      }
      if (supported) {
        for (let channel = 0; channel < 3; channel++) {
          const reference = nativeHdr[channel]
          const actual = deferredHdr[channel]
          const absolute = Math.abs(actual - reference)
          const relative = reference > 1e-6 ? absolute / Math.abs(reference) : Infinity
          entry.perChannel.push({
            channel,
            reference: +reference.toFixed(6),
            actual: +actual.toFixed(6),
            absoluteError: +absolute.toFixed(6),
            relativeError: Number.isFinite(relative) ? +relative.toFixed(6) : null,
            pass: absolute <= ABSOLUTE_TOLERANCE || relative <= RELATIVE_TOLERANCE,
          })
        }
        entry.pass = entry.perChannel.every(c => c.pass)
      }
      comparison.push(entry)
    }

    const supportedSamples = comparison.filter(entry => entry.supported)
    report.cases = comparison
    report.supportedSampleCount = supportedSamples.length
    report.passingSampleCount = supportedSamples.filter(entry => entry.pass).length
    report.diagnostics = result.diagnostics
    report.lightingEnvironment = result.lightingEnvironment
    report.valid = supportedSamples.length === 7 && supportedSamples.every(entry => entry.pass)
    report.limitations = [
      'Cross-scene bit-equality is NOT the goal: fog, atmosphere and any other view-dependent term would differ even with identical BRDF maths.',
      'Only pixels whose material flags mark STANDARD_PBR_VALID participate; unsupported surfaces are expected to pass through untouched.',
      'The linear HDR comparison deliberately bypasses tonemapping, which would otherwise hide lighting errors.',
    ]
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))

    assert.equal(supportedSamples.length, 7, 'all seven material cases must be sampled');
    assert.ok(supportedSamples.length > 0,
      `no sample landed on a supported surface; g-buffer: ${JSON.stringify(comparison.map(entry => ({ id: entry.id, eyeDepth: entry.eyeDepth, flags: entry.flags })))}`)

    console.log(JSON.stringify({
      diagnostics: report.diagnostics,
      lightingEnvironment: report.lightingEnvironment,
      supportedSamples: report.supportedSampleCount,
      passingSamples: report.passingSampleCount,
      valid: report.valid,
      detail: comparison.map(entry => ({
        id: entry.id,
        supported: entry.supported,
        native: entry.nativeHdr.map(v => +v.toFixed(4)),
        deferred: entry.deferredHdr.map(v => +v.toFixed(4)),
        pass: entry.pass,
      })),
      report: path.relative(path.resolve(__dirname, '..'), path.join(output, 'report.json')),
    }, null, 2))

    // The gate is reported, not silently relaxed: a failure here is the honest B02 status.
    assert.ok(report.valid, `deferred lighting did not match native within tolerance: ${JSON.stringify(supportedSamples.filter(e => !e.pass))}`)
  } catch (error) {
    report.error = String((error && error.message) || error)
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    throw error
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(error)
  if (error && /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error.message))) {
    console.error(`[check-deferred-lighting] no dev server on ${origin}; start one with: node scripts/dev-server.cjs --port ${port}`)
  }
  process.exitCode = 1
})
