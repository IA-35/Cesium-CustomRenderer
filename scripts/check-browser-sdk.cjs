const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'docs/verification')
const port = process.env.CCR_TEST_PORT || '8876'
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const results = []
    for (const [mode, url, handle] of [['source', '/examples/index.html?dataset=sample', 'demo'],
      ['umd', '/build/0.1.0/example.html?dataset=sample', 'sdkDemo']]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 750 } })
      const errors = [], sourceRequests = [], lookupRequests = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (request.url().includes('/src/')) sourceRequests.push(request.url())
        if (request.url().includes('/rendering/smaa/')) lookupRequests.push(request.url())
      })
      await page.goto(`http://127.0.0.1:${port}${url}`)
      await page.waitForFunction(handle => window[handle]?.tileset?.tilesLoaded && window[handle]?.pipeline?.smaa?.getDiagnostics().effective === 'smaa', handle, { timeout: 90000 })
      const result = await page.evaluate(async handle => {
        const app = window[handle], { viewer, pipeline } = app
        const frames = n => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { off(); reject(new Error('render timeout: ' + app.errors.join('; '))) }, 15000)
          const off = viewer.scene.postRender.addEventListener(() => { if (--n === 0) { off(); clearTimeout(timer); resolve() } })
        })
        const checks = { globalCCR: typeof window.CCR?.createVisualPipeline === 'function',
          noLegacyGlobals: !window.CampusRendering && !window.CesiumCustomRenderer,
          sameRegistry: window.CCR?.getVisualPipeline(viewer) === pipeline,
          smaa: pipeline.smaa.getDiagnostics().effective === 'smaa' }
        pipeline.setTaa({ enabled: true }); await frames(20)
        const taa = pipeline.getTaaDiagnostics()
        checks.taaOrDocumentedFallback = taa.valid || (taa.reason === 'Requires single-frustum depth' && viewer.scene.postProcessStages.fxaa.enabled)
        pipeline.setEnabled(false); await frames(4)
        checks.nativeRestore = viewer.camera.frustum.xOffset === 0 && viewer.camera.frustum.yOffset === 0 && !!viewer.scene.postProcessStages.outputTexture
        pipeline.setEnabled(true); await frames(12)
        checks.reenabled = pipeline.getTaaDiagnostics().valid || viewer.scene.postProcessStages.fxaa.enabled
        return { checks, taa: { valid: taa.valid, reason: taa.reason }, version: window.CCR.VERSION || null, errors: app.errors.slice() }
      }, handle)
      if (mode === 'umd') { assert.equal(sourceRequests.length, 0); assert.equal(lookupRequests.length, 0) }
      assert.ok(Object.values(result.checks).every(Boolean), JSON.stringify(result))
      assert.equal(result.errors.length, 0); assert.equal(errors.length, 0)
      await page.screenshot({ path: path.join(output, `ccr-${mode}-verified.png`) })
      results.push({ mode, ...result, sourceRequestCount: sourceRequests.length, lookupRequestCount: lookupRequests.length, pageErrors: errors })
      await page.close()
    }
    fs.writeFileSync(path.join(output, 'ccr-browser-review.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
