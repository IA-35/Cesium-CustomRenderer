import LightFrustum from './LightFrustum.js'
import ShadowTarget from './ShadowTarget.js'
import ShadowReceiver143 from './ShadowReceiver143.js'
import ShadowCache from './ShadowCache.js'
import selectLightTiles from './CasterCommands143.js'
import CameraShadowCoverage from './CameraShadowCoverage.js'
import CascadedShadowCoverage,{terrainDepthRange} from './CascadedShadowCoverage.js'
import {shadowUniforms} from './shadowUniforms143.js'

// Each level selects its own light-space casters. Native ShadowMap is never a fallback.
export default class DirectionalShadowPass {
  constructor(C,viewer,getOptions,isTransparentForwardActive=()=>false){
    Object.assign(this,{C,viewer,scene:viewer.scene,getOptions,enabled:false,ready:false,dead:false,levels:[],version:0})
    this.coverage=new CascadedShadowCoverage(C);this.singleCoverage=new CameraShadowCoverage(C)
    this.stats={updates:0,cacheHits:0,casters:0,receivers:0,selectedOffscreen:0,error:null,cascades:[]}
    this.uniforms=shadowUniforms(C,this.scene,()=>this.getReceiverData(viewer.camera))
    this.adapter=new ShadowReceiver143(C,this.scene,this.uniforms,{cascades:true,sunUbo:false,
      shouldReceive:command=>command.pass!==C.Pass.TRANSLUCENT||!isTransparentForwardActive()})
    this.proxy={update:state=>this.update(state),isDestroyed:()=>this.dead,destroy(){}}
    this.scene.primitives.add(this.proxy)
    this.removePreUpdate=this.scene.preUpdate.addEventListener(()=>{if(this.enabled)this.scene.primitives.raiseToTop(this.proxy)})
    this.debugStage=this.scene.postProcessStages.add(new C.PostProcessStage({name:'campus_custom_shadow_depth',
      fragmentShader:'uniform sampler2D shadowDepth;in vec2 v_textureCoordinates;void main(){float d=texture(shadowDepth,v_textureCoordinates).r;out_FragColor=vec4(vec3(d),1.0);}',
      uniforms:{shadowDepth:()=>this.levels[0]?.target.depth||this.scene.context.defaultTexture}}))
    this.debugStage.enabled=false
  }
  // Retained for environment-volume and legacy diagnostics: the far map spans
  // the broadest region. Surface receivers use getReceiverData's full contract.
  get target(){return this.levels.at(-1)?.target}
  get light(){return this.levels.at(-1)?.light}
  setOrigin(){this.invalidate()}
  invalidate(){for(const level of this.levels)level.cache.invalidate();this.ready=false;this.version++}
  setEnabled(enabled){
    if(this.dead||enabled===this.enabled)return
    this.enabled=enabled;this.invalidate()
    if(enabled){this.adapter.install()}
    else{this.adapter.detach();this.debugStage.enabled=false;this.releaseTargets()}
    if(!this.viewer.isDestroyed())this.scene.requestRender()
  }
  update(state){
    if(!this.enabled||!state.passes.render)return
    if(this.scene.mode!==this.C.SceneMode.SCENE3D){this.ready=false;return}
    state.commandList.push({pass:this.C.Pass.COMPUTE,execute:()=>this.render(state)})
  }
  sphere(bound){
    if(Number.isFinite(bound?.radius))return bound
    if(bound?.halfAxes)return this.C.BoundingSphere.fromOrientedBoundingBox(bound,new this.C.BoundingSphere())
    return null
  }
  roots(collection,out=[]){
    if(collection.show===false)return out
    for(let i=0;i<collection.length;i++){
      const p=collection.get(i);if(p.show===false)continue
      if(typeof p.get==='function'&&typeof p.length==='number')this.roots(p,out)
      else if(p.root?.boundingSphere)out.push(p.root.boundingSphere)
    }
    return out
  }
  depthBounds(region,direction,bounds){
    const C=this.C;let min=-region.extent,max=region.extent
    for(const b of bounds){
      if(!b)continue
      const offset=C.Cartesian3.subtract(b.center,region.center,new C.Cartesian3()),z=C.Cartesian3.dot(offset,direction)
      // A sphere whose light-space XY projection misses the receiver circle cannot cast onto it.
      if(C.Cartesian3.magnitudeSquared(offset)-z*z>(region.extent*Math.SQRT2+b.radius)**2)continue
      min=Math.min(min,z-b.radius);max=Math.max(max,z+b.radius)
    }
    return {min,max}
  }
  render(state){
    const C=this.C,s=this.scene,ctx=s.context,us=ctx.uniformState,options=this.getOptions()
    const camera=state.camera,commandList=state.commandList,cullingVolume=state.cullingVolume
    const viewport=C.BoundingRectangle.clone(us.viewport),previousPass=us.pass
    const gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
    try{
      const toLight=s.light instanceof C.SunLight?us.sunDirectionWC:C.Cartesian3.negate(s.light.direction,new C.Cartesian3())
      if(C.Cartesian3.dot(toLight,camera.positionWC)<=0){this.ready=false;return}
      const count=options.shadowCascades===1?1:3
      const direction=C.Cartesian3.normalize(toLight,new C.Cartesian3()),visible=[],main=new Set()
      let terrainMin=Infinity,terrainMax=-Infinity
      // Receiver spheres and the terrain height envelope are consumed only by the
      // multi-cascade coverage; the single cascade derives its region from the
      // camera ray alone, so skip that per-frame collection for the common case.
      for(const bin of s._view.frustumCommandsList)for(const pass of [C.Pass.GLOBE,C.Pass.CESIUM_3D_TILE,C.Pass.OPAQUE,C.Pass.TRANSLUCENT]){
        for(let i=0;i<(bin.indices[pass]||0);i++){
          const command=bin.commands[pass][i];main.add(command)
          if(count===1)continue
          if(pass===C.Pass.GLOBE){const region=command.owner?.data?.tileBoundingRegion;terrainMin=Math.min(terrainMin,region?.minimumHeight??0);terrainMax=Math.max(terrainMax,region?.maximumHeight??0)}
          else{const b=this.sphere(command.boundingVolume);if(b)visible.push(b)}
        }
      }
      if(count>1&&terrainMin!==Infinity){const range=terrainDepthRange(C,camera,options.shadowDistance,terrainMin,terrainMax,s.globe?.ellipsoid);if(range)visible.push(range)}
      let regions
      if(count===1){const r=this.singleCoverage.update(camera,options.shadowDistance,s.globe?.ellipsoid);regions={near:camera.frustum.near,far:options.shadowDistance,splits:[camera.frustum.near,options.shadowDistance],cascades:[r]}}
      else regions=this.coverage.update(camera,options.shadowDistance,visible)
      this.regions=regions
      if(!regions.cascades.length){this.ready=false;this.stats.cascades=[];return}
      const sizes=count===1?[options.shadowSize]:[options.shadowSize,Math.max(512,options.shadowSize/2),Math.max(512,options.shadowSize/2)]
      if(this.levels.length!==count||this.levels.some((l,i)=>l.target.size!==sizes[i])){
        this.releaseTargets()
        for(const size of sizes)this.levels.push({light:new LightFrustum(C,s),target:new ShadowTarget(C,ctx,size),cache:new ShadowCache(),ready:false,updates:0,cacheHits:0})
      }
      const bounds=count===1?null:[...commandList.map(c=>this.sphere(c.boundingVolume)).filter(Boolean),...this.roots(s.primitives)]
      const results=[]
      for(let i=0;i<count;i++){
        const level=this.levels[i],region=regions.cascades[i],lightCommands=[]
        const broad=count===1?null:this.depthBounds(region,direction,bounds)
        level.light.update(region.center,direction,region.extent,sizes[i],true,broad)
        const pass=new C.Cesium3DTilePassState({pass:C.Cesium3DTilePass.SHADOW,camera:level.light.camera,cullingVolume:level.light.cullingVolume,commandList:lightCommands})
        try{selectLightTiles(s.primitives,state,pass)}finally{state.commandList=commandList;state.camera=camera;state.cullingVolume=cullingVolume}
        for(const c of lightCommands)if(c.pass===C.Pass.COMPUTE)c.execute(s._computeEngine)
        const candidates=[...new Set([...commandList,...lightCommands])].filter(c=>c.castShadows&&c.shaderProgram&&c.pass!==C.Pass.TRANSLUCENT&&
          (!c.boundingVolume||level.light.cullingVolume.computeVisibility(c.boundingVolume)!==C.Intersect.OUTSIDE))
        if(count>1)level.light.update(region.center,direction,region.extent,sizes[i],true,this.depthBounds(region,direction,candidates.map(c=>this.sphere(c.boundingVolume)).filter(Boolean)))
        const casters=candidates.filter(c=>!c.boundingVolume||level.light.cullingVolume.computeVisibility(c.boundingVolume)!==C.Intersect.OUTSIDE)
          .map(c=>this.adapter.cast(c,level.target.framebuffer,level.light.camera,camera))
        const key=options.shadowStatic?level.cache.signature(level.light.viewProjection,sizes[i],casters):null
        if(level.ready&&level.cache.matches(key)){level.cacheHits++;this.stats.cacheHits++}
        else{
          us.updateCamera(level.light.camera);us.viewport=level.target.passState.viewport
          level.target.clear.execute(ctx,level.target.passState)
          for(const c of casters){us.updatePass(c.pass);c.execute(ctx,level.target.passState)}
          level.cache.commit(key);level.ready=true;level.updates++
        }
        results.push({size:sizes[i],near:region.near??regions.near,far:region.far??regions.far,extent:region.extent,texelWorld:level.light.texelWorld,
          depthSpan:level.light.depthSpan,casters:casters.length,selectedOffscreen:candidates.filter(c=>!main.has(c)).length,updates:level.updates,cacheHits:level.cacheHits})
      }
      this.version++;this.ready=true;this.debugStage.enabled=options.shadowDebug===true
      Object.assign(this.stats,{updates:this.stats.updates+1,casters:results.reduce((n,r)=>n+r.casters,0),receivers:this.adapter.commands.size,
        selectedOffscreen:results.reduce((n,r)=>n+r.selectedOffscreen,0),cascades:results,error:null,bytes:sizes.reduce((n,size)=>n+size*size*4,0),
        coverage:{mode:'camera',count,near:regions.near,far:regions.far,extent:regions.cascades.at(-1).extent,center:C.Cartesian3.clone(regions.cascades.at(-1).center),texelWorld:results[0].texelWorld}})
    }catch(error){this.stats.error=error.message;this.ready=false;this.setEnabled(false)}
    finally{
      state.commandList=commandList;state.camera=camera;state.cullingVolume=cullingVolume
      us.updateCamera(camera);us.updatePass(previousPass);us.viewport=viewport
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached
      this.adapter.prune()
    }
  }
  getReceiverData(camera){
    if(!this.enabled||!this.ready||!this.levels.length)return null
    if(this.receiverVersion!==this.version||!this.receiverView||!this.C.Matrix4.equals(this.receiverView,camera.inverseViewMatrix)){
      const C=this.C
      this.receiverView=C.Matrix4.clone(camera.inverseViewMatrix,this.receiverView);this.receiverVersion=this.version
      const cascades=this.levels.map(l=>({texture:l.target.depth,matrix:C.Matrix4.clone(l.light.receiverMatrix(camera)),
        params:new C.Cartesian4(1/l.target.size,l.light.texelWorld,l.light.depthSpan,1)}))
      const splits=this.regions.splits
      this.receiverData={...cascades[0],cascades,splits:new C.Cartesian4(splits[1],splits[2]??splits[1],splits[3]??splits[1],splits[0])}
    }
    return this.receiverData
  }
  releaseTargets(){for(const l of this.levels)l.target.destroy();this.levels=[];this.ready=false;this.receiverData=null;this.receiverVersion=undefined;this.stats.bytes=0;this.stats.cascades=[]}
  destroy(){
    if(this.dead)return
    this.setEnabled(false);this.removePreUpdate();this.adapter.destroy();this.releaseTargets()
    if(!this.viewer.isDestroyed()){this.scene.primitives.remove(this.proxy);this.scene.postProcessStages.remove(this.debugStage)}
    this.dead=true
  }
}
