#!/usr/bin/env node
// Measure the rewritten environment pass against the tier settings.
//
// Uses real mouse drags, because a camera set programmatically every frame does not reproduce
// the tile selection a drag produces and produced misleading stall profiles earlier. Reports
// p90/p99 and the long-frame ratio: with an average frame near 60 FPS the mean hides the stalls,
// which is exactly how this work started.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

function parseArgs(argv = process.argv.slice(2)) {
  const result = { port: 8921, seconds: 12, tiers: 'performance,balanced,high', output: null, url: null }
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2)
    const value = inline === undefined ? argv[++i] : inline
    if (key === '--port') result.port = Number(value)
    else if (key === '--seconds') result.seconds = Number(value)
    else if (key === '--tiers') result.tiers = value
    else if (key === '--output') result.output = value
    else if (key === '--url') result.url = value
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  return result
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]
}

async function main() {
  const options = parseArgs()
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: `browser unavailable: ${error.message}` }))
    return
  }
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(options.port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const origin = `http://127.0.0.1:${options.port}`
  const base = options.url || `${origin}/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1`
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  const results = []
  try {
    for (const tier of options.tiers.split(',')) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
      const errors = []
      page.on('pageerror', error => errors.push(error.message.slice(0, 160)))
      await page.goto(`${base}&cb=${Date.now()}`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
      await page.waitForFunction(() => {
        const campus = window.campus
        return typeof campus.assetsReady !== 'function' || campus.assetsReady()
      }, null, { timeout: 180000 }).catch(() => {})
      const applied = await page.evaluate(async ({ tier }) => {
        const pipeline = window.campus.pipeline
        pipeline.setOptions({ environmentQuality: tier })
        await new Promise(resolve => setTimeout(resolve, 3000))
        const frames = []
        let previous = performance.now()
        const listener = () => { const now = performance.now(); frames.push(now - previous); previous = now }
        window.campus.viewer.scene.postRender.addEventListener(listener)
        window.__frames = frames
        window.__stop = () => window.campus.viewer.scene.postRender.removeEventListener(listener)
        const shader = pipeline.environmentRenderer?.stages?.raymarchStage?.fragmentShader || ''
        return {
          tier: pipeline.getOptions().environmentQuality,
          cloudSteps: (shader.match(/#define CLOUD_STEPS (\d+)/) || [])[1] || null,
          cloudLightSteps: (shader.match(/#define CLOUD_LIGHT_STEPS (\d+)/) || [])[1] || null,
          grown: shader.includes('CLOUD_STEP_GROWTH')
        }
      }, { tier })
      // A real drag, in both directions, repeated for the sampling window.
      const deadline = Date.now() + options.seconds * 1000
      const cx = 960, cy = 540
      let direction = 1
      while (Date.now() < deadline) {
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        for (let step = 0; step < 28 && Date.now() < deadline; step++) {
          await page.mouse.move(cx + direction * step * 13, cy + Math.sin(step / 4) * 20, { steps: 2 })
          await page.waitForTimeout(16)
        }
        await page.mouse.up()
        direction *= -1
        await page.waitForTimeout(100)
      }
      const frames = await page.evaluate(() => { window.__stop(); return window.__frames.slice(2) })
      const valid = frames.filter(value => value > 0)
      const long = valid.filter(value => value > 33).length
      const entry = {
        ...applied,
        frames: valid.length,
        p50: percentile(valid, 0.5),
        p90: percentile(valid, 0.9),
        p99: percentile(valid, 0.99),
        max: valid.reduce((max, value) => Math.max(max, value), 0),
        longFrameRatio: Number((long / Math.max(1, valid.length)).toFixed(3)),
        errors
      }
      results.push(entry)
      console.log(`${entry.tier.padEnd(12)} cloud=${entry.cloudSteps}x${entry.cloudLightSteps} grown=${entry.grown}`
        + ` p50=${entry.p50?.toFixed(1)} p90=${entry.p90?.toFixed(1)} p99=${entry.p99?.toFixed(1)}`
        + ` max=${entry.max.toFixed(0)} long=${(entry.longFrameRatio * 100).toFixed(1)}%`)
      await page.close()
    }
    if (options.output) fs.writeFileSync(options.output, JSON.stringify({ results, generatedAt: new Date().toISOString() }, null, 2) + '\n')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
