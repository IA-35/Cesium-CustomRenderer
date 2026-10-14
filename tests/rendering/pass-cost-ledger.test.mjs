import test from 'node:test'
import assert from 'node:assert/strict'
import PassCostLedger143 from '../../src/diagnostics/PassCostLedger143.js'

test('ledger emits the phase 0 contract and robust timing statistics', () => {
  const ledger = new PassCostLedger143({
    scene: { name: 'fixture', viewport: { width: 1920, height: 1080 }, dpr: 1 },
    mode: { native: false, enhanced: true }, warmupFrames: 1,
    bootstrap: { iterations: 300, seed: 7 }, gpuSupported: true
  })
  ledger.recordFrame({ cpuMs: 1, gpuMs: 0.5 }) // warmup
  ledger.recordFrame({ cpuMs: 10, gpuMs: 4, drawCalls: 3, submittedCommands: 4, triangles: 12,
    passes: [{ name: 'shadow', cpuMs: 2, gpuMs: 1, draws: 1, renderItems: 2, batches: 1 }],
    state: { programBinds: 2, uniformUploads: 3 },
    memory: { graphPhysicalBytes: 100, poolCurrentBytes: 80 } })
  ledger.recordFrame({ cpuMs: 20, gpuMs: 8, drawCalls: 5, submittedCommands: 6, triangles: 24,
    passes: [{ name: 'shadow', cpuMs: 4, gpuMs: 2, draws: 2, renderItems: 3, batches: 2 }],
    state: { programBinds: 4, uniformUploads: 6 },
    memory: { graphPhysicalBytes: 160, poolCurrentBytes: 120 } })
  ledger.recordFrame({ cpuMs: 99, valid: false, invalidReason: 'focusLoss', focusLoss: true })
  const report = ledger.getReport()
  assert.deepEqual(Object.keys(report).sort(), ['frame', 'memory', 'mode', 'passes', 'scene', 'schemaVersion', 'state', 'validity'])
  assert.equal(report.scene.name, 'fixture')
  assert.equal(report.validity.warmupFrames, 1)
  assert.equal(report.validity.sampledFrames, 3)
  assert.equal(report.validity.validFrames, 2)
  assert.equal(report.validity.invalidFrames, 1)
  assert.equal(report.frame.cpuMs.p50, 10)
  assert.equal(report.frame.cpuMs.p95, 20)
  assert.ok(report.frame.cpuMs.bootstrapCI)
  assert.ok(Number.isFinite(report.frame.cpuMs.cv))
  assert.equal(report.passes[0].name, 'shadow')
  assert.equal(report.passes[0].gpuMs.p50, 1)
  assert.equal(report.state.programBinds, 6)
  assert.equal(report.memory.graphPhysicalBytes, 160)
})

test('unsupported GPU timing is explicit and never invents values', () => {
  const ledger = new PassCostLedger143({ gpuSupported: false })
  ledger.recordFrame({ cpuMs: 5, gpuMs: 123 })
  const report = ledger.getReport()
  assert.equal(report.validity.gpuSupported, false)
  assert.equal(report.frame.gpuMs.supported, false)
  assert.match(report.frame.gpuMs.reason, /unavailable/i)
  assert.equal(report.frame.gpuMs.p50, null)
  assert.equal(report.frame.gpuMs.p95, null)
})

test('disjoint and configuration changes invalidate samples and are counted', () => {
  const ledger = new PassCostLedger143({ gpuSupported: true })
  ledger.recordFrame({ cpuMs: 5, gpuMs: 2, disjoint: true })
  ledger.recordFrame({ cpuMs: 6, gpuMs: 3, configChanged: true })
  ledger.recordFrame({ cpuMs: 7, gpuMs: 4 })
  const report = ledger.getReport()
  assert.equal(report.validity.validFrames, 1)
  assert.equal(report.validity.invalidFrames, 2)
  assert.equal(report.validity.disjointCount, 1)
  assert.equal(report.validity.configChanges, 1)
  assert.equal(report.validity.discarded, 2)
  assert.equal(report.frame.gpuMs.p50, 4)
})

test('memory peaks are monotonic, preserve zero, and expose graph/pool scopes', () => {
  const ledger = new PassCostLedger143({ gpuSupported: false })
  ledger.recordMemory({ graphPeakBytes: 32, poolPeakBytes: 16 })
  ledger.recordMemory({ graphPhysicalBytes: 0, poolCurrentBytes: 0 })
  ledger.recordMemory({ graphPhysicalBytes: 128, poolCurrentBytes: 64 })
  ledger.recordMemory({ graphPhysicalBytes: 16, graphPeakBytes: 32, poolCurrentBytes: 8, poolPeakBytes: 16 })
  const report = ledger.getReport()
  assert.equal(report.memory.graphPhysicalBytes, 16)
  assert.equal(report.memory.graphPeakBytes, 128)
  assert.equal(report.memory.poolCurrentBytes, 8)
  assert.equal(report.memory.poolPeakBytes, 64)
  assert.match(report.memory.graphScope, /graph/i)
  assert.match(report.memory.poolScope, /pool/i)
})

test('frame and pass reports do not create a synthetic frame pass', () => {
  const ledger = new PassCostLedger143({ gpuSupported: true })
  ledger.recordFrame({ cpuMs: 4, gpuMs: 2, passes: [{ name: 'shadow', cpuMs: 1, gpuMs: 0.5 }] })
  ledger.recordPass({ name: 'shadow', cpuMs: 2, gpuMs: 1 })
  const report = ledger.getReport()
  assert.deepEqual(report.passes.map(pass => pass.name), ['shadow'])
  assert.equal(report.passes[0].cpuMs.samples, 2)
})
