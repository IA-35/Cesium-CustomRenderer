// Native selected silhouettes run after TAA. Their ID mask is already unjittered,
// but EdgeDetection also reads depth; the main color depth is still jittered.
// Reuse the matching ID-pass depth only for these edges, without another draw pass.
import { selectedIdFramebufferOf, usesPostProcessSelected } from '../scene/cesiumPrivate143.js'
export function attachTaaSelectionDepth(scene, isActive) {
  const collection = scene.postProcessStages, previous = collection.execute
  let active = true
  function hook(...args) {
    if (!active) return previous.apply(this, args)
    const restores = []
    const visit = stage => {
      if (typeof stage.get === 'function') {
        for (let i = 0; i < stage.length; i++) visit(stage.get(i))
        return
      }
      if (!stage.name?.startsWith('czm_edge_detection_') || !stage.uniforms || !('length' in stage.uniforms)) return
      const hadOwn = Object.prototype.hasOwnProperty.call(stage, 'execute'), execute = stage.execute
      const wrapper = function(context, color, depth, id) {
        const framebuffer = selectedIdFramebufferOf(scene)
        const stableDepth = framebuffer?.depthStencilTexture
        if (isActive() && usesPostProcessSelected(scene) &&
            this._combinedSelected?.length && stableDepth && !stableDepth.isDestroyed() &&
            id === framebuffer.getColorTexture(0)) depth = stableDepth
        return execute.call(this, context, color, depth, id)
      }
      stage.execute = wrapper
      restores.push(() => {
        if (stage.execute !== wrapper) return
        if (hadOwn) stage.execute = execute
        else delete stage.execute
      })
    }
    try {
      visit(collection)
      return previous.apply(this, args)
    } finally {
      for (const restore of restores) restore()
    }
  }
  collection.execute = hook
  return () => {
    active = false
    if (collection.execute === hook) collection.execute = previous
  }
}
