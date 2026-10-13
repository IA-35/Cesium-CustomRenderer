const coordinators = new WeakMap()
import { peekRenderTargetPool } from '../pipeline/RenderTargetPool143.js'

// Cesium 1.143: compose linear HDR inputs before the captured native execute chain.
function ensureCoordinator(native, scene) {
  let token = coordinators.get(native)
  if (token) return token
  token = { active: true, scene, entries: new Set(), orderedEntries: [], dirty: true, previous: native.execute, hook: undefined, graphs: new Set() }
  token.hook = function (...args) {
    const graphs = [...token.graphs].filter(graph => graph && !graph.destroyed)
    let started = []
    try {
      for (const graph of graphs) { graph.beginFrame({ scene: token.scene, context: args[0], args }); started.push(graph) }
      if (token.active) {
        const [context, , depth, id] = args
        if (token.dirty) {
          token.orderedEntries = [...token.entries].sort((a, b) => a.priority - b.priority)
          token.dirty = false
        }
        for (const entry of token.orderedEntries) if (entry.active) {
          const previous = args[1]
          args[1] = entry.process(context, previous, depth, id)
          if (args[1] !== previous) peekRenderTargetPool(context)?.releaseTexture(previous)
        }
      }
      return token.previous.apply(this, args)
    } finally {
      let error
      for (const graph of started.reverse()) { try { graph.endFrame({ scene: token.scene, context: args[0], args }) } catch (current) { error ||= current } }
      peekRenderTargetPool(args[0])?.releaseTexture(args[1])
      if (error) throw error
    }
  }
  native.execute = token.hook
  coordinators.set(native, token)
  return token
}

function retireIfUnused(native, token) {
  if (token.entries.size || token.graphs.size) return
  token.active = false
  coordinators.delete(native)
  if (native.execute === token.hook) native.execute = token.previous
}

export function attachHdrGraph(scene, graph) {
  if (!scene?.postProcessStages || !graph) throw new Error('attachHdrGraph requires { scene, graph }')
  const token = ensureCoordinator(scene.postProcessStages, scene)
  token.graphs.add(graph)
  return () => { token.graphs.delete(graph); retireIfUnused(scene.postProcessStages, token) }
}

export function registerHdrEffect(scene, priority, process) {
  const native = scene.postProcessStages
  const token = ensureCoordinator(native)
  const entry = { active: true, priority, process }
  token.entries.add(entry)
  token.dirty = true
  return () => {
    if (!entry.active) return
    entry.active = false
    token.entries.delete(entry)
    token.dirty = true
    retireIfUnused(native, token)
  }
}
