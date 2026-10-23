import { frustumBinsOf } from '../scene/cesiumPrivate143.js'
import LightFrustum from './LightFrustum.js'
import ShadowTarget from './ShadowTarget.js'
import ShadowReceiver143 from './ShadowReceiver143.js'
import ShadowCache from './ShadowCache.js'
import selectLightTiles from './CasterCommands143.js'
import CameraShadowCoverage from './CameraShadowCoverage.js'
import CascadedShadowCoverage,{terrainDepthRange} from './CascadedShadowCoverage.js'
import {shadowUniforms} from './shadowUniforms143.js'
import {groupShadowCommands,withShadowBindings} from './ShadowSubmit143.js'
import {keepPrimitiveLast} from '../pipeline/PrimitiveOrder143.js'

// Reuse for at most one display frame by default, including a stationary camera:
// caster matrices, animation and instance buffers may change without new commands.
// Applications with static campus casters can raise this to 3 or 4 to reduce the
// shadow pass GPU duty cycle while keeping the camera path responsive.
const DEFAULT_SHADOW_UPDATE_INTERVAL=2
// 预热只让编译命中浏览器程序缓存，Cesium 首次绑定仍在主线程重编（实测中位 16 ms、p90 21 ms）。
// 每次阴影重画最多放行这么多个新投影程序，避免几十个同时就绪的投影体叠成一个长帧。
export const MAX_CASTER_LINKS_PER_FRAME=3

