import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { summarize, summarizeRun, summarizeReport, renderMarkdown, parseArgs } = require('../../scripts/performance/summarize-milestone.cjs')

test('missing and nonnumeric measurements remain unavailable rather than zero', () => {
  for (const values of [undefined, null, [], [null, undefined, NaN, Infinity, '4']]) {
    const result = summarize(values)
    assert.equal(result.n, 0)
    assert.equal(result.p50, null)
    assert.equal(result.p95, null)
    assert.equal(result.p99, null)
    assert.equal(result.mean, null)
    assert.equal(result.bootstrap95CI.median, null)
    assert.equal(result.bootstrap95CI.p95, null)
  }
  assert.equal(summarize([0, null]).mean, 0)
})

test('known ordered samples use the existing ledger nearest-rank percentiles', () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 - i)
  const result = summarize(values)
  assert.deepEqual([result.n, result.p50, result.p95, result.p99, result.mean], [100, 50, 95, 99, 50.5])
  assert.equal(values[0], 100, 'statistics must not sort the caller array in place')
})

test('bootstrap is reproducible and bounds constant and skewed observations', () => {
  const constant = summarize([7, 7, 7, 7])
  assert.deepEqual(constant.bootstrap95CI.median, [7, 7])
  assert.deepEqual(constant.bootstrap95CI.p95, [7, 7])
  assert.equal(constant.bootstrap95CI.iterations, 1000)
  const values = [...Array(95).fill(1), ...Array(5).fill(100)]
  const a = summarize(values)
  assert.deepEqual(a, summarize(values))
  assert.deepEqual(a.bootstrap95CI.median, [1, 1])
  assert.deepEqual(a.bootstrap95CI.p95, [1, 100], 'tail uncertainty differs from median uncertainty')
  assert.deepEqual(summarize([3]).bootstrap95CI.p95, [3, 3])
})

test('run summaries keep GPU labels separate and do not invent query denominators', () => {
  const run = summarizeRun({ caseId: 'clouds', repeat: 2, measurement: {
    cpuMs: [1, 2], rafMs: [16.667, 20, 33.333, 50, 100, 101],
    gpu: [{ label: 'frame', milliseconds: 9 }, { label: 'cloud.march', milliseconds: 2 },
      { label: 'frame', milliseconds: 11 }, { label: 'cloud.march', milliseconds: null }],
    gpuStatus: { supported: true, issuedByLabel: { frame: 4, 'empty.pass': 2 } }
  }, memory: { graphPhysicalBytes: 512, tilesetReportedBytes: 1024 }, validity: { valid: true } })
  assert.equal(run.gpuByLabel.frame.n, 2)
  assert.equal(run.gpuByLabel.frame.p50, 9)
  assert.equal(run.gpuByLabel['cloud.march'].p50, 2)
  assert.deepEqual(run.gpuByLabel.frame.queryAvailability, { valid: 2, issued: 4, ratio: 0.5 })
  assert.equal(run.gpuByLabel['cloud.march'].queryAvailability.ratio, null)
  assert.equal(run.gpuByLabel['empty.pass'].n, 0)
  assert.equal(run.gpuByLabel['empty.pass'].queryAvailability.ratio, 0)
  assert.deepEqual(run.rafStalls.map(item => item.count), [5, 3, 2, 1])
  assert.equal(run.memory.actualVramBytes, null)
  assert.equal(run.memory.logicalTracked.graphPhysicalBytes, 512)
  assert.equal(run.memory.assetEstimate.tilesetReportedBytes, 1024)
  assert.deepEqual(run.validity, { valid: true })
})

test('report tables preserve separate repeats and expose missing data and memory scope', () => {
  const summary = summarizeReport({ schemaVersion: 'raw-v1', sdkSha256: 'test-hash', runs: [
    { caseId: 'off|sky', repeat: 1, measurement: { cpuMs: [1, 2], rafMs: [20] } },
    { caseId: 'off|sky', repeat: 2, measurement: { cpuMs: [3, 4] } }
  ] })
  assert.equal(summary.runs.length, 2)
  assert.equal(summary.sdkSha256, 'test-hash')
  assert.equal(summary.sourceSchemaVersion, 'raw-v1')
  const markdown = renderMarkdown(summary)
  assert.match(markdown, /off\\\|sky/)
  assert.match(markdown, /N\/A/)
  assert.match(markdown, /VRAM/)
  assert.match(markdown, /IID/)
  assert.throws(() => summarizeReport({}), /runs/)
})

test('CLI parses explicit report paths and rejects unknown or missing options', () => {
  assert.deepEqual(parseArgs(['--input', 'raw.json', '--output=summary.json', '--markdown', 'summary.md']),
    { input: 'raw.json', output: 'summary.json', markdown: 'summary.md' })
  assert.throws(() => parseArgs(['--unknown', 'x']), /Unknown/)
  assert.throws(() => parseArgs(['--input']), /Missing/)
})

test('harness nested memory sources preserve raw values without summing overlapping scopes', () => {
  const memory = { trackedTextures: { currentBytes: 0, peakBytes: 4096, entries: [{ name: 'cloud.history', bytes: 4096 }] },
    pool: { currentBytes: 128, peakBytes: 2048, windowPeakBytes: 1024 },
    uniformBuffers: { currentBytes: 16, peakBytes: 32 }, jsHeapPeakBytes: 65536,
    assetsBefore: { tilesetBytes: 1000, glbGeometryBytes: 2000, glbTextureBytes: 3000 },
    assetsAfter: { tilesetBytes: 2000, glbGeometryBytes: 4000, glbTextureBytes: 6000 },
    graphPhysicalBytes: null, graphPhysicalReason: 'Shared RHI pool', actualVramBytes: null }
  const summary = summarizeReport({ schema: 'ccr-environment-milestone-1', runs: [
    { caseId: 'default', repeat: 1, identity: { renderer: 'Test GPU' }, memory,
      measurement: { gpuStatus: { supported: false, attemptsByLabel: { frame: 300 } } },
      validity: { nonzeroDraws: true, disjointPolls: 0 } }
  ] })
  const run = summary.runs[0]
  assert.equal(summary.sourceSchemaVersion, 'ccr-environment-milestone-1')
  assert.equal(run.identity.renderer, 'Test GPU')
  assert.deepEqual(run.memory.trackedTextures, memory.trackedTextures)
  assert.deepEqual(run.memory.assetsAfter, memory.assetsAfter)
  assert.equal(run.memory.logicalTracked.texturesCurrentBytes, 0)
  assert.equal(run.memory.logicalTracked.texturesPeakBytes, 4096)
  assert.equal(run.memory.logicalTracked.poolWindowPeakBytes, 1024)
  assert.equal(run.memory.logicalTracked.uniformBufferPeakBytes, 32)
  assert.deepEqual(run.memory.assetEstimate.before, memory.assetsBefore)
  assert.deepEqual(run.memory.assetEstimate.after, memory.assetsAfter)
  assert.equal(run.memory.actualVramBytes, null)
  assert.equal(run.memory.totalBytes, undefined)
  assert.equal(run.gpuByLabel.frame.n, 0, 'attempted labels remain visible even when all queries failed')
  const markdown = renderMarkdown(summary)
  assert.match(markdown, /Pool window peak/)
  assert.match(markdown, /Assets before/)
  assert.match(markdown, /JS heap peak/)
})
