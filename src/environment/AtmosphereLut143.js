/* Hillaire atmosphere LUT scheduling adapted from webgpu-cesium, Apache-2.0.
 * See reference/hillaire/NOTICE.md. Cesium owns the WebGL context. */
import { PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M, RAYLEIGH_BETA, MIE_BETA, ABSORPTION_BETA,
  RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT, OZONE_CENTER_HEIGHT, OZONE_FALLOFF, MIE_G } from './atmosphereScattering143.js'
import { hillaireTransmittanceShader, hillaireMultipleScatteringShader, hillaireSkyViewShader } from './hillaireAtmosphereGLSL143.js'

export const ATMOSPHERE_LUT_SIZES = Object.freeze({ transmittance: [256, 64], multipleScattering: [32, 32], skyView: [192, 108] })
const shaders = { transmittance: hillaireTransmittanceShader, multipleScattering: hillaireMultipleScatteringShader, skyView: hillaireSkyViewShader }
const passKeys = { transmittance: 'atmosphere.transmittanceLut', multipleScattering: 'atmosphere.multiscatterLut', skyView: 'atmosphere.skyViewLut' }
const components = (v, fallback) => fallback.map((value, index) => v?.[index] ?? v?.[['x', 'y', 'z', 'w'][index]] ?? value)
const finite = values => values.every(Number.isFinite)

// Public inputs use metres and the camera's planet-centred tangent-sphere
// coordinates. Symmetry makes sky depend only on altitude and sun elevation;
// camera rotation and the absolute ENU frame do not invalidate it.
export function atmosphereLutParameters(params = {}) {
  const radiiScale = components(params.atmosphereParams, [PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M, 1 / MIE_SCALE_HEIGHT, 1 / RAYLEIGH_SCALE_HEIGHT])
  const origin = components(params.atmoOrigin, [0, 0, radiiScale[0] + 1])
  const sun = components(params.sunLocal, [0, 0, 1])
  const radius = Math.hypot(...origin), sunLength = Math.hypot(...sun)
  const mie = components(params.atmosphereMieParameters, [1, MIE_G])
  const medium = {
    radii: radiiScale.slice(0, 2), densityScale: radiiScale.slice(2, 4), mie,
    rayleighBeta: components(params.rayleighBeta, RAYLEIGH_BETA),
    mieBeta: typeof params.mieBeta === 'number' ? [params.mieBeta, params.mieBeta, params.mieBeta] : components(params.mieBeta, [MIE_BETA, MIE_BETA, MIE_BETA]),
    absorptionBeta: components(params.absorptionBeta, ABSORPTION_BETA),
    ozone: components(params.ozone, [OZONE_CENTER_HEIGHT, OZONE_FALLOFF]),
    groundAlbedo: components(params.groundAlbedo, [0.3, 0.3, 0.3]), modelVersion: params.modelVersion ?? 1
  }
  if (!finite([...radiiScale, ...origin, ...sun, ...mie, ...medium.rayleighBeta, ...medium.mieBeta, ...medium.absorptionBeta, ...medium.ozone, ...medium.groundAlbedo]) ||
    radiiScale[0] <= 0 || radiiScale[1] <= radiiScale[0] || radiiScale[2] <= 0 || radiiScale[3] <= 0 || radius <= 0 || sunLength <= 0 ||
    mie[0] < 0 || Math.abs(mie[1]) >= 1 || [...medium.rayleighBeta, ...medium.mieBeta, ...medium.absorptionBeta].some(x => x < 0)) throw new Error('Invalid atmosphere LUT medium or camera')
  const skyRadius = Math.max(radiiScale[0] + 1, radius) * 0.001
  const sunCosine = Math.max(-1, Math.min(1, origin.reduce((sum, v, i) => sum + v * sun[i], 0) / (radius * sunLength)))
  // Rounding only discards floating point frame-transform noise (sub-mm height,
  // sub-microradian sun changes). Keys are committed after every pass succeeds.
  const sky = [Number(skyRadius.toFixed(6)), Number(sunCosine.toFixed(8))]
  const mediumKey = JSON.stringify(medium)
  return { medium, sky, keys: { medium: mediumKey, sky: `${mediumKey}|${sky.join(',')}` } }
}

