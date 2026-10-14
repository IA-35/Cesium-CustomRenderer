#!/usr/bin/env node
// Phase 0 baseline runner. It records browser observations and delegates the
// report shape/statistics to PassCostLedger143 in the page; no GPU or VRAM value
// is fabricated when the timer query or a memory source is unavailable.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

function parseArgs(argv = process.argv.slice(2)) {
  const result = { case: 'enhanced-current', warmup: 30, sample: 300, repeat: 3,
    port: Number(process.env.CCR_BASELINE_PORT || 8878), output: null, url: null,
    headless: true, noServer: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [key, inline] = arg.split('=', 2)
    const flag = key === '--headed' || key === '--no-server' || key === '--help' || key === '-h'
    const value = inline === undefined && !flag ? argv[++i] : inline
    if (key === '--case') result.case = value
    else if (key === '--warmup') result.warmup = Math.max(0, Number(value))
    else if (key === '--sample' || key === '--samples') result.sample = Math.max(1, Number(value))
    else if (key === '--repeat' || key === '--repeats') result.repeat = Math.max(1, Number(value))
    else if (key === '--port') result.port = Number(value)
    else if (key === '--output') result.output = value
    else if (key === '--url') result.url = value
    else if (key === '--headed') result.headless = false
    else if (key === '--no-server') result.noServer = true
    else if (key === '--help' || key === '-h') result.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['native', 'enhanced-current', 'deferred-current', 'deferred-transparent-current'].includes(result.case)) {
    throw new Error(`Unsupported case: ${result.case}`)
  }
  for (const name of ['warmup', 'sample', 'repeat', 'port']) if (!Number.isFinite(result[name])) throw new Error(`Invalid ${name}`)
  return result
}

function usage() {
  return 'Usage: node scripts/performance/measure-rendering-baseline.cjs [--case native|enhanced-current|deferred-current|deferred-transparent-current] [--warmup 30] [--sample 300] [--repeat 3] [--output file.json] [--port 8878] [--url http://...] [--headed] [--no-server]'
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : null
}

function summarizeRuns(runs) {
  const cpu = runs.map(run => run.frame?.cpuMs?.p95).filter(Number.isFinite)
  const gpu = runs.map(run => run.frame?.gpuMs?.p50).filter(Number.isFinite)
  return { repeat: runs.length,
    cpuP95: { p50: percentile(cpu, 0.5), p95: percentile(cpu, 0.95) },
    gpuP50: { p50: percentile(gpu, 0.5), p95: percentile(gpu, 0.95) },
    validFrames: runs.reduce((sum, run) => sum + (run.validity?.validFrames || 0), 0),
    invalidFrames: runs.reduce((sum, run) => sum + (run.validity?.invalidFrames || 0), 0),
    gpuSupported: runs.every(run => run.validity?.gpuSupported === true) }
}

function recordPerformanceSample(ledger, sample = {}) {
  return ledger.recordFrame(sample)
}

const STATE_FIELDS = ['drawHookInstallations', 'drawHookInvocations', 'programBinds', 'materialBinds', 'uniformUploads', 'textureBinds']

function counterDelta(current = {}, previous = {}) {
  const delta = {}
  for (const field of STATE_FIELDS) {
    const value = Number(current[field])
    if (!Number.isFinite(value)) continue
    const before = Number(previous[field])
    delta[field] = Number.isFinite(before) && value >= before ? value - before : value
  }
  return delta
}

function gpuFrameSamples(samples = []) {
  return (Array.isArray(samples) ? samples : [])
    .filter(sample => sample?.label === 'frame' && Number.isFinite(sample.milliseconds))
    .map(sample => sample.milliseconds)
}

