import test from 'node:test'
import assert from 'node:assert/strict'
import PerformanceGovernor143, { quantile } from '../../src/performance/PerformanceGovernor143.js'
import VisualPipeline from '../../src/VisualPipeline.js'
import { normalizeOptions } from '../../src/presets.js'

const TARGET_MS = 1000 / 30

function host(initial = { resolutionScale: 1, shadowSize: 4096, shadowMode: 'custom' }) {
  const state = { ...initial }
  const listeners = { post: [], pre: [] }
  const channel = bucket => ({
    addEventListener: fn => bucket.push(fn),
    removeEventListener: fn => { const index = bucket.indexOf(fn); if (index >= 0) bucket.splice(index, 1) }
  })
  const scene = { requestRenderMode: false, postRender: channel(listeners.post), preUpdate: channel(listeners.pre) }
  const pipeline = {
    viewer: { scene }, enabled: true, suspensions: new Set(),
    setOptions(next) { Object.assign(state, next); return { ...state } },
    getOptions() { return { ...state } }
  }
  return { pipeline, state, scene, listeners, depth: () => listeners.post.length + listeners.pre.length }
}

function clock() {
  let value = 0
  return { advance: step => { value += step }, now: () => value }
}

function drive(listeners, clockControl, frames, interval) {
  for (let i = 0; i < frames; i++) {
    clockControl.advance(interval)
    listeners.post.slice().forEach(fn => fn())
    listeners.pre.slice().forEach(fn => fn())
  }
}

function governor(pipeline, clockControl, overrides = {}) {
  return new PerformanceGovernor143(pipeline, { targetFps: 30, sampleWindow: 8, evaluateEvery: 4,
    settleFrames: 2, now: clockControl.now, ...overrides })
}

test('quantile uses nearest rank and tolerates empty windows', () => {
  assert.equal(quantile([], 0.95), 0)
  assert.equal(quantile([10], 0.5), 10)
  assert.equal(quantile([5, 1, 4, 2, 3], 0.95), 5)
  assert.equal(quantile([5, 1, 4, 2, 3], 0.5), 3)
})

test('sustained over-budget frames step resolution down before capping the shadow map', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  drive(h.listeners, time, 20, 50)
  assert.ok(h.state.resolutionScale < 1, 'resolution should drop first')
  assert.equal(h.state.shadowSize, 4096, 'shadow map is preserved while resolution still has room')

  drive(h.listeners, time, 600, 50)
  const diagnostics = g.getDiagnostics()
  assert.equal(diagnostics.step, diagnostics.maxStep)
  assert.equal(h.state.shadowSize, 1024)
  assert.ok(Math.abs(h.state.resolutionScale - 0.6) < 1e-9)
  assert.equal(diagnostics.enabled, true)
  g.destroy()
})

test('sustained headroom recovers to the exact original configuration', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time, { recoverStreakRequired: 2 })
  g.setEnabled(true)
  drive(h.listeners, time, 600, 50)
  assert.ok(g.getDiagnostics().step > 0)

  drive(h.listeners, time, 800, 10)
  assert.equal(g.getDiagnostics().step, 0)
  assert.equal(h.state.resolutionScale, 1)
  assert.equal(h.state.shadowSize, 4096)
  g.destroy()
})

test('frame times inside the hysteresis band change nothing', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  // 33.3 ms target: degrade above 38.3 ms, recover below 26.6 ms.
  drive(h.listeners, time, 800, 33)
  assert.equal(g.getDiagnostics().step, 0)
  assert.equal(h.state.resolutionScale, 1)
  assert.equal(h.state.shadowSize, 4096)
  g.destroy()
})

test('the governor never lowers quality below the floor or raises it above the baseline', () => {
  const h = host({ resolutionScale: 0.75, shadowSize: 2048, shadowMode: 'custom' }), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  drive(h.listeners, time, 900, 50)
  assert.ok(h.state.resolutionScale >= 0.6 - 1e-9, 'never below the configured floor')
  assert.ok(h.state.resolutionScale <= 0.75 + 1e-9, 'never above the user baseline')
  assert.equal(h.state.shadowSize, 1024)

  drive(h.listeners, time, 900, 10)
  assert.equal(h.state.resolutionScale, 0.75)
  assert.equal(h.state.shadowSize, 2048)
  g.destroy()
})

test('disabling the governor restores the baseline exactly', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  drive(h.listeners, time, 400, 50)
  assert.ok(g.getDiagnostics().step > 0)

  g.setEnabled(false)
  assert.equal(g.getDiagnostics().enabled, false)
  assert.equal(h.depth(), 0, 'listeners are released')
  assert.equal(h.state.resolutionScale, 1)
  assert.equal(h.state.shadowSize, 4096)
})

