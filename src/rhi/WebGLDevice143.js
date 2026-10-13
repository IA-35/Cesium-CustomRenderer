import { getRenderTargetPool } from '../pipeline/RenderTargetPool143.js'

// Small WebGL2 RHI boundary. Cesium remains the context owner; CCR owns leases and
// destruction of resources it creates through this adapter.
export default class WebGLDevice143 {
  constructor(C, scene) {
    if (!C || !scene?.context) throw new Error('WebGLDevice143 requires Cesium and scene context')
    this.C = C; this.scene = scene; this.context = scene.context
    this.pool = getRenderTargetPool(C, this.context)
    this.owner = { kind: 'rhi' }
    this.pool.attach(this.owner)
    this.resources = new Set(); this.destroyed = false
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
  track(resource) { if (resource?.release) this.resources.add(resource); return resource }
  getDiagnostics() { return { live: [...this.resources].filter(resource => !resource.released).length, pool: this.pool.getDiagnostics(), destroyed: this.destroyed } }
  destroy() {
    if (this.destroyed) return
    for (const resource of [...this.resources]) resource.release()
    this.resources.clear(); this.pool.detach(this.owner); this.destroyed = true
  }
}
