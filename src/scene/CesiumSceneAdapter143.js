import { createFrameState143 } from '../core/FrameState143.js'
import { createRenderItem143, sortRenderItems143 } from '../renderer/RenderItem143.js'

// Cesium scene adapter: reads scene/frame data and never allocates CCR targets.
export default class CesiumSceneAdapter143 {
  constructor(C, scene) { this.C = C; this.scene = scene; this.generation = 0 }
  snapshot() { return createFrameState143(this.scene, { generation: ++this.generation }) }
  collect(commands = [], frameState = this.snapshot()) {
    const translucent = this.C.Pass?.TRANSLUCENT
    return sortRenderItems143(commands.map(command => createRenderItem143(command, {
      frameState,
      pass: command.pass === translucent ? 'transparent.forward' : 'native.forward',
      pipelineKey: command.shaderProgram?.id || command.shaderProgram?._id || '',
      sortKey: command.owner?.id || 0,
    })))
  }
}
