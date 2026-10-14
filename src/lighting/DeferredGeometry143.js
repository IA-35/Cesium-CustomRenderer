import { materialSources } from '../channels/materialShader143.js'
import { invalidMaterialSources, transparencySources } from '../channels/MaterialChannels143.js'
import { materialTargetSupport } from '../channels/MaterialTarget143.js'
import DepthPyramid143 from '../channels/DepthPyramid143.js'
import {keepPrimitiveLast} from '../pipeline/PrimitiveOrder143.js'

// One fullscreen lighting draw is issued for every distinct model environment
// texture. Beyond this budget the deferred path costs more than native enhanced
// lighting, even when the models occupy only a small part of the viewport.
const MAX_DEFERRED_LIGHTING_GROUPS = 32

// Compact layout v1: four color outputs. Group IDs occupy bits 10..23 of FLOAT
// emissiveFlags.a; the low ten bits retain the existing material flags contract.
export function compactMaterialSources(C, source, forceInvalid = false) {
  const nativeStyling = C._shadersCPUStylingStageFS && source.fragmentShaderSource.sources.some(s => s.includes(C._shadersCPUStylingStageFS.trim()))
  const material = materialSources(C, source, false, false, true, !!nativeStyling)
  const supported = !forceInvalid && !!material?.standardPbrValid
  const result = supported ? material : invalidMaterialSources(C, source, false, false, true, true)
  const fragmentShaderSource = result.fragmentShaderSource.clone()
  fragmentShaderSource.sources = fragmentShaderSource.sources.map(text => text
    .replace('layout(location = 3) out float campus_transparentCoverage;', '')
    .replace('layout(location = 4) out vec4 campus_albedoOcclusion;', 'layout(location = 3) out vec4 campus_albedoOcclusion;')
    .replace('layout(location = 2) out float campus_materialDepth;', 'layout(location = 2) out vec4 campus_materialDepth;')
    .replaceAll('campus_transparentCoverage = 0.0;', '')
    .replace('campus_materialDepth = -1.0;', 'campus_materialDepth = vec4(-1.0, 0.0, 0.0, 0.0);')
    .replace('campus_materialDepth = -attributes.positionEC.z;', 'campus_materialDepth = vec4(-attributes.positionEC.z, attributes.positionEC.xy, campus_materialMetallic);')
    .replace(/vec4\(campus_materialOctNormal\((\w+)\.normalEC\), clamp\(\1\.roughness, 0\.0, 1\.0\), clamp\(campus_materialMetallic, 0\.0, 1\.0\)\)/g, 'vec4($1.normalEC, $1.roughness)')
    .replace('campus_materialFlags);', 'campus_materialFlags + ccr_lightingGroup * 1024.0);'))
  if (supported) fragmentShaderSource.sources.unshift('uniform float ccr_lightingGroup;')
  return { vertexShaderSource: result.vertexShaderSource, fragmentShaderSource, supported }
}

export default class DeferredGeometry143 {
  constructor(C, scene, owner) {
    Object.assign(this, { C, scene, owner, enabled: false, frame: undefined, ready: false,
      target: null, programs: new Map(), aliases: new Map(), states: new Map(), groups: [],
      captured: [], error: null, reason: 'Disabled', stats: {} })
    this.depthPyramid = new DepthPyramid143(C, scene)
  }

  declareGraph(graph) {
    this.graph = graph
    this.graphTarget = {
      normalRoughMetal: graph.importResource('deferred.gbuffer.normalRoughMetal'),
      emissiveFlags: graph.importResource('deferred.gbuffer.emissiveFlags'),
      eyeDepth: graph.importResource('deferred.gbuffer.eyeDepth'),
      albedoOcclusion: graph.importResource('deferred.gbuffer.albedoOcclusion'),
      transparency: graph.importResource('deferred.gbuffer.transparency')
    }
    this.bindGraphTargets()
    return this.graphTarget
  }

  bindGraphTargets() {
    if (!this.graph || !this.graphTarget || !this.target) return
    for (const name of Object.keys(this.graphTarget)) this.graph.bindExternal(this.graphTarget[name], this.target[name])
  }

