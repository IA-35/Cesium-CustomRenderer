import { forwardShader } from './transparentForwardShader143.js'
import { createFrameBridge } from './FrameBridge143.js'
import {shadowUniforms} from '../shadows/shadowUniforms143.js'
import {acquireSunUniforms} from '../buffers/SunUniforms143.js'

// Own only the derived shader and added uniforms. Vertex transforms, material
// evaluation, alpha/discard, depth, picking and OIT remain with the engine.
export default class TransparentForward143 {
  constructor({Cesium:C,scene,getShadowVisibility=()=>null,isDeferredActive=()=>false,getOptions=()=>({})}={}) {
    if(!C||!scene)throw new Error('TransparentForward143 requires { Cesium, scene }')
    if(!/^1\.143(?:\.0)?$/.test(C.VERSION))throw new Error('TransparentForward143 requires Cesium 1.143')
    Object.assign(this,{C,scene,getShadowVisibility,isDeferredActive,getOptions,enabled:false,destroyed:false,failed:false,
      reason:'Disabled',error:null,programs:new Map(),programFrames:new Map(),commands:new Map(),water:new Map(),stats:{frames:0,translucentCommands:0,patchedCommands:0,compatibilityCommands:0,shaderVariants:0}})
  }
  _sceneDestroyed(){return !!this.scene.isDestroyed?.()}
  scopeReason(){
    if(this.destroyed||this._sceneDestroyed())return 'Destroyed'
    if(!this.enabled)return this.failed?'Transparent forward failed; disable before retrying':'Disabled'
    if(this.scene.context._gl.isContextLost())return 'Context lost'
    const passes=this.scene.frameState.passes
    if(!passes.render||passes.pick||passes.depth)return 'Not a color frame'
    if(!this.isDeferredActive())return 'Deferred opaque lighting is not active'
    return null
  }
  setEnabled(value){
    if(this.destroyed)return
    if(!value){this.enabled=false;this.detach();this.failed=false;this.error=null;this.reason='Disabled';return}
    if(this.enabled||this.failed)return
    try{
      this.sunUniforms=acquireSunUniforms(this.C,this.scene)
      this.bridge=createFrameBridge({Cesium:this.C,scene:this.scene})
      this.offCommand=this.bridge.onCommand(command=>this.applyTo(command))
      this.offResolve=this.bridge.on('resolve',()=>this.endFrame())
      this.bridge.install();this.enabled=true;this.reason='Not rendered'
      this.proxy={update:state=>this.updateWater(state),isDestroyed:()=>false,destroy(){}}
      this.scene.primitives?.add(this.proxy)
      this.onLost=()=>this.fail(new Error('Context lost'))
      this.scene.canvas?.addEventListener('webglcontextlost',this.onLost)
    }catch(error){this.fail(error)}
    this.scene.requestRender()
  }
  beginFrame(){
    const frame=this.scene.frameState.frameNumber
    if(this.frame===frame)return
    this.frame=frame;this.outputFrame=undefined
    this.stats.frames++;this.stats.translucentCommands=0;this.stats.patchedCommands=0;this.stats.compatibilityCommands=0
    this.stats.opaqueParticleCommands=0
    this.stats.patchedFamilies={};this.stats.compatibilityReasons={}
  }
  applyTo(command){
    if(this.destroyed||!this.enabled||this.failed)return
    this.beginFrame()
    let record=this.commands.get(command)
    // BillboardCollection splits alpha=1 cores from translucent edges. Both
    // particle commands remain forward-rendered and share emissive controls.
    const opaqueParticle=command.pass===this.C.Pass.OPAQUE&&this.family(command)==='particle'
    if(this.scopeReason()||(command.pass!==this.C.Pass.TRANSLUCENT&&!opaqueParticle)){
      if(record){this.restore(command,record);this.commands.delete(command)}
      return
    }
    if(opaqueParticle)this.stats.opaqueParticleCommands++
    else this.stats.translucentCommands++
    if(record&&(command.shaderProgram!==record.program||command.uniformMap!==record.mergedUniforms)){
      this.restore(command,record);this.commands.delete(command);record=null
    }
    try{
      if(!record){
        const source=command.shaderProgram,family=this.family(command),program=this.programFor(source,family)
        if(!program){
          this.stats.compatibilityCommands++
          const reason=family==='compatibility'?'unmapped material or primitive':'unmapped '+family+' shader'
          this.stats.compatibilityReasons[reason]=(this.stats.compatibilityReasons[reason]||0)+1
          return
        }
        record={source,program,family,key:family+':'+source.id,originalUniforms:command.uniformMap}
        this.assign(command,record);this.commands.set(command,record)
      }
      record.frame=this.frame;this.programFrames.set(record.key,this.frame)
      if(record.family==='water'&&command.boundingVolume?.center)this.C.Cartesian3.clone(command.boundingVolume.center,this.water.get(command.owner).position)
      this.stats.patchedCommands++;this.outputFrame=this.frame;this.reason=null
      this.stats.patchedFamilies[record.family]=(this.stats.patchedFamilies[record.family]||0)+1
    }catch(error){this.fail(error)}
  }
  family(command){
    if(command.shaderProgram?.fragmentShaderSource.defines?.includes('LIGHTING_PBR'))return 'model'
    if(command.owner?.appearance?.material?.type==='Water')return 'water'
    if(!this.C.BillboardCollection||!(command.owner instanceof this.C.BillboardCollection))return 'compatibility'
    const visit=collection=>{
      if(!collection)return false
      for(let i=0;i<collection.length;i++){const p=collection.get(i)
        if(this.C.ParticleSystem&&p instanceof this.C.ParticleSystem&&p._billboardCollection===command.owner)return true
        if(this.C.PrimitiveCollection&&p instanceof this.C.PrimitiveCollection&&visit(p))return true
      }
      return false
    }
    return visit(this.scene.primitives)?'particle':'compatibility'
  }
  programFor(source,family){
    const key=family+':'+source.id
    if(this.programs.has(key))return this.programs.get(key)
    let program=null
    try{
      const fs=forwardShader(this.C,source,family,!!this.sunUniforms)
      if(fs){
        fs.sources.unshift('uniform vec4 ccr_forwardTerms;')
        program=this.C.ShaderProgram.fromCache({context:this.scene.context,vertexShaderSource:source.vertexShaderSource,fragmentShaderSource:fs,attributeLocations:source._attributeLocations})
        const gl=this.scene.context._gl,previous=gl.getParameter(gl.CURRENT_PROGRAM)
        try{program._bind()}finally{gl.useProgram(previous)}
      }
    }catch(error){if(program&&!program.isDestroyed())program.destroy();throw error}
    this.programs.set(key,program);this.programFrames.set(key,this.frame)
    this.stats.shaderVariants=[...this.programs.values()].filter(Boolean).length
    return program
  }
  terms(){
    const o=this.scopeReason()?{}:this.getOptions()
    return new this.C.Cartesian4(+(o.lightingDirect!==false),+(o.lightingIndirect!==false),+(o.lightingEmissive!==false),+(o.lightingShadow!==false))
  }
  shadow(){return !this.scopeReason()&&this.getOptions().lightingShadow!==false?this.getShadowVisibility():null}
  assign(command,record){
    const C=this.C,original=record.originalUniforms||{}
    const merged={...original,ccr_forwardTerms:()=>this.terms(),
      ccr_forwardActive:()=>!this.scopeReason(),
      ...shadowUniforms(C,this.scene,()=>this.shadow(),()=>this._whiteTexture())}
    // Native IBL evaluation and its per-model probe/reference frame stay intact.
    if(original.model_iblFactor){
      const factor=new C.Cartesian2()
      merged.model_iblFactor=()=>{const source=original.model_iblFactor(),weight=this.terms().y;factor.x=source.x*weight;factor.y=source.y*weight;return factor}
    }
    if(record.family==='water')Object.assign(merged,this.waterUniforms(command))
    record.mergedUniforms=merged;command.shaderProgram=record.program;command.uniformMap=merged;command.dirty=true
  }
  waterUniforms(command){
    const C=this.C,owner=command.owner,ctx=this.scene.context
    let entry=this.water.get(owner)
    if(!entry){
      const manager=C.DynamicEnvironmentMapManager.isDynamicUpdateSupported(this.scene)?new C.DynamicEnvironmentMapManager({maximumSecondsDifference:60}):null
      entry={manager,position:C.Cartesian3.clone(command.boundingVolume?.center||this.scene.camera.positionWC),reference:new C.Matrix3()}
      this.water.set(owner,entry)
    }
    const factor=new C.Cartesian2(),zero=Array.from({length:9},()=>new C.Cartesian3())
    return {model_iblFactor:()=>{const weight=entry.manager?.radianceCubeMap?this.terms().y:0;factor.x=weight;factor.y=weight;return factor},
      model_iblReferenceFrameMatrix:()=>entry.reference,model_sphericalHarmonicCoefficients:()=>entry.manager?.sphericalHarmonicCoefficients||zero,
      model_specularEnvironmentMaps:()=>entry.manager?.radianceCubeMap||ctx.defaultCubeMap,model_specularEnvironmentMapsMaximumLOD:()=>entry.manager?.maximumMipmapLevel||0}
  }
  updateWater(state){
    const C=this.C
    for(const [owner,entry]of this.water){
      if(owner.isDestroyed?.()){entry.manager?.destroy();this.water.delete(owner);continue}
      const frame=C.Transforms.eastNorthUpToFixedFrame(entry.position)
      const eye=C.Matrix4.multiply(state.context.uniformState.view3D,frame,new C.Matrix4())
      C.Matrix3.transpose(C.Matrix4.getRotation(eye,new C.Matrix3()),entry.reference)
      C.Matrix3.multiply(new C.Matrix3(1,0,0,0,0,1,0,-1,0),entry.reference,entry.reference)
      if(entry.manager){
        const intensity=this.getOptions().skyLightIntensity??3.2
        if(entry.manager.atmosphereScatteringIntensity!==intensity){entry.manager.atmosphereScatteringIntensity=intensity;entry.manager.position=undefined}
        entry.manager.position=entry.position;entry.manager.update(state)
      }
    }
  }
  _whiteTexture(){return this.scene.context.defaultTexture||(this._white??=new this.C.Texture({context:this.scene.context,width:1,height:1,pixelFormat:this.C.PixelFormat.RGBA,pixelDatatype:this.C.PixelDatatype.UNSIGNED_BYTE,source:{width:1,height:1,arrayBufferView:new Uint8Array([255,255,255,255])}}))}
  _noShadowParams(){return this._noShadow??=new this.C.Cartesian4(0,0,1,0)}
  restore(command,record){
    if(command.shaderProgram===record.program)command.shaderProgram=record.source
    if(command.uniformMap===record.mergedUniforms)command.uniformMap=record.originalUniforms
    command.dirty=true
  }
  endFrame(){
    if(this.destroyed)return
    this.beginFrame()
    const live=new Set()
    for(const bin of this.scene._view?.frustumCommandsList||[])for(const pass of [this.C.Pass.OPAQUE,this.C.Pass.TRANSLUCENT])for(let i=0;i<(bin.indices[pass]||0);i++)live.add(bin.commands[pass][i])
    for(const [command,record]of this.commands)if(!live.has(command)||this.scopeReason()){this.restore(command,record);this.commands.delete(command)}
    for(const [key,last]of this.programFrames)if(last<this.scene.frameState.frameNumber-120){const program=this.programs.get(key);if(program&&!program.isDestroyed())program.destroy();this.programs.delete(key);this.programFrames.delete(key)}
    this.stats.trackedCommands=this.commands.size
    if(!this.stats.patchedCommands)this.reason='No patchable translucent draws'
  }
  release(){
    for(const [command,record]of this.commands)this.restore(command,record)
    this.commands.clear()
    for(const program of this.programs.values())if(program&&!program.isDestroyed())program.destroy()
    this.programs.clear();this.programFrames.clear()
    if(this._white&&!this._white.isDestroyed())this._white.destroy()
    this._white=undefined;this.outputFrame=undefined
    for(const entry of this.water.values())entry.manager?.destroy()
    this.water.clear()
  }
  detach(){
    this.offCommand?.();this.offCommand=null;this.offResolve?.();this.offResolve=null
    this.bridge?.destroy();this.bridge=null
    if(this.proxy&&!this._sceneDestroyed())this.scene.primitives?.remove(this.proxy)
    this.proxy=null
    if(this.onLost)this.scene.canvas?.removeEventListener('webglcontextlost',this.onLost)
    this.onLost=null;this.release()
    this.sunUniforms?.release();this.sunUniforms=null
  }
  fail(error){this.enabled=false;this.failed=true;this.error=error.message||String(error);this.reason=this.error+'; disable before retrying';this.detach()}
  getDiagnostics(){return {enabled:this.enabled,failed:this.failed,error:this.error,valid:!this.scopeReason()&&this.outputFrame===this.scene.frameState.frameNumber,
    reason:this.failed?this.reason:this.scopeReason()||this.reason,partial:true,contract:'CCR direct term/shadow, per-model indirect IBL and emissive controls',
    coverage:'standard PBR models, Water PBR forward, emissive particles; native OIT MRT/multipass and sorted order',stats:{...this.stats}}}
  destroy(){if(this.destroyed)return;this.enabled=false;this.detach();this.destroyed=true}
}