// Each level selects its own light-space casters. Native ShadowMap is never a fallback.
export default class DirectionalShadowPass {
  constructor(C,viewer,getOptions,isTransparentForwardActive=()=>false){
    Object.assign(this,{C,viewer,scene:viewer.scene,getOptions,enabled:false,ready:false,dead:false,levels:[],version:0})
    this.coverage=new CascadedShadowCoverage(C);this.singleCoverage=new CameraShadowCoverage(C)
    this.stats={updates:0,cacheHits:0,skippedFrames:0,casters:0,receivers:0,selectedOffscreen:0,error:null,cascades:[]}
    this.forceShadowUpdate=true
    this.shadowFrameCounter=0
    this.lastShadowFrame=-Infinity
    this.lastCommandCount=-1
    this.lastCommandRefs=[]
    this.lastPrimitiveCount=-1
    this.lastPrimitiveRefs=[]
    this.lastCameraView=null
    this.lastLightDirection=null
    this.lastFrustumKey=''
    this.lastShadowOptionsKey=''
    this.uniforms=shadowUniforms(C,this.scene,()=>this.getReceiverData(viewer.camera))
    this.isTransparentForwardActive=isTransparentForwardActive
    // 登记为动态的投影体（按 DrawCommand.owner 匹配，即 Model）在静态缓存模式下单独成层。
    // VisualPipeline 会换成它自己持有的集合，使阴影 pass 创建前的登记也生效。
    this.dynamicOwners=new WeakSet()
    // 投影程序后台预热（RHI 提供，可为空）。编译未完成的投影体先不画，避免阴影 pass 里同步编译卡帧。
    this.shaderWarmup=null
    this.warmedSources=new WeakSet()
    this.casterKeys=new WeakMap()
    this.deferredCasters=0
    this.linkedThisFrame=new Set()
    this.configureReceivers(getOptions().shadowCascades!==1)
    this.proxy={update:state=>this.update(state),isDestroyed:()=>this.dead,destroy(){}}
    this.scene.primitives.add(this.proxy)
    this.removePreUpdate=this.scene.preUpdate.addEventListener(()=>{if(this.enabled)keepPrimitiveLast(this.scene.primitives,this.proxy)})
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
  // Two severities, because callers invalidate for very different reasons.
  // Immediate (default): the depth targets or their contents changed in a way the
  // next rendered frame must reflect, so the reuse gate has to miss unconditionally.
  // Deferred: only the static-cache signature is dropped; shadowUpdateInterval still
  // decides when to redraw. Continuously animated casters such as TrafficSystem must
  // use the deferred form. Calling the immediate form once per frame pinned
  // forceShadowUpdate, which made shouldReuseShadowFrame miss on every single frame
  // and turned a 4096px shadow pass into a per-frame full redraw (measured on the
  // campus scene: 22.7 FPS with traffic vs 59.9 FPS once the redraw rate returned to
  // the configured interval).
  // dynamicOnly：只有登记过的动态投影体变化（车辆生成/显隐），保留静态层缓存，
  // 下次刷新只重新合成动态层。
  invalidate({immediate=true,dynamicOnly=false}={}){
    if(!dynamicOnly)for(const level of this.levels)level.cache.invalidate()
    this.version++
    if(!immediate)return
    this.ready=false;this.forceShadowUpdate=true
  }
  getFrameNumber(state){
    const frame=state?.frameNumber??state?.frameState?.frameNumber
    return Number.isFinite(frame)?frame:++this.shadowFrameCounter
  }
  shadowOptionsKey(options){return [options.shadowCascades,options.shadowSize,options.shadowDistance].join('|')}
  // Deliberately excludes xOffset/yOffset. Those are the TAA sub-pixel jitter
  // (src/antialiasing/TaaJitter143.js), which shifts the main projection by a
  // fraction of a pixel every frame. Including them made the key differ on every
  // jitter phase, so shouldReuseShadowFrame never hit and the shadow maps were
  // redrawn at full rate while TAA was enabled. Jitter cannot change shadow map
  // content: maps are rendered from the light camera and receivers are geometry,
  // and the coverage fit only sees the offsets at offset/near (~2e-4 here).
  cameraFrustumKey(camera){
    const f=camera?.frustum||{}
    return [f.near,f.far,f.fovy,f.aspectRatio].join('|')
  }
  rootPrimitivesMatch(){
    const current=this.scene.primitives?._primitives
    if(!Array.isArray(current))return this.scene.primitives?.length===this.lastPrimitiveCount
    if(current.length!==this.lastPrimitiveRefs.length)return false
    for(let i=0;i<current.length;i++)if(current[i]!==this.lastPrimitiveRefs[i])return false
    return true
  }
  commandListMatch(commandList){
    let index=0
    for(const command of commandList){
      if(!this.isShadowCaster(command))continue
      if(command!==this.lastCommandRefs[index++])return false
    }
    return index===this.lastCommandRefs.length
  }
  // 静态层按投影程序判定与签名：command.shaderProgram 在增强模式下是从不绑定的接收程序。
  casterProgramOf(command){return this.adapter.castProgram(this.adapter.raw(command))}
  isDynamicCaster(command){return this.dynamicOwners.has(command.owner)||!ShadowCache.cacheable(command,this.casterProgramOf(command))}
  isShadowCaster(command){return !!command.castShadows&&!!command.shaderProgram&&command.pass!==this.C.Pass.TRANSLUCENT&&command.pass!==this.C.Pass.COMPUTE}
  shadowSizesMatch(options){
    const count=options.shadowCascades===1?1:3
    const sizes=count===1?[options.shadowSize]:[options.shadowSize,Math.max(512,options.shadowSize/2),Math.max(512,options.shadowSize/2)]
    return this.levels.length===count&&this.levels.every((level,i)=>level.target.size===sizes[i])
  }
  shouldReuseShadowFrame(state,camera,commandList,toLight,options){
    // 有投影体还在后台编译：不复用上一帧，就绪后尽快补画。
    if(this.deferredCasters)return false
    if(!this.ready||this.forceShadowUpdate||!this.lastCameraView||!this.lastLightDirection)return false
    if(!this.commandListMatch(commandList)||this.lastPrimitiveCount!==this.scene.primitives?.length||!this.rootPrimitivesMatch())return false
    if(this.lastShadowOptionsKey!==this.shadowOptionsKey(options)||this.lastFrustumKey!==this.cameraFrustumKey(camera)||!this.shadowSizesMatch(options))return false
    if(this.C.Cartesian3.distanceSquared(toLight,this.lastLightDirection)>1e-12)return false
    if(this.C.Cartesian3.dot(toLight,camera.positionWC)<=0)return false
    const frame=this.getFrameNumber(state)
    const interval = Number.isFinite(options.shadowUpdateInterval)
      ? Math.max(1, Math.min(4, Math.round(options.shadowUpdateInterval)))
      : DEFAULT_SHADOW_UPDATE_INTERVAL
    if(frame-this.lastShadowFrame>=interval)return false
    if(this.C.Matrix4.equalsEpsilon(camera.viewMatrix,this.lastCameraView,1e-10)){
      this.lastShadowReuseReason='camera-stable'
      return true
    }
    if(frame-this.lastShadowFrame<interval){
      this.lastShadowReuseReason='camera-moving'
      return true
    }
    return false
  }
  rememberShadowFrame(state,camera,commandList,toLight,options){
    const roots=this.scene.primitives?._primitives
    this.lastCommandRefs=commandList.filter(command=>this.isShadowCaster(command))
    this.lastCommandCount=this.lastCommandRefs.length
    this.lastPrimitiveCount=this.scene.primitives?.length??0
    this.lastPrimitiveRefs=Array.isArray(roots)?roots.slice():[]
    this.lastCameraView=this.C.Matrix4.clone(camera.viewMatrix,this.lastCameraView)
    this.lastLightDirection=this.C.Cartesian3.clone(toLight,this.lastLightDirection)
    this.lastFrustumKey=this.cameraFrustumKey(camera)
    this.lastShadowOptionsKey=this.shadowOptionsKey(options)
    this.lastShadowFrame=this.getFrameNumber(state)
    this.forceShadowUpdate=false
  }
  skipShadowFrame(options){
    this.version++
    this.stats.skippedFrames++
    this.stats.lastSkipReason=this.lastShadowReuseReason||'adaptive'
    this.debugStage.enabled=options.shadowDebug===true
    this.adapter.prune()
  }
  configureReceivers(cascades){
    this.adapter?.destroy()
    this.adapter=new ShadowReceiver143(this.C,this.scene,this.uniforms,{cascades,sunUbo:false,
      shouldReceive:command=>command.pass!==this.C.Pass.TRANSLUCENT||!this.isTransparentForwardActive()})
    if(this.enabled)this.adapter.install()
  }
  setEnabled(enabled){
    if(this.dead)return
    const cascades=this.getOptions().shadowCascades!==1
    if(enabled&&this.adapter.cascades!==cascades)this.configureReceivers(cascades)
    if(enabled===this.enabled)return
    this.enabled=enabled;this.invalidate()
    if(enabled){this.adapter.install()}
    else{this.adapter.detach();this.debugStage.enabled=false;this.releaseTargets()}
    if(!this.viewer.isDestroyed())this.scene.requestRender()
  }
  update(state){
    if(!this.enabled||!state.passes.render)return
    if(this.scene.mode!==this.C.SceneMode.SCENE3D){this.ready=false;return}
    this.prewarmCasters(state.commandList)
    state.commandList.push({pass:this.C.Pass.COMPUTE,execute:()=>this.render(state)})
  }
  // 模型就绪后命令就进入 commandList，通常早于进入光源视锥：这时就把投影程序交给后台预热。
  // 每个源程序只看一次；本 pass 被保持在 primitives 末尾，此时 commandList 已含全部模型命令。
  prewarmCasters(commandList){
    if(!this.shaderWarmup?.parallel)return
    for(const command of commandList){
      if(!this.isShadowCaster(command))continue
      const source=this.adapter.raw(command)
      if(this.warmedSources.has(source))continue
      this.warmedSources.add(source)
      this.warmCaster(this.adapter.castProgram(source))
    }
  }
  warmCaster(program){
    // _program 是 Cesium ShaderProgram 编译后才有的 GL 句柄：已编译就无需预热。
    if(program._program!==undefined||this.casterKeys.has(program))return
    const key=this.shaderWarmup.warm({vertexShaderText:program._vertexShaderText,fragmentShaderText:program._fragmentShaderText,
      attributeLocations:program._attributeLocations})
    if(key)this.casterKeys.set(program,key)
  }
  // 返回本次可以绘制的投影体。程序仍在后台编译、或本次新程序名额已满的先跳过（阴影晚几帧出现），并请求下一帧；
  // 静态缓存签名含投影体数量，补上后会自动重画静态层。没有并行编译能力时原样返回。
  readyCasters(commands){
    const warmup=this.shaderWarmup
    if(!warmup?.parallel)return commands
    const ready=[];let deferred=0
    for(const command of commands){
      const program=this.adapter.castProgram(this.adapter.raw(command))
      if(program._program===undefined){
        this.warmCaster(program)
        const key=this.casterKeys.get(program)
        if(key&&!warmup.isReady([key])){deferred++;continue}
        // 同一次重画的后续级联再画已放行的程序不重复计数（第一次绑定后它就编译好了）。
        if(!this.linkedThisFrame.has(program)){
          if(this.linkedThisFrame.size>=MAX_CASTER_LINKS_PER_FRAME){deferred++;continue}
          this.linkedThisFrame.add(program)
        }
      }
      ready.push(command)
    }
    this.deferredCasters+=deferred
    if(deferred)this.scene.requestRender?.()
    return ready
  }
  sphere(bound){
    if(Number.isFinite(bound?.radius))return bound
    if(bound?.halfAxes)return this.C.BoundingSphere.fromOrientedBoundingBox(bound,new this.C.BoundingSphere())
    return null
  }
  orderCasters(commands){return groupShadowCommands(commands)}
  submitCasters(commands,ctx,passState,us){
    withShadowBindings(ctx._gl,()=>{for(const c of this.orderCasters(commands)){us.updatePass(c.pass);c.execute(ctx,passState)}})
  }
  drawDepth(level,target,commands,ctx,us,camera,clear=true){
    const casters=commands.map(c=>this.adapter.cast(c,target.framebuffer,level.light.camera,camera))
    us.updateCamera(level.light.camera);us.viewport=target.passState.viewport
    if(clear)target.clear.execute(ctx,target.passState)
    this.submitCasters(casters,ctx,target.passState,us)
  }
  // 静态缓存模式分两层：静态投影体缓存在 level.staticTarget，签名一致就不重画；
  // 动态投影体（登记过的、或带蒙皮/形变无法缓存的）每次刷新在静态深度的拷贝上叠加。
  // 车流播放时相机静止，只需一次深度 blit 加画车辆，不再整图重绘全部建筑。
  renderLayered(level,commands,size,ctx,us,camera){
    const staticCommands=[],dynamicCommands=[]
    for(const c of commands)(this.isDynamicCaster(c)?dynamicCommands:staticCommands).push(c)
    const reuse=level.cache.matches(level.light.viewProjection,size,staticCommands,command=>this.casterProgramOf(command))&&level.staticReady
    if(reuse){level.cacheHits++;this.stats.cacheHits++}
    else{
      level.staticTarget??=new ShadowTarget(this.C,ctx,size)
      this.drawDepth(level,level.staticTarget,staticCommands,ctx,us,camera)
      level.cache.commit();level.staticReady=true;level.staticVersion++
    }
    // 静态层未变、上次合成后也没有动态层：主深度图内容仍然正确，连 blit 都省掉。
    if(level.composedVersion===level.staticVersion&&!dynamicCommands.length&&!level.composedDynamic)return
    level.staticTarget.copyTo(ctx,level.target)
    if(dynamicCommands.length)this.drawDepth(level,level.target,dynamicCommands,ctx,us,camera,false)
    level.composedVersion=level.staticVersion;level.composedDynamic=dynamicCommands.length>0;level.updates++
  }
  releaseStaticLayer(level){
    level.staticTarget?.destroy();level.staticTarget=null;level.staticReady=false;level.composedVersion=-1
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
    const toLight=s.light instanceof C.SunLight?us.sunDirectionWC:C.Cartesian3.negate(s.light.direction,new C.Cartesian3())
    if(C.Cartesian3.dot(toLight,camera.positionWC)<=0){this.ready=false;return}
    if(this.shouldReuseShadowFrame(state,camera,commandList,toLight,options)){this.skipShadowFrame(options);return}
    const viewport=C.BoundingRectangle.clone(us.viewport),previousPass=us.pass
    const gl=ctx._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
    try{
      this.deferredCasters=0;this.linkedThisFrame.clear()
      const count=options.shadowCascades===1?1:3
      const direction=C.Cartesian3.normalize(toLight,new C.Cartesian3()),visible=[],main=count>1?new Set():null
      let terrainMin=Infinity,terrainMax=-Infinity
      // Receiver spheres and the terrain height envelope are consumed only by the
      // multi-cascade coverage; the single cascade derives its region from the
      // camera ray alone, so skip that per-frame collection for the common case.
      if(count>1) for(const bin of frustumBinsOf(s))for(const pass of [C.Pass.GLOBE,C.Pass.CESIUM_3D_TILE,C.Pass.OPAQUE,C.Pass.TRANSLUCENT]){
        for(let i=0;i<(bin.indices[pass]||0);i++){
          const command=bin.commands[pass][i];main.add(command)
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
        for(const size of sizes)this.levels.push({light:new LightFrustum(C,s),target:new ShadowTarget(C,ctx,size),cache:new ShadowCache(),ready:false,updates:0,cacheHits:0,
          staticTarget:null,staticReady:false,staticVersion:0,composedVersion:-1,composedDynamic:false})
      }
      const bounds=count===1?null:[...commandList.map(c=>this.sphere(c.boundingVolume)).filter(Boolean),...this.roots(s.primitives)]
      const results=[]
      for(let i=0;i<count;i++){
        const level=this.levels[i],region=regions.cascades[i],lightCommands=[]
        const broad=count===1?null:this.depthBounds(region,direction,bounds)
        level.light.update(region.center,direction,region.extent,sizes[i],true,broad,camera.positionWC)
        const pass=new C.Cesium3DTilePassState({pass:C.Cesium3DTilePass.SHADOW,camera:level.light.camera,cullingVolume:level.light.cullingVolume,commandList:lightCommands})
        try{selectLightTiles(s.primitives,state,pass)}finally{state.commandList=commandList;state.camera=camera;state.cullingVolume=cullingVolume}
        for(const c of lightCommands)if(c.pass===C.Pass.COMPUTE)c.execute(s._computeEngine)
        const candidates=[...new Set([...commandList,...lightCommands])].filter(c=>c.castShadows&&c.shaderProgram&&c.pass!==C.Pass.TRANSLUCENT&&
          (!c.boundingVolume||level.light.cullingVolume.computeVisibility(c.boundingVolume)!==C.Intersect.OUTSIDE))
        if(count>1)level.light.update(region.center,direction,region.extent,sizes[i],true,this.depthBounds(region,direction,candidates.map(c=>this.sphere(c.boundingVolume)).filter(Boolean)),camera.positionWC)
        const casters=this.readyCasters(candidates.filter(c=>!c.boundingVolume||level.light.cullingVolume.computeVisibility(c.boundingVolume)!==C.Intersect.OUTSIDE))
        if(options.shadowStatic)this.renderLayered(level,casters,sizes[i],ctx,us,camera)
        else{
          if(level.staticTarget){this.releaseStaticLayer(level);level.cache.invalidate()}
          this.drawDepth(level,level.target,casters,ctx,us,camera);level.updates++
        }
        level.ready=true
        results.push({size:sizes[i],near:region.near??regions.near,far:region.far??regions.far,extent:region.extent,texelWorld:level.light.texelWorld,
          depthSpan:level.light.depthSpan,casters:casters.length,selectedOffscreen:main ? candidates.filter(c=>!main.has(c)).length : 0,updates:level.updates,cacheHits:level.cacheHits})
      }
      this.version++;this.ready=true;this.debugStage.enabled=options.shadowDebug===true
      Object.assign(this.stats,{updates:this.stats.updates+1,casters:results.reduce((n,r)=>n+r.casters,0),deferredCasters:this.deferredCasters,receivers:this.adapter.commands.size,
        selectedOffscreen:results.reduce((n,r)=>n+r.selectedOffscreen,0),cascades:results,error:null,bytes:this.levels.reduce((n,l)=>n+l.target.size*l.target.size*4*(l.staticTarget?2:1),0),
        coverage:{mode:'camera',count,near:regions.near,far:regions.far,extent:regions.cascades.at(-1).extent,center:C.Cartesian3.clone(regions.cascades.at(-1).center),texelWorld:results[0].texelWorld}})
      this.rememberShadowFrame(state,camera,commandList,toLight,options)
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
    // 每条接收 draw 的每个阴影 uniform 都会调到这里（校园约 2000 次/帧）。同一帧、同一阴影版本、
    // 同一相机直接复用，不再每次读 camera.inverseViewMatrix 并比较 16 个分量。
    // 前提：一帧的命令执行期间相机不动（Cesium 在 render 之前的 initializeFrame 里更新相机）。
    const frame=this.scene.frameState?.frameNumber
    if(frame!==undefined&&frame===this.receiverFrame&&camera===this.receiverCamera&&this.receiverVersion===this.version)return this.receiverData
    this.receiverFrame=frame;this.receiverCamera=camera
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
  releaseTargets(){for(const l of this.levels){l.target.destroy();l.staticTarget?.destroy()}this.levels=[];this.ready=false;this.forceShadowUpdate=true;this.receiverData=null;this.receiverVersion=undefined;this.stats.bytes=0;this.stats.cascades=[]}
  destroy(){
    if(this.dead)return
    this.setEnabled(false);this.removePreUpdate();this.adapter.destroy();this.releaseTargets()
    if(!this.viewer.isDestroyed()){this.scene.primitives.remove(this.proxy);this.scene.postProcessStages.remove(this.debugStage)}
    this.dead=true
  }
}
