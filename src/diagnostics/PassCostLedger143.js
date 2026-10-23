// Phase 0 performance contract. This module only records observations; it does
// not query WebGL or infer board/driver memory from tracked allocations.

const FRAME_FIELDS = ['drawCalls', 'submittedCommands', 'triangles']
const MEMORY_FIELDS = [
  'graphPhysicalBytes', 'graphPeakBytes', 'poolCurrentBytes', 'poolPeakBytes',
  'ccrTextureBytes', 'tilesetReportedBytes', 'jsHeapBytes'
]
const STATE_FIELDS = [
  'drawHookInstallations', 'drawHookInvocations', 'programBinds', 'drawCalls', 'materialBinds',
  'uniformUploads', 'textureBinds'
]

function finite(value) { return Number.isFinite(value) }

function quantile(values, q) {
  if (!values.length) return null
  const sorted = values.filter(finite).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function bootstrapInterval(values, iterations, seed) {
  const source = values.filter(finite)
  if (!source.length) return { low: null, high: null, confidence: 0.95, iterations: 0 }
  if (source.length === 1) return { low: source[0], high: source[0], confidence: 0.95, iterations: 1 }
  const count = Math.max(100, Number(iterations) || 1000)
  const random = seededRandom(seed)
  const estimates = []
  for (let i = 0; i < count; i++) {
    const sample = []
    for (let j = 0; j < source.length; j++) sample.push(source[Math.floor(random() * source.length)])
    estimates.push(quantile(sample, 0.5))
  }
  estimates.sort((a, b) => a - b)
  return {
    low: estimates[Math.floor(estimates.length * 0.025)],
    high: estimates[Math.min(estimates.length - 1, Math.floor(estimates.length * 0.975))],
    confidence: 0.95,
    iterations: count
  }
}

function stats(values, options = {}) {
  const source = values.filter(finite)
  if (options.supported === false) {
    return { supported: false, reason: options.reason || 'GPU timer query unavailable', samples: 0,
      p50: null, p95: null, mean: null, cv: null, bootstrapCI: null }
  }
  if (!source.length) {
    return { supported: options.supported !== false, reason: options.reason || null, samples: 0,
      p50: null, p95: null, mean: null, cv: null,
      bootstrapCI: bootstrapInterval([], options.bootstrapIterations, options.bootstrapSeed) }
  }
  const mean = source.reduce((sum, value) => sum + value, 0) / source.length
  const variance = source.reduce((sum, value) => sum + (value - mean) ** 2, 0) / source.length
  return {
    supported: options.supported !== false,
    reason: options.reason || null,
    samples: source.length,
    p50: quantile(source, 0.5),
    p95: quantile(source, 0.95),
    mean,
    cv: mean ? Math.sqrt(variance) / Math.abs(mean) : null,
    bootstrapCI: bootstrapInterval(source, options.bootstrapIterations, options.bootstrapSeed)
  }
}

function countValue(values) { return quantile(values, 0.5) }

function clone(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item))
  } catch {
    return undefined
  }
}

export default class PassCostLedger143 {
  constructor(options = {}) {
    this.bootstrapIterations = options.bootstrap?.iterations || options.bootstrapIterations || 1000
    this.bootstrapSeed = options.bootstrap?.seed || options.bootstrapSeed || 143
    this.warmupTarget = Math.max(0, Number(options.warmupFrames) || 0)
    this.scene = { name: null, viewport: null, dpr: null, renderer: null, cesiumVersion: null,
      assetHash: null, cameraTrack: null, clock: null, ...clone(options.scene || {}) }
    this.mode = { native: false, enhanced: false, deferred: false, deferredTransparent: false,
      taa: false, ao: false, bloom: false, ...clone(options.mode || {}) }
    this.gpuSupported = options.gpuSupported === true
    this.gpuReason = options.gpuReason || (this.gpuSupported ? null : 'GPU timer query unavailable')
    this.validity = { warmupFrames: 0, sampledFrames: 0, validFrames: 0, invalidFrames: 0,
      gpuSupported: this.gpuSupported, disjointCount: 0, discarded: 0, focusLoss: 0,
      configChanges: 0, assetChanges: 0, readinessChanges: 0, invalidReasons: {} }
    this._frames = []
    this._passes = new Map()
    this._state = Object.fromEntries(STATE_FIELDS.map(field => [field, null]))
    this._memory = Object.fromEntries(MEMORY_FIELDS.map(field => [field, null]))
    this._memoryPeaks = Object.fromEntries(MEMORY_FIELDS.map(field => [field, 0]))
  }

  recordFrame(sample = {}) {
    if (sample.warmup || this.validity.warmupFrames < this.warmupTarget) {
      this.validity.warmupFrames++
      return false
    }
    this.validity.sampledFrames++
    const invalidReasons = []
    if (sample.valid === false) invalidReasons.push(sample.invalidReason || 'invalid')
    if (sample.disjoint) { this.validity.disjointCount++; invalidReasons.push('disjoint') }
    if (sample.focusLoss) { this.validity.focusLoss++; invalidReasons.push('focusLoss') }
    if (sample.configChanged) { this.validity.configChanges++; invalidReasons.push('configChanges') }
    if (sample.assetChanged) { this.validity.assetChanges++; invalidReasons.push('assetChanges') }
    if (sample.readinessChanged) { this.validity.readinessChanges++; invalidReasons.push('readinessChanges') }
    if (sample.gpuSupported !== undefined) {
      this.gpuSupported = sample.gpuSupported === true
      this.validity.gpuSupported = this.gpuSupported
      if (sample.gpuReason) this.gpuReason = sample.gpuReason
    }
    if (invalidReasons.length) {
      this.validity.invalidFrames++
      this.validity.discarded++
      for (const reason of invalidReasons) this.validity.invalidReasons[reason] = (this.validity.invalidReasons[reason] || 0) + 1
      return false
    }
    this.validity.validFrames++
    this._frames.push({ cpuMs: sample.cpuMs, gpuMs: this.gpuSupported ? sample.gpuMs : undefined,
      drawCalls: sample.drawCalls, submittedCommands: sample.submittedCommands, triangles: sample.triangles })
    for (const pass of sample.passes || []) this.recordPass(pass)
    this.recordState(sample.state)
    this.recordMemory(sample.memory)
    return true
  }