  setEnabled(value) {
    if (this.enabled === value) return
    this.enabled = value
    if (!value) { this.detach(); return }
    const token = { active: true }, context = this.scene.context, dispatcher=context._ccrDrawDispatcher, previous = context.draw, self = this
    this.token = token; this.previous = previous
    this.hook = function(command, passState, ...args) {
      const item = self.owner.renderItemFor?.(command), submitted = item?.command || command
      if (!token.active || self.busy || !self.canCapture(submitted, passState)) {
        return previous.call(this, command, passState, ...args)
      }
      if(self.owner.shouldCull(command))return
      // Context.draw permits shader/uniform overrides. Capture the effective
      // command so a native override cannot leave stale material data behind it.
      if (args[0] || args[1]) {
        command = self.C.DrawCommand.shallowClone(command)
        command.shaderProgram = args[0] ?? command.shaderProgram
        command.uniformMap = args[1] ?? command.uniformMap
      }
      try { return self.capture(previous, command, passState) }
      catch(error) {
        // Recover earlier captures before retiring the material textures. The
        // failed command and all subsequent draws then use native rendering.
        self.owner.recover(error)
        return previous.call(this, command, passState)
      }
    }
    if(dispatcher)this.dispatcherOff=dispatcher.addHandler(event=>{
      let command=event.command
      const item=self.owner.renderItemFor?.(command),submitted=item?.command||command
      // Fast reject: a command that prepare() did not mark can only fall through to native draw.
      // Without this the handler re-derived the material program on every context.draw.
      if(!self.supportedCommands?.has(command)&&!self.supportedCommands?.has(submitted))return 'continue'
      if(!token.active||self.busy||!self.canCapture(submitted,event.passState))return 'continue'
      if(self.owner.shouldCull(command))return 'skip'
      if(event.overrides[0]||event.overrides[1]){
        command=self.C.DrawCommand.shallowClone(command);command.shaderProgram=event.overrides[0]??command.shaderProgram;command.uniformMap=event.overrides[1]??command.uniformMap
      }
      try{self.capture(event.native,command,event.passState);return 'replace'}catch(error){self.owner.recover(error);return 'continue'}
    },{name:'deferred-geometry',priority:10})
    else context.draw = this.hook
    this.proxy = { update: state => {
      this.ready = false
      if (state.passes.render) state.commandList.push({ pass: this.C.Pass.COMPUTE, execute: () => this.prepare() })
    }, isDestroyed: () => false, destroy() {} }
    this.scene.primitives.add(this.proxy)
    this.offUpdate = this.scene.preUpdate.addEventListener(() => keepPrimitiveLast(this.scene.primitives, this.proxy))
  }

  scopeReason() {
    const C = this.C, s = this.scene, o = this.owner.getOptions()
    if (!this.enabled) return 'Disabled'
    if(s.isDestroyed?.())return 'Scene destroyed'
    const support = materialTargetSupport(s.context)
    if (!support.supported) return support.reason
    if (s.context._gl.isContextLost()) return 'Context lost'
    if (!s.highDynamicRange || s.mode !== C.SceneMode.SCENE3D || !(s.camera.frustum instanceof C.PerspectiveFrustum)) return 'Requires HDR 3D perspective'
    if (!s.frameState.passes.render || s.frameState.passes.pick || s.frameState.passes.depth) return 'Not a color frame'
    if (!s._environmentState.useOIT) return 'Sorted transparency uses enhanced rendering'
    if (s.msaaSamples > 1) return 'MSAA uses enhanced rendering; compact geometry has single-sample native depth'
    if (o.antialiasing === 'taa') return 'TAA combination uses enhanced rendering until its deferred contract is available'
    if (s._environmentState.useWebVR || s._environmentState.useInvertClassification || s._globeTranslucencyState?.translucent) return 'Unsupported view/classification mode'
    return null
  }

