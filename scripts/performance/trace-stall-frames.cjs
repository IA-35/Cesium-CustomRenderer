#!/usr/bin/env node
// Use Chrome tracing to attribute the slow drag frames.
//
// A V8 sampling profile at 200us could not resolve the stalls: 84% of samples were idle, i.e.
// the main thread was waiting, not computing. Tracing records the actual task/event durations,
// which is what is needed to see whether a frame is long because of script, raster, layout or
// a GPU sync.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

function parseArgs(argv = process.argv.slice(2)) {
  const result = { port: 8898, seconds: 16, url: null, headed: false, output: null, trace: null }
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2)
    const flag = key === '--headed'
    const value = inline === undefined && !flag ? argv[++i] : inline
    if (key === '--port') result.port = Number(value)
    else if (key === '--seconds') result.seconds = Number(value)
    else if (key === '--url') result.url = value
    else if (key === '--output') result.output = value
    else if (key === '--trace') result.trace = value
    else if (key === '--headed') result.headed = true
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
  const target = options.url || `${origin}/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1`
  const browser = await chromium.launch({ channel: 'chrome', headless: !options.headed })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await page.waitForFunction(() => {
      const c = window.campus
      return typeof c.assetsReady !== 'function' || c.assetsReady()
    }, null, { timeout: 180000 }).catch(() => {})
    await page.evaluate(() => {
      const frames = []
      let previous = performance.now()
      window.__frames = frames
      const listener = () => { const now = performance.now(); frames.push(now - previous); previous = now }
      window.campus.viewer.scene.postRender.addEventListener(listener)
      window.__stopFrames = () => window.campus.viewer.scene.postRender.removeEventListener(listener)
    })

    const client = await page.context().newCDPSession(page)
    const events = []
    client.on('Tracing.dataCollected', payload => { for (const event of payload.value || []) events.push(event) })
    await client.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing,gpu,disabled-by-default-devtools.timeline',
      transferMode: 'ReportEvents' })

    const deadline = Date.now() + options.seconds * 1000
    const cx = 960, cy = 540
    let direction = 1
    while (Date.now() < deadline) {
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      for (let step = 0; step < 30; step++) {
        await page.mouse.move(cx + direction * step * 12, cy + Math.sin(step / 4) * 20, { steps: 2 })
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      direction *= -1
      await page.waitForTimeout(120)
    }
    const stopped = new Promise(resolve => client.once('Tracing.tracingComplete', resolve))
    await client.send('Tracing.end')
    await stopped
    const frames = await page.evaluate(() => { window.__stopFrames(); return window.__frames.slice(2) })
    if (options.trace) fs.writeFileSync(options.trace, JSON.stringify(events))

    // Aggregate the nested timeline events by name: total and max duration.
    const byName = new Map()
    for (const event of events) {
      if (!Number.isFinite(event.dur)) continue
      const entry = byName.get(event.name) || { name: event.name, count: 0, total: 0, max: 0, long: 0 }
      entry.count++
      entry.total += event.dur / 1000
      const ms = event.dur / 1000
      if (ms > entry.max) entry.max = ms
      if (ms > 5) entry.long++
      byName.set(event.name, entry)
    }
    const valid = frames.filter(value => value > 0)
    const sorted = [...valid].sort((a, b) => a - b)
    const longFrames = valid.filter(value => value > 33)
    const result = {
      supported: true,
      traceEventCount: events.length,
      frameCount: valid.length,
      fps: Number((valid.length / options.seconds).toFixed(1)),
      frameMs: { p50: percentile(valid, 0.5), p90: percentile(valid, 0.9), p99: percentile(valid, 0.99), max: sorted.at(-1) },
      longFrameRatio: Number((longFrames.length / Math.max(1, valid.length)).toFixed(3)),
      // Anything that ever exceeded 5ms is a stall candidate; sorted by worst single occurrence.
      stallCandidates: [...byName.values()].filter(entry => entry.long > 0)
        .sort((a, b) => b.max - a.max).slice(0, 25)
        .map(entry => ({ name: entry.name, count: entry.count, over5ms: entry.long,
          totalMs: Number(entry.total.toFixed(1)), meanMs: Number((entry.total / entry.count).toFixed(3)), maxMs: Number(entry.max.toFixed(2)) })),
      topByTotal: [...byName.values()].sort((a, b) => b.total - a.total).slice(0, 20)
        .map(entry => ({ name: entry.name, count: entry.count, totalMs: Number(entry.total.toFixed(1)), maxMs: Number(entry.max.toFixed(2)) }))
    }
    if (options.output) fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