function unavailableReport(options, reason) {
  const run = { schemaVersion: 'phase0-v3', scene: { name: null, viewport: null, dpr: null,
      renderer: null, cesiumVersion: null, assetHash: null, cameraTrack: null, clock: null },
    mode: { native: options.case === 'native', enhanced: options.case === 'enhanced-current',
      deferred: options.case === 'deferred-current', deferredTransparent: options.case === 'deferred-transparent-current',
      taa: false, ao: false, bloom: false },
    validity: { warmupFrames: 0, sampledFrames: 0, validFrames: 0, invalidFrames: 0,
      gpuSupported: false, gpuReason: reason, disjointCount: 0, discarded: 0, focusLoss: 0,
      configChanges: 0, assetChanges: 0, readinessChanges: 0, invalidReasons: {}, pageErrors: [reason] },
    frame: { cpuMs: { supported: true, reason: null, samples: 0, p50: null, p95: null, mean: null, cv: null, bootstrapCI: null },
      gpuMs: { supported: false, reason, samples: 0, p50: null, p95: null, mean: null, cv: null, bootstrapCI: null },
      drawCalls: null, submittedCommands: null, triangles: null }, passes: [],
    state: { drawHookInstallations: 0, drawHookInvocations: 0, programBinds: 0, materialBinds: 0, uniformUploads: 0, textureBinds: 0 },
    memory: { graphPhysicalBytes: null, graphPeakBytes: null, poolCurrentBytes: null, poolPeakBytes: null,
      ccrTextureBytes: null, tilesetReportedBytes: null, jsHeapBytes: null,
      scope: 'tracked allocations; true board VRAM requires vendor profiler',
      graphScope: 'render-graph transient physical allocations when an allocator exposes byte diagnostics; null means unavailable',
      poolScope: 'CCR render-target pool allocations reported by the pool; excludes driver and board overhead' } }
  const report = { schemaVersion: 'phase0-v3-baseline', case: options.case,
    options: { warmupFrames: options.warmup, sampledFrames: options.sample, repeat: options.repeat },
    runs: Array.from({ length: options.repeat }, () => run), summary: summarizeRuns(Array.from({ length: options.repeat }, () => run)),
    generatedAt: new Date().toISOString() }
  if (options.output) { const output = path.resolve(options.output); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)) }
  console.log(JSON.stringify(report))
  return report
}

