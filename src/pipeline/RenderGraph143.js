// Render Graph core adapted from webgpu-cesium/packages/renderer/src/graph/RenderGraph.ts
// Copyright 2026 webgpu-cesium contributors.
// Source: https://github.com/Xiaobai-grow/webgpu-cesium/blob/main/packages/renderer/src/graph/RenderGraph.ts
// Licensed under the Apache License, Version 2.0. This WebGL adapter maps
// transient resources to a caller-owned allocator while Cesium owns the frame loop.
function assertName(name, kind) { if (typeof name !== 'string' || !name.trim()) throw new Error(`RenderGraph143 ${kind} name is required`) }
function keyOf(descriptor = {}) { return [descriptor.width ?? 0, descriptor.height ?? 0, descriptor.format ?? descriptor.pixelFormat ?? '', descriptor.datatype ?? descriptor.pixelDatatype ?? '', descriptor.samples ?? 1, descriptor.depth ? 1 : 0].join('|') }

export default class RenderGraph143 {
  constructor({ label = 'CCR', executeExternal = false, transientAllocator = null } = {}) {
    this.label = label; this.executeExternal = executeExternal; this.transientAllocator = transientAllocator; this.frame = 0; this.reset()
  }
  setTransientAllocator(allocator = null) {
    if (allocator !== null && (typeof allocator.acquire !== 'function' || typeof allocator.release !== 'function')) throw new Error('RenderGraph143 transient allocator requires acquire() and release()')
    if (this.activeFrame) throw new Error('RenderGraph143 cannot replace allocator during an active frame')
    this.transientAllocator = allocator; return this
  }
  setGpuTimer(timer = null) {
    if (timer !== null && typeof timer.measure !== 'function') throw new Error('RenderGraph143 GPU timer requires measure()')
    this.gpuTimer = timer
    return this
  }
  executePass(name, context = this.activeFrame?.context) {
    if (!this.activeFrame) return false
    const pass = this.compiled?.find(candidate => candidate.name === name); if (!pass) return false
    const executed = this.activeFrame.executed || (this.activeFrame.executed = new Set()); if (executed.has(name)) return true
    const run=()=>pass.execute?.(context, pass)
    if(this.gpuTimer) this.gpuTimer.measure(`graph:${name}`,run); else run()
    executed.add(name); return true
  }
  completePass(name) {
    if (!this.activeFrame || !this.compiled) return false
    if (!this.compiled.some(candidate => candidate.name === name)) return false
    for (const group of this.aliasGroups) {
      if (group.lastPass !== name) continue
      // Outputs borrowed by native HDR/B09 consumers outlive the final declared
      // producer. keepAlive is a frame lease, released by endFrame/finally.
      if(group.resources.some(resource=>resource.descriptor.keepAlive)) continue
      const lease = this.activeFrame.groupLeases?.get(group.index); if (!lease) continue
      try { this.transientAllocator ? this.transientAllocator.release(lease, group) : lease.release() } finally { this.activeFrame.groupLeases.delete(group.index); for (const resource of group.resources) this.activeFrame.resourceValues.delete(resource.id) }
    }
    return true
  }
  bindExternal(resource, value) {
    if (!resource || this.resources[resource.id] !== resource || resource.kind !== 'external') throw new Error('RenderGraph143 external binding requires an external resource')
    this._validateBinding(resource, value)
    if (value == null) this.externalBindings.delete(resource.id)
    else this.externalBindings.set(resource.id, value)
    return value
  }
  _validateBinding(resource, value) {
    if (value == null) return value
    const expected = resource.descriptor || {}
    for (const key of ['width', 'height']) if (Number.isFinite(expected[key]) && Number.isFinite(value[key]) && expected[key] !== value[key]) throw new Error(`RenderGraph143 ${resource.name} ${key} mismatch: expected ${expected[key]}, got ${value[key]}`)
    if (value.context && this.activeFrame?.context?.context && value.context !== this.activeFrame.context.context) throw new Error(`RenderGraph143 ${resource.name} context mismatch`)
    return value
  }
  externalOf(resource) { return this.externalBindings.get(resource?.id) }
  resolve(resource) {
    if (!resource || this.resources[resource.id] !== resource) throw new Error('RenderGraph143 resolve requires a graph resource')
    if (resource.kind === 'external') return this.externalBindings.get(resource.id)
    const value = this.activeFrame?.resourceValues?.get(resource.id); if (value !== undefined) return value
    const group = this.aliasGroups.find(candidate => candidate.resources.some(item => item.id === resource.id)); return group ? this.resolvePhysicalSlot(group) : undefined
  }
  _groupFor(resource) { return this.aliasGroups.find(candidate => candidate.resources.some(item => item.id === resource?.id)) }
  _ensureGroupLease(group) {
    if (!this.activeFrame || !this.transientAllocator || !group) return this.activeFrame?.groupLeases?.get(group?.index)
    const existing = this.activeFrame.groupLeases.get(group.index)
    if (existing) return existing
    const lease = this.transientAllocator.acquire({ ...group.descriptor }, group)
    if (!lease || typeof lease.release !== 'function') throw new Error(`RenderGraph143 allocator returned invalid lease for ${group.aliasSlot}`)
    this.activeFrame.groupLeases.set(group.index, lease)
    return lease
  }
  resolvePhysicalSlot(group) {
    const candidate = typeof group === 'number' ? this.aliasGroups[group] : typeof group === 'string' ? this.aliasGroups.find(item => item.aliasSlot === group) : group
    if (!candidate) return undefined
    const lease = this._ensureGroupLease(candidate); if (!lease) return undefined
    const value = lease.resource ?? lease.target ?? lease
    for (const resource of candidate.resources) this.activeFrame.resourceValues.set(resource.id, value)
    return value
  }
  trackLease(resource, lease) {
    if (!this.activeFrame) throw new Error('RenderGraph143 lease tracking requires an active frame')
    if (!resource || this.resources[resource.id] !== resource || resource.kind !== 'transient') throw new Error('RenderGraph143 leases require a transient resource')
    if (!lease || typeof lease.release !== 'function') throw new Error('RenderGraph143 invalid resource lease')
    const group = this._groupFor(resource); if (!group) throw new Error(`RenderGraph143 resource has no compiled alias group: ${resource.name}`)
    const existing = this.activeFrame.groupLeases.get(group.index)
    if (existing && existing !== lease) throw new Error(`RenderGraph143 alias group already leased: ${group.aliasSlot}`)
    if (!existing) this.activeFrame.groupLeases.set(group.index, lease)
    this.resolvePhysicalSlot(group); return lease
  }
  leaseOf(resource) { const group = this._groupFor(resource); return group ? this._ensureGroupLease(group) : undefined }
  _releaseFrameLeases() {
    const frame = this.activeFrame; if (!frame?.groupLeases) return
    for (const [index, lease] of [...frame.groupLeases.entries()].reverse()) { try { this.transientAllocator ? this.transientAllocator.release(lease, this.aliasGroups[index]) : lease.release() } catch {} frame.groupLeases.delete(index) }
    frame.resourceValues.clear()
  }
  reset() { if (this.activeFrame) throw new Error('RenderGraph143 cannot reset during an active frame'); this.resources = []; this.passes = []; this.compiled = null; this.lastHash = null; this.aliases = []; this.aliasGroups = []; this.culled = []; this.externalBindings = new Map(); this.activeFrame = null }
  _refreshTransientDescriptors(drawingBuffer) {
    if (!Number.isInteger(drawingBuffer?.width) || !Number.isInteger(drawingBuffer?.height)) return false
    let changed = false
    for (const resource of this.resources) {
      const scale = resource.kind === 'transient' && Number(resource.descriptor.scale)
      if (!(scale > 0)) continue
      const width = Math.max(1, Math.ceil(drawingBuffer.width * scale)), height = Math.max(1, Math.ceil(drawingBuffer.height * scale))
      if (resource.descriptor.width !== width || resource.descriptor.height !== height) { resource.descriptor.width = width; resource.descriptor.height = height; changed = true }
    }
    return changed
  }
  registerPassLifecycle(name, lifecycle = {}) { const pass = this.passes.find(candidate => candidate.name === name); if (!pass) throw new Error(`RenderGraph143 unknown pass: ${name}`); pass.lifecycle = { begin: lifecycle.begin, end: lifecycle.end }; return () => { if (pass.lifecycle) pass.lifecycle = undefined } }
  beginFrame(context = {}) {
    if (this.activeFrame) return this._diagnostics(this.lastHash)
    const drawingBuffer = context?.drawingBuffer || context?.scene && {
      width: context.scene.drawingBufferWidth, height: context.scene.drawingBufferHeight
    }
    this._refreshTransientDescriptors(drawingBuffer)
    const diagnostics = this.describe(); const frame = this.activeFrame = { number: ++this.frame, context, started: diagnostics.passes.slice(), executed: new Set(), groupLeases: new Map(), resourceValues: new Map() }
    try {
      if (this.transientAllocator?.resize && Number.isInteger(drawingBuffer?.width) && Number.isInteger(drawingBuffer?.height)) this.transientAllocator.resize(drawingBuffer.width, drawingBuffer.height)
      for (const pass of this.compiled) pass.lifecycle?.begin?.(context, pass)
    } catch (error) { this._releaseFrameLeases(); this.activeFrame = null; throw error }
    return this._diagnostics(this.lastHash)
  }
  endFrame(context = this.activeFrame?.context) {
    if (!this.activeFrame) return null
    let error; for (const pass of [...this.compiled].reverse()) try { pass.lifecycle?.end?.(context, pass) } catch (current) { error ||= current }
    this._releaseFrameLeases(); const completed = this.activeFrame; this.activeFrame = null; if (error) throw error; return { ...this._diagnostics(this.lastHash), frame: completed.number }
  }
  importResource(name, descriptor = {}) { assertName(name, 'resource'); const handle = { id: this.resources.length, name, kind: 'external', descriptor: { ...descriptor } }; this.resources.push(handle); return handle }
  createResource(name, descriptor = {}) { assertName(name, 'resource'); const handle = { id: this.resources.length, name, kind: 'transient', descriptor: { ...descriptor } }; this.resources.push(handle); return handle }
  addPass(name, setup, execute = null, { sideEffect = false, phase = 'external' } = {}) { assertName(name, 'pass'); if (this.passes.some(pass => pass.name === name)) throw new Error(`RenderGraph143 duplicate pass: ${name}`); const node = { name, index: this.passes.length, phase, reads: new Set(), writes: new Set(), sideEffect, execute }; const builder = { read: resource => this._use(node, resource, 'read'), write: resource => this._use(node, resource, 'write'), sideEffect: () => { node.sideEffect = true } }; setup?.(builder); this.passes.push(node); this.compiled = null; return node }
  _use(node, resource, type) { if (!resource || this.resources[resource.id] !== resource) throw new Error(`RenderGraph143 invalid resource in ${node.name}`); node[type === 'read' ? 'reads' : 'writes'].add(resource.id); return resource }
  compile() {
    const hash = this._hash(); if (this.compiled && this.lastHash === hash) return this._diagnostics(hash)
    const externalRoots = this.resources.filter(resource => resource.kind === 'external' && resource.descriptor.keepAlive === true).map(resource => resource.id)
    const needed = new Set([...externalRoots, ...this.externalBindings.keys()]), alive = new Set(); let changed = true
    while (changed) { changed = false; for (let index = this.passes.length - 1; index >= 0; index--) { const pass = this.passes[index]; if (alive.has(pass)) continue; if (pass.sideEffect || [...pass.writes].some(id => needed.has(id))) { alive.add(pass); changed = true; for (const id of pass.reads) needed.add(id) } } }
    const nodes = this.passes.filter(pass => alive.has(pass)), edges = new Map(nodes.map(pass => [pass, new Set()])), indegree = new Map(nodes.map(pass => [pass, 0])); const addEdge = (from, to) => { if (!from || from === to || edges.get(from).has(to)) return; edges.get(from).add(to); indegree.set(to, indegree.get(to) + 1) }
    const writers = new Map(); for (const pass of nodes) for (const id of pass.writes) { const list = writers.get(id) || []; list.push(pass); writers.set(id, list) }; for (const list of writers.values()) for (let i = 1; i < list.length; i++) addEdge(list[i - 1], list[i]); for (const reader of nodes) for (const id of reader.reads) { const list = writers.get(id) || []; if (!list.length) continue; const previous = list.filter(writer => writer.index < reader.index); addEdge(previous.length ? previous[previous.length - 1] : list[list.length - 1], reader) }
    const ready = nodes.filter(pass => indegree.get(pass) === 0), order = []; while (ready.length) { ready.sort((a, b) => a.index - b.index); const pass = ready.shift(); order.push(pass); for (const next of edges.get(pass)) { indegree.set(next, indegree.get(next) - 1); if (indegree.get(next) === 0) ready.push(next) } }; if (order.length !== nodes.length) throw new Error(`RenderGraph143 cyclic dependency: ${nodes.filter(pass => !order.includes(pass)).map(pass => pass.name).join(', ')}`)
    this.compiled = order; this.culled = this.passes.filter(pass => !alive.has(pass)).map(pass => pass.name); ({ aliases: this.aliases, groups: this.aliasGroups } = this._assignAliases(order)); this.lastHash = hash; return this._diagnostics(hash)
  }
  _assignAliases(order) {
    const ranges = new Map(); order.forEach((pass, index) => { for (const id of [...pass.reads, ...pass.writes]) { if (this.resources[id].kind !== 'transient') continue; const resource = this.resources[id], range = ranges.get(id) || { first: index, last: index }; range.last = index; if (resource.descriptor.keepAlive === true) range.last = order.length - 1; ranges.set(id, range) } }); const slots = [], groups = [], aliases = []
    for (const [id, range] of ranges) { const resource = this.resources[id], key = keyOf(resource.descriptor); let slot = slots.find(candidate => candidate.key === key && candidate.last < range.first); if (!slot) { slot = { key, index: slots.length, last: range.last, resources: [] }; slots.push(slot) } else slot.last = range.last; slot.resources.push(resource); const group = { index: groups.length, aliasSlot: `${key}#${slot.index}`, descriptor: { ...resource.descriptor }, resources: slot.resources.slice(), firstPass: order[range.first].name, lastPass: order[range.last].name, first: range.first, last: range.last }; groups.push(group); aliases.push({ resource: resource.name, aliasSlot: group.aliasSlot, firstPass: group.firstPass, lastPass: group.lastPass }) }
    const merged = []; for (const group of groups) { const target = merged.find(item => item.aliasSlot === group.aliasSlot); if (target) { target.resources.push(...group.resources); target.first = Math.min(target.first, group.first); target.last = Math.max(target.last, group.last); target.firstPass = order[target.first].name; target.lastPass = order[target.last].name } else merged.push({ ...group, resources: [...group.resources] }) }; merged.forEach((group, index) => { group.index = index }); const byName = new Map(merged.flatMap(group => group.resources.map(resource => [resource.name, group]))); for (const alias of aliases) { const group = byName.get(alias.resource); alias.aliasSlot = group.aliasSlot; alias.firstPass = group.firstPass; alias.lastPass = group.lastPass }; return { aliases, groups: merged }
  }
  _hash() { return JSON.stringify({ resources: this.resources.map(resource => [resource.kind, resource.name, resource.descriptor]), passes: this.passes.map(pass => [pass.name, [...pass.reads], [...pass.writes], pass.sideEffect, pass.phase]), bindings: [...this.externalBindings.keys()] }) }
  _diagnostics(hash) { return { label: this.label, frame: this.frame, activeFrame: this.activeFrame ? { number: this.activeFrame.number, started: [...this.activeFrame.started], executed: [...(this.activeFrame.executed || [])] } : null, hash, passes: this.compiled?.map(pass => pass.name) || [], culled: [...this.culled], aliases: [...this.aliases], aliasGroups: this.aliasGroups.map(group => ({ aliasSlot: group.aliasSlot, descriptor: { ...group.descriptor }, resources: group.resources.map(resource => resource.name), firstPass: group.firstPass, lastPass: group.lastPass })), logicalSlots: new Set(this.aliasGroups.map(group => group.aliasSlot)).size, physicalSlots: this.activeFrame ? new Set([...this.activeFrame.groupLeases?.keys() || []]).size : 0, feedbackConflicts: [], gpuTiming: this.gpuTimer ? { supported: this.gpuTimer.supported !== false, pending: this.gpuTimer.pending?.length || 0, samples: this.gpuTimer.samples?.slice(-64) || [], skipped: this.gpuTimer.skipped || 0, discarded: this.gpuTimer.discarded || 0 } : null, graphTransientActive: !!this.transientAllocator, allocatorMode: this.transientAllocator ? 'graph' : 'pool-fallback', resources: this.resources.map(resource => ({ name: resource.name, kind: resource.kind, bound: resource.kind === 'external' ? this.externalBindings.has(resource.id) : undefined, descriptor: { ...resource.descriptor } })) } }
  execute(context) { const diagnostics = this.beginFrame(context); try { if (this.executeExternal) for (const pass of this.compiled) this.executePass(pass.name, context) } finally { this.endFrame(context); this.reset() } return diagnostics }
  describe() { return this.compile() }
  toJSON() { return this.describe() }
  toMermaid() { this.describe(); const lines = ['flowchart LR']; for (const pass of this.compiled) { lines.push(`  ${pass.name}["${pass.name}"]`); for (const id of pass.reads) lines.push(`  ${this.resources[id].name} --> ${pass.name}`); for (const id of pass.writes) lines.push(`  ${pass.name} --> ${this.resources[id].name}`) } for (const name of this.culled) lines.push(`  ${name}["${name} (culled)"]`); return lines.join('\n') }
}
export function createRenderGraph143(options) { return new RenderGraph143(options) }
