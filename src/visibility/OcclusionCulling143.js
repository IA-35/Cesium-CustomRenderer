import OccluderCache143 from './OccluderCache143.js'
import {createFrameBridge} from '../pipeline/FrameBridge143.js'
import {getRenderTargetPool} from '../pipeline/RenderTargetPool143.js'

export function acceptOcclusionResult(state,visible,issued,current){
  if(issued!==current||visible){state.hidden=false;state.misses=0;state.confirmed=issued===current&&visible;return}
  state.misses++;state.hidden=state.misses>=2;state.confirmed=state.hidden
}
export function projectOcclusionBounds(C,camera,sphere,width,height){
  if(C.Cartesian3.distance(camera.positionWC,sphere.center)<=sphere.radius)return null
  const center=C.Matrix4.multiplyByPoint(camera.viewMatrix,sphere.center,new C.Cartesian3()),near=-center.z-sphere.radius
  if(near<=camera.frustum.near*1.01)return null
  const rect=new C.Cartesian4(Infinity,Infinity,-Infinity,-Infinity)
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
    const clip=C.Matrix4.multiplyByVector(camera.frustum.projectionMatrix,new C.Cartesian4(center.x+x*sphere.radius,center.y+y*sphere.radius,center.z+z*sphere.radius,1),new C.Cartesian4())
    rect.x=Math.min(rect.x,clip.x/clip.w);rect.y=Math.min(rect.y,clip.y/clip.w);rect.z=Math.max(rect.z,clip.x/clip.w);rect.w=Math.max(rect.w,clip.y/clip.w)
  }
  rect.x=Math.max(-1,rect.x-4/width);rect.y=Math.max(-1,rect.y-4/height);rect.z=Math.min(1,rect.z+4/width);rect.w=Math.min(1,rect.w+4/height)
  if(rect.x>=rect.z||rect.y>=rect.w)return null
  return {rect,near,area:(rect.z-rect.x)*(rect.w-rect.y)/4}
}

