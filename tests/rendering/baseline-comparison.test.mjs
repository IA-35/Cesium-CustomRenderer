import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildComparison, renderMarkdown, selectRun, THRESHOLDS } = createRequire(import.meta.url)(
  '../../scripts/performance/compare-rendering-baseline.cjs')

const run = (overrides = {}) => ({
  case: 'enhanced-current',
  validity: { validFrames: 300, invalidFrames: 0, gpuSupported: true },
  frame: { cpuMs: { p50: 2, p95: 4 }, gpuMs: { p50: 3, p95: 5 }, drawCalls: 84, submittedCommands: 621 },
  state: { programBinds: 100, drawHookInvocations: 700 },
  memory: { ccrTextureBytes: 800, poolPeakBytes: 100, graphPeakBytes: 0 },
  ...overrides
})

test('comparison reports a reduction as a positive improvement', () => {
  const comparison = buildComparison(run(), run({
    frame: { cpuMs: { p50: 2, p95: 3 }, gpuMs: { p50: 2.5, p95: 4 }, drawCalls: 84, submittedCommands: 621 },
    state: { programBinds: 60, drawHookInvocations: 700 }
  }))
  assert.equal(comparison.correctness, 'pass')
  assert.equal(comparison.noRegression, 'pass')
  // cpu p95 4 -> 3 is a 25% reduction, above the 15% target.
  assert.ok(comparison.metrics.cpuP95.reduction > 0.24)
  assert.ok(comparison.metrics.programBinds.reduction > 0.39)
  assert.ok(comparison.achieved.includes('cpuP95'))
  assert.ok(comparison.achieved.includes('programBinds'))
})

test('a candidate that gets slower is never reported as an improvement', () => {
  const comparison = buildComparison(run(), run({ frame: { cpuMs: { p50: 2, p95: 8 }, gpuMs: { p50: 6, p95: 9 } } }))
  assert.ok(comparison.metrics.cpuP95.reduction < 0)
  assert.equal(comparison.optimizationSuccess, 'not-achieved')
})

test('an invalid run fails correctness and blocks the success tier', () => {
  const comparison = buildComparison(run(), run({ validity: { validFrames: 10, invalidFrames: 5, gpuSupported: true } }))
  assert.equal(comparison.correctness, 'fail')
  assert.equal(comparison.noRegression, 'fail')
  assert.equal(comparison.optimizationSuccess, 'not-achieved')
})

test('a missing GPU timer is reported as unavailable rather than zero', () => {
  const noGpu = { frame: { cpuMs: { p50: 2, p95: 4 }, gpuMs: { p50: null, p95: null }, drawCalls: 84, submittedCommands: 621 } }
  const comparison = buildComparison(
    run({ ...noGpu, validity: { validFrames: 300, invalidFrames: 0, gpuSupported: false } }),
    run({ ...noGpu, validity: { validFrames: 300, invalidFrames: 0, gpuSupported: false } }))
  assert.equal(comparison.metrics.gpuP50.reduction, null, 'missing data must not read as a measured 0% change')
  assert.match(comparison.notes.join(' '), /GPU timing unavailable/)
  assert.equal(comparison.optimizationSuccess, 'not-achieved', 'a metric without data cannot satisfy a threshold')
})

test('selectRun picks the requested case from a multi-run baseline file', () => {
  const document = { runs: [{ case: 'native' }, { case: 'deferred-current' }] }
  assert.equal(selectRun(document, 'deferred-current').case, 'deferred-current')
  assert.equal(selectRun(document).case, 'native')
  assert.throws(() => selectRun(document, 'missing'), /not found/)
})

test('markdown states the tracked-allocation caveat', () => {
  const markdown = renderMarkdown(buildComparison(run(), run()), 'a.json', 'b.json')
  assert.match(markdown, /not true board VRAM/)
  assert.match(markdown, /thresholds|target/)
  assert.equal(THRESHOLDS.programBindReduction, 0.30)
})