  prepare() {
    this.frame = undefined; this.groups = []; this.captured = []; this.ready = false
    this.owner.reflectionFrame=undefined
    this.owner.groups=[];this.owner.groupFrame=this.scene.frameState.frameNumber
    this.stats = { materialDraws: 0, nativeSupportedColorDraws: 0, compatibilityDraws: 0, coverageDraws: 0 }
    this.reason = this.scopeReason()
    if (this.reason || this.owner.failed) { this.owner.setGeometryAvailable(false); return }
    const C = this.C, s = this.scene, ctx = s.context
    const bins = s._view.frustumCommandsList
    if (!bins?.length) { this.reason = 'No geometry'; this.owner.setGeometryAvailable(false); return }
    for (const bin of bins) {
      if ([C.Pass.TERRAIN_CLASSIFICATION, C.Pass.CESIUM_3D_TILE_CLASSIFICATION,
        C.Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW, C.Pass.VOXELS, C.Pass.GAUSSIAN_SPLATS,
        C.Pass.CESIUM_3D_TILE_EDGES, C.Pass.CESIUM_3D_TILE_EDGES_DIRECT].some(p => bin.indices[p] > 0)) {
        this.reason = 'Unsupported command family uses enhanced rendering'; this.owner.setGeometryAvailable(false); return
      }
      for(const pass of [C.Pass.OPAQUE,C.Pass.CESIUM_3D_TILE,C.Pass.TRANSLUCENT])for(let i=0;i<(bin.indices[pass]||0);i++){
        const stencil=bin.commands[pass][i].renderState?.stencilTest
        if(stencil?.enabled&&(stencil.frontFunction!==C.StencilFunction.ALWAYS||stencil.backFunction!==C.StencilFunction.ALWAYS)){
          this.reason='Complex stencil uses enhanced rendering';this.owner.setGeometryAvailable(false);return
        }
      }
    }
    try {
      // Compile before removing any native colors. Unknown/depth-dependent shaders
      // that cannot be invalidated safely force native rendering for this frame.
      const saved = ctx._gl.getParameter(ctx._gl.CURRENT_PROGRAM)
      // Mark the commands whose material program already supports the compact MRT during the
      // prepare pass, so the per-draw dispatcher handler can reject everything else with one
      // WeakSet lookup instead of re-deriving the program on every context.draw.
      this.supportedCommands = new WeakSet()
      try {
        for (const bin of bins) for (const pass of [C.Pass.GLOBE, C.Pass.CESIUM_3D_TILE, C.Pass.OPAQUE, C.Pass.TRANSLUCENT]) {
          for (let i=0;i<(bin.indices[pass]||0);i++) {
            let command=bin.commands[pass][i]
            if(s.frameState.useLogDepth&&command.derivedCommands?.logDepth)command=command.derivedCommands.logDepth.command
            if(s.highDynamicRange&&command.derivedCommands?.hdr)command=command.derivedCommands.hdr.command
            if(pass===C.Pass.TRANSLUCENT)this.coverageProgram(command)._program._bind()
            else {
              const record=this.programFor(command)
              record._program._bind();record._invalid?._bind();record._recovery?._bind()
              // Record support against both the raw and the derived (log-depth/HDR) command so the
              // handler can match whichever one Cesium actually submits.
              this.supportedCommands.add(command)
              if(record.supported){this.supportedCommands.add(bin.commands[pass][i]);this.owner.environmentGroup(command)}
              if (this.owner.groups.length > MAX_DEFERRED_LIGHTING_GROUPS) {
                this.reason = `Deferred lighting group budget exceeded (${this.owner.groups.length}>${MAX_DEFERRED_LIGHTING_GROUPS})`
                this.owner.setGeometryAvailable(false)
                this.releaseTarget()
                return
              }
            }
          }
        }
      } finally { ctx._gl.useProgram(saved) }
      // Budget fallback must precede allocation. Otherwise rejected frames create
      // and destroy the entire compact MRT (57 bytes/pixel) on every render.
      this.allocate()
      this.target.clear.execute(ctx)
      this.target.clearCoverage.execute(ctx)
      for (const manager of [s._view.globeDepth?.colorFramebufferManager,s._view.sceneFramebuffer?._colorFramebuffer]) {
        const native=manager?.framebuffer
        if(native?.depthStencilTexture||native?.depthTexture) {
          if(this.alias(native).status!==ctx._gl.FRAMEBUFFER_COMPLETE)throw new Error('Native-depth MRT alias incomplete')
        }
      }
      this.frame = s.frameState.frameNumber
      this.ready = true; this.reason = null
    } catch (error) { this.reason = error.message; this.owner.fail(error) }
  }

