#!/usr/bin/env node
// Capture the environment pass as images so the composite can be inspected rather than guessed.
//
// readPixels on the default framebuffer returns nothing useful under Cesium's HDR chain, so this
// writes real PNGs: the full frame, and the same frame with clouds disabled and with the whole
// environment disabled. Comparing the three shows which layer produced the visible artefact.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: error.message }))
    return
  }
  const port = 8941
  const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'rendering-performance')
  fs.mkdirSync(outDir, { recursive: true })
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', error => console.error('page error:', error.message))
    // The manifest's baseUrl points at an external asset host. The dev server exposes the same
    // GLBs under /campus-mobile-glb/, so point the example at it; without this every model 404s
    // and the frame is just background, which makes any environment screenshot meaningless.
    const query = 'traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none'
      + '&singleFrustum=1&assets=/assets/campus-assets&glbAssets=' + encodeURIComponent(`http://127.0.0.1:${port}/campus-mobile-glb`)
    await page.goto(`http://127.0.0.1:${port}/examples/campus.html?${query}&cb=${Date.now()}`,
      { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await page.evaluate(() => window.campus.viewer.scene.renderError.addEventListener((_scene, error) => {
      window.__renderError = String(error.stack || error)
    }))
    await page.waitForTimeout(3000)
    console.log('startup:', JSON.stringify(await page.evaluate(() => ({
      models: campus.models.length, errors: campus.errors.map(e => String(e.stack || e)),
      renderError: window.__renderError, hdr: campus.pipeline.environmentRenderer?.hdr.getDiagnostics()
    }))))
    await page.waitForFunction(() => {
        const campus = window.campus
        return campus.expectedModels > 0 && campus.models?.length === campus.expectedModels
          && campus.assetsReady()
      }, null, { timeout: 90000 })
    const status = await page.evaluate(() => ({
      models: window.campus?.models?.length ?? null,
      expected: window.campus?.expectedModels ?? null,
      errors: (window.campus?.errors || []).map(error => String(error)).slice(0, 2)
    }))
    console.log('models ready:', JSON.stringify(status))
    await new Promise(resolve => setTimeout(resolve, 4000))
    await page.evaluate(() => {
      const viewer = campus.viewer, carto = viewer.camera.positionCartographic
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 300),
        orientation: { heading: 0, pitch: 0, roll: 0 } })
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelector('.lil-gui')?.style.setProperty('display', 'none')
    })
    await page.waitForTimeout(1500)
    const shots = [
      ['env-current', {}],
      ['env-clouds-off', { clouds: false, volumetricFog: false }],
      ['env-off', { environment: false }]
    ]
    for (const [name, patch] of shots) {
      if (Object.keys(patch).length) {
        await page.evaluate(async ({ patch }) => {
          window.campus.pipeline.setOptions(patch)
          await new Promise(resolve => setTimeout(resolve, 2500))
        }, { patch })
      }
      const file = path.join(outDir, `diag-${name}.png`)
      await page.screenshot({ path: file })
      console.log(`wrote ${path.relative(process.cwd(), file)}`)
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
