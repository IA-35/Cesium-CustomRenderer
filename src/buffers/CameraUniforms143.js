import UniformBuffer143 from './UniformBuffer143.js'

export const cameraBlockGLSL = `
layout(std140) uniform CampusCamera {
  mat4 campusProjection;
  mat4 campusInverseProjection;
  vec4 campusViewport;
  vec4 campusClip;
};
`

const owners = new WeakMap()

export function acquireCameraUniforms(C, scene) {
  let owner = owners.get(scene)
  if (!owner) {
    owner = { inverse: new C.Matrix4(), data: new Float32Array(40), references: 0,
      buffer: new UniformBuffer143(scene.context._gl, 160) }
    owners.set(scene, owner)
  }
  owner.references++
  let released = false
  return {
    buffer: owner.buffer,
    data: owner.data,
    update() {
      if (released) throw new Error('Camera uniform lease is released')
      // Main-camera projection stays independent of the active replay frustum.
      // Read it each call: camera changes can occur within the same frame.
      const frustum = scene.camera.frustum, projection = frustum.projectionMatrix
      C.Matrix4.inverse(projection, owner.inverse)
      for (let i = 0; i < 16; i++) {
        owner.data[i] = projection[i]
        owner.data[i + 16] = owner.inverse[i]
      }
      owner.data.set([0, 0, scene.drawingBufferWidth, scene.drawingBufferHeight, frustum.near, frustum.far, 0, 0], 32)
      return owner.buffer.update(owner.data)
    },
    getDiagnostics() {
      return { ...owner.buffer.getDiagnostics(), references: owner.references, released }
    },
    release() {
      if (released) return
      released = true
      owner.references--
      if (owner.references === 0) {
        owners.delete(scene)
        owner.buffer.destroy()
      }
    }
  }
}
