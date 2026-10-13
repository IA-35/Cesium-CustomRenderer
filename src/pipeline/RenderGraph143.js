// Render Graph core adapted from webgpu-cesium/packages/renderer/src/graph/RenderGraph.ts
// Copyright 2026 webgpu-cesium contributors.
// Source: https://github.com/Xiaobai-grow/webgpu-cesium/blob/main/packages/renderer/src/graph/RenderGraph.ts
// Licensed under the Apache License, Version 2.0. This WebGL adapter removes GPUDevice
// execution and maps transient resources to CCR's RenderTargetPool143.
//
// Lightweight WebGL Render Graph for CCR-owned stages.
// Cesium still owns the actual frame loop; CCR declares resources and dependencies here.
function assertName(name, kind) { if (typeof name !== 'string' || !name.trim()) throw new Error(`RenderGraph143 ${kind} name is required`) }
function keyOf(descriptor = {}) { return [descriptor.width ?? 0, descriptor.height ?? 0, descriptor.format ?? '', descriptor.datatype ?? '', descriptor.samples ?? 1].join('|') }

export default class RenderGraph143 {
  constructor({ label = 'CCR', executeExternal = false } = {}) { this.label = label; this.executeExternal = executeExternal; this.frame = 0; this.reset() }
  executePass(name, context = this.activeFrame?.context) {
    if (!this.activeFrame) return false
    const pass = this.compiled?.find(candidate => candidate.name === name)
    if (!pass) return false
    const executed = this.activeFrame.executed || (this.activeFrame.executed = new Set())
    if (executed.has(name)) return true
    pass.execute?.(context, pass)
    executed.add(name)
    return true
  }
  completePass(name) {
    if (!this.activeFrame || !this.compiled) return false
    const pass = this.compiled.find(candidate => candidate.name === name)
    if (!pass) return false
    const leases = this.activeFrame.leases
    if (!leases) return true
    for (const [id, lease] of [...leases.entries()]) {
      const alias = this.aliases.find(candidate => candidate.resource === this.resources[id].name)
      if (alias?.lastPass === name) { lease.release(); leases.delete(id) }
    }
    return true
  }
  bindExternal(resource, value) {
    if (!resource || this.resources[resource.id] !== resource || resource.kind !== 'external') throw new Error('RenderGraph143 external binding requires an external resource')
    this.externalBindings.set(resource.id, value)
    return value
  }
  externalOf(resource) { return this.externalBindings.get(resource?.id) }
  trackLease(resource, lease) {
    if (!this.activeFrame) throw new Error('RenderGraph143 lease tracking requires an active frame')
    if (!resource || this.resources[resource.id] !== resource || resource.kind !== 'transient') throw new Error('RenderGraph143 leases require a transient resource')
    if (!lease || typeof lease.release !== 'function') throw new Error('RenderGraph143 invalid resource lease')
    const leases = this.activeFrame.leases || (this.activeFrame.leases = new Map())
    if (leases.has(resource.id)) throw new Error(`RenderGraph143 resource already leased: ${resource.name}`)
    leases.set(resource.id, lease)
    return lease
  }
  leaseOf(resource) { return this.activeFrame?.leases?.get(resource?.id) }
  _releaseFrameLeases() {
    const leases = this.activeFrame?.leases
    if (!leases) return
    for (const lease of [...leases.values()].reverse()) { try { lease.release() } catch {} }
    leases.clear()
  }
  reset() { if (this.activeFrame) throw new Error('RenderGraph143 cannot reset during an active frame'); this.resources = []; this.passes = []; this.compiled = null; this.lastHash = null; this.aliases = []; this.culled = []; this.externalBindings = new Map(); this.activeFrame = null }
  registerPassLifecycle(name, lifecycle = {}) {
    const pass = this.passes.find(candidate => candidate.name === name)
    if (!pass) throw new Error(`RenderGraph143 unknown pass: ${name}`)
    pass.lifecycle = { begin: lifecycle.begin, end: lifecycle.end }
    return () => { if (pass.lifecycle) pass.lifecycle = undefined }
  }
  beginFrame(context = {}) {
    if (this.activeFrame) return this._diagnostics(this.lastHash)
    const diagnostics = this.describe()
    this.activeFrame = { number: ++this.frame, context, started: diagnostics.passes.slice(), executed: new Set() }
    try {
      for (const pass of this.compiled) pass.lifecycle?.begin?.(context, pass)
    } catch (error) {
      this.activeFrame = null
      throw error
    }
    return diagnostics
  }
  endFrame(context = this.activeFrame?.context) {
    if (!this.activeFrame) return null
    let error
    for (const pass of [...this.compiled].reverse()) {
      try { pass.lifecycle?.end?.(context, pass) } catch (current) { error ||= current }
    }
    this._releaseFrameLeases()
    const completed = this.activeFrame
    this.activeFrame = null
    if (error) throw error
    return { ...this._diagnostics(this.lastHash), frame: completed.number }
  }
  importResource(name, descriptor = {}) { assertName(name, 'resource'); const handle = { id: this.resources.length, name, kind: 'external', descriptor: { ...descriptor } }; this.resources.push(handle); return handle }
  createResource(name, descriptor = {}) { assertName(name, 'resource'); const handle = { id: this.resources.length, name, kind: 'transient', descriptor: { ...descriptor } }; this.resources.push(handle); return handle }
  addPass(name, setup, execute = null, { sideEffect = false, phase = 'external' } = {}) {
    assertName(name, 'pass'); if (this.passes.some(pass => pass.name === name)) throw new Error(`RenderGraph143 duplicate pass: ${name}`)
    const node = { name, index: this.passes.length, phase, reads: new Set(), writes: new Set(), sideEffect, execute }
    const builder = { read: resource => this._use(node, resource, 'read'), write: resource => this._use(node, resource, 'write'), sideEffect: () => { node.sideEffect = true } }
    setup?.(builder); this.passes.push(node); this.compiled = null; return node
  }
  _use(node, resource, type) { if (!resource || this.resources[resource.id] !== resource) throw new Error(`RenderGraph143 invalid resource in ${node.name}`); node[type === 'read' ? 'reads' : 'writes'].add(resource.id); return resource }
  compile() {
    const hash = this._hash(); if (this.compiled && this.lastHash === hash) return this._diagnostics(hash)
    const needed = new Set(this.resources.filter(resource => resource.kind === 'external').map(resource => resource.id)), alive = new Set(); let changed = true
    while (changed) { changed = false; for (let index = this.passes.length - 1; index >= 0; index--) { const pass = this.passes[index]; if (alive.has(pass)) continue; if (pass.sideEffect || [...pass.writes].some(id => needed.has(id))) { alive.add(pass); changed = true; for (const id of pass.reads) needed.add(id) } } }
    const nodes = this.passes.filter(pass => alive.has(pass)), edges = new Map(nodes.map(pass => [pass, new Set()])), indegree = new Map(nodes.map(pass => [pass, 0]))
    const addEdge = (from, to) => { if (from === to || edges.get(from).has(to)) return; edges.get(from).add(to); indegree.set(to, indegree.get(to) + 1) }
    const writers = new Map(); for (const pass of nodes) for (const id of pass.writes) { const list = writers.get(id) || []; list.push(pass); writers.set(id, list) }
    for (const list of writers.values()) for (let i = 1; i < list.length; i++) addEdge(list[i - 1], list[i])
    for (const reader of nodes) for (const id of reader.reads) { const list = writers.get(id) || []; if (!list.length) continue; const previous = list.filter(writer => writer.index < reader.index); addEdge(previous.length ? previous[previous.length - 1] : list[list.length - 1], reader) }
    const ready = nodes.filter(pass => indegree.get(pass) === 0), order = []
    while (ready.length) { ready.sort((a, b) => a.index - b.index); const pass = ready.shift(); order.push(pass); for (const next of edges.get(pass)) { indegree.set(next, indegree.get(next) - 1); if (indegree.get(next) === 0) ready.push(next) } }
    if (order.length !== nodes.length) throw new Error(`RenderGraph143 cyclic dependency: ${nodes.filter(pass => !order.includes(pass)).map(pass => pass.name).join(', ')}`)
    this.compiled = order; this.culled = this.passes.filter(pass => !alive.has(pass)).map(pass => pass.name); this.aliases = this._assignAliases(order); this.lastHash = hash; return this._diagnostics(hash)
  }
  _assignAliases(order) {
    const ranges = new Map(); order.forEach((pass, index) => { for (const id of [...pass.reads, ...pass.writes]) { if (this.resources[id].kind !== 'transient') continue; const range = ranges.get(id) || { first: index, last: index }; range.last = index; ranges.set(id, range) } })
    const slots = [], aliases = []; for (const [id, range] of ranges) { const resource = this.resources[id], key = keyOf(resource.descriptor); let slot = slots.find(candidate => candidate.key === key && candidate.last < range.first); if (!slot) { slot = { key, index: slots.length, last: range.last }; slots.push(slot) } else slot.last = range.last; aliases.push({ resource: resource.name, aliasSlot: `${key}#${slot.index}`, firstPass: order[range.first].name, lastPass: order[range.last].name }) } return aliases
  }
  _hash() { return JSON.stringify({ resources: this.resources.map(resource => [resource.kind, resource.name, resource.descriptor]), passes: this.passes.map(pass => [pass.name, [...pass.reads], [...pass.writes], pass.sideEffect, pass.phase]) }) }
  _diagnostics(hash) { return { label: this.label, frame: this.frame, activeFrame: this.activeFrame ? { number: this.activeFrame.number, started: [...this.activeFrame.started], executed: [...(this.activeFrame.executed || [])] } : null, hash, passes: this.compiled.map(pass => pass.name), culled: [...this.culled], aliases: [...this.aliases], resources: this.resources.map(resource => ({ name: resource.name, kind: resource.kind, bound: resource.kind === 'external' ? this.externalBindings.has(resource.id) : undefined, descriptor: { ...resource.descriptor } })) } }
  execute(context) {
    const diagnostics = this.beginFrame(context)
    try { if (this.executeExternal) for (const pass of this.compiled) this.executePass(pass.name, context) }
    finally { this.endFrame(context); this.reset() }
    return diagnostics
  }
  describe() { return this.compile() }
  toJSON() { return this.describe() }
  toMermaid() { this.describe(); const lines = ['flowchart LR']; for (const pass of this.compiled) { lines.push(`  ${pass.name}["${pass.name}"]`); for (const id of pass.reads) lines.push(`  ${this.resources[id].name} --> ${pass.name}`); for (const id of pass.writes) lines.push(`  ${pass.name} --> ${this.resources[id].name}`) } for (const name of this.culled) lines.push(`  ${name}["${name} (culled)"]`); return lines.join('\n') }
}
export function createRenderGraph143(options) { return new RenderGraph143(options) }
