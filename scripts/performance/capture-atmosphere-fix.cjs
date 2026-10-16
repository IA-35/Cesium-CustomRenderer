#!/usr/bin/env node
// Capture the environment result after the atmosphere fixes, at each quality tier.
//
// The campus model set normally comes from an external asset host; when that host is unavailable
// the terrain tileset still loads locally, which is enough to judge the sky and the clouds. The
// script reports whether models loaded so a blank frame is not mistaken for a render failure.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: error.message }))
    return
  }
  const port = 8951
  const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'rendering-performance')
  fs.mkdirSync(outDir, { recursive: true })
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message.slice(0, 160)))
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('ERR_CONNECTION_REFUSED')) {
        errors.push('console: ' + message.text().slice(0, 160))
      }
    })
    const query = 'traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1'
    await page.goto(`http://127.0.0.1:${port}/examples/campus.html?${query}&cb=${Date.now()}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    // Give the terrain tileset time to load; the model host may be unavailable, which is fine.
    await new Promise(resolve => setTimeout(resolve, 15000))
    const state = await page.evaluate(() => ({
      terrainTiles: window.campus?.tiles?.length ?? null,
      models: window.campus?.models?.length ?? null,
      cameraHeight: window.campus?.viewer?.camera?.positionCartographic?.height ?? null,
      envEnabled: window.campus?.pipeline?.getOptions?.().environment ?? null
    }))
    console.log('scene:', JSON.stringify(state))
    for (const tier of ['performance', 'balanced', 'high']) {
      await page.evaluate(async ({ tier }) => {
        window.campus.pipeline.setOptions({ environmentQuality: tier, environment: true, clouds: true })
        await new Promise(resolve => setTimeout(resolve, 2500))
      }, { tier })
      const file = path.join(outDir, `atmos-fixed-${tier}.png`)
      await page.screenshot({ path: file })
      console.log(`wrote ${path.relative(process.cwd(), file)}`)
    }
    if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 4)))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