export default class OcclusionCulling143 {
  constructor(C,scene,getMaterials,onDemand=()=>{}){
    Object.assign(this,{C,scene,getMaterials,onDemand,enabled:false,needsDepth:false,states:new Map(),groups:[],pending:[],key:null,frame:null,pollFrames:0,
      stats:{queries:0,available:0,skippedDraws:0,skippedTriangles:0,invalidations:0,timeouts:0},owner:{kind:'occlusion'},quiescent:true,warmup:0,stableFrames:0})
  }
  setDemand(value){if(this.needsDepth!==value){this.needsDepth=value;this.onDemand()}}
  setEnabled(value){
    if(this.destroyed)return
    if(!value){this.detach();this.failed=false;this.reason='Disabled';return}
    if(this.enabled||this.failed)return
    const C=this.C,s=this.scene,ctx=s.context,gl=ctx._gl
    if(!ctx.webgl2||!gl.createQuery){this.reason='Requires WebGL2 occlusion queries';return}
    try{
    this.enabled=true;this.cache=new OccluderCache143(C,s);this.pool=getRenderTargetPool(C,ctx);this.pool.attach(this.owner)
    const previous=ctx.draw,token={active:true},self=this;this.previous=previous;this.token=token
    this.hook=function(command,ps,...args){
      const fb=command.framebuffer||ps?.framebuffer,view=s._view
      if(token.active&&self.shouldCull(command)&&(fb===view.globeDepth?.colorFramebufferManager?.framebuffer||fb===view.sceneFramebuffer?._colorFramebuffer?.framebuffer)){
        self.recordSkip(command);return
      }
      return previous.call(this,command,ps,...args)
    }
    ctx.draw=this.hook
    this.proxy={update:state=>{if(state.passes.render)state.commandList.unshift({pass:C.Pass.COMPUTE,execute:()=>this.prepare()})},isDestroyed:()=>false,destroy(){}}
    s.primitives.add(this.proxy);this.offUpdate=s.preUpdate.addEventListener(()=>s.primitives.raiseToTop(this.proxy))
    this.bridge=createFrameBridge({Cesium:C,scene:s});this.offResolve=this.bridge.on('resolve',()=>this.query());this.bridge.install()
    this.offPost=s.postRender.addEventListener(()=>{if((this.needsDepth||this.warmup>0)&&this.pollFrames<8){this.pollFrames++;this.warmup=Math.max(0,this.warmup-1);s.requestRender()}})
    this.onLost=()=>{this.reason='Context lost';this.detach()};s.canvas?.addEventListener('webglcontextlost',this.onLost)
    s.requestRender()
    }catch(error){this.reason=error.message;this.failed=true;this.detach()}
  }
  viewKey(){
    const C=this.C,s=this.scene,c=s.camera
    return JSON.stringify([s.mode,s.drawingBufferWidth,s.drawingBufferHeight,c.positionWC,c.directionWC,c.upWC,...C.Matrix4.toArray(c.frustum.projectionMatrix)])
  }
  prepare(){
    if(!this.enabled)return
    const C=this.C,s=this.scene,commands=[]
    this.frame=s.frameState.frameNumber;this.stats.skippedDraws=0;this.stats.skippedTriangles=0
    if(s.mode!==C.SceneMode.SCENE3D||!(s.camera.frustum instanceof C.PerspectiveFrustum)||s._environmentState.useWebVR||s._environmentState.useInvertClassification||s._globeTranslucencyState?.translucent){this.reset();this.setDemand(false);this.reason='Unsupported view or classification remains visible';return}
    // Apply scene.debugCommandFilter here too: it only suppresses drawing
    // inside Scene.executeCommand, so ignoring it here would let the cache
    // keep hiding objects that were occluded by a wall that is now filtered
    // out (the command list and content revision do not change on their own).
    // Excluding filtered commands makes the cache signature change, which bumps
    // the revision and invalidates the stale hidden state (review R6).
    const filter=s.debugCommandFilter
    for(const bin of s._view.frustumCommandsList)for(const pass of [C.Pass.OPAQUE,C.Pass.CESIUM_3D_TILE])for(let i=0;i<(bin.indices[pass]||0);i++){const command=bin.commands[pass][i];if(!filter||filter(command))commands.push(command)}
    const snapshot=this.cache.update([...new Set(commands)]),key=this.viewKey()+':'+snapshot.revision
    if(key!==this.key){
      this.reset();this.key=key;this.stats.invalidations++;this.stableFrames=0
      if(this.quiescent){this.pollFrames=0;this.warmup=2;this.quiescent=false}
    }else this.stableFrames++
    this.groups=snapshot.groups.map(g=>({...g,projected:projectOcclusionBounds(C,s.camera,g.sphere,s.drawingBufferWidth,s.drawingBufferHeight)}))
    if(snapshot.unsafe){this.reset();this.warmup=0;this.setDemand(false);this.reason='Dynamic or unknown deformation remains visible';return}
    if(this.stableFrames<1){this.setDemand(false);this.reason='Waiting for stable view and content';return}
    this.poll()
    const occluders=this.groups.filter(g=>g.projected&&g.projected.area>=.12)
    const occluderSet=new Set(occluders)
    const contains=(a,b)=>a.x<=b.x&&a.y<=b.y&&a.z>=b.z&&a.w>=b.w
    this.candidates=this.groups.filter(g=>g.projected&&!occluderSet.has(g)&&occluders.some(o=>o.projected.near<g.projected.near&&contains(o.projected.rect,g.projected.rect)))
    const candidateSet=new Set(this.candidates)
    for(const g of this.groups){if(!this.states.has(g.owner))this.states.set(g.owner,{hidden:false,misses:0,confirmed:false});if(!candidateSet.has(g))Object.assign(this.states.get(g.owner),{hidden:false,misses:0,confirmed:true})}
    const unresolved=this.candidates.some(g=>!this.states.get(g.owner).confirmed)
    this.setDemand(unresolved||this.pending.length>0)
    if(!this.needsDepth){this.quiescent=true;this.warmup=0}
    this.reason=this.candidates.length?'Conservative queries / stable visibility cache':'No useful occluder overlap; queries disabled'
  }
  poll(){
    const gl=this.scene.context._gl
    this.pending=this.pending.filter(record=>{
      if(!gl.getQueryParameter(record.query,gl.QUERY_RESULT_AVAILABLE)){
        if(this.pollFrames<8)return true
        this.stats.timeouts++;Object.assign(record.state,{hidden:false,misses:0,confirmed:true})
      }else{acceptOcclusionResult(record.state,!!gl.getQueryParameter(record.query,gl.QUERY_RESULT),record.key,this.key);this.stats.available++;if(record.key===this.key)this.pollFrames=0}
      record.state.pending=false;gl.deleteQuery(record.query);return false
    })
  }
  shouldCull(command){
    const s=this.scene
    return this.enabled&&this.frame===s.frameState.frameNumber&&s.frameState.passes.render&&!s.frameState.passes.pick&&!s.frameState.passes.depth&&
      [this.C.Pass.OPAQUE,this.C.Pass.CESIUM_3D_TILE].includes(command.pass)&&this.states.get(command.owner)?.hidden===true&&
      (!s.debugCommandFilter||s.debugCommandFilter(command))
  }
  recordSkip(command){this.stats.skippedDraws++;this.stats.skippedTriangles+=(command.count||0)*(command.instanceCount||1)/(command.primitiveType===this.C.PrimitiveType.TRIANGLES?3:1)}
  createCommands(){
    const C=this.C,ctx=this.scene.context
    this.fillOptions={depthTest:{enabled:true,func:C.DepthFunction.ALWAYS},depthMask:true,colorMask:{red:false,green:false,blue:false,alpha:false}}
    this.proxyOptions={depthTest:{enabled:true,func:C.DepthFunction.LESS_OR_EQUAL},depthMask:false,colorMask:{red:false,green:false,blue:false,alpha:false},cull:{enabled:false}}
    this.fill=ctx.createViewportQuadCommand(`uniform sampler2D depthTexture;uniform sampler2D flagsTexture;uniform float farLog;in vec2 v_textureCoordinates;
      void main(){float d=texture(depthTexture,v_textureCoordinates).r;int flags=int(mod(texture(flagsTexture,v_textureCoordinates).a,1024.0)+.5);
        gl_FragDepth=d>0.0&&(flags&1)==1&&(flags&64)==0?log2(1.0+d)/farLog:1.0;out_FragColor=vec4(0.0);}`,{
      renderState:C.RenderState.fromCache(this.fillOptions),uniformMap:{depthTexture:()=>this.textures.eyeDepth,flagsTexture:()=>this.textures.emissiveFlags,farLog:()=>this.farLog}})
    const vs=new C.ShaderSource({sources:['in vec4 position;uniform vec4 rectangle;uniform float nearest;void main(){gl_Position=vec4(mix(rectangle.xy,rectangle.zw,position.xy*.5+.5),nearest,1.0);}']})
    this.proxyDraw=new C.DrawCommand({vertexArray:this.fill.vertexArray,primitiveType:this.fill.primitiveType,
      shaderProgram:C.ShaderProgram.fromCache({context:ctx,vertexShaderSource:vs,fragmentShaderSource:'void main(){out_FragColor=vec4(0.0);}',attributeLocations:{position:0}}),
      renderState:C.RenderState.fromCache(this.proxyOptions),uniformMap:{rectangle:()=>this.queryBounds.rect,nearest:()=>this.queryDepth}})
  }
  query(){
    if(!this.enabled||!this.needsDepth)return
    const C=this.C,s=this.scene,ctx=s.context,gl=ctx._gl
    const candidates=this.candidates?.filter(g=>{const state=this.states.get(g.owner);return !state.confirmed&&!state.pending}).slice(0,128)||[]
    if(!candidates.length)return
    this.textures=this.getMaterials()?.getTextures()
    if(!this.textures?.eyeDepth||!this.textures.emissiveFlags)return
    if(gl.getQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,gl.CURRENT_QUERY)){this.reason='Foreign occlusion query active';return}
    const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer,viewport=C.BoundingRectangle.clone(ctx.uniformState.viewport)
    let lease
    try{
      if(!this.fill)this.createCommands()
      this.pool.resize(s.drawingBufferWidth,s.drawingBufferHeight)
      lease=this.pool.acquire(this.owner,{width:s.drawingBufferWidth,height:s.drawingBufferHeight,pixelFormat:C.PixelFormat.DEPTH_COMPONENT,pixelDatatype:C.PixelDatatype.UNSIGNED_INT,depth:true,samples:1})
      const ps=new C.PassState(ctx);ps.framebuffer=lease.framebuffer;ps.viewport=new C.BoundingRectangle(0,0,s.drawingBufferWidth,s.drawingBufferHeight)
      this.farLog=Math.log2(1+s.camera.frustum.far)
      this.fill.framebuffer=lease.framebuffer;this.fill.execute(ctx,ps)
      for(const group of candidates){
        const query=gl.createQuery();if(!query)break
        this.queryBounds=group.projected;this.queryDepth=2*Math.log2(1+Math.max(0,group.projected.near-Math.max(.05,group.projected.near*.0001)))/this.farLog-1
        this.proxyDraw.framebuffer=lease.framebuffer
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,query)
        let completed=false
        try{this.proxyDraw.execute(ctx,ps);completed=true}finally{gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);if(!completed)gl.deleteQuery(query)}
        const state=this.states.get(group.owner);state.pending=true;this.pending.push({query,state,key:this.key});this.stats.queries++
      }
    }catch(error){this.reason=error.message;this.failed=true;this.detach()}
    finally{lease?.release();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached;ctx.uniformState.viewport=viewport}
  }
  reset(){const gl=this.scene.context?._gl;for(const r of this.pending)gl?.deleteQuery(r.query);this.pending=[];this.states.clear()}
  getDiagnostics(){return {enabled:this.enabled,failed:!!this.failed,reason:this.reason,groups:this.groups.length,hidden:[...this.states.values()].filter(s=>s.hidden).length,pending:this.pending.length,
    needsDepth:this.needsDepth,queryBudget:128,revision:this.cache?.revision,...this.stats}}
  detach(){
    this.enabled=false;this.setDemand(false);this.reset();this.cache?.destroy();this.cache=null
    if(this.token)this.token.active=false
    if(this.scene.context?.draw===this.hook)this.scene.context.draw=this.previous
    this.offUpdate?.();this.offPost?.();this.offResolve?.();this.bridge?.destroy();this.bridge=null
    if(this.onLost)this.scene.canvas?.removeEventListener('webglcontextlost',this.onLost)
    if(this.proxy&&!this.scene.isDestroyed?.())this.scene.primitives.remove(this.proxy);this.proxy=null
    for(const command of [this.fill,this.proxyDraw])if(command&&!command.shaderProgram.isDestroyed())command.shaderProgram.destroy()
    if(this.fillOptions)this.C.RenderState.removeFromCache(this.fillOptions)
    if(this.proxyOptions)this.C.RenderState.removeFromCache(this.proxyOptions)
    this.fillOptions=this.proxyOptions=null
    this.fill=this.proxyDraw=null;this.pool?.detach(this.owner);this.pool=null;this.key=null;this.quiescent=true;this.warmup=0;this.pollFrames=0
  }
  destroy(){if(this.destroyed)return;this.detach();this.destroyed=true}
}