test('suspended pipelines and on-demand rendering are never degraded on their samples', () => {
  const suspended = host(), timeA = clock()
  const gA = governor(suspended.pipeline, timeA)
  gA.setEnabled(true)
  suspended.pipeline.suspensions.add('weather')
  drive(suspended.listeners, timeA, 400, 50)
  assert.equal(gA.getDiagnostics().step, 0)
  assert.equal(gA.getDiagnostics().reason, 'Suspended')
  gA.destroy()

  const onDemand = host(), timeB = clock()
  onDemand.scene.requestRenderMode = true
  const gB = governor(onDemand.pipeline, timeB)
  gB.setEnabled(true)
  drive(onDemand.listeners, timeB, 400, 50)
  assert.equal(gB.getDiagnostics().step, 0)
  assert.equal(gB.getDiagnostics().reason, 'on-demand rendering')
  gB.destroy()
})

test('a scene without render events refuses to enable instead of degrading blindly', () => {
  const pipeline = { viewer: { scene: {} }, enabled: true, suspensions: new Set(),
    setOptions() {}, getOptions: () => ({ resolutionScale: 1, shadowSize: 4096, shadowMode: 'custom' }) }
  const g = new PerformanceGovernor143(pipeline, { targetFps: 30 })
  g.setEnabled(true)
  assert.equal(g.getDiagnostics().enabled, false)
  assert.equal(g.getDiagnostics().reason, 'scene events unavailable')
  g.destroy()
})

test('detach stops sampling and drops state without touching the pipeline', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  drive(h.listeners, time, 400, 50)
  assert.ok(g.getDiagnostics().step > 0)
  const frozen = { ...h.state }

  g.detach()
  assert.equal(h.depth(), 0)
  assert.equal(g.getDiagnostics().baseline, null)
  drive(h.listeners, time, 400, 50)
  assert.deepEqual(h.state, frozen, 'no further writes after detach')
  g.destroy()
})

test('pauses and post-adjustment hitches are not mistaken for frame cost', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  g.setEnabled(true)
  drive(h.listeners, time, 60, 16)
  assert.equal(g.getDiagnostics().step, 0)

  // A long blocked gap (e.g. a suspended pipeline) must not seed the window.
  h.pipeline.suspensions.add('weather')
  drive(h.listeners, time, 5, 3000)
  assert.equal(g.getDiagnostics().reason, 'Suspended')
  h.pipeline.suspensions.delete('weather')

  drive(h.listeners, time, 600, 16)
  assert.equal(g.getDiagnostics().step, 0, 'a resumed fast pipeline stays at baseline')
  assert.ok(g.getDiagnostics().p95 < 33.3)
  g.destroy()
})

test('a failing adjustment is reported and does not claim the step was applied', () => {
  const h = host(), time = clock()
  const g = governor(h.pipeline, time)
  h.pipeline.setOptions = () => { throw new Error('resize refused') }
  g.setEnabled(true)
  drive(h.listeners, time, 400, 50)
  const diagnostics = g.getDiagnostics()
  assert.equal(diagnostics.step, 0)
  assert.match(diagnostics.reason, /adjustment failed: resize refused/)
  g.destroy()
})

function pipelineHost() {
  const listeners = { post: [], pre: [] }
  const channel = bucket => ({ addEventListener: fn => bucket.push(fn),
    removeEventListener: fn => { const index = bucket.indexOf(fn); if (index >= 0) bucket.splice(index, 1) } })
  const p = Object.create(VisualPipeline.prototype)
  p.options = normalizeOptions({})
  p.destroyed = false
  p.enabled = true
  p.suspensions = new Set()
  p.viewer = { scene: { requestRenderMode: false, postRender: channel(listeners.post), preUpdate: channel(listeners.pre) },
    isDestroyed: () => true }
  p.setOptions = next => { Object.assign(p.options, next); return p.options }
  return { p, listeners }
}

test('the pipeline exposes governor control and destroys it with the pipeline', () => {
  const { p, listeners } = pipelineHost()
  assert.deepEqual(p.getPerformanceDiagnostics(), { enabled: false, reason: 'Not requested' })

  const diagnostics = p.setPerformance({ enabled: true, targetFps: 30 })
  assert.equal(diagnostics.enabled, true)
  assert.equal(diagnostics.targetFrameMs, TARGET_MS)

  const first = p.governor
  p.setPerformance({ enabled: true, targetFps: 60 })
  assert.notEqual(p.governor, first, 'tuning keys rebuild the governor')
  assert.equal(p.getPerformanceDiagnostics().targetFrameMs, 1000 / 60)

  assert.equal(p.setPerformance({ enabled: false }).enabled, false)
  assert.equal(listeners.post.length + listeners.pre.length, 0)

  p.setPerformance({ enabled: true, targetFps: 30 })
  p.destroy()
  assert.equal(p.governor, null)
  assert.equal(listeners.post.length + listeners.pre.length, 0)
  assert.equal(p.getPerformanceDiagnostics().reason, 'Destroyed')
})
