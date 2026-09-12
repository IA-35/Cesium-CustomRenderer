import LightFrustum from './LightFrustum.js'
import ShadowTarget from './ShadowTarget.js'
import ShadowReceiver143 from './ShadowReceiver143.js'
import ShadowCache from './ShadowCache.js'
import selectLightTiles from './CasterCommands143.js'

// Owns selection, depth rendering and receiving. Does not use Cesium.ShadowMap.
export default class DirectionalShadowPass {
  constructor(C, viewer, getOptions) {
    Object.assign(this, { C, viewer, scene: viewer.scene, getOptions, enabled: false, ready: false, dead: false })
    this.light = new LightFrustum(C, this.scene)
    this.cache = new ShadowCache()
    this.stats = { updates: 0, cacheHits: 0, casters: 0, receivers: 0, selectedOffscreen: 0, error: null }
    const uniforms = {
      campus_shadowDepth: () => this.target ? this.target.depth : this.scene.context.defaultTexture,
      campus_eyeToShadow: () => this.light.receiverMatrix(this.viewer.camera),
      campus_shadowParams: () => new C.Cartesian4(1 / (this.target ? this.target.size : 1),
        this.light.texelWorld || 1, this.light.depthSpan || 1, this.enabled && this.ready ? (this.debugReceiver ? 2 : 1) : 0)
    }
    this.adapter = new ShadowReceiver143(C, this.scene, uniforms)
    this.proxy = { update: state => this.update(state), isDestroyed: () => this.dead, destroy() {} }
    this.scene.primitives.add(this.proxy)
    this.removePreUpdate = this.scene.preUpdate.addEventListener(() => {
      if (this.enabled) this.scene.primitives.raiseToTop(this.proxy)
    })
    this.debugStage = this.scene.postProcessStages.add(new C.PostProcessStage({
      name: 'campus_custom_shadow_depth',
      fragmentShader: `uniform sampler2D shadowDepth; in vec2 v_textureCoordinates;
        void main() { float d = texture(shadowDepth, v_textureCoordinates).r; out_FragColor = vec4(vec3(d), 1.0); }`,
      uniforms: { shadowDepth: uniforms.campus_shadowDepth }
    }))
    this.debugStage.enabled = false
  }
  setOrigin(origin) { this.origin = this.C.Cartesian3.clone(origin); this.invalidate() }
  invalidate() { this.cache.invalidate(); this.ready = false }
  setEnabled(enabled) {
    if (this.dead || enabled === this.enabled) return
    this.enabled = enabled
    this.invalidate()
    if (enabled) this.adapter.install()
    else { this.adapter.detach(); this.debugStage.enabled = false }
    if (!this.viewer.isDestroyed()) this.scene.requestRender()
  }
  update(frameState) {
    if (!this.enabled || !this.origin || !frameState.passes.render) return
    const C = this.C
    const toLight = this.scene.light instanceof C.SunLight ? this.scene.context.uniformState.sunDirectionWC
      : C.Cartesian3.negate(this.scene.light.direction, new C.Cartesian3())
    if (C.Cartesian3.dot(toLight, this.origin) <= 0) { this.ready = false; return }
    const options = this.getOptions()
    this.light.update(this.origin, toLight, options.shadowDistance / 2, options.shadowSize)
    frameState.commandList.push({ pass: C.Pass.COMPUTE, execute: () => this.render(frameState) })
  }
  render(frameState) {
    const C = this.C, scene = this.scene, context = scene.context, uniforms = context.uniformState
    const viewport = C.BoundingRectangle.clone(uniforms.viewport)
    const camera = frameState.camera, commandList = frameState.commandList, cullingVolume = frameState.cullingVolume
    const lightCommands = [], mainCommands = new Set(commandList)
    try {
      const size = this.getOptions().shadowSize
      if (!this.target || this.target.size !== size) {
        if (this.target) this.target.destroy()
        this.target = new ShadowTarget(C, context, size)
      }
      const pass = new C.Cesium3DTilePassState({ pass: C.Cesium3DTilePass.SHADOW,
        camera: this.light.camera, cullingVolume: this.light.cullingVolume, commandList: lightCommands })
      selectLightTiles(scene.primitives, frameState, pass)
      frameState.commandList = commandList
      frameState.camera = camera
      frameState.cullingVolume = cullingVolume
      for (const command of lightCommands) {
        if (command.pass === C.Pass.COMPUTE) command.execute(scene._computeEngine)
      }
      let count = 0, offscreen = 0
      const casters = []
      for (const command of new Set([...commandList, ...lightCommands])) {
        if (!command.castShadows || !command.shaderProgram || command.pass === C.Pass.TRANSLUCENT) continue
        if (command.boundingVolume && this.light.cullingVolume.computeVisibility(command.boundingVolume) === C.Intersect.OUTSIDE) continue
        casters.push(this.adapter.cast(command, this.target.framebuffer, this.light.camera, camera))
        count++
        if (!mainCommands.has(command)) offscreen++
      }
      this.debugStage.enabled = this.getOptions().shadowDebug === true
      const key = this.getOptions().shadowStatic === true
        ? this.cache.signature(this.light.viewProjection, size, casters) : null
      if (this.ready && this.cache.matches(key)) { this.stats.cacheHits++; return }
      uniforms.updateCamera(this.light.camera)
      uniforms.viewport = this.target.passState.viewport
      this.target.clear.execute(context, this.target.passState)
      for (const command of casters) {
        uniforms.updatePass(command.pass)
        command.execute(context, this.target.passState)
      }
      this.cache.commit(key)
      this.ready = true
      Object.assign(this.stats, { updates: this.stats.updates + 1, casters: count,
        receivers: this.adapter.commands.size, selectedOffscreen: offscreen, error: null })
    } catch (error) {
      this.ready = false
      this.stats.error = error.message
      this.setEnabled(false)
      console.error('Custom directional shadow pass disabled:', error)
    } finally {
      frameState.commandList = commandList
      frameState.camera = camera
      frameState.cullingVolume = cullingVolume
      uniforms.updateCamera(camera)
      uniforms.viewport = viewport
      this.adapter.prune()
    }
  }
  destroy() {
    if (this.dead) return
    this.setEnabled(false)
    this.removePreUpdate()
    this.adapter.destroy()
    if (this.target) this.target.destroy()
    if (!this.viewer.isDestroyed()) {
      this.scene.primitives.remove(this.proxy)
      this.scene.postProcessStages.remove(this.debugStage)
    }
    this.dead = true
  }
}
