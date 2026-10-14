import { createFrameBridge } from '../pipeline/FrameBridge143.js'
import DeferredGeometry143 from './DeferredGeometry143.js'
import { deferredLightingShaderSource } from './deferredLightingShader143.js'
import DeferredReflectionTarget143 from './DeferredReflectionTarget143.js'
import {shadowUniforms} from '../shadows/shadowUniforms143.js'
import {acquireSunUniforms} from '../buffers/SunUniforms143.js'
import RenderItemExecutor143 from '../renderer/RenderItemExecutor143.js'

export default class DeferredLighting143 {
  constructor({ Cesium:C, scene, rhi=null, graph=null, getOptions=()=>({}), prepareAo=()=>null, prepareReflections=color=>color, getShadowVisibility=()=>null, onGeometryAvailability=()=>{},shouldCull=()=>false }={}) {
    if(!C||!scene||!/^1\.143(?:\.0)?$/.test(C.VERSION))throw new Error('Deferred lighting requires Cesium 1.143 and scene')
    Object.assign(this,{C,scene,rhi,graph,getOptions,prepareAo,prepareReflections,getShadowVisibility,onGeometryAvailability,shouldCull,enabled:false,failed:false,destroyed:false,
      reason:'Disabled',error:null,outputFrame:undefined,programs:new Map(),groups:[],targets:new Map(),renderItems:new Map()})
    this.materials=new DeferredGeometry143(C,scene,this)
    this.reflections=new DeferredReflectionTarget143(C,scene,rhi)
    this.terms={direct:true,indirect:true,emissive:true,shadow:true,ao:true}
    this.aoStrength=1;this.debugMode=0
    this.stats={frames:0,draws:0,lastAoValid:false,lastShadowValid:false};this.whiteResource=null;this.executor=new RenderItemExecutor143(C,{label:'deferred'})
  }
  setEnabled(value){
    if(this.destroyed)return
    if(!value){
      this.enabled=false;this.detach()
      this.failed=false;this.error=null;this.reason='Disabled';return
    }
    if(this.enabled||this.failed)return
    try{
      this.enabled=true
      this.sunUniforms=acquireSunUniforms(this.C,this.scene)
      this.geometryAvailable=undefined
      this.bridge=createFrameBridge({Cesium:this.C,scene:this.scene})
      this.offItems=this.bridge.onRenderItem(item=>this.renderItems.set(item.command,item))
       this.offFrame=this.bridge.on('opaqueFrame',()=>this.renderItems.clear(),{priority:-100})
       this.off=this.bridge.on('translucent',()=>this.render())
      this.bridge.install()
      this.materials.setEnabled(true)
      this.onLost=()=>this.fail(new Error('Context lost'))
      this.scene.canvas?.addEventListener('webglcontextlost',this.onLost)
      this.reason='Not rendered'
    }catch(error){this.fail(error)}
    this.scene.requestRender()
  }
  renderItemFor(command){return this.renderItems.get(command)}
  setGeometryAvailable(value){
    if(this.geometryAvailable===value)return
    this.geometryAvailable=value
    this.onGeometryAvailability(value)
  }
  setTerms(values={}){for(const key of Object.keys(this.terms))if(typeof values[key]==='boolean')this.terms[key]=values[key]}
  setDebugMode(value){if(Number.isFinite(value))this.debugMode=Math.max(0,Math.min(7,Math.round(value)))}
  set({aoStrength,debugMode,terms}={}){
    if(Number.isFinite(aoStrength))this.aoStrength=Math.max(0,Math.min(1,aoStrength))
    if(debugMode!==undefined)this.setDebugMode(debugMode)
    if(terms)this.setTerms(terms)
    this.scene.requestRender()
  }
  environmentGroup(command){
    if(this.groupFrame!==this.scene.frameState.frameNumber){this.groups=[];this.groupFrame=this.scene.frameState.frameNumber}
    const map=command.uniformMap||{},C=this.C,us=this.scene.context.uniformState
    const defines=new Set((command.shaderProgram.fragmentShaderSource.defines||[]).map(s=>s.split(/\s+/)[0]))
    // Native per-model fog uses interpolated scattering not present in compact-v1.
    if(defines.has('HAS_ATMOSPHERE')&&map.u_isInFog?.())return null
    const diffuse=defines.has('DIFFUSE_IBL'),specular=defines.has('SPECULAR_IBL')
    const sh=diffuse?(map.model_sphericalHarmonicCoefficients?.()||us.sphericalHarmonicCoefficients):null
    const probe=specular?(map.model_specularEnvironmentMaps?.()||us.specularEnvironmentMaps):null
    if(diffuse&&sh?.length!==9||specular&&!probe)return null
    const factor=map.model_iblFactor?.()||new C.Cartesian2(0,0)
    const matrix=map.model_iblReferenceFrameMatrix?.()||C.Matrix3.IDENTITY
    const lod=specular?(map.model_specularEnvironmentMapsMaximumLOD?.()??us.specularEnvironmentMapsMaximumLOD??0):0
    // The reference frame is only consumed by the IBL branches. Including each
    // model's local frame for ordinary direct/emissive lighting needlessly turns
    // one fullscreen lighting draw into one draw per model.
    const environmentActive=diffuse||specular
    const key=[diffuse,specular,environmentActive?factor.x:0,environmentActive?factor.y:0,
      ...(environmentActive?Array.from(matrix):[]),...(sh||[]).flatMap(v=>[v.x,v.y,v.z]),lod].join(',')
    let group=this.groups.find(g=>g.key===key&&g.probe===probe)
    if(group)return group
    if(this.groups.length>=16383)return null
    group={id:this.groups.length+1,key,diffuse,specular,probe,sh,
      reference:C.Matrix3.clone(environmentActive?matrix:C.Matrix3.IDENTITY),
      factor:C.Cartesian2.clone(environmentActive?factor:C.Cartesian2.ZERO),lod}
    this.ensureProgram(group) // compile before dropping this model's native color
    this.groups.push(group)
    return group
  }
  ensureProgram(group){
    const C=this.C,ctx=this.scene.context,reflection=!!this.getOptions().screenSpaceReflectionEnabled,key=group.diffuse+':'+group.specular+':'+reflection
    let entry=this.programs.get(key)
    if(!entry){
      const options={depthTest:{enabled:false},depthMask:false,blending:{enabled:false}}
      const state=C.RenderState.fromCache(options)
      let command
      try{
        command=ctx.createViewportQuadCommand(deferredLightingShaderSource(C,{...group,reflection,cascades:true,sunUbo:!!this.sunUniforms}),{renderState:state})
        const saved=ctx._gl.getParameter(ctx._gl.CURRENT_PROGRAM)
        try{command.shaderProgram._bind()}finally{ctx._gl.useProgram(saved)}
        entry={command,options};this.programs.set(key,entry)
      }catch(error){
        if(command?.shaderProgram&&!command.shaderProgram.isDestroyed())command.shaderProgram.destroy()
        C.RenderState.removeFromCache(options);throw error
      }
    }
    return entry.command
  }
  _releaseFramebuffer(resource){if(!resource)return;if(resource.release)resource.release();else if(!resource.isDestroyed?.())resource.destroy()}
  _framebufferOf(resource){return resource?.framebuffer||resource}
  writeTarget(){
    const C=this.C,ctx=this.scene.context,texture=this.scene._view.oit?._opaqueTexture
    if(!texture||texture.isDestroyed())return null
    if(this.getOptions().screenSpaceReflectionEnabled){
      for(const fb of this.targets.values())this._releaseFramebuffer(fb)
      this.targets.clear()
      const target=this.reflections.update(texture)
      target.clear.execute(ctx)
      return target.lighting
    }
    this.reflections.destroy();this.reflectionFrame=undefined
    for(const [old,fb]of this.targets)if(old!==texture){this._releaseFramebuffer(fb);this.targets.delete(old)}
    if(!this.targets.has(texture)){
      const resource=this.rhi?this.rhi.createFramebuffer([texture]):new C.Framebuffer({context:ctx,colorTextures:[texture],destroyAttachments:false})
       const fb=this._framebufferOf(resource)
      if(fb.status!==ctx._gl.FRAMEBUFFER_COMPLETE){this._releaseFramebuffer(resource);throw new Error('Lighting target incomplete')}
      this.targets.set(texture,resource)
    }
    return this._framebufferOf(this.targets.get(texture))
  }
  render(){
    this.outputFrame=undefined
    if(!this.enabled||this.failed)return
    if(!this.materials.ready){this.reason=this.materials.reason;return}
    const C=this.C,ctx=this.scene.context,us=ctx.uniformState
    const viewport=C.BoundingRectangle.clone(us.viewport),cached=ctx._currentFramebuffer
    const gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try{
      this.materials.finish();this.geometrySubmission=this.materials.getGeometrySubmission()
       this.graph?.executePass('deferred.geometry', this.scene)
      const textures=this.materials.getTextures(),target=this.writeTarget()
      if(!target)throw new Error('Resolved opaque target unavailable')
      const used=new Set(this.geometrySubmission?.lightingBatches?.map(batch=>batch.id)||[])
      const groups=this.groups.filter(group=>used.has(group.id))
      if(!groups.length){
        this.reason='No supported PBR draws'
        this.materials.ready=false
        this.setGeometryAvailable(false)
        return
      }
      const opaque=this.scene._view.oit._opaqueTexture
      const ao=this.terms.ao?this.prepareAo(opaque):null,shadow=this.terms.shadow?this.getShadowVisibility():null
      this.stats.lastAoValid=!!ao;this.stats.lastShadowValid=!!shadow
      const state=new C.PassState(ctx)
      state.framebuffer=target
      state.viewport=new C.BoundingRectangle(0,0,opaque.width,opaque.height)
      if(!this.white){this.whiteResource=this.rhi?this.rhi.createTexture({width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.UNSIGNED_BYTE,source:{width:1,height:1,arrayBufferView:new Uint8Array([255,255,255,255])}}):null;this.white=this.whiteResource?.texture||new C.Texture({context:ctx,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.UNSIGNED_BYTE,source:{width:1,height:1,arrayBufferView:new Uint8Array([255,255,255,255])}})}
              const drawGroups=()=>{for(const group of groups){
        const command=this.ensureProgram(group)
        const uniformMap={
          u_normalRoughMetal:()=>textures.normalRoughMetal,u_albedoOcclusion:()=>textures.albedoOcclusion,
          u_emissiveFlags:()=>textures.emissiveFlags,u_eyeDepth:()=>textures.eyeDepth,
          u_group:()=>group.id,
          u_terms:()=>new C.Cartesian4(+this.terms.direct,+this.terms.indirect,+this.terms.emissive,+this.terms.shadow),
          u_debugMode:()=>this.debugMode,u_aoVisibility:()=>ao||this.white,u_aoStrength:()=>ao?this.aoStrength:0,
          model_iblFactor:()=>group.factor,model_iblReferenceFrameMatrix:()=>group.reference,
          model_sphericalHarmonicCoefficients:()=>group.sh,model_specularEnvironmentMaps:()=>group.probe,
          model_specularEnvironmentMapsMaximumLOD:()=>group.lod,
          ...shadowUniforms(C,this.scene,()=>shadow,()=>this.white),
        }
        this.executor.execute({command,pass:'deferred.lighting'},ctx,state,{framebuffer:target,uniformMap})
        this.stats.draws++
      }}
      if(this.sunUniforms)this.sunUniforms.withPrograms(groups.map(group=>this.ensureProgram(group).shaderProgram),drawGroups)
      else drawGroups()
      if(this.getOptions().screenSpaceReflectionEnabled){
        this.reflectionFrame=this.scene.frameState.frameNumber
        const reflected=this.prepareReflections(opaque)
        if(reflected!==opaque)this.reflections.copy(reflected,this.reflections.target.color)
        this.reflections.copy(opaque,this.reflections.target.snapshot)
      }
      this.graph?.executePass('deferred.lighting', this.scene)
       this.outputFrame=this.scene.frameState.frameNumber;this.reason=null;this.stats.frames++
    }catch(error){this.recover(error)}
    finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached;us.viewport=viewport}
  }
  recover(error){
    try { this.materials.restoreNativeColors() } catch (recovery) { error=new Error(error.message+'; native recovery: '+recovery.message) }
    this.fail(error)
  }
  fail(error){
    this.error=error.message||String(error)
    this.detach();this.enabled=false;this.failed=true
    this.reason=this.error+'; disable before retrying'
    this.setGeometryAvailable(false)
  }
  detach(){
    this.off?.();this.off=null;this.offItems?.();this.offItems=null;this.offFrame?.();this.offFrame=null
    this.bridge?.destroy();this.bridge=null
    this.materials.setEnabled(false)
    if(this.onLost)this.scene.canvas?.removeEventListener('webglcontextlost',this.onLost)
    this.onLost=null
    for(const fb of this.targets.values())this._releaseFramebuffer(fb)
    this.targets.clear()
    for(const {command,options}of this.programs.values()){if(!command.shaderProgram.isDestroyed())command.shaderProgram.destroy();this.C.RenderState.removeFromCache(options)}
    this.programs.clear()
    if(this.whiteResource)this.whiteResource.release();else if(this.white&&!this.white.isDestroyed())this.white.destroy();this.whiteResource=null;this.white=null
    this.groups=[];this.geometrySubmission=undefined;this.groupFrame=undefined;this.outputFrame=undefined
    this.renderItems.clear()
    this.reflections.destroy();this.reflectionFrame=undefined
    this.sunUniforms?.release();this.sunUniforms=null
  }
  getReflectionTextures(){
    const t=this.reflections.target
    return t&&this.reflectionFrame===this.scene.frameState.frameNumber?{reflectionSpecular:t.reflectionSpecular,reflectionResponse:t.reflectionResponse,opaqueColor:t.opaqueColor}:{}
  }
  getDiagnostics(){
    return {enabled:this.enabled,attached:!!this.bridge,failed:this.failed,error:this.error,
      reason:this.failed?this.reason:this.materials.ready?this.reason:this.materials.reason,
      valid:this.enabled&&!this.failed&&this.outputFrame===this.scene.frameState.frameNumber,
      activeMode:this.enabled&&this.outputFrame===this.scene.frameState.frameNumber?'deferred':'enhanced',
      terms:{...this.terms},debugMode:this.debugMode,stats:{...this.stats,...this.materials.stats},
      groupCount:this.groups.length,colorAttachmentCount:4,materialLayout:'compact-v1',
      resources:{lightingFramebuffers:this.targets.size+(this.reflections.target?4:0),lightingPrograms:this.programs.size,materialPrograms:this.materials.programs.size,
        reflectionBytes:(this.reflections.target?.textures||[]).reduce((sum,t)=>sum+t.sizeInBytes,0)}}
  }
  destroy(){if(this.destroyed)return;this.detach();this.materials.destroy();this.destroyed=true;this.enabled=false}
}
