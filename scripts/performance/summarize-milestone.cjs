#!/usr/bin/env node
// Pure observations: GPU stages have independent sample sets and tracked bytes
// do not estimate actual device VRAM. Quantiles match PassCostLedger143.
const { percentile } = require('./measure-rendering-baseline.cjs')
const fs = require('node:fs')
const path = require('node:path')

const BOOTSTRAP_ITERATIONS = 1000
const BOOTSTRAP_SEED = 1947

function summarize(values) {
  const source = (Array.isArray(values) ? values : []).filter(Number.isFinite)
  const result = { n: source.length, p50: percentile(source, 0.5), p95: percentile(source, 0.95),
    p99: percentile(source, 0.99), mean: source.length ? source.reduce((sum, value) => sum + value, 0) / source.length : null,
    bootstrap95CI: { median: null, p95: null, iterations: 0, seed: BOOTSTRAP_SEED } }
  if (!source.length) return result
  // Same LCG as the ledger. Each replicate supplies both median and P95 so
  // uncertainty in the tail is not replaced by uncertainty in the median.
  let state = BOOTSTRAP_SEED
  const estimates = { median: [], p95: [] }
  for (let i = 0; i < BOOTSTRAP_ITERATIONS; i++) {
    const sample = []
    for (let j = 0; j < source.length; j++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0
      sample.push(source[Math.floor(state / 0x100000000 * source.length)])
    }
    sample.sort((a, b) => a - b)
    estimates.median.push(sample[Math.ceil(sample.length * 0.5) - 1])
    estimates.p95.push(sample[Math.ceil(sample.length * 0.95) - 1])
  }
  for (const [key, samples] of Object.entries(estimates)) {
    samples.sort((a, b) => a - b)
    result.bootstrap95CI[key] = [samples[Math.floor(samples.length * 0.025)], samples[Math.floor(samples.length * 0.975)]]
  }
  result.bootstrap95CI.iterations = BOOTSTRAP_ITERATIONS
  return result
}

function summarizeRun(run) {
  const measurement = run.measurement || {}
  const gpu = Array.isArray(measurement.gpu) ? measurement.gpu : []
  const gpuStatus = measurement.gpuStatus || {}
  const issuedByLabel = gpuStatus.issuedByLabel || {}
  const attemptsByLabel = gpuStatus.attemptsByLabel || {}
  const labels = [...new Set([...gpu.map(item => item.label).filter(Boolean), ...Object.keys(issuedByLabel), ...Object.keys(attemptsByLabel)])]
  const gpuByLabel = Object.fromEntries(labels.map(label => {
    const stats = summarize(gpu.filter(item => item.label === label).map(item => item.milliseconds))
    const issued = Number.isFinite(issuedByLabel[label]) ? issuedByLabel[label]
      : Number.isFinite(attemptsByLabel[label]) ? 0 : null
    return [label, { ...stats, queryAvailability: { valid: stats.n, issued,
      ratio: issued > 0 ? stats.n / issued : null } }]
  }))
  const raf = (measurement.rafMs || []).filter(Number.isFinite)
  const memory = run.memory || {}
  const logicalTracked = {}
  const assetEstimate = {}
  for (const key of ['graphPhysicalBytes', 'graphPeakBytes', 'poolCurrentBytes', 'poolPeakBytes', 'ccrTextureBytes']) {
    logicalTracked[key] = Number.isFinite(memory[key]) ? memory[key] : null
  }
  for (const [key, value] of Object.entries({ texturesCurrentBytes: memory.trackedTextures?.currentBytes,
    texturesPeakBytes: memory.trackedTextures?.peakBytes, poolCurrentBytes: memory.pool?.currentBytes ?? memory.poolCurrentBytes,
    poolPeakBytes: memory.pool?.peakBytes ?? memory.poolPeakBytes, poolWindowPeakBytes: memory.pool?.windowPeakBytes,
    uniformBufferCurrentBytes: memory.uniformBuffers?.currentBytes, uniformBufferPeakBytes: memory.uniformBuffers?.peakBytes })) {
    logicalTracked[key] = Number.isFinite(value) ? value : null
  }
  for (const key of ['tilesetReportedBytes', 'modelReportedBytes']) assetEstimate[key] = Number.isFinite(memory[key]) ? memory[key] : null
  assetEstimate.before = memory.assetsBefore || {}
  assetEstimate.after = memory.assetsAfter || {}
  const { measurement: _measurement, memory: _memory, ...metadata } = run
  return { ...metadata, caseId: run.caseId, repeat: run.repeat, validity: run.validity || {},
    ...Object.fromEntries(['cpuMs', 'rafMs', 'drawCalls', 'commands'].map(key => [key, summarize(measurement[key])])),
    rafStalls: [16.667, 33.333, 50, 100].map(thresholdMs => {
      const count = raf.filter(value => value > thresholdMs).length
      return { thresholdMs, count, ratio: raf.length ? count / raf.length : null }
    }), longTasks: measurement.longTasks || [], gpuByLabel, gpuStatus, counters: measurement.counters || {},
    memory: { ...memory, logicalTracked, assetEstimate, actualVramBytes: null,
      scope: 'Logical tracked allocations and asset-reported estimates; not actual device VRAM. Sources may overlap and must not be summed.' } }
}

