const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const umd=process.argv.includes('--umd')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html'+(umd?'?mode=umd':''));await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startStage1Scene}=await import('/tests/rendering/stage1-scene.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js')
  await startStage1Scene(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors)
  s.globe.show=false;p.setOptions({environment:true,clouds:false,environmentAnimation:false,shadows:true,shadowMode:'custom',antialiasing:'off'})
  p.setLighting({mode:'deferred'});p.setScreenSpaceReflections({enabled:true,transparent:true});await wait(60)
  const camera=p.screenSpaceAO.cameraUniforms,sun=p.deferredLighting.sunUniforms
  const cameraShared=camera.buffer===p.screenSpaceReflections.cameraUniforms.buffer&&camera.buffer===p.transparentReflections.cameraUniforms.buffer
  const sunShared=sun.buffer===p.transparentForward.sunUniforms.buffer&&sun.buffer===p.customShadow.sunUniforms.buffer
  // Cesium's repeated view orthonormalization leaves sub-nanometre cancellation
  // noise in this local transform. Freeze the test input itself, not UBO uploads.
  const environment=p.environmentRenderer,eyeToLocal=C.Matrix4.clone(environment.frameInputs.eyeToLocal())
  environment.frameInputs.eyeToLocal=()=>eyeToLocal;await wait(2)
  const before=p.getFrameUniformDiagnostics(),envBefore=Array.from(p.environmentRenderer.frameData);await wait(10);const stable=p.getFrameUniformDiagnostics(),envAfter=Array.from(p.environmentRenderer.frameData)
  const gl=s.context._gl,read=buffer=>{const old=gl.getParameter(gl.UNIFORM_BUFFER_BINDING),data=new Float32Array(buffer.byteLength/4);try{gl.bindBuffer(gl.UNIFORM_BUFFER,buffer.buffer);gl.getBufferSubData(gl.UNIFORM_BUFFER,0,data);return Array.from(data)}finally{gl.bindBuffer(gl.UNIFORM_BUFFER,old)}}
  const frame=s.frameState.frameNumber,initial=read(camera.buffer),offset=s.camera.frustum.xOffset
  s.camera.frustum.xOffset=.00003;const cameraBytes=camera.update(),changed=read(camera.buffer);s.camera.frustum.xOffset=offset;camera.update()
  const originalColor=s.context.uniformState.lightColorHdr.x;s.context.uniformState.lightColorHdr.x+=.5
  const sunBytes=sun.update(),sunData=read(sun.buffer);s.context.uniformState.lightColorHdr.x=originalColor;sun.update()
  const sameFrame=s.frameState.frameNumber===frame,cameraEqual=changed.slice(0,16).every((v,i)=>v===new Float32Array(C.Matrix4.toArray((()=>{const f=s.camera.frustum.clone();f.xOffset=.00003;return f.projectionMatrix})()))[i])
  const buffers=[camera.buffer,sun.buffer,p.environmentRenderer.frameUniforms]
  p.destroy()
  return {cameraShared,sunShared,before,stable,envDiff:envAfter.map((v,i)=>({i,before:envBefore[i],after:v})).filter(x=>x.before!==x.after),cameraBytes,sunBytes,sameFrame,cameraChanged:initial.some((v,i)=>v!==changed[i]),cameraEqual,sunData,originalColor,released:buffers.every(x=>x.isDestroyed()),errors:f.errors}
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B05',{recursive:true});fs.writeFileSync('docs/verification/stage1-B05/'+(umd?'uniforms-umd':'uniforms')+'.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.cameraShared,true);assert.equal(report.sunShared,true)
 assert.equal(report.before.bufferSubDataCalls,report.stable.bufferSubDataCalls,'identical frame data must not upload')
 assert.equal(report.sameFrame,true);assert.equal(report.cameraChanged,true);assert.equal(report.cameraEqual,true);assert.ok(report.cameraBytes>0);assert.ok(report.sunBytes>0);assert.equal(report.sunData[4],Math.fround(report.originalColor+.5));assert.equal(report.released,true)
 console.log(JSON.stringify({shared:[report.cameraShared,report.sunShared],before:report.before,stable:report.stable,cameraBytes:report.cameraBytes,sunBytes:report.sunBytes}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
