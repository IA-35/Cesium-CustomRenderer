#!/usr/bin/env node
// Verify the rewritten environment stages actually load and render in a real browser.
//
// Node tests can confirm shader strings but not that the pipeline binds the uniforms or that the
// driver accepts the program at runtime, so this checks the live diagnostics. It disables the HTTP
// cache and appends a cache-busting query so an earlier module copy cannot mask the result.
const path = require('node:path')
const { spawn } = require('node:child_process')

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: `browser unavailable: ${error.message}` }))
    return
  }
  const port = 8911
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text().slice(0, 200)) })
    const query = `?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1&cb=${Date.now()}`
    await page.goto(`http://127.0.0.1:${port}/examples/campus.html${query}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await new Promise(resolve => setTimeout(resolve, 15000))
    const result = await page.evaluate(() => {
      const pipeline = window.campus.pipeline
      const renderer = pipeline.environmentRenderer
      const diagnostics = renderer?.getDiagnostics?.() || {}
      const occlusion = renderer?.getMediumOcclusionDiagnostics?.() || {}
      const shader = renderer?.stages?.raymarchStage?.fragmentShader || ''
      const stageLabels = ['raymarchStage', 'resolveStage', 'occlusionStage']
        .filter(name => renderer?.stages?.[name])
        .map(name => {
          const stage = renderer.stages[name]
          return { name, ready: !!stage.ready, destroyed: !!(stage.isDestroyed && stage.isDestroyed()) }
        })
      return {
        enabled: diagnostics.enabled,
        quality: diagnostics.quality,
        hdrValid: diagnostics.hdr?.valid,
        hdrReason: diagnostics.hdr?.reason,
        occlusionValid: occlusion.valid,
        occlusionReason: occlusion.reason,
        hasAtmosphereFunction: shader.includes('ccrAtmosphere('),
        hasCloudFunction: shader.includes('ccrClouds('),
        atmosphereSteps: (shader.match(/#define ATMOS_OUTER_STEPS (\d+)/) || [])[1] || null,
        atmosphereLightSteps: (shader.match(/#define ATMOS_LIGHT_STEPS (\d+)/) || [])[1] || null,
        cloudSteps: (shader.match(/#define CLOUD_STEPS (\d+)/) || [])[1] || null,
        cloudLightSteps: (shader.match(/#define CLOUD_LIGHT_STEPS (\d+)/) || [])[1] || null,
        usesAtmosphereIntersect: shader.includes('ccrAtmosphereIntersect('),
        stageLabels
      }
    })
    result.pageErrors = errors.slice(0, 6)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
