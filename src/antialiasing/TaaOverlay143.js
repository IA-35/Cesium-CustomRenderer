import {particleBillboards} from '../pipeline/particleBillboards143.js'

// Screen-facing UI has no surface velocity/depth suitable for scene TAA.
// Defer its native commands, then composite on a separate target so UI pixels
// never contaminate the temporal history. Picking/ID commands remain native.
export default class TaaOverlay143 {
  constructor(C, scene, jitter) {
    Object.assign(this, {C, scene, jitter, active: false, drawing: false, skipped: 0, drawn: 0})
    const overlay=this, context=scene.context
    this.previous=context.draw
    this.hook=function(command, passState, ...args) {
      const passes=scene.frameState.passes, view=scene._view
      if(overlay.active&&!overlay.drawing&&passes.render&&!passes.pick&&!passes.depth&&
        overlay.isOverlay(command)){
        const framebuffer=command.framebuffer||passState?.framebuffer
        if(framebuffer&&framebuffer!==view?.sceneFramebuffer?.idFramebuffer&&
          (framebuffer===view?.globeDepth?.framebuffer||framebuffer===view?.sceneFramebuffer?.framebuffer||
           framebuffer===view?.oit?._translucentFBO?.framebuffer||framebuffer===view?.oit?._alphaFBO?.framebuffer)){
          overlay.skipped++;return
        }
      }
      return overlay.previous.call(this,command,passState,...args)
    }
    context.draw=this.hook
  }
  isOverlay(command) {
    const {C}=this,owner=command.owner
    if (owner instanceof C.BillboardCollection) {
      const frame=this.scene.frameState.frameNumber
      if (this.particleFrame!==frame || !this.particles) {
        this.particles=particleBillboards(C,this.scene.primitives);this.particleFrame=frame
      }
      if (this.particles.has(owner)) return false
    }
    return owner instanceof C.BillboardCollection || owner instanceof C.LabelCollection || owner instanceof C.PointPrimitiveCollection
  }
  begin(active) { this.active=active;this.skipped=0;this.drawn=0 }
  composite(color) {
    const passes=this.scene.frameState.passes
    if(!this.active||!this.skipped||!passes.render||passes.pick||passes.depth)return color
    const {C,scene}=this,context=scene.context,us=context.uniformState,view=scene._view
    const source=scene._environmentState.useGlobeDepthFramebuffer?view.globeDepth.framebuffer:view.sceneFramebuffer.framebuffer
    const depth=source.depthStencilTexture
    if(!depth)throw new Error('TAA overlay requires the native single-sample scene depth')
    if(!this.texture||this.texture.width!==color.width||this.texture.height!==color.height||this.texture.pixelDatatype!==color.pixelDatatype){
      this.releaseTarget()
      this.texture=new C.Texture({context,width:color.width,height:color.height,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:color.pixelDatatype})
    }
    if(!this.framebuffer||this.depth!==depth){
      this.framebuffer?.destroy()
      this.framebuffer=new C.Framebuffer({context,colorTextures:[this.texture],depthStencilTexture:depth,destroyAttachments:false})
      this.depth=depth
    }
    if(!this.copy)this.copy=context.createViewportQuadCommand('uniform sampler2D u_color; in vec2 v_textureCoordinates; void main(){out_FragColor=texture(u_color,v_textureCoordinates);}',{
      uniformMap:{u_color:()=>this.input},renderState:C.RenderState.fromCache({depthTest:{enabled:false},depthMask:false})})
    const viewport=C.BoundingRectangle.clone(us.viewport),previousPass=us.pass
    const gl=context._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=context._currentFramebuffer
    const saved=C.PerspectiveFrustum.prototype.clone.call(scene.camera.frustum),stable=C.PerspectiveFrustum.prototype.clone.call(scene.camera.frustum)
    saved.near=stable.near=us.currentFrustum.x;saved.far=stable.far=us.currentFrustum.y
    const request=this.jitter.getRequest(),ratio=stable.near/scene.camera.frustum.near
    saved.xOffset=scene.camera.frustum.xOffset*ratio;saved.yOffset=scene.camera.frustum.yOffset*ratio
    stable.xOffset=(request?.baseX||0)*ratio;stable.yOffset=(request?.baseY||0)*ratio
    this.input=color;this.copy.framebuffer=this.framebuffer
    const pass=new C.PassState(context);pass.framebuffer=this.framebuffer;pass.viewport=new C.BoundingRectangle(0,0,color.width,color.height)
    try{
      this.drawing=true;us.viewport=pass.viewport
      this.copy.execute(context,pass)
      us.updateFrustum(stable)
      const commands=scene.frameState.commandList.filter(c=>this.isOverlay(c)&&c.shaderProgram&&
        (!scene.debugCommandFilter||scene.debugCommandFilter(c)))
      commands.sort((a,b)=>a.pass-b.pass)
      for(const original of commands){
        let command=original
        if(scene.frameState.useLogDepth&&command.derivedCommands?.logDepth)command=command.derivedCommands.logDepth.command
        if(scene.highDynamicRange&&command.derivedCommands?.hdr)command=command.derivedCommands.hdr.command
        us.updatePass(command.pass)
        command.execute(context,pass);this.drawn++
      }
      return this.texture
    }finally{
      this.drawing=false;us.updateFrustum(saved);us.updatePass(previousPass);us.viewport=viewport
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);context._currentFramebuffer=cached
    }
  }
  releaseTarget(){this.framebuffer?.destroy();this.texture?.destroy();this.framebuffer=this.texture=this.depth=undefined}
  getDiagnostics(){return {active:this.active,skipped:this.skipped,drawn:this.drawn,bytes:this.texture?.sizeInBytes||0}}
  destroy(){this.active=false;if(this.scene.context.draw===this.hook)this.scene.context.draw=this.previous;this.releaseTarget();this.copy?.shaderProgram.destroy();this.copy=undefined}
}
