import { getRenderTargetPool } from '../pipeline/RenderTargetPool143.js'

export function resolveTransientPixelFormat143(C, value) {
  const format = C?.PixelFormat || {}
  if (value === format.RED || String(value) === String(format.RED)) return format.RED
  if (value === format.RGBA || String(value) === String(format.RGBA)) return format.RGBA
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().replace(/[-_]/g, '')
    if (normalized === 'red' || normalized === 'r16f' || normalized === 'r32f' || normalized === 'redinteger') return format.RED
    if (normalized === 'rgba' || normalized === 'rgba8' || normalized === 'rgba16f' || normalized === 'rgba32f') return format.RGBA
  }
  return format.RGBA
}

export function resolveTransientPixelDatatype143(C, value) {
  const datatype = C?.PixelDatatype || {}
  if (value === datatype.FLOAT || String(value) === String(datatype.FLOAT)) return datatype.FLOAT
  if (value === datatype.HALF_FLOAT || String(value) === String(datatype.HALF_FLOAT)) return datatype.HALF_FLOAT
  if (value === datatype.UNSIGNED_BYTE || String(value) === String(datatype.UNSIGNED_BYTE)) return datatype.UNSIGNED_BYTE
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().replace(/[-_]/g, '')
    if (normalized === 'float' || normalized === 'float32' || normalized === 'r32f' || normalized === 'rgba32f') return datatype.FLOAT
    if (normalized === 'halffloat' || normalized === 'float16' || normalized === 'r16f' || normalized === 'rgba16f') return datatype.HALF_FLOAT
    if (normalized === 'ubyte' || normalized === 'unsignedbyte' || normalized === 'rgba8') return datatype.UNSIGNED_BYTE
  }
  return datatype.UNSIGNED_BYTE
}

// Small WebGL2 RHI boundary. Cesium remains the context owner; CCR owns leases and
// destruction of resources it creates through this adapter.
export default class WebGLDevice143 {
  constructor(C, scene) {
    if (!C || !scene?.context) throw new Error('WebGLDevice143 requires Cesium and scene context')
    this.C = C; this.scene = scene; this.context = scene.context
    this.pool = getRenderTargetPool(C, this.context)
    this.owner = { kind: 'rhi' }
    this.pool.attach(this.owner)
    this.resources = new Set(); this.transientOwners = new Set(); this.destroyed = false
  }
  createTexture(spec = {}) {
    if (this.destroyed) throw new Error('WebGLDevice143 is destroyed')
    const texture = new this.C.Texture({ context: this.context, ...spec })
    const resource = { texture, released: false, release: () => { if (!resource.released) { resource.released = true; if (!texture.isDestroyed?.()) texture.destroy(); this.resources.delete(resource) } } }
    this.resources.add(resource)
    return resource
  }
  createFramebuffer(textures, spec = {}) {
    if (this.destroyed) throw new Error('WebGLDevice143 is destroyed')
    const framebuffer = new this.C.Framebuffer({ context: this.context, colorTextures: textures, destroyAttachments: false, ...spec })
    const resource = { framebuffer, released: false, release: () => { if (!resource.released) { resource.released = true; if (!framebuffer.isDestroyed?.()) framebuffer.destroy(); this.resources.delete(resource) } } }
    this.resources.add(resource)
    return resource
  }
  createRenderTarget(spec = {}) {
    if (this.destroyed) throw new Error('WebGLDevice143 is destroyed')
    const lease = this.pool.acquire(this.owner, { context: this.context, ...spec })
    const resource = { lease, texture: lease.texture, framebuffer: lease.framebuffer, spec: { ...spec }, released: false }
    resource.release = () => { if (!resource.released) { resource.released = true; lease.release(); this.resources.delete(resource) } }
    this.resources.add(resource)
    return resource
  }
  createTransientAllocator(label = 'graph') {
    if (this.destroyed) throw new Error('WebGLDevice143 is destroyed')
    const owner = { kind: `rhi.${label}` }
    this.pool.attach(owner); this.transientOwners.add(owner)
    return {
      resize: (width, height) => this.pool.resize(width, height),
      acquire: (descriptor = {}) => this.pool.acquire(owner, { context: this.context,
        width: descriptor.width, height: descriptor.height,
        pixelFormat: resolveTransientPixelFormat143(this.C, descriptor.pixelFormat ?? descriptor.format),
        // datatype 也要走 format 回退：`{ format: 'rgba16f' }` 这种只写格式简写的
        // 描述此前拿到 undefined → 兜底成 UNSIGNED_BYTE，HDR/深度资源被静默降级。
        pixelDatatype: resolveTransientPixelDatatype143(this.C, descriptor.pixelDatatype ?? descriptor.datatype ?? descriptor.format),
        samples: descriptor.samples ?? 1, depth: !!descriptor.depth }),
      release: lease => lease?.release?.(),
      getDiagnostics: () => ({ mode: 'graph', owner: owner.kind, pool: this.pool.getDiagnostics() }),
      destroy: () => { if (this.transientOwners.delete(owner)) this.pool.detach(owner) },
    }
  }
  getDiagnostics() { return { live: [...this.resources].filter(resource => !resource.released).length, pool: this.pool.getDiagnostics(), destroyed: this.destroyed } }
  destroy() {
    if (this.destroyed) return
    for (const resource of [...this.resources]) resource.release()
    for (const owner of [...this.transientOwners]) { this.pool.detach(owner); this.transientOwners.delete(owner) }
    this.resources.clear(); this.pool.detach(this.owner); this.destroyed = true
  }
}