  recordPass(pass = {}) {
    if (!pass.name) return false
    let entry = this._passes.get(pass.name)
    if (!entry) {
      entry = { name: pass.name, cpuMs: [], gpuMs: [], draws: [], renderItems: [], batches: [] }
      this._passes.set(pass.name, entry)
    }
    for (const field of ['cpuMs', 'gpuMs', 'draws', 'renderItems', 'batches']) {
      if (finite(pass[field]) && (field !== 'gpuMs' || this.gpuSupported)) entry[field].push(pass[field])
    }
    return true
  }

  recordState(state = {}) {
    if (!state) return
    for (const field of STATE_FIELDS) if (finite(state[field])) this._state[field] = (this._state[field] ?? 0) + state[field]
  }

  recordMemory(memory = {}) {
    if (!memory) return
    for (const field of MEMORY_FIELDS) {
      if (!finite(memory[field])) continue
      if (field === 'graphPeakBytes') this._memory[field] = Math.max(this._memory[field] ?? 0, memory[field], this._memoryPeaks.graphPhysicalBytes)
      else if (field === 'poolPeakBytes') this._memory[field] = Math.max(this._memory[field] ?? 0, memory[field], this._memoryPeaks.poolCurrentBytes)
      else this._memory[field] = memory[field]
      this._memoryPeaks[field] = Math.max(this._memoryPeaks[field], memory[field])
      if (field === 'graphPhysicalBytes' && finite(this._memory.graphPeakBytes)) this._memory.graphPeakBytes = Math.max(this._memory.graphPeakBytes, memory[field])
      if (field === 'poolCurrentBytes' && finite(this._memory.poolPeakBytes)) this._memory.poolPeakBytes = Math.max(this._memory.poolPeakBytes, memory[field])
    }
  }

  // Attach delayed EXT_disjoint_timer_query results after frame submission.
  // Query results are intentionally matched in order and may be fewer than CPU frames.
  recordGpuSamples(samples = []) {
    const values = samples.filter(finite)
    const pending = this._frames.filter(frame => frame.gpuMs === undefined)
    const count = Math.min(values.length, pending.length)
    for (let i = 0; i < count; i++) pending[i].gpuMs = values[i]
    return count
  }

  recordFrameCounters(frames = []) {
    const source = Array.isArray(frames) ? frames : []
    for (let i = 0; i < Math.min(source.length, this._frames.length); i++) {
      for (const field of FRAME_FIELDS) if (finite(source[i]?.[field])) this._frames[i][field] = source[i][field]
    }
    return Math.min(source.length, this._frames.length)
  }

  invalidate(reason = 'invalid') {
    return this.recordFrame({ valid: false, invalidReason: reason })
  }

  getReport() {
    const common = { bootstrapIterations: this.bootstrapIterations, bootstrapSeed: this.bootstrapSeed }
    const cpu = stats(this._frames.map(frame => frame.cpuMs), common)
    const gpu = stats(this._frames.map(frame => frame.gpuMs), { ...common, supported: this.gpuSupported,
      reason: this.gpuReason })
    const frame = { cpuMs: cpu, gpuMs: gpu }
    for (const field of FRAME_FIELDS) frame[field] = countValue(this._frames.map(item => item[field]))
    const passes = [...this._passes.values()].map(pass => ({ name: pass.name,
      cpuMs: stats(pass.cpuMs, common), gpuMs: stats(pass.gpuMs, { ...common, supported: this.gpuSupported, reason: this.gpuReason }),
      draws: countValue(pass.draws), renderItems: countValue(pass.renderItems), batches: countValue(pass.batches) }))
    const memory = { ...this._memory, scope: 'tracked allocations; true board VRAM requires vendor profiler' }
    if (memory.graphPeakBytes === null) memory.graphPeakBytes = finite(this._memoryPeaks.graphPhysicalBytes) ? this._memoryPeaks.graphPhysicalBytes : null
    if (memory.poolPeakBytes === null) memory.poolPeakBytes = finite(this._memoryPeaks.poolCurrentBytes) ? this._memoryPeaks.poolCurrentBytes : null
    memory.graphScope = 'render-graph transient physical allocations when an allocator exposes byte diagnostics; null means unavailable'
    memory.poolScope = 'CCR render-target pool allocations reported by the pool; excludes driver and board overhead'
    return { schemaVersion: 'phase0-v3', scene: clone(this.scene), mode: clone(this.mode),
      validity: { ...this.validity, gpuSupported: this.gpuSupported }, frame, passes,
      state: { ...this._state }, memory }
  }

  toJSON() { return this.getReport() }
}

export { quantile, stats, bootstrapInterval }