  allocate() {
    const C=this.C,ctx=this.scene.context,w=this.scene.drawingBufferWidth,h=this.scene.drawingBufferHeight,device=this.owner.rhi
    if(this.target?.width===w&&this.target?.height===h)return
    this.releaseTarget()
    const textures=[],resources=[]
    try {
      const sampler=new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST})
      const texture=(format,type)=>{
        if(device){const resource=device.createTexture({width:w,height:h,pixelFormat:format,pixelDatatype:type,sampler});resources.push(resource);textures.push(resource.texture);return resource.texture}
        const t=new C.Texture({context:ctx,width:w,height:h,pixelFormat:format,pixelDatatype:type,sampler});textures.push(t);return t
      }
      const normalRoughMetal=texture(C.PixelFormat.RGBA,C.PixelDatatype.FLOAT)
      const emissiveFlags=texture(C.PixelFormat.RGBA,C.PixelDatatype.FLOAT)
      const eyeDepth=texture(C.PixelFormat.RGBA,C.PixelDatatype.FLOAT)
      const albedoOcclusion=texture(C.PixelFormat.RGBA,C.PixelDatatype.HALF_FLOAT)
      const transparency=texture(C.PixelFormat.RED,C.PixelDatatype.UNSIGNED_BYTE)
      const colors=[normalRoughMetal,emissiveFlags,eyeDepth,albedoOcclusion]
      const framebuffer=device ? (resources.push(device.createFramebuffer(colors)),resources.at(-1).framebuffer) : new C.Framebuffer({context:ctx,colorTextures:colors,destroyAttachments:false})
      const coverageFramebuffer=device ? (resources.push(device.createFramebuffer([transparency])),resources.at(-1).framebuffer) : new C.Framebuffer({context:ctx,colorTextures:[transparency],destroyAttachments:false})
      this.target={width:w,height:h,normalRoughMetal,emissiveFlags,eyeDepth,albedoOcclusion,transparency,colors,textures,resources,framebuffer,coverageFramebuffer}
      this.bindGraphTargets()
      if(this.target.framebuffer.status!==ctx._gl.FRAMEBUFFER_COMPLETE)throw new Error('Compact MRT incomplete')
      this.target.clear=new C.ClearCommand({framebuffer:this.target.framebuffer,color:C.Color.TRANSPARENT})
      this.target.clearCoverage=new C.ClearCommand({framebuffer:this.target.coverageFramebuffer,color:C.Color.TRANSPARENT})
    } catch(error) {
      if(this.target)this.releaseTarget();else if(device)for(const resource of resources)resource.release();else for(const t of textures)t.destroy()
      throw error
    }
  }

  programFor(command) {
    const source=command.shaderProgram
    if(!source)throw new Error('Missing shader')
    const key=source.id
    let record=this.programs.get(key)
    if(!record){
      const stencil=command.renderState.stencilTest
      if(stencil.enabled&&(stencil.frontFunction!==this.C.StencilFunction.ALWAYS||stencil.backFunction!==this.C.StencilFunction.ALWAYS))throw new Error('Complex stencil uses enhanced rendering')
      const sources=compactMaterialSources(this.C,source)
      record={...sources,_program:this.C.ShaderProgram.fromCache({context:this.scene.context,...sources,attributeLocations:source._attributeLocations})}
      // Own the first program before constructing other variants, so failure
      // cleanup can release a partially constructed record as well.
      this.programs.set(key,record)
      if (sources.supported) {
        const invalid=compactMaterialSources(this.C,source,true)
        record._invalid=this.C.ShaderProgram.fromCache({context:this.scene.context,...invalid,attributeLocations:source._attributeLocations})
        const fs=source.fragmentShaderSource.clone()
        fs.sources=fs.sources.map(text=>text.replace('out_FragColor = color;', `
          vec2 ccr_uv=gl_FragCoord.xy/ccr_bufferSize;
          float ccr_depth=texture(ccr_savedDepth,ccr_uv).r;
          float ccr_group=floor(texture(ccr_savedFlags,ccr_uv).a/1024.0);
          if(ccr_group!=ccr_recoveryGroup || ccr_depth<=0.0 || abs(ccr_depth+attributes.positionEC.z)>max(0.05,ccr_depth*0.00001))discard;
          out_FragColor = color;`))
        fs.sources.unshift('uniform sampler2D ccr_savedDepth; uniform sampler2D ccr_savedFlags; uniform vec2 ccr_bufferSize; uniform float ccr_recoveryGroup;')
        record._recovery=this.C.ShaderProgram.fromCache({context:this.scene.context,vertexShaderSource:source.vertexShaderSource,
          fragmentShaderSource:fs,attributeLocations:source._attributeLocations})
      }
    }
    record.frame=this.scene.frameState.frameNumber
    return record
  }

  coverageProgram(command) {
    const source=command.shaderProgram,key='coverage:'+source.id
    let record=this.programs.get(key)
    if(!record){
      const sources=transparencySources(this.C,source,true)
      record={_program:this.C.ShaderProgram.fromCache({context:this.scene.context,...sources,attributeLocations:source._attributeLocations})}
      this.programs.set(key,record)
    }
    record.frame=this.scene.frameState.frameNumber
    return record
  }

  canCapture(command,passState) {
    const C=this.C,s=this.scene
    if (this.owner.getOptions?.().renderItemDirectSubmit === false) return false
    if(!this.ready||this.frame!==s.frameState.frameNumber||!s.frameState.passes.render||s.frameState.passes.pick)return false
    if(![C.Pass.GLOBE,C.Pass.CESIUM_3D_TILE,C.Pass.OPAQUE].includes(command.pass))return false
    const fb=command.framebuffer||passState?.framebuffer
    const view=s._view
    return !!fb&&(fb===view.globeDepth?.colorFramebufferManager?.framebuffer||fb===view.sceneFramebuffer?._colorFramebuffer?.framebuffer)
  }

  alias(native) {
    let record=this.aliases.get(native)
    if(!record){
      const depth=native.depthStencilTexture?{depthStencilTexture:native.depthStencilTexture}:
        native.depthTexture?{depthTexture:native.depthTexture}:null
      if(!depth)throw new Error('Native depth texture unavailable')
      const C=this.C,context=this.scene.context
      record={
        material:new C.Framebuffer({context,colorTextures:this.target.colors,...depth,destroyAttachments:false}),
      }
      this.aliases.set(native,record)
    }
    return record.material
  }

  capture(nativeDraw,command,passState) {
    const C=this.C,s=this.scene,ctx=s.context,record=this.programFor(command)
    const nativeTarget=command.framebuffer||passState.framebuffer
    this.busy=true
    try {
      const derived=C.DrawCommand.shallowClone(command)
      derived.shaderProgram=record._program
      derived.framebuffer=this.alias(nativeTarget)
      const group=record.supported&&this.neutralFeatures(command)?this.owner.environmentGroup(command):null
      if(group){
        // Preserve each model's actual environment uniforms, including custom SH,
        // IBL factor and reference frame. Material values themselves stay in MRT.
        derived.uniformMap={...command.uniformMap,ccr_lightingGroup:()=>group.id}
        const frustum=s.camera.frustum.clone()
        frustum.near=ctx.uniformState.currentFrustum.x;frustum.far=ctx.uniformState.currentFrustum.y
        this.captured.push({command,nativeTarget,group,frustum})
        this.owner.executor ? this.owner.executor.execute({command:derived,pass:'deferred.geometry'},ctx,passState,{},nativeDraw) : nativeDraw.call(ctx,derived,passState)
        this.owner.setGeometryAvailable(true)
        this.stats.materialDraws++
      }else{
        derived.shaderProgram=record._invalid||record._program
        nativeDraw.call(ctx,command,passState)
        let state=this.states.get(command.renderState.id)
        if(!state){
          const options=C.RenderState.getState(command.renderState)
          options.colorMask={red:true,green:true,blue:true,alpha:true}
          options.depthTest.func=C.DepthFunction.LESS_OR_EQUAL
          options.depthMask=false;options.stencilMask=0
          state={value:C.RenderState.fromCache(options),options}
          this.states.set(command.renderState.id,state)
        }
        derived.renderState=state.value
        state.frame=this.frame
        nativeDraw.call(ctx,derived,passState)
        this.stats.compatibilityDraws++
      }
    } finally { this.busy=false }
  }

  finish() {
    if(!this.ready)return
    const C=this.C,s=this.scene,ctx=s.context,us=ctx.uniformState
    const viewport=C.BoundingRectangle.clone(us.viewport),pass=us.pass
    this.busy=true
    try {
      us.updateFrustum(s.camera.frustum)
      us.updatePass(C.Pass.TRANSLUCENT)
      for(const bin of s._view.frustumCommandsList)for(let i=0;i<(bin.indices[C.Pass.TRANSLUCENT]||0);i++){
        let command=bin.commands[C.Pass.TRANSLUCENT][i]
        if(s.frameState.useLogDepth&&command.derivedCommands?.logDepth)command=command.derivedCommands.logDepth.command
        if(s.highDynamicRange&&command.derivedCommands?.hdr)command=command.derivedCommands.hdr.command
        const record=this.coverageProgram(command),key='coverage:'+command.renderState.id
        let state=this.states.get(key)
        if(!state){
          const options=C.RenderState.getState(command.renderState)
          options.depthTest={enabled:false};options.depthMask=false;options.stencilTest={enabled:false};options.stencilMask=0
          options.blending={enabled:false};options.colorMask={red:true,green:true,blue:true,alpha:true}
          state={value:C.RenderState.fromCache(options),options};this.states.set(key,state)
        }
        const derived=C.DrawCommand.shallowClone(command)
        derived.shaderProgram=record._program;derived.renderState=state.value;derived.framebuffer=this.target.coverageFramebuffer
        state.frame=this.frame
        const ps=new C.PassState(ctx);ps.viewport=new C.BoundingRectangle(0,0,this.target.width,this.target.height)
        derived.execute(ctx,ps);this.stats.coverageDraws++
      }
    } finally {this.busy=false;us.viewport=viewport;us.updatePass(pass)}
    const options=this.owner.getOptions()
    if(options.screenSpaceAoEnabled||options.depthPyramidEnabled||options.screenSpaceReflectionEnabled){
      this.depthPyramid.setMaxLevel?.(options.depthPyramidEnabled ? undefined : options.screenSpaceReflectionEnabled ? 5 : 0)
      this.depthPyramid.update(this.target.eyeDepth,this.frame,this.target.transparency)
    }
    else this.depthPyramid.release()
    for(const [key,r]of this.programs)if(r.frame<this.frame-120){r._program.destroy();r._invalid?.destroy();r._recovery?.destroy();this.programs.delete(key)}
    for(const [key,r]of this.states)if(r.frame<this.frame-120){this.C.RenderState.removeFromCache(r.options);this.states.delete(key)}
    for(const [native,r]of this.aliases)if(native.isDestroyed()){r.material.destroy();this.aliases.delete(native)}
  }

  neutralFeatures(command) {
    const defines=command.shaderProgram.fragmentShaderSource.defines||[]
    if(!defines.includes('HAS_SELECTED_FEATURE_ID')&&!defines.includes('USE_CPU_STYLING'))return true
    const table=command.owner?._featureTables?.[command.owner.featureTableId]
    if(!table||!Number.isSafeInteger(table.featuresLength))return false
    const color=new this.C.Color()
    for(let i=0;i<table.featuresLength;i++) {
      table.getColor(i,color)
      if(!this.C.Color.equals(color,this.C.Color.WHITE))return false
    }
    return true
  }

  restoreNativeColors() {
    const C=this.C,s=this.scene,ctx=s.context,us=ctx.uniformState
    const frustum=s.camera.frustum.clone(),viewport=C.BoundingRectangle.clone(us.viewport),pass=us.pass
    frustum.near=us.currentFrustum.x;frustum.far=us.currentFrustum.y
    this.busy=true
    try {
      for(const {command,nativeTarget,group,frustum}of this.captured) {
        const record=this.programFor(command),key='recovery:'+command.renderState.id
        let state=this.states.get(key)
        if(!state){
          const options=C.RenderState.getState(command.renderState)
          options.depthTest={enabled:false};options.depthMask=false;options.stencilTest={enabled:false};options.stencilMask=0
          state={value:C.RenderState.fromCache(options),options};this.states.set(key,state)
        }
        us.updateFrustum(frustum);us.updatePass(command.pass)
        const derived=C.DrawCommand.shallowClone(command)
        derived.framebuffer=nativeTarget;derived.shaderProgram=record._recovery;derived.renderState=state.value
        state.frame=this.frame
        derived.uniformMap={...command.uniformMap,ccr_savedDepth:()=>this.target.eyeDepth,ccr_savedFlags:()=>this.target.emissiveFlags,
          ccr_bufferSize:()=>new C.Cartesian2(this.target.width,this.target.height),ccr_recoveryGroup:()=>group.id}
        const ps=new C.PassState(ctx);ps.viewport=new C.BoundingRectangle(0,0,this.target.width,this.target.height)
        derived.execute(ctx,ps)
      }
    } finally {this.busy=false;us.updateFrustum(frustum);us.updatePass(pass);us.viewport=viewport}
  }

  getTextures() {
    if(!this.ready||this.frame!==this.scene.frameState.frameNumber||!this.target)return null
    const {normalRoughMetal,emissiveFlags,eyeDepth,albedoOcclusion,transparency}=this.target
    return {normalRoughMetal,emissiveFlags,eyeDepth,albedoOcclusion,transparency,...this.owner.getReflectionTextures()}
  }
  getReflectionDiagnostics(){return {valid:!!this.getTextures()?.reflectionSpecular,source:'deferred-lighting',layout:'compact-v1'}}
  getGeometrySubmission() {
    const items=[], batches=new Map(), fallbacks=[]
    for(const record of this.captured){
      const item=this.owner.renderItemFor?.(record.command)
      if(item)items.push(item)
      else fallbacks.push({command:record.command,reason:'RenderItem unavailable'})
      const batch=batches.get(record.group.id)||{id:record.group.id,group:record.group,items:[]}
      if(item)batch.items.push(item)
      batches.set(record.group.id,batch)
    }
    const lightingBatches=[...batches.values()].map(batch=>Object.freeze({...batch,items:Object.freeze(batch.items.slice())}))
    return Object.freeze({items:Object.freeze(items),lightingBatches:Object.freeze(lightingBatches),fallbacks:Object.freeze(fallbacks),frame:this.frame})
  }


  getDepthPyramidLevels(){return this.depthPyramid.getLevels()}
  get compactActive(){return !!this.getTextures()}
  getDiagnostics(){return {enabled:this.enabled,valid:!!this.getTextures(),reason:this.reason,compact:true,colorAttachmentCount:4,
    bytes:this.target?this.target.width*this.target.height*57:0,format:'RGBA32F normalXYZ/roughness + RGBA32F emissive/flags/group + RGBA32F eyeDepth/eyeXY/metalness + RGBA16F albedo/occlusion; separate R8 coverage',stats:{...this.stats}}}
  releaseTarget(){
    for(const r of this.aliases.values())if(!r.material.isDestroyed())r.material.destroy()
    this.aliases.clear()
    if(this.target){
      if(this.target.resources)for(const resource of this.target.resources)resource.release()
      else {
        if(this.target.framebuffer&&!this.target.framebuffer.isDestroyed())this.target.framebuffer.destroy()
        if(this.target.coverageFramebuffer&&!this.target.coverageFramebuffer.isDestroyed())this.target.coverageFramebuffer.destroy()
        for(const t of this.target.textures)if(!t.isDestroyed())t.destroy()
      }
      this.target=null
    }
    this.depthPyramid.release()
  }
  detach(){
    if(this.token)this.token.active=false
    this.dispatcherOff?.();this.dispatcherOff=null
    if(this.scene.context?.draw===this.hook)this.scene.context.draw=this.previous
    this.offUpdate?.();this.offUpdate=null
    if(this.proxy&&!this.scene.isDestroyed?.())this.scene.primitives.remove(this.proxy)
    this.proxy=null
    this.ready=false;this.frame=undefined;this.captured=[];this.groups=[];this.releaseTarget()
    for(const r of this.programs.values())for(const key of ['_program','_invalid','_recovery'])if(r[key]&&!r[key].isDestroyed())r[key].destroy()
    this.programs.clear()
    for(const r of this.states.values())this.C.RenderState.removeFromCache(r.options)
    this.states.clear()
  }
  destroy(){this.setEnabled(false);this.depthPyramid.destroy()}
}
