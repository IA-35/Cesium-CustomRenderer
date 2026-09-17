const coordinators = new WeakMap()
import {peekRenderTargetPool} from '../pipeline/RenderTargetPool143.js'

// Cesium 1.143: compose linear HDR inputs before the captured native execute chain.
export function registerHdrEffect(scene, priority, process) {
  const native = scene.postProcessStages
  let token = coordinators.get(native)
  if (!token) {
    token = { active: true, entries: new Set(), previous: native.execute, hook: undefined }
    token.hook = function(...args) {
      try{
      if (token.active) {
        const [context, , depth, id] = args
        const entries = [...token.entries].sort((a, b) => a.priority - b.priority)
        for (const entry of entries) {
          if (entry.active) {
            const previous=args[1]
            args[1] = entry.process(context, previous, depth, id)
            if(args[1]!==previous)peekRenderTargetPool(context)?.releaseTexture(previous)
          }
        }
      }
      return token.previous.apply(this, args)}
      finally{peekRenderTargetPool(args[0])?.releaseTexture(args[1])}
    }
    native.execute = token.hook
    coordinators.set(native, token)
  }
  // Entry identity permits registering the same callback more than once.
  const entry = { active: true, priority, process }
  token.entries.add(entry)
  return () => {
    if (!entry.active) return
    entry.active = false
    token.entries.delete(entry)
    if (token.entries.size) return
    // Retired hooks may remain inside foreign wrappers, but must never reactivate.
    token.active = false
    coordinators.delete(native)
    if (native.execute === token.hook) native.execute = token.previous
  }
}
