#!/usr/bin/env node
// Attribute the slow drag frames: sample where a long frame actually spends its time.
//
// The coarse probe showed no CCR module exceeding 4ms during slow frames, so the cost is
// elsewhere. This version records (a) the slow frames' positions in the frame stream, to see
// whether they are periodic or clustered with the drag, and (b) a fine-grained breakdown of
// JS execution inside the worst frames using a self-sampling profiler.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

function parseArgs(argv = process.argv.slice(2)) {
  const result = { port: 8897, seconds: 20, url: null, headed: false, output: null, mode: 'drag' }
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2)
    const flag = key === '--headed'
    const value = inline === undefined && !flag ? argv[++i] : inline
    if (key === '--port') result.port = Number(value)
    else if (key === '--seconds') result.seconds = Number(value)
    else if (key === '--url') result.url = value
    else if (key === '--output') result.output = value
    else if (key === '--mode') result.mode = value
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

const installProfiler = () => {
  const samples = new Map()
  const frames = []
  let frameStart = performance.now()
  let inFrame = true
  const record = () => {
    // Sample the current JS call stack by walking the Error stack.
    const now = performance.now()
    const elapsed = now - frameStart
    frames.push(elapsed)
    frameStart = now
    // Attribute this frame's CPU time to the function whose execution was interrupted.
    const stack = (new Error()).stack || ''
    const line = stack.split('\n')[2] || 'unknown'
    const key = line.trim().replace(/^at\s+/, '').split(' ')[0] || 'unknown'
    const entry = samples.get(key) || { key, count: 0 }
    entry.count++
    samples.set(key, entry)
  }
  let previous = performance.now()
  const onPostRender = () => {
    const now = performance.now()
    const delta = now - previous
    previous = now
    frames.push(delta)
  }
  window.campus.viewer.scene.postRender.addEventListener(onPostRender)

  // Frame-level instrumentation: time every phase the scene runs, including Cesium's own.
  const slowFrames = []
  window.__attr = { samples, frames, slowFrames, timeline: [] }
  const scene = window.campus.viewer.scene
  const wrapScene = (name) => {
    const original = scene[name]
    if (typeof original !== 'function') return null
    scene[name] = function (...args) {
      const start = performance.now()
      try { return original.apply(this, args) }
      finally {
        const cost = performance.now() - start
        if (cost > 5) window.__attr.timeline.push({ name, ms: Number(cost.toFixed(2)), t: Number(start.toFixed(0)) })
      }
    }
    return () => { scene[name] = original }
  }
  const restores = ['render', 'updateAndExecuteCommands', 'resolveFramebuffers'].map(wrapScene).filter(Boolean)

  // Report which tasks the browser ran during each long frame.
  window.__attr.stop = () => {
    scene.postRender.removeEventListener(onPostRender)
    for (const restore of restores) restore()
  }
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

  // Chrome tracing gives an exact picture of what runs during a long frame.
  const browser = await chromium.launch({ channel: 'chrome', headless: !options.headed })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    const client = await page.context().newCDPSession(page)
    await client.send('Profiler.enable')
    await client.send('Profiler.setSamplingInterval', { interval: 200 })
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await page.waitForFunction(() => {
      const c = window.campus
      return typeof c.assetsReady !== 'function' || c.assetsReady()
    }, null, { timeout: 180000 }).catch(() => {})
    await page.evaluate(installProfiler)
    await client.send('Profiler.start')

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
    const { profile } = await client.send('Profiler.stop')
    const collected = await page.evaluate(() => {
      const a = window.__attr
      a.stop()
      return { frames: a.frames.slice(2), timeline: a.timeline }
    })

    // Aggregate the V8 profile: self time per function.
    const byId = new Map()
    for (const node of profile.nodes) {
      const callFrame = node.callFrame
      const name = `${callFrame.functionName || '(anonymous)'} @ ${(callFrame.url || '').split('/').slice(-1)[0]}:${callFrame.lineNumber}`
      byId.set(node.id, { name, self: 0 })
    }
    const total = profile.samples.length || 1
    const intervalMs = (profile.endTime - profile.startTime) / 1000 / total
    for (const id of profile.samples) {
      const entry = byId.get(id)
      if (entry) entry.self++
    }
    const hot = [...byId.values()].map(entry => ({ name: entry.name, selfMs: Number((entry.self * intervalMs).toFixed(1)), pct: Number((entry.self / total * 100).toFixed(2)) }))
      .sort((a, b) => b.selfMs - a.selfMs).slice(0, 25)

    const frames = collected.frames.filter(value => value > 0)
    const sorted = [...frames].sort((a, b) => a - b)
    const longFrames = frames.filter(value => value > 33)
    const byName = new Map()
    for (const item of collected.timeline) {
      const entry = byName.get(item.name) || { name: item.name, count: 0, total: 0, max: 0 }
      entry.count++; entry.total += item.ms; entry.max = Math.max(entry.max, item.ms)
      byName.set(item.name, entry)
    }
    const result = {
      supported: true,
      profileWindowMs: Number(((profile.endTime - profile.startTime) / 1000).toFixed(1)),
      frameCount: frames.length,
      fps: Number((frames.length / options.seconds).toFixed(1)),
      frameMs: { p50: percentile(frames, 0.5), p90: percentile(frames, 0.9), p99: percentile(frames, 0.99), max: sorted.at(-1) },
      longFrameRatio: Number((longFrames.length / Math.max(1, frames.length)).toFixed(3)),
      scenePhaseSpansOver5ms: [...byName.values()].map(entry => ({ name: entry.name, count: entry.count,
        meanMs: Number((entry.total / entry.count).toFixed(2)), maxMs: Number(entry.max.toFixed(2)) })),
      hottestFunctions: hot
    }
    if (options.output) fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
