import GpuTimer from './GpuTimer.js'
import {peekRenderTargetPool} from '../pipeline/RenderTargetPool143.js'

// Explicit short diagnostic runs only; never installed by the business pipeline.
// Pass timings are sampled on different frames and must not be added as one frame.
export default class RenderProfiler143 {
  constructor(C, pipeline) {
    if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('RenderProfiler143 requires Cesium 1.143')
    this.scene = pipeline.viewer.scene
    this.pipeline = pipeline
    this.peakTextureBytes = 0
    this.peakUniformBufferBytes = 0
    this.timer = new GpuTimer(this.scene.context._gl)
    this.frames = []
    this.cpu = []
    this.hooks = []
    this.active = true
    this.labels = ['frame']
    this.drawCalls = 0
    this.index = 0
    for (const [label, target, method] of [
      ['shadow', pipeline.customShadow, 'render'],
      ['materials', pipeline.materialChannels, '_render'],
      ['hiz', pipeline.materialChannels && pipeline.materialChannels.depthPyramid, 'update'],
      ['occlusion', pipeline.occlusionCulling, 'query'],
      ['ssr', pipeline.screenSpaceReflections, '_execute'],
      ['transparentSsr', pipeline.transparentReflections, '_execute'],
      ['ao', pipeline.screenSpaceAO, '_execute'],
      ['bloom', pipeline.hdrBloom, '_execute'],
      ['environment', pipeline.environmentRenderer && pipeline.environmentRenderer.hdr, '_execute'],
      ['smaa', pipeline.smaa, '_execute'],
      ['fxaa', pipeline.fxaa, '_execute']
    ]) {
      if (!target) continue
      this.labels.push(label)
      this._wrap(target, method, invoke => this._measure(label, invoke))
    }
    this._wrap(this.scene.context, 'draw', invoke => { this.drawCalls++; return invoke() })
    this._wrap(this.scene, 'render', invoke => {
      this.timer.poll()
      this.selected = this.labels[this.index++ % this.labels.length]
      this.drawCalls = 0
      const start = performance.now()
      try { return this._measure('frame', invoke) } finally {
        this.frames.push({ milliseconds: performance.now() - start, drawCalls: this.drawCalls,
          submittedCommands: this.scene.frameState.commandList.length })
        this._textures()
        this.peakUniformBufferBytes = Math.max(this.peakUniformBufferBytes, this._uniformBuffers().currentBytes)
        // Bound diagnostic retention, even if a caller forgets to stop recording.
        if (this.frames.length >= 4096) this.destroy()
      }
    })
  }

  _measure(label, invoke) {
    const start = performance.now()
    try { return this.selected === label ? this.timer.measure(label, invoke) : invoke() } finally {
      this.cpu.push({ label, milliseconds: performance.now() - start })
    }
  }

  _wrap(target, key, run) {
    const previous = target[key], profiler = this
    const hook = function() {
      const invoke = () => previous.apply(this, arguments)
      return profiler.active ? run(invoke) : invoke()
    }
    target[key] = hook
    this.hooks.push({ target, key, previous, hook })
  }

  getReport() {
    this.timer.poll()
    return { scope: 'diagnostic-only; alternating GPU scopes, CPU submission is not GPU time',
      gpuSupported: this.timer.supported, gpu: [...this.timer.samples], cpu: [...this.cpu],
      frames: [...this.frames], textures: this._textures(), uniformBuffers: this._uniformBuffers(),
      occlusion: this.pipeline.getOcclusionDiagnostics?.(),
      pending: this.timer.pending.length, discarded: this.timer.discarded,
      skipped: this.timer.skipped, drawScope: 'Context.draw submissions; not unique objects or GPU primitives' }
  }

