const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs')
;(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 const result=await page.evaluate(async()=>{
  const C=Cesium,ctx=fixture.viewer.scene.context,{createEnvironmentStages}=await import('/src/environment/environmentStages.js')
  const stages=createEnvironmentStages(C,{},'balanced','local',false)
  const source=C.ShaderSource.replaceMain(stages.raymarchStage.fragmentShader,'unusedRaymarch')+'\nuniform vec3 samplePoint;void main(){out_FragColor=vec4(vec3(sunVisibility(samplePoint)),1.0);}'
  const texture=new C.Texture({context:ctx,width:2,height:2,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT,
   sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST}),
   source:{width:2,height:2,arrayBufferView:new Float32Array([.2,0,0,1,.8,0,0,1,.2,0,0,1,.8,0,0,1])}})
  const target=new C.Texture({context:ctx,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT}),fb=new C.Framebuffer({context:ctx,colorTextures:[target]})
  let x=0;const state={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false}}
  const command=ctx.createViewportQuadCommand(source,{framebuffer:fb,renderState:C.RenderState.fromCache(state),uniformMap:{
   shadowTexture:()=>texture,localToShadow:()=>C.Matrix4.IDENTITY,shadowInfo:()=>new C.Cartesian4(1,.5,0,0),samplePoint:()=>new C.Cartesian3(x*2-1,0,0)}})
  const run=position=>{x=position;command.execute(ctx);return ctx.readPixels({framebuffer:fb,width:1,height:1})[0]}
  const result={left:run(.25-.0001),right:run(.25+.0001),middle:run(.5),lit:run(.75)}
  command.shaderProgram.destroy();C.RenderState.removeFromCache(state);fb.destroy();texture.destroy();stages.composite.destroy();stages.occlusionStage.destroy()
  return result
 });fs.writeFileSync('docs/verification/volume-shadow-filter.json',JSON.stringify(result,null,2));console.log(result)
 assert.ok(Math.abs(result.left-result.right)<.001,'subtexel motion must not cause a 25%/50% visibility jump')
 assert.ok(Math.abs(result.middle-.5)<.001);assert.ok(Math.abs(result.lit-1)<.001)
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})
