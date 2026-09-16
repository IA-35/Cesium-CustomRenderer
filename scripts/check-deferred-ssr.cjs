const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),assert=require('node:assert/strict')
const umd=process.argv.includes('--umd')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 if(umd){await page.addScriptTag({url:'http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/build/0.1.0/CCR.min.js'});await page.evaluate(()=>{fixture.CCR=window.CCR})}
 const r=await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js')
  await startStage1Scene(f);const s=f.viewer.scene,p=f.pipeline,wait=n=>waitFrames(s,n,f.errors)
  const {runSyntheticReflectionChecks}=await import('/tests/rendering/ssr-numeric-fixture.js')
  const numeric=runSyntheticReflectionChecks(C,f.viewer)
  p.setOptions({environment:false,clouds:false,shadows:false,antialiasing:'off'});p.setScreenSpaceAO({enabled:false});await wait(35)
  for(const model of f.models)for(const node of model._sceneGraph.components.nodes)for(const primitive of node.primitives||[]){primitive.material.metallicRoughness.roughnessFactor=.12;primitive.material.metallicRoughness.metallicFactor=.8}
  p.setLighting({mode:'deferred'});p.setScreenSpaceReflections({enabled:true,distance:300,thickness:1,strength:0});await wait(18)
  const initial={lighting:p.getLightingDiagnostics(),ssr:p.getScreenSpaceReflectionDiagnostics()}
  if(!initial.lighting.valid||!initial.ssr.valid)return {initial,errors:f.errors}
  const ctx=s.context,gl=ctx._gl,w=s.drawingBufferWidth,h=s.drawingBufferHeight
  const t=new C.Texture({context:ctx,width:w,height:h,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT}),fb=new C.Framebuffer({context:ctx,colorTextures:[t],destroyAttachments:false})
  const options={viewport:new C.BoundingRectangle(0,0,w,h),depthTest:{enabled:false},depthMask:false};let input
  const probe=ctx.createViewportQuadCommand('uniform sampler2D src;in vec2 v_textureCoordinates;void main(){out_FragColor=texture(src,v_textureCoordinates);}',{framebuffer:fb,renderState:C.RenderState.fromCache(options),uniformMap:{src:()=>input}})
  const read=src=>{const rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer,v=C.BoundingRectangle.clone(ctx.uniformState.viewport);try{input=src;probe.execute(ctx);return ctx.readPixels({framebuffer:fb,width:w,height:h})}finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,rd);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dr);ctx._currentFramebuffer=cached;ctx.uniformState.viewport=v}}
  const color=()=>read(s._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0)),zero=color()
  p.setScreenSpaceReflections({enabled:false});await wait(10);const off=color()
  p.setScreenSpaceReflections({enabled:true,strength:1});await wait(14);const on=color(),source=p.getActiveMaterialChannels(),textures=source.getTextures()
  const spec=read(textures.reflectionSpecular),trace=read(p.screenSpaceReflections.getReflectionTexture())
  let zeroDifference=0,changed=0,validSpecular=0,hits=0,maxDelta=0
  for(let i=0;i<on.length;i+=4){if(spec[i+3]>.5)validSpecular++;if(trace[i+3]>0)hits++;for(let c=0;c<3;c++){zeroDifference=Math.max(zeroDifference,Math.abs(zero[i+c]-off[i+c]));const delta=Math.abs(on[i+c]-zero[i+c]);if(delta>.001)changed++;maxDelta=Math.max(maxDelta,delta)}}
  const result={numeric,initial,lighting:p.getLightingDiagnostics(),ssr:p.getScreenSpaceReflectionDiagnostics(),zeroDifference,changed,validSpecular,hits,maxDelta,source:source.getReflectionDiagnostics(),legacyEnabled:!!p.materialChannels?.enabled,errors:f.errors}
  // Independently compare the captured environment term against native PBR replay.
  p.setScreenSpaceReflections({strength:0});p.setLighting({mode:'enhanced'});await wait(16)
  const nativeSpec=read(p.materialChannels.getTextures().reflectionSpecular)
  p.setLighting({mode:'deferred'});await wait(16);const deferredSpec=read(p.getActiveMaterialChannels().getTextures().reflectionSpecular)
  let compared=0,failures=0
  for(let i=0;i<nativeSpec.length;i+=4)if(nativeSpec[i+3]>.5&&deferredSpec[i+3]>.5){compared++;for(let c=0;c<3;c++)if(Math.abs(nativeSpec[i+c]-deferredSpec[i+c])>Math.max(.01,Math.abs(nativeSpec[i+c])*.02))failures++}
  result.specularParity={compared,failures}
  const {planeGlb}=await import('/tests/rendering/deferred-transparency-fixture.js')
  const glassMatrix=C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(f.origin),C.Matrix4.fromTranslation(new C.Cartesian3(0,0,2)),new C.Matrix4())
  C.Matrix4.multiplyByScale(glassMatrix,new C.Cartesian3(90,90,1),glassMatrix)
  const glass=await C.Model.fromGltfAsync({url:planeGlb(C,{baseColor:[.4,.5,.6,.35],metallic:.3,roughness:.12,blend:true}),modelMatrix:glassMatrix,upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
  s.primitives.add(glass);p.setScreenSpaceReflections({strength:1,transparent:true});await wait(40)
  const transparent=p.getTransparentReflectionDiagnostics(),deltaTexture=p.transparentReflections.getDeltaTexture()
  let deltaPixels=0;if(deltaTexture){const delta=read(deltaTexture);for(let i=0;i<delta.length;i+=4)if(Math.max(Math.abs(delta[i]),Math.abs(delta[i+1]),Math.abs(delta[i+2]))>1e-4)deltaPixels++}
  const glassOn=read(p.transparentReflections.target.output),presentedOn=ctx.readPixels({width:w,height:h})
  p.setScreenSpaceReflections({transparent:false});await wait(8);const glassOff=color(),presentedOff=ctx.readPixels({width:w,height:h})
  result.glass={transparent,deltaPixels,changed:glassOn.reduce((n,v,i)=>n+(i%4<3&&Math.abs(v-glassOff[i])>.001?1:0),0),
    presentedChanged:presentedOn.reduce((n,v,i)=>n+(i%4<3&&Math.abs(v-presentedOff[i])>1?1:0),0),forward:p.getLightingDiagnostics().transparentForward,lighting:p.getLightingDiagnostics().valid}
  const oldTextures=p.deferredLighting.reflections.target.textures.slice()
  f.viewer.resolutionScale=.75;await wait(12)
  result.resize={released:oldTextures.every(t=>t.isDestroyed()),valid:p.getLightingDiagnostics().valid,width:p.deferredLighting.reflections.color.width,expected:s.drawingBufferWidth}
  const currentTextures=p.deferredLighting.reflections.target.textures.slice()
  p.setLighting({mode:'enhanced'});await wait(8)
  result.release={textures:currentTextures.every(t=>t.isDestroyed()),bytes:p.getLightingDiagnostics().resources.reflectionBytes,legacy:p.getScreenSpaceReflectionDiagnostics().lightingSource}
  probe.shaderProgram.destroy();C.RenderState.removeFromCache(options);fb.destroy();t.destroy();return result
 })
 fs.mkdirSync('docs/verification/stage1-B03-fixed',{recursive:true});fs.writeFileSync('docs/verification/stage1-B03-fixed/'+(umd?'ssr-umd':'ssr')+'.json',JSON.stringify({...r,pageErrors:errors},null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(r.errors,[]);assert.equal(r.initial.lighting.valid,true,'deferred must stay active with SSR');assert.equal(r.initial.ssr.valid,true,'SSR active')
  assert.ok(r.zeroDifference<.001,'strength zero preserves HDR');assert.ok(r.validSpecular>100);assert.ok(r.hits>10,'real reflection hits');assert.ok(r.changed>10,'real replacement pixels');assert.equal(r.legacyEnabled,false)
 assert.ok(r.specularParity.compared>100);assert.equal(r.specularParity.failures,0,'environment baseline must match native');assert.equal(r.glass.transparent.valid,true,'glass SSR active');assert.ok(r.glass.deltaPixels>10,'glass real SSR contribution');assert.ok(r.glass.changed>10);assert.ok(r.glass.presentedChanged>10,'SSR reaches presented frame');assert.equal(r.glass.lighting,true)
 assert.equal(r.resize.released,true);assert.equal(r.resize.valid,true);assert.equal(r.resize.width,r.resize.expected);assert.equal(r.release.textures,true);assert.equal(r.release.bytes,0);assert.equal(r.release.legacy,'native-replay')
 console.log(JSON.stringify({zeroDifference:r.zeroDifference,changed:r.changed,hits:r.hits,source:r.source}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
