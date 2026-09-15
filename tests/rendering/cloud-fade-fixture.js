import { cloudShellGLSL } from '../../src/environment/cloudShell143.js'

export function runCloudFadeChecks(C, viewer) {
  const context=viewer.scene.context, gl=context._gl
  const viewport=C.BoundingRectangle.clone(context.uniformState.viewport)
  const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const texture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
  const fbo=new C.Framebuffer({context,colorTextures:[texture],destroyAttachments:false})
  const radiusHeight=new C.Cartesian2(6378137,100),point=new C.Cartesian3()
  const state={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false}
  let command
  try {
    command=context.createViewportQuadCommand(`${cloudShellGLSL}
      uniform vec3 u_point;
      void main(){out_FragColor=vec4(shellDistanceVisibility(u_point));}`,{
      framebuffer:fbo,renderState:C.RenderState.fromCache(state),uniformMap:{shellRadiusHeight:()=>radiusHeight,u_point:()=>point}})
    const sample=(height,distance)=>{radiusHeight.y=height;point.x=distance;command.execute(context);return context.readPixels({framebuffer:fbo,width:1,height:1})[0]}
    const near=sample(100,5000),start=sample(100,12000),middle=sample(100,30000),far=sample(100,50000)
    const orbit=sample(2000000,2000000),above=sample(100000,100000)
    const checks={nearCloudsUnchanged:near===1&&start===1,farCloudsFade:middle>0&&middle<1&&far===0,
      highAltitudeRangeStaysBounded:orbit===0&&above===0}
    if(!Object.values(checks).every(Boolean))throw new Error(JSON.stringify({checks,near,start,middle,far,orbit,above}))
    return {checks,measurements:{near,start,middle,far,orbit,above}}
  }finally{
    if(command)command.shaderProgram.destroy();fbo.destroy();texture.destroy();C.RenderState.removeFromCache(state)
    context.uniformState.viewport=viewport;gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)
  }
}