function summarizeReport(report) {
  if (!Array.isArray(report.runs)) throw new Error('Input report must contain a runs array')
  const { runs, schemaVersion, ...metadata } = report
  return { ...metadata, schemaVersion: 'environment-milestone-summary-v1', sourceSchemaVersion: schemaVersion ?? report.schema,
    statistics: { quantile: 'nearest rank; matches PassCostLedger143',
      bootstrap: '1000 seeded IID frame resamples; conditional on each run, not independent repeat-level or autocorrelation-adjusted uncertainty',
      seed: BOOTSTRAP_SEED, confidence: 0.95, gpu: 'Independent sample sets by query label; no subtraction or summation of stage medians',
      memory: 'Logical allocations and asset estimates may overlap; no total VRAM inference' },
    runs: runs.map(summarizeRun) }
}

function renderMarkdown(report) {
  const cell = value => value === null || value === undefined ? 'N/A' : String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
  const number = value => Number.isFinite(value) ? value.toFixed(3) : 'N/A'
  const interval = value => value ? `[${number(value[0])}, ${number(value[1])}]` : 'N/A'
  const ratio = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A'
  const table = (headings, rows) => [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
  const lines = ['# Environment milestone measured statistics', '',
    'Timing unit: ms. Nearest-rank quantiles match PassCostLedger143. Each row is a separate run.', '',
    '95% bootstrap intervals use 1000 deterministic IID frame resamples. They describe within-run uncertainty and do not correct serial correlation or substitute for independent repeated runs.', '',
    'CPU submission duration and RAF interval measure different costs. GPU query labels have independent sample counts; stage medians must not be added or subtracted to infer missing timings.', '',
    table(['Case', 'Repeat', 'Metric', 'n', 'P50', 'P50 95% CI', 'P95', 'P95 95% CI', 'P99', 'Mean'], report.runs.flatMap(run =>
      ['cpuMs', 'rafMs'].map(key => {
        const stats = run[key]
        return [run.caseId, run.repeat, key, stats.n, number(stats.p50), interval(stats.bootstrap95CI.median),
          number(stats.p95), interval(stats.bootstrap95CI.p95), number(stats.p99), number(stats.mean)]
      }))), '',
    table(['Case', 'Repeat', 'RAF >16.667', 'RAF >33.333', 'RAF >50', 'RAF >100', 'Draw P50', 'Commands P50', 'Long tasks'], report.runs.map(run =>
      [run.caseId, run.repeat, ...run.rafStalls.map(item => `${item.count} (${ratio(item.ratio)})`),
        number(run.drawCalls.p50), number(run.commands.p50), run.longTasks.length])), '',
    table(['Case', 'Repeat', 'GPU label', 'Valid n', 'Issued', 'Attempts', 'Availability', 'P50', 'P50 95% CI', 'P95', 'P95 95% CI', 'P99', 'Mean'],
      report.runs.flatMap(run => Object.entries(run.gpuByLabel).map(([label, stats]) =>
        [run.caseId, run.repeat, label, stats.n, stats.queryAvailability.issued, run.gpuStatus.attemptsByLabel?.[label], ratio(stats.queryAvailability.ratio),
          number(stats.p50), interval(stats.bootstrap95CI.median), number(stats.p95), interval(stats.bootstrap95CI.p95), number(stats.p99), number(stats.mean)]))), '',
    'Memory unit: bytes. Logical tracked allocations and asset-reported estimates are separate, may overlap, and must not be summed. Actual device VRAM is unavailable without a device profiler.', '',
    'Tracked textures include pool/history/LUT resources. Pool and uniform-buffer metrics retain their own scopes; pool lifetime peak and measurement-window peak are different observations.', '',
    table(['Case', 'Repeat', 'Textures current', 'Textures peak', 'Pool current', 'Pool lifetime peak', 'Pool window peak', 'Uniform buffers current', 'Uniform buffers peak', 'Graph physical', 'JS heap peak', 'Actual VRAM'],
      report.runs.map(run => [run.caseId, run.repeat, ...['texturesCurrentBytes', 'texturesPeakBytes', 'poolCurrentBytes', 'poolPeakBytes', 'poolWindowPeakBytes',
        'uniformBufferCurrentBytes', 'uniformBufferPeakBytes', 'graphPhysicalBytes'].map(key => run.memory.logicalTracked[key]),
        run.memory.jsHeapPeakBytes, run.memory.actualVramBytes])), '',
    table(['Case', 'Repeat', 'Asset snapshot', 'Tileset bytes (engine estimate)', 'GLB geometry bytes (engine estimate)', 'GLB texture bytes (engine estimate)'],
      report.runs.flatMap(run => ['before', 'after'].map(phase => [run.caseId, run.repeat, phase === 'before' ? 'Assets before' : 'Assets after',
        ...['tilesetBytes', 'glbGeometryBytes', 'glbTextureBytes'].map(key => run.memory.assetEstimate[phase][key])]))), '',
    table(['Case', 'Repeat', 'Validity', 'GPU status'], report.runs.map(run =>
      [run.caseId, run.repeat, JSON.stringify(run.validity), JSON.stringify(run.gpuStatus)])), '']
  return lines.join('\n')
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    const equals = arg.indexOf('=')
    const key = equals < 0 ? arg : arg.slice(0, equals)
    if (!['--input', '--output', '--markdown'].includes(key)) throw new Error(`Unknown option: ${arg}`)
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1)
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options[key.slice(2)] = value
  }
  return options
}

function runCli() {
  const options = parseArgs()
  if (options.help) {
    console.log('Usage: node scripts/performance/summarize-milestone.cjs --input results.json [--output summary.json] [--markdown summary.md]')
    return
  }
  if (!options.input) throw new Error('Missing --input results.json')
  const input = path.resolve(options.input)
  const summary = summarizeReport(JSON.parse(fs.readFileSync(input, 'utf8')))
  const markdown = renderMarkdown(summary)
  const output = path.resolve(options.output || path.join(path.dirname(input), 'summary.json'))
  const markdownPath = path.resolve(options.markdown || path.join(path.dirname(input), 'summary.md'))
  if (output === input || markdownPath === input || output === markdownPath) throw new Error('Input, JSON output and Markdown output must have distinct paths')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(markdownPath, markdown)
  console.log(JSON.stringify({ input, output, markdown: markdownPath, runs: summary.runs.length }))
}

if (require.main === module) {
  try { runCli() } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
}
module.exports = { summarize, summarizeRun, summarizeReport, renderMarkdown, parseArgs }
