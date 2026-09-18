// Compare every depth texel within the same scene frame. Ambient probe/UI changes
// between presented frames cannot be mistaken for a shadow-order regression.
export function shadowDepthParity(C, pipeline) {
  const shadow=pipeline.customShadow,s=pipeline.viewer.scene,ctx=s.context,gl=ctx._gl,us=ctx.uniformState
  const submit=shadow.submitCasters,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
  const viewport=C.BoundingRectangle.clone(us.viewport),size=shadow.target.size,half=size/2
  const depth=new C.Texture({context:ctx,width:size,height:size,pixelFormat:shadow.target.depth.pixelFormat,pixelDatatype:shadow.target.depth.pixelDatatype,
    sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST})})
  const copy=new C.Framebuffer({context:ctx,depthTexture:depth})
  const color=new C.Texture({context:ctx,width:half,height:half,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.UNSIGNED_BYTE})
  const output=new C.Framebuffer({context:ctx,colorTextures:[color]})
  const rs={viewport:new C.BoundingRectangle(0,0,half,half),depthTest:{enabled:false},depthMask:false}
  const command=ctx.createViewportQuadCommand(`uniform sampler2D beforeDepth;uniform sampler2D afterDepth;
    float differs(ivec2 p){return texelFetch(beforeDepth,p,0).r==texelFetch(afterDepth,p,0).r?0.0:1.0;}
    void main(){ivec2 p=ivec2(gl_FragCoord.xy)*2;out_FragColor=vec4(differs(p),differs(p+ivec2(1,0)),differs(p+ivec2(0,1)),differs(p+ivec2(1,1)));}`,{
    framebuffer:output,renderState:C.RenderState.fromCache(rs),uniformMap:{beforeDepth:()=>depth,afterDepth:()=>shadow.target.depth}})
  try {
    shadow.submitCasters=function(commands,context,passState,uniformState){for(const c of commands){uniformState.updatePass(c.pass);c.execute(context,passState)}}
    shadow.render(s.frameState)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,shadow.target.framebuffer._framebuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,copy._framebuffer)
    gl.blitFramebuffer(0,0,size,size,0,0,size,size,gl.DEPTH_BUFFER_BIT,gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached
    shadow.submitCasters=submit;shadow.render(s.frameState)
    command.execute(ctx)
    const pixels=ctx.readPixels({framebuffer:output,width:half,height:half});let different=0
    for(const byte of pixels)if(byte)different++
    return {texels:size*size,different,glError:gl.getError()}
  } finally {
    shadow.submitCasters=submit;command.shaderProgram.destroy();C.RenderState.removeFromCache(rs);copy.destroy();output.destroy()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);ctx._currentFramebuffer=cached;us.viewport=viewport
  }
}
