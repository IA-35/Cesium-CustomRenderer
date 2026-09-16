const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html')
  await page.waitForFunction(()=>window.fixture)
  const r=await page.evaluate(async()=>{
   const C=Cesium,f=fixture,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js')
   const {waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js')
   await startStage1Scene(f)
   const p=f.pipeline,s=f.viewer.scene,ctx=s.context,gl=ctx._gl,wait=n=>waitFrames(s,n,f.errors)
   s.skyBox.show=false;s.skyAtmosphere.show=false
   p.setHdrBloom({enabled:false});p.setAntiAliasing({mode:'off'});p.setOptions({environment:false,clouds:false,shadows:true,shadowMode:'custom'})
   p.setScreenSpaceAO({enabled:true,algorithm:'hbao',radius:5,strength:1})
   const w=s.drawingBufferWidth,h=s.drawingBufferHeight
   const texture=new C.Texture({context:ctx,width:w,height:h,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
   const framebuffer=new C.Framebuffer({context:ctx,colorTextures:[texture],destroyAttachments:false})
   let input
   const state={viewport:new C.BoundingRectangle(0,0,w,h),depthTest:{enabled:false},depthMask:false}
   const cmd=ctx.createViewportQuadCommand('uniform sampler2D source; in vec2 v_textureCoordinates; void main(){out_FragColor=texture(source,v_textureCoordinates);}',{
     framebuffer,renderState:C.RenderState.fromCache(state),uniformMap:{source:()=>input}})
   const read=source=>{
    const previous=ctx._currentFramebuffer,rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),viewport=C.BoundingRectangle.clone(ctx.uniformState.viewport)
    try{input=source;cmd.execute(ctx);return ctx.readPixels({framebuffer,width:w,height:h})}
    finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,rd);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dr);ctx._currentFramebuffer=previous;ctx.uniformState.viewport=viewport}
   }
   const color=()=>read(s._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0))
   const capture=async terms=>{p.setLighting({mode:'deferred',...terms});await wait(12);return color()}
   const direct=await capture({direct:true,indirect:false,emissive:false,shadow:false,ao:false})
   const directAo=await capture({ao:true})
   const flags=read(p.deferredLighting.materials.target.emissiveFlags)
   const valid=i=>flags[i+3]>=1024
   const difference=(a,b)=>{
    let max=0,darker=0
    for(let i=0;i<a.length;i+=4)if(valid(i)){let changed=false;for(let c=0;c<3;c++){max=Math.max(max,Math.abs(a[i+c]-b[i+c]));if(b[i+c]<a[i+c]-.0005)changed=true}if(changed)darker++}
    return {max,darker}
   }
   const indirect=await capture({direct:false,indirect:true,emissive:false,shadow:false,ao:false})
   const indirectAo=await capture({ao:true})
   const shadowOff=await capture({direct:true,indirect:false,emissive:false,ao:false,shadow:false})
   const shadowOn=await capture({shadow:true})
   const emission=await capture({direct:false,indirect:false,emissive:true,ao:false,shadow:false})
   const emissionEffects=await capture({ao:true,shadow:true})
   const result={directAo:difference(direct,directAo),indirectAo:difference(indirect,indirectAo),
    directShadow:difference(shadowOff,shadowOn),emissiveInvariant:difference(emission,emissionEffects),
    lighting:p.getLightingDiagnostics(),ao:p.getScreenSpaceAODiagnostics(),errors:f.errors.slice()}
   p.setScreenSpaceAO({enabled:false});p.setOptions({shadows:false});p.setLighting({mode:'enhanced'})
   const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin)
   const offset=new C.Cartesian3(0,-20,18)
   const glassMatrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(offset),new C.Matrix4())
   C.Matrix4.multiply(glassMatrix,C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationX(Math.PI/2)),glassMatrix)
   C.Matrix4.multiplyByScale(glassMatrix,new C.Cartesian3(40,40,1),glassMatrix)
   s.primitives.add(new C.Primitive({asynchronous:false,
     geometryInstances:new C.GeometryInstance({geometry:new C.PlaneGeometry({vertexFormat:C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT}),modelMatrix:glassMatrix,
       attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(new C.Color(.2,.5,.8,.5))}}),
     appearance:new C.PerInstanceColorAppearance({flat:true,translucent:true,closed:false,
       fragmentShaderSource:'void main(){out_FragColor=vec4(0.2,0.5,0.8,0.5);}',renderState:{depthTest:{enabled:true},depthMask:false,cull:{enabled:false}}})}))
   await wait(20)
   const point=C.SceneTransforms.worldToWindowCoordinates(s,C.Matrix4.multiplyByPoint(frame,offset,new C.Cartesian3()))
   const index=((h-1-Math.round(point.y))*w+Math.round(point.x))*4
   const nativeTransparent=Array.from(color().slice(index,index+3))
   p.setLighting({mode:'deferred',direct:true,indirect:true,emissive:true,shadow:false,ao:false});await wait(12)
   result.transparent={native:nativeTransparent,deferred:Array.from(color().slice(index,index+3)),
     coverage:read(p.deferredLighting.materials.target.transparency)[index],draws:p.getLightingDiagnostics().stats.coverageDraws}
   cmd.shaderProgram.destroy();C.RenderState.removeFromCache(state);framebuffer.destroy();texture.destroy()
   return result
  })
  fs.writeFileSync(path.join(__dirname,'../docs/verification/B02-composition.json'),JSON.stringify({...r,pageErrors:errors},null,2))
  assert.deepEqual(errors,[]);assert.deepEqual(r.errors,[])
  assert.ok(r.directAo.max<.00001,'AO must not darken direct lighting')
  assert.ok(r.indirectAo.darker>10,'AO must affect actual indirect pixels')
  assert.ok(r.directShadow.darker>10,'shadow must affect actual direct pixels')
  assert.ok(r.emissiveInvariant.max<.00001,'shadow/AO must not change emission')
  assert.equal(r.lighting.stats.lastAoValid,true);assert.equal(r.lighting.stats.lastShadowValid,true)
  assert.ok(r.transparent.native.every((v,i)=>Math.abs(v-r.transparent.deferred[i])<.01),'transparent/native composition parity')
  assert.equal(r.transparent.coverage,1);assert.ok(r.transparent.draws>0)
  console.log(JSON.stringify({directAo:r.directAo,indirectAo:r.indirectAo,directShadow:r.directShadow,emissive:r.emissiveInvariant}))
 }finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