export default class AtmosphereLut143 {
  constructor(C, scene, { rhi, runPass = (_key, execute) => execute() } = {}) {
    this.C = C; this.scene = scene; this.context = scene?.context; this.rhi = rhi
    this.runPass = runPass
    this.destroyed = false; this.valid = false; this.error = null
    this.targets = []; this.resources = []; this.commands = {}; this.states = {}
    this.published = {}; this.keys = {}; this.committed = null; this.pending = null
    this.stats = { updates: 0, transmittance: 0, multipleScattering: 0, skyView: 0, failures: 0, cacheHits: 0 }
  }

  get supported() {
    const context = this.context
    return !!(context?.webgl2 && ((context.halfFloatingPointTexture && context.colorBufferHalfFloat) ||
      (context.floatingPointTexture && context.colorBufferFloat)))
  }
  get ready() { return this.valid && !this.destroyed && !this.scene?.isDestroyed?.() && !this.context?._gl?.isContextLost?.() }
  getTextures() { return { ...this.published } }

  _uniforms(getState, getTextures) {
    const C = this.C
    const vec2 = values => new C.Cartesian2(...values)
    const vec3 = values => new C.Cartesian3(...values)
    return {
      u_lutAtmosphereRadii: () => vec2(getState().medium.radii),
      u_lutDensityScale: () => vec2(getState().medium.densityScale),
      u_lutMie: () => vec2(getState().medium.mie),
      u_lutRayleighBeta: () => vec3(getState().medium.rayleighBeta),
      u_lutMieBeta: () => vec3(getState().medium.mieBeta),
      u_lutAbsorptionBeta: () => vec3(getState().medium.absorptionBeta),
      u_lutOzone: () => vec2(getState().medium.ozone),
      u_lutGroundAlbedo: () => vec3(getState().medium.groundAlbedo),
      u_lutSkyParameters: () => vec2(getState().sky),
      u_lutManualFiltering: () => this.manualFiltering,
      u_atmosphereTransmittanceLut: () => getTextures().transmittance,
      u_atmosphereMultipleScatteringLut: () => getTextures().multipleScattering,
      u_atmosphereSkyViewLut: () => getTextures().skyView
    }
  }

  getUniformMap() {
    if (!this.uniformMap) this.uniformMap = this._uniforms(() => this.committed || atmosphereLutParameters(), () => this.published)
    return this.uniformMap
  }

  _releaseTargets() {
    for (const resource of this.resources.reverse()) resource.release()
    this.resources = []; this.targets = []
    for (const state of Object.values(this.states)) this.C.RenderState.removeFromCache(state)
    this.states = {}
  }

  _releaseCommands() {
    for (const command of Object.values(this.commands)) if (command.shaderProgram && !command.shaderProgram.isDestroyed?.()) command.shaderProgram.destroy()
    this.commands = {}
  }

