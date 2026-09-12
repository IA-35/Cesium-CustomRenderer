import UniformBuffer143 from './UniformBuffer143.js'

export const LIGHT_CAPACITY = 128
export const lightBlockGLSL = `
struct CampusLight {
  vec4 positionRadius;
  vec4 colorIntensity;
  vec4 directionOuter;
  vec4 parameters;
};
layout(std140) uniform CampusLights {
  vec4 campusLightHeader;
  CampusLight campusLights[128];
};
`

const finiteVector = value => value && value.length === 3 && [0, 1, 2].every(index => Number.isFinite(value[index]))

function validateLight(light) {
  if (!light || !['point', 'spot'].includes(light.type) || !finiteVector(light.position) ||
    !finiteVector(light.color) || light.color.some(value => value < 0) ||
    !Number.isFinite(light.intensity) || light.intensity < 0 || !Number.isFinite(light.radius) || light.radius <= 0) {
    throw new Error('Invalid point or spot light')
  }
  if (light.type === 'spot' && (!finiteVector(light.direction) || !light.direction.some(value => value !== 0) ||
    !Number.isFinite(light.innerCos) || !Number.isFinite(light.outerCos) ||
    light.innerCos > 1 || light.outerCos < -1 || light.innerCos < light.outerCos)) {
    throw new Error('Invalid spot light direction or cone')
  }
}

export default class LightUniforms143 {
  constructor(C, context) {
    this.C = C
    this.data = new Float32Array(4 + LIGHT_CAPACITY * 16)
    this.buffer = new UniformBuffer143(context._gl, this.data.byteLength)
    this.count = 0
    this.nextOffset = 0
  }

  update(lights, offset, viewMatrix) {
    if (this.isDestroyed()) throw new Error('Light uniform buffer is destroyed')
    if (!Array.isArray(lights) || !Number.isSafeInteger(offset) || offset < 0 || offset > lights.length) {
      throw new Error('Invalid light page offset')
    }
    if (!viewMatrix || !Array.from({ length: 16 }, (_, index) => viewMatrix[index]).every(Number.isFinite)) {
      throw new Error('Invalid light view matrix')
    }
    const count = Math.min(LIGHT_CAPACITY, lights.length - offset)
    for (let index = 0; index < count; index++) validateLight(lights[offset + index])
    // Stage the entire page so validation/conversion failures preserve published
    // CPU data and GPU contents, and shorter pages erase every unused slot.
    const next = new Float32Array(this.data.length), C = this.C, vector = new C.Cartesian3()
    next[0] = count
    for (let index = 0; index < count; index++) {
      const light = lights[offset + index], base = 4 + index * 16, spot = light.type === 'spot'
      C.Cartesian3.fromArray(light.position, 0, vector)
      C.Matrix4.multiplyByPoint(viewMatrix, vector, vector)
      next.set([vector.x, vector.y, vector.z, light.radius], base)
      next.set([...light.color, light.intensity], base + 4)
      if (spot) {
        C.Cartesian3.fromArray(light.direction, 0, vector)
        // Direction length has no meaning; scale before squared-length
        // normalization so finite tiny/large inputs cannot underflow/overflow.
        C.Cartesian3.divideByScalar(vector, Math.max(Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z)), vector)
        C.Matrix4.multiplyByPointAsVector(viewMatrix, vector, vector)
        C.Cartesian3.normalize(vector, vector)
        next.set([vector.x, vector.y, vector.z, light.outerCos], base + 8)
      } else next.set([0, 0, -1, -1], base + 8)
      next.set([spot ? 1 : 0, spot ? light.innerCos : 0, 0, 0], base + 12)
    }
    for (let index = 0; index < count; index++) {
      if (!(next[4 + index * 16 + 3] > 0)) throw new Error('Light radius underflows positive float range')
    }
    if (!next.every(Number.isFinite)) throw new Error('Light data exceeds finite float range')
    const uploadedBytes = this.buffer.update(next)
    this.data.set(next)
    this.count = count
    this.nextOffset = offset + count
    return { count, nextOffset: this.nextOffset, uploadedBytes }
  }

  getDiagnostics() {
    return { ...this.buffer.getDiagnostics(), capacity: LIGHT_CAPACITY, count: this.count, nextOffset: this.nextOffset }
  }
  isDestroyed() { return this.buffer.isDestroyed() }
  destroy() { this.buffer.destroy() }
}