  _textures() {
    const p = this.pipeline, aa = p.smaa, env = p.environmentRenderer
    const entries = [], seen = new Set()
    const add = (name, texture) => {
      if (!texture || texture.isDestroyed() || seen.has(texture)) return
      seen.add(texture)
      entries.push({ name, width: texture.width, height: texture.height, bytes: texture.sizeInBytes })
    }
    const stage = (name, value) => {
      if (value && !value.isDestroyed()) add(name, value.outputTexture)
    }
    for(const entry of peekRenderTargetPool(this.scene.context)?.entries||[])add(`pool.${entry.id}`,entry.texture)
    if (p.hdrBloom && p.hdrBloom.stages) p.hdrBloom.stages.forEach((value, index) => stage(`bloom.${index}`, value))
    if(p.customShadow?.levels) p.customShadow.levels.forEach((level,index)=>add(`shadow.${index}.depth`,level.target.depth))
    else add('shadow.depth', p.customShadow && p.customShadow.target && p.customShadow.target.depth)
    const materials = p.materialChannels && p.materialChannels.target
    if (materials) for (const name of ['normalRoughMetal', 'emissiveFlags', 'eyeDepth', 'depthStencil', 'transparency', 'reflectionSpecular', 'reflectionResponse', 'opaqueColor', 'albedoOcclusion']) add(`materials.${name}`, materials[name])
    const pyramid = p.materialChannels && p.materialChannels.depthPyramid
    if (pyramid) pyramid.levels.forEach((level, index) => add(`hiz.${index}`, level.texture))
    if (p.screenSpaceReflections && p.screenSpaceReflections.stages) {
      for (const [name, value] of Object.entries(p.screenSpaceReflections.stages)) stage(`ssr.${name}`, value)
    }
    const transparent = p.transparentReflections && p.transparentReflections.target
    if (transparent) for (const name of ['delta', 'output']) add(`transparentSsr.${name}`, transparent[name])
    if (p.screenSpaceAO && p.screenSpaceAO.stages) {
      for (const [name, value] of Object.entries(p.screenSpaceAO.stages)) stage(`ao.${name}`, value)
    }
    stage('grading', p.color)
    if (aa) {
      add('smaa.area', aa.areaTexture); add('smaa.search', aa.searchTexture)
      for (const [name, value] of Object.entries(aa.stages || {})) stage(`smaa.${name}`, value)
    }
    if (env) {
      add('environment.noise', env.noise)
      for (const name of ['raymarchStage', 'resolveStage']) stage(`environment.${name}`, env.stages && env.stages[name])
    }
    const currentBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    this.peakTextureBytes = Math.max(this.peakTextureBytes, currentBytes)
    return { scope: 'known pipeline textures only; excludes native MSAA, assets, driver storage and transient allocations',
      currentBytes, peakBytes: this.peakTextureBytes, entries }
  }

  _uniformBuffers() {
    const entries = [], seen = new Set()
    const add = (name, buffer) => {
      if (!buffer || buffer.isDestroyed() || seen.has(buffer)) return
      seen.add(buffer)
      const { bytes, uploads, uploadedBytes } = buffer.getDiagnostics()
      entries.push({ name, bytes, uploads, uploadedBytes })
    }
    for (const [name, pass] of [['ao',this.pipeline.screenSpaceAO],['ssr', this.pipeline.screenSpaceReflections], ['transparentSsr', this.pipeline.transparentReflections]]) {
      if (!pass) continue
      add(`${name}.camera`, pass.cameraUniforms && pass.cameraUniforms.buffer)
      add(`${name}.reflection`, pass.reflectionUniforms)
    }
    for(const [name,pass]of [['shadow',this.pipeline.customShadow],['deferred',this.pipeline.deferredLighting],['transparent',this.pipeline.transparentForward]])add(name+'.sun',pass?.sunUniforms?.buffer)
    add('environment.frame',this.pipeline.environmentRenderer?.frameUniforms)
    return { scope: 'CCR camera, solar and effect blocks; shared storage counted once',
      currentBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), peakBytes: this.peakUniformBufferBytes, entries }
  }

  destroy() {
    if (!this.active) return
    this.active = false
    for (const { target, key, previous, hook } of this.hooks.reverse()) {
      if (target[key] === hook) target[key] = previous
    }
    this.hooks = []
    this.timer.destroy()
  }
}