  _allocate(context, pixelDatatype) {
    const C = this.C
    this.manualFiltering = pixelDatatype === C.PixelDatatype.FLOAT
      ? context.textureFloatLinear === false : context.textureHalfFloatLinear === false
    const sampler = new C.Sampler({ minificationFilter: this.manualFiltering ? C.TextureMinificationFilter.NEAREST : C.TextureMinificationFilter.LINEAR,
      magnificationFilter: this.manualFiltering ? C.TextureMagnificationFilter.NEAREST : C.TextureMagnificationFilter.LINEAR,
      wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE })
    const own = (object, property) => {
      const resource = { [property]: object, release() { if (!object.isDestroyed?.()) object.destroy() } }
      this.resources.push(resource); return resource
    }
    for (let version = 0; version < 2; version++) {
      const target = {}; this.targets.push(target)
      for (const [name, [width, height]] of Object.entries(ATMOSPHERE_LUT_SIZES)) {
        const spec = { context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype, sampler, flipY: false }
        let textureResource
        if (this.rhi) { textureResource = this.rhi.createTexture(spec); this.resources.push(textureResource) }
        else textureResource = own(new C.Texture(spec), 'texture')
        const texture = textureResource.texture
        let framebufferResource
        if (this.rhi) { framebufferResource = this.rhi.createFramebuffer([texture]); this.resources.push(framebufferResource) }
        else framebufferResource = own(new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false }), 'framebuffer')
        const framebuffer = framebufferResource.framebuffer
        if (framebuffer.status !== context._gl.FRAMEBUFFER_COMPLETE) throw new Error(`Atmosphere ${name} framebuffer incomplete`)
        target[name] = { texture, framebuffer }
        if (!this.states[name]) this.states[name] = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, width, height), depthTest: { enabled: false }, depthMask: false })
      }
    }
    this.pixelDatatype = pixelDatatype
  }

  _ensure(context) {
    if (this.targets.length === 2) return
    const C = this.C
    if (context.halfFloatingPointTexture && context.colorBufferHalfFloat) {
      try { this._allocate(context, C.PixelDatatype.HALF_FLOAT); return }
      catch (error) { this._releaseTargets(); if (!(context.floatingPointTexture && context.colorBufferFloat)) throw error }
    }
    try { this._allocate(context, C.PixelDatatype.FLOAT) }
    catch (error) { this._releaseTargets(); throw error }
  }

  update(context = this.context, params = {}) {
    if (this.destroyed || this.scene?.isDestroyed?.()) return false
    if (context !== this.context) { this.error = 'Atmosphere LUT context changed'; return false }
    if (context._gl.isContextLost?.()) {
      this._releaseTargets(); this._releaseCommands()
      this.valid = false; this.published = {}; this.committed = null; this.keys = {}
      this.error = 'Atmosphere LUT context lost'
      return false
    }
    if (!this.supported) return false
    const C = this.C, gl = context._gl
    const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
    const cachedFramebuffer = context._currentFramebuffer
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      const next = atmosphereLutParameters(params)
      const mediumDirty = !this.valid || this.keys.medium !== next.keys.medium
      const skyDirty = mediumDirty || this.keys.sky !== next.keys.sky
      if (!skyDirty) { this.stats.cacheHits++; return true }
      this._ensure(context)
      // Each attachment has its own front/back index: a sky-only update can
      // swap Sky without forcing expensive T/M recomputation. Never render into
      // any currently published attachment, even after mixed update sequences.
      const nextTextures = { ...this.published }, passes = mediumDirty ? Object.keys(shaders) : ['skyView']
      this.pending = next; this.pendingTextures = nextTextures
      const passState = new C.PassState(context)
      for (const name of passes) {
        const target = this.targets.find(version => version[name].texture !== this.published[name])[name]
        if (!this.commands[name]) this.commands[name] = context.createViewportQuadCommand(shaders[name], {
          uniformMap: this._uniforms(() => this.pending, () => this.pendingTextures), owner: this })
        const command = this.commands[name]
        command.framebuffer = passState.framebuffer = target.framebuffer
        command.renderState = this.states[name]; passState.viewport = this.states[name].viewport
        if (target.framebuffer.status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Atmosphere ${name} framebuffer incomplete`)
        // Cesium 1.143's status getter binds/unbinds raw GL without repairing
        // Context's binding cache. Force the real draw to bind its target.
        context._currentFramebuffer = undefined
        let executed = false
        const result = this.runPass(passKeys[name], () => { command.execute(context, passState); executed = true; return true })
        if (!executed || result === false) throw new Error(`Atmosphere ${name} pass did not complete`)
        const error = gl.getError?.()
        if (error !== undefined && error !== (gl.NO_ERROR ?? 0)) throw new Error(`Atmosphere ${name} WebGL error ${error}`)
        nextTextures[name] = target.texture
      }
      // Atomic publication includes medium uniforms, texture references and
      // invalidation state; failures above leave the last complete set intact.
      this.published = nextTextures; this.committed = next; this.keys = next.keys
      this.valid = true; this.error = null; this.stats.updates++
      for (const name of passes) this.stats[name]++
      return true
    } catch (error) {
      this.error = error.message; this.stats.failures++
      return this.ready
    } finally {
      this.pending = null; this.pendingTextures = null
      context.uniformState.viewport = viewport
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
      context._currentFramebuffer = cachedFramebuffer
    }
  }

  getDiagnostics() {
    return { supported: this.supported, ready: this.ready, valid: this.valid, destroyed: this.destroyed,
      model: 'Hillaire-2020-2D', radiance: 'per-unit-incoming-solar-radiance', sizes: ATMOSPHERE_LUT_SIZES,
      format: this.pixelDatatype === this.C.PixelDatatype.HALF_FLOAT ? 'rgba16f' : this.pixelDatatype ? 'rgba32f' : null,
      keys: { ...this.keys }, stats: { ...this.stats }, error: this.error,
      bytes: this.targets.length * Object.values(ATMOSPHERE_LUT_SIZES).reduce((sum, [w, h]) => sum + w * h *
        (this.pixelDatatype === this.C.PixelDatatype.HALF_FLOAT ? 8 : 16), 0) }
  }

  isDestroyed() { return this.destroyed }
  destroy() {
    if (this.destroyed) return
    this._releaseTargets()
    this._releaseCommands()
    this.published = {}; this.committed = null; this.keys = {}; this.valid = false; this.destroyed = true
  }
}