async function ensureServer(port) {
  const origin = `http://127.0.0.1:${port}`
  try { await fetch(`${origin}/examples/campus.html`, { signal: AbortSignal.timeout(1000) }); return null } catch {}
  const child = spawn(process.execPath, [path.resolve(__dirname, '../baseline-server.cjs'), '--port', String(port)], {
    cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.stdout?.removeAllListeners(); resolve() }, 1500)
    child.once('error', reject)
    child.stdout?.on('data', chunk => { if (/http:\/\//.test(String(chunk))) { clearTimeout(timer); resolve() } })
  })
  return child
}

async function run() {
  const options = parseArgs()
  if (options.help) { console.log(usage()); return }
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    return unavailableReport(options, `browser unavailable: ${error.message}`)
  }
  const server = options.noServer ? null : await ensureServer(options.port)
  const origin = `http://127.0.0.1:${options.port}`
  const target = options.url || `${origin}/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1`
  const browser = await chromium.launch({ channel: 'chrome', headless: options.headless })
  const runs = []
  try {
    for (let repeat = 0; repeat < options.repeat; repeat++) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
      const pageErrors = []
      page.on('pageerror', error => pageErrors.push(error.message))
      await page.goto(target, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
      const result = await page.evaluate(async ({ options, repeat }) => {
        const { default: PassCostLedger143 } = await import('/src/diagnostics/PassCostLedger143.js')
        const campus = window.campus
        const scene = campus.viewer.scene
        const pipeline = campus.pipeline
        if (typeof campus.assetsReady === 'function') {
          const deadline = performance.now() + 120000
          while (!campus.assetsReady() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (options.case === 'native' && pipeline?.setEnabled) pipeline.setEnabled(false)
        else if (pipeline?.setEnabled) pipeline.setEnabled(true)
        const gpuExtension = scene.context?._gl?.getExtension?.('EXT_disjoint_timer_query_webgl2')
        const gpuSupported = !!gpuExtension
        const ledger = new PassCostLedger143({
          scene: { name: 'campus', viewport: { width: scene.drawingBufferWidth, height: scene.drawingBufferHeight },
            dpr: devicePixelRatio, renderer: scene.context?._gl?.getParameter?.(scene.context._gl.RENDERER),
            cesiumVersion: Cesium.VERSION, cameraTrack: 'fixed', clock: Cesium.JulianDate.toIso8601(campus.viewer.clock.currentTime) },
          mode: { native: options.case === 'native', enhanced: options.case === 'enhanced-current',
            deferred: options.case === 'deferred-current', deferredTransparent: options.case === 'deferred-transparent-current',
            taa: pipeline?.getOptions?.()?.antialiasing === 'taa', ao: !!pipeline?.getOptions?.()?.screenSpaceAoEnabled,
            bloom: !!pipeline?.getOptions?.()?.bloomEnabled }, warmupFrames: options.warmup, gpuSupported
        })
        let profiler
        const recordSample = sample => ledger.recordFrame(sample)
        const gpuFrameSamples = samples => (Array.isArray(samples) ? samples : [])
          .filter(sample => sample?.label === 'frame' && Number.isFinite(sample.milliseconds))
          .map(sample => sample.milliseconds)
        const deltaCounters = (current = {}, previous = {}) => {
          const delta = {}
          for (const field of ['drawHookInstallations', 'drawHookInvocations', 'programBinds', 'materialBinds', 'uniformUploads', 'textureBinds']) {
            const value = Number(current[field])
            if (!Number.isFinite(value)) continue
            const before = Number(previous[field])
            delta[field] = Number.isFinite(before) && value >= before ? value - before : value
          }
          return delta
        }
        let previousState = {}
        const frames = count => new Promise(resolve => {
          let left = count
          if (!left) return resolve()
          const off = scene.postRender.addEventListener(() => { if (--left === 0) { off(); resolve() } })
        })
        await frames(options.warmup)
        // The wait above happens outside the ledger listener; account for those
        // frames explicitly so sampled frames are not discarded as warmup again.
        for (let index = 0; index < options.warmup; index++) ledger.recordFrame({ warmup: true })
        if (pipeline) {
          const { default: RenderProfiler143 } = await import('/src/diagnostics/RenderProfiler143.js')
          profiler = new RenderProfiler143(Cesium, pipeline)
        }
        await new Promise(resolve => {
          let left = options.sample
          const off = scene.postRender.addEventListener(() => {
            const latest = profiler?.frames?.at(-1)
            const diagnostics = pipeline.drawDispatcher?.getDiagnostics?.() || {}
            const state = deltaCounters(diagnostics, previousState)
            previousState = diagnostics
            const pool = pipeline.getResourcePoolDiagnostics?.() || {}
            recordSample({ cpuMs: latest?.milliseconds ?? null, gpuSupported, valid: !document.hidden && document.hasFocus(),
              invalidReason: document.hidden ? 'focusLoss' : undefined, focusLoss: document.hidden || !document.hasFocus(),
              drawCalls: latest?.drawCalls ?? null,
              submittedCommands: latest?.submittedCommands ?? scene.frameState.commandList?.length ?? null,
              triangles: null,
              state,
              memory: { poolCurrentBytes: pool.currentBytes ?? null, poolPeakBytes: pool.peakBytes ?? null } })
            if (--left === 0) { off(); resolve() }
          })
        })
        if (profiler) {
          // EXT_disjoint_timer_query results are asynchronous. Give the browser
          // a few render turns to publish the last sampled queries before reading
          // the report; otherwise gpuSupported=true can still produce zero GPU samples.
          await frames(Math.min(8, Math.max(2, options.sample)))
          const profilerReport = profiler.getReport()
          if (gpuSupported) ledger.recordGpuSamples(gpuFrameSamples(profilerReport.gpu))
          for (const sample of profilerReport.cpu || []) {
            if (sample.label !== 'frame') ledger.recordPass({ name: sample.label, cpuMs: sample.milliseconds })
          }
          for (const sample of profilerReport.gpu || []) {
            if (sample.label !== 'frame') ledger.recordPass({ name: sample.label, gpuMs: sample.milliseconds })
          }
          const pool = pipeline.getResourcePoolDiagnostics?.() || {}
          const graph = pipeline.renderGraph?.transientAllocator?.getDiagnostics?.() || {}
          const graphEntries = (pool.entries || []).filter(entry => String(entry.kind || '').startsWith('rhi.graph'))
          const graphBytes = Number.isFinite(graph.currentBytes) ? graph.currentBytes
            : graphEntries.length ? graphEntries.filter(entry => entry.live).reduce((sum, entry) => sum + (entry.bytes || 0), 0) : null
          const graphPeakBytes = Number.isFinite(graph.peakBytes) ? graph.peakBytes
            : graphEntries.length ? graphEntries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) : null
          ledger.recordMemory({ ccrTextureBytes: profilerReport.textures?.currentBytes ?? null,
            graphPhysicalBytes: graphBytes,
            graphPeakBytes,
            poolCurrentBytes: pool.currentBytes ?? null, poolPeakBytes: pool.peakBytes ?? null })
          profiler.destroy()
        }
        const report = ledger.getReport()
        report.validity.pageErrors = []
        report.repeat = repeat + 1
        return report
      }, { options, repeat })
      result.validity.pageErrors = pageErrors
      runs.push(result)
      await page.close()
    }
  } finally {
    await browser.close()
    if (server) server.kill()
  }
  const report = { schemaVersion: 'phase0-v3-baseline', case: options.case,
    options: { warmupFrames: options.warmup, sampledFrames: options.sample, repeat: options.repeat },
    runs, summary: summarizeRuns(runs), generatedAt: new Date().toISOString() }
  const output = options.output && path.resolve(options.output)
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)) }
  console.log(JSON.stringify(report))
}

if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
module.exports = { parseArgs, percentile, summarizeRuns, recordPerformanceSample, counterDelta, gpuFrameSamples, usage }
