import { reflectionCommon, traceFunctions } from '../../src/reflections/ssrShaders143.js'

export function runReflectionTransitionChecks(C,viewer) {
  const context=viewer.scene.context,gl=context._gl,viewport=C.BoundingRectangle.clone(context.uniformState.viewport)
  const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const texture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
  const fbo=new C.Framebuffer({context,colorTextures:[texture],destroyAttachments:false})
  const state={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false}
  const params=new C.Cartesian4(.5,.5,.8,0),extras=new C.Cartesian2(100,.1)
  let command
  try {
    command=context.createViewportQuadCommand(`${reflectionCommon}\n${traceFunctions}
      uniform vec4 u_params; uniform vec2 u_extras;
      void main(){out_FragColor=vec4(reflectionHitConfidence(u_params.xy,u_params.z,u_extras.x,u_params.w,u_extras.y));}`,{
      framebuffer:fbo,renderState:C.RenderState.fromCache(state),uniformMap:{u_params:()=>params,u_extras:()=>extras}})
    const sample=(edge,facing,length,budget)=>{params.x=edge;params.z=facing;params.w=budget;extras.x=length;command.execute(context);return context.readPixels({framebuffer:fbo,width:1,height:1})[0]}
    const center=sample(.5,.8,100,0),edge=sample(.005,.8,100,0),grazing=sample(.5,.025,100,0),short=sample(.5,.8,2.1,0),budget=sample(.5,.8,100,.99)
    const checks={centralHitPreserved:center>.99,edgeFades:edge>0&&edge<.1,grazingFades:grazing>0&&grazing<.1,
      shortRayFades:short>0&&short<.1,budgetBoundaryFades:budget>0&&budget<.1}
    if(!Object.values(checks).every(Boolean))throw new Error(JSON.stringify({checks,center,edge,grazing,short,budget}))
    return {checks,measurements:{center,edge,grazing,short,budget}}
  }finally{if(command)command.shaderProgram.destroy();fbo.destroy();texture.destroy();C.RenderState.removeFromCache(state);context.uniformState.viewport=viewport;gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)}
}
