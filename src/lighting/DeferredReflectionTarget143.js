// Optional lighting outputs. No geometry replay and no additional G-buffer slots.
export default class DeferredReflectionTarget143 {
  constructor(C,scene){this.C=C;this.scene=scene}
  update(color){
    if(this.color===color&&this.target)return this.target
    this.destroy()
    const C=this.C,ctx=this.scene.context,t=this.target={},textures=[]
    this.color=color
    try{
      const make=()=>{const texture=new C.Texture({context:ctx,width:color.width,height:color.height,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.HALF_FLOAT,
        sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST})});textures.push(texture);return texture}
      t.textures=textures;t.reflectionSpecular=make();t.reflectionResponse=make();t.opaqueColor=make()
      t.lighting=new C.Framebuffer({context:ctx,colorTextures:[color,t.reflectionSpecular,t.reflectionResponse],destroyAttachments:false})
      t.auxiliary=new C.Framebuffer({context:ctx,colorTextures:[t.reflectionSpecular,t.reflectionResponse],destroyAttachments:false})
      t.snapshot=new C.Framebuffer({context:ctx,colorTextures:[t.opaqueColor],destroyAttachments:false})
      t.color=new C.Framebuffer({context:ctx,colorTextures:[color],destroyAttachments:false})
      for(const name of ['lighting','auxiliary','snapshot','color'])if(t[name].status!==ctx._gl.FRAMEBUFFER_COMPLETE)throw new Error('Deferred reflection target incomplete')
      t.clear=new C.ClearCommand({framebuffer:t.auxiliary,color:C.Color.TRANSPARENT})
      t.options={depthTest:{enabled:false},depthMask:false,blending:{enabled:false}}
      t.copy=ctx.createViewportQuadCommand('uniform sampler2D source;in vec2 v_textureCoordinates;void main(){out_FragColor=texture(source,v_textureCoordinates);}',{renderState:C.RenderState.fromCache(t.options),uniformMap:{source:()=>this.input}})
      return t
    }catch(error){this.destroy();throw error}
  }
  copy(source,framebuffer){
    const C=this.C,ctx=this.scene.context,ps=new C.PassState(ctx)
    ps.viewport=new C.BoundingRectangle(0,0,this.color.width,this.color.height)
    this.input=source;this.target.copy.framebuffer=framebuffer;this.target.copy.execute(ctx,ps)
  }
  destroy(){
    const t=this.target
    if(t){
      if(t.copy&&!t.copy.shaderProgram.isDestroyed())t.copy.shaderProgram.destroy()
      if(t.options)this.C.RenderState.removeFromCache(t.options)
      for(const key of ['lighting','auxiliary','snapshot','color'])if(t[key]&&!t[key].isDestroyed())t[key].destroy()
      for(const texture of t.textures||[])if(!texture.isDestroyed())texture.destroy()
    }
    this.target=null;this.color=null;this.input=null
  }
}
