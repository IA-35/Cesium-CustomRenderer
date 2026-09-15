import {edgesShader} from '../../src/antialiasing/smaaShaders.js'
import {fxaaShader} from '../../src/antialiasing/fxaaShader143.js'
import {spatialQuality} from '../../src/antialiasing/settings143.js'

export function runSpatialAaChecks(C,viewer){
 const context=viewer.scene.context,gl=context._gl,size=64,resources=[],states=[],checks={}
 const viewport=C.BoundingRectangle.clone(context.uniformState.viewport),read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
 const data=new Float32Array(size*size*4)
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=x>y*.45+12?.475:.4;data[i+3]=.37}
 const texture=new C.Texture({context,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT,source:{width:size,height:size,arrayBufferView:data},flipY:false,
  sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.LINEAR,magnificationFilter:C.TextureMagnificationFilter.LINEAR})});resources.push(texture)
 const run=shader=>{
  const t=new C.Texture({context,width:size,height:size,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT});resources.push(t)
  const f=new C.Framebuffer({context,colorTextures:[t],destroyAttachments:false});resources.push(f)
  const options={viewport:new C.BoundingRectangle(0,0,size,size),depthTest:{enabled:false},depthMask:false};states.push(options)
  const state=C.RenderState.fromCache(options)
  new C.ClearCommand({framebuffer:f,color:C.Color.TRANSPARENT,renderState:state}).execute(context)
  const command=context.createViewportQuadCommand(shader,{framebuffer:f,renderState:state,uniformMap:{colorTexture:()=>texture,resolution:()=>new C.Cartesian2(1/size,1/size)}});resources.push(command.shaderProgram);command.execute(context)
  return context.readPixels({framebuffer:f,width:size,height:size})
 }
 const assert=(name,value)=>{checks[name]=!!value;if(!value)throw new Error('Spatial AA: '+name)}
 try{
  const sharp=run(edgesShader),balanced=run(edgesShader.replace('#define SMAA_THRESHOLD 0.1','#define SMAA_THRESHOLD 0.05'))
  const count=a=>a.reduce((n,v,i)=>n+(i%4<2&&v>.5?1:0),0)
  assert('balancedDetectsLowContrastEdgesMissedByOriginal',count(sharp)===0&&count(balanced)>20)
  const output=run(fxaaShader(C,spatialQuality('balanced')))
  let blended=0;for(let i=0;i<output.length;i+=4)if(output[i]>.401&&output[i]<.474)blended++
  assert('fxaaSmoothsLowContrastDiagonal',blended>20)
  assert('fxaaPreservesAlpha',output.every((v,i)=>i%4!==3||Math.abs(v-.37)<.00001))
  assert('finiteOutput',output.every(Number.isFinite))
  for(let i=0;i<data.length;i+=4)data[i]=data[i+1]=data[i+2]=.4
  texture.copyFrom({source:{width:size,height:size,arrayBufferView:data}})
  const flat=run(fxaaShader(C,spatialQuality('smooth')))
  assert('flatColorUnchanged',flat.every((v,i)=>Math.abs(v-(i%4===3?.37:.4))<.00001))
  return {checks,measurements:{originalEdgePixels:count(sharp),balancedEdgePixels:count(balanced),fxaaBlendedPixels:blended}}
 }finally{for(const r of resources.reverse())if(!r.isDestroyed())r.destroy();for(const state of states)C.RenderState.removeFromCache(state);context.uniformState.viewport=viewport;gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)}
}
