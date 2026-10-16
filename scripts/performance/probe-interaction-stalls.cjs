#!/usr/bin/env node
// Interaction stall probe using REAL mouse drags.
//
// The earlier version of this probe drove the camera with camera.setView() every frame, which
// rebuilds the frustum and re-selects terrain tiles. That is not what a drag does and it
// produced a misleading stall profile. This version reproduces the actual interaction:
// pointer down, a sequence of pointer moves, pointer up, repeating a few times.
//
// It records per-frame wall time and, for the worst frames, captures the Cesium/CCR work that
// ran during them so the cost can be attributed instead of guessed.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

function parseArgs(argv = process.argv.slice(2)) {
  const result = { port: 8896, seconds: 20, url: null, headed: false, output: null }
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2)
    const flag = key === '--headed'
    const value = inline === undefined && !flag ? argv[++i] : inline
    if (key === '--port') result.port = Number(value)
    else if (key === '--seconds') result.seconds = Number(value)
    else if (key === '--url') result.url = value
    else if (key === '--output') result.output = value
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

const pageProbe = () => {
  const frames = []
  const slowSpans = []
  window.__stallProbe = { frames, slowSpans, active: true, marks: [] }
  let previous = performance.now()
  const onPostRender = () => {
    const now = performance.now()
    frames.push(now - previous)
    previous = now
  }
  window.campus.viewer.scene.postRender.addEventListener(onPostRender)
  window.__stallProbe.stop = () => window.campus.viewer.scene.postRender.removeEventListener(onPostRender)

  // Sample where a single slow frame spends its time by timing the named CCR entry points.
  const targets = []
  const pipeline = window.campus.pipeline
  const wrap = (label, object, method) => {
    if (!object || typeof object[method] !== 'function') return
    const original = object[method]
    object[method] = function (...args) {
      const start = performance.now()
      try { return original.apply(this, args) }
      finally {
        const cost = performance.now() - start
        if (cost > 4) slowSpans.push({ label, ms: Number(cost.toFixed(2)), t: Number(start.toFixed(1)) })
      }
    }
    targets.push([object, method, original])
  }
  wrap('environment.hdr._execute', pipeline.environmentRenderer?.hdr, '_execute')
  wrap('environment.update', pipeline.environmentRenderer, 'update')
  wrap('shadow.render', pipeline.customShadow, 'render')
  wrap('materials._render', pipeline.materialChannels, '_render')
  wrap('deferred.geometry', pipeline.deferredLighting?.materials, 'prepare')
  wrap('deferred.lighting.render', pipeline.deferredLighting, 'render')
  wrap('transparent.render', pipeline.transparentForward, 'endFrame')
  wrap('occlusion.query', pipeline.occlusionCulling, 'query')
  wrap('scene.render', window.campus.viewer.scene, 'render')
  window.__stallProbe.restore = () => { for (const [object, method, original] of targets) object[method] = original }
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
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await page.waitForFunction(() => {
      const c = window.campus
      return typeof c.assetsReady !== 'function' || c.assetsReady()
    }, null, { timeout: 180000 }).catch(() => {})
    await page.evaluate(pageProbe)

    // Real drag: press, move in small steps, release, repeat. This is what the user does.
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
    const report = await page.evaluate(() => {
      const probe = window.__stallProbe
      probe.stop(); probe.restore()
      return { frames: probe.frames.slice(2), slowSpans: probe.slowSpans }
    })
    const frames = report.frames.filter(value => value > 0)
    const sorted = [...frames].sort((a, b) => a - b)
    const longFrames = frames.filter(value => value > 33)
    // Group the spans that occurred inside slow frames by label.
    const byLabel = new Map()
    for (const span of report.slowSpans) {
      const entry = byLabel.get(span.label) || { label: span.label, count: 0, total: 0, max: 0 }
      entry.count++; entry.total += span.ms; entry.max = Math.max(entry.max, span.ms)
      byLabel.set(span.label, entry)
    }
    const result = {
      supported: true,
      seconds: options.seconds,
      frameCount: frames.length,
      fps: Number((frames.length / options.seconds).toFixed(1)),
      frameMs: { p50: percentile(frames, 0.5), p90: percentile(frames, 0.9), p95: percentile(frames, 0.95),
        p99: percentile(frames, 0.99), min: sorted[0], max: sorted.at(-1) },
      longFrameCount: longFrames.length,
      longFrameRatio: Number((longFrames.length / Math.max(1, frames.length)).toFixed(3)),
      worstFrames: [...longFrames].sort((a, b) => b - a).slice(0, 12).map(value => Number(value.toFixed(1))),
      slowSpans: [...byLabel.values()].sort((a, b) => b.total - a.total).map(entry => ({
        label: entry.label, count: entry.count, meanMs: Number((entry.total / entry.count).toFixed(2)), maxMs: Number(entry.max.toFixed(2)),
      })),
      pageErrors
    }
    if (options.output) fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
