import test from 'node:test'
import assert from 'node:assert/strict'
import baselineModule from '../../scripts/performance/measure-rendering-baseline.cjs'

const { parseArgs, recordPerformanceSample, counterDelta, gpuFrameSamples } = baselineModule

test('CLI accepts separate values without consuming following flags', () => {
  const options = parseArgs(['--no-server', '--sample', '1', '--repeat', '1', '--headed'])
  assert.equal(options.noServer, true)
  assert.equal(options.sample, 1)
  assert.equal(options.repeat, 1)
  assert.equal(options.headless, false)
})

test('baseline sample forwards draw, pass, state and memory metrics to the ledger', () => {
  const calls = []
  const ledger = {
    recordFrame(sample) { calls.push(['frame', sample]) },
  }
  recordPerformanceSample(ledger, {
    cpuMs: 4, gpuMs: 2, gpuSupported: true, valid: true,
    drawCalls: 9, submittedCommands: 12, triangles: 300,
    passes: [{ name: 'deferred.lighting', cpuMs: 1, gpuMs: 0.7, draws: 2, renderItems: 4, batches: 2 }],
    state: { drawHookInvocations: 9, programBinds: 3, uniformUploads: 5, textureBinds: 6 },
    memory: { graphPhysicalBytes: 1024, graphPeakBytes: 2048, poolCurrentBytes: 512, poolPeakBytes: 768 },
  })
  assert.deepEqual(calls, [['frame', {
    cpuMs: 4, gpuMs: 2, gpuSupported: true, valid: true,
    drawCalls: 9, submittedCommands: 12, triangles: 300,
    passes: [{ name: 'deferred.lighting', cpuMs: 1, gpuMs: 0.7, draws: 2, renderItems: 4, batches: 2 }],
    state: { drawHookInvocations: 9, programBinds: 3, uniformUploads: 5, textureBinds: 6 },
    memory: { graphPhysicalBytes: 1024, graphPeakBytes: 2048, poolCurrentBytes: 512, poolPeakBytes: 768 },
  }]])
})

test('baseline sample is recorded once by the ledger and does not double count nested metrics', () => {
  const ledger = {
    frames: 0,
    recordFrame(sample) {
      this.frames++
      this.sample = sample
      return true
    },
    recordPass() { throw new Error('nested pass must be owned by recordFrame') },
    recordState() { throw new Error('nested state must be owned by recordFrame') },
    recordMemory() { throw new Error('nested memory must be owned by recordFrame') },
  }
  assert.equal(recordPerformanceSample(ledger, { cpuMs: 3, passes: [{ name: 'frame' }], state: {}, memory: {} }), true)
  assert.equal(ledger.frames, 1)
})

test('counter deltas preserve per-frame state without adding cumulative snapshots', () => {
  assert.deepEqual(counterDelta({ drawHookInvocations: 10, programBinds: 4 }, { drawHookInvocations: 7, programBinds: 3 }), {
    drawHookInvocations: 3, programBinds: 1,
  })
  assert.deepEqual(counterDelta({ drawHookInvocations: 2 }, { drawHookInvocations: 7 }), { drawHookInvocations: 2 })
})

test('GPU frame samples exclude pass scopes and preserve unavailable values', () => {
  assert.deepEqual(gpuFrameSamples([{ label: 'frame', milliseconds: 2 }, { label: 'shadow', milliseconds: 1 }]), [2])
  assert.deepEqual(gpuFrameSamples([{ label: 'frame', milliseconds: 2 }, { label: 'frame', milliseconds: null }]), [2])
})
