const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const umd=process.argv.includes('--umd')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html'+(umd?'?mode=umd':''));await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startOcclusionFixture}=await import('/tests/rendering/occlusion-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js'),{cubeUrl}=await import('/tests/rendering/stage1-scene.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js')
  await startOcclusionFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors),result={}
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin)
  const extra=await Promise.all(Array.from({length:140},(_,i)=>{
   const matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3((i%14-6.5)*5,10+Math.floor(i/14)*4,5)),new C.Matrix4());C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(2,2,5),matrix)
   return C.Model.fromGltfAsync({url:cubeUrl(C),modelMatrix:matrix})
  }))
  for(const model of extra){model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0);s.primitives.add(model)}await wait(25)
  const reference=framePixels(C,s);p.setOcclusionCulling({enabled:true})
  const batches=[];let previous=0;const off=s.postRender.addEventListener(()=>{const n=p.getOcclusionDiagnostics().queries;batches.push(n-previous);previous=n})
  await wait(60);off();const output=framePixels(C,s)
  result.budget={...p.getOcclusionDiagnostics(),batches,delta:reference.reduce((n,v,i)=>Math.max(n,Math.abs(v-output[i])),0)}
  const wallBound=p.occlusionCulling.groups.find(g=>g.owner===f.wall).sphere
  const eye=C.Matrix4.multiplyByPoint(s.camera.viewMatrix,wallBound.center,new C.Cartesian3())
  const near=s.camera.frustum.near;s.camera.frustum.near=-eye.z-wallBound.radius+.1;await wait(16)
  result.near={projected:p.occlusionCulling.groups.find(g=>g.owner===f.wall)?.projected??null,hidden:!!p.occlusionCulling.states.get(f.wall)?.hidden}
  s.camera.frustum.near=near
  const pose={position:C.Cartesian3.clone(s.camera.positionWC),direction:C.Cartesian3.clone(s.camera.directionWC),up:C.Cartesian3.clone(s.camera.upWC)}
  s.camera.setView({destination:f.wall.boundingSphere.center,orientation:{direction:pose.direction,up:pose.up}});await wait(16)
  result.inside={projected:p.occlusionCulling.groups.find(g=>g.owner===f.wall)?.projected??null,hidden:!!p.occlusionCulling.states.get(f.wall)?.hidden}
  s.camera.setView({destination:pose.position,orientation:{direction:pose.direction,up:pose.up}});await wait(25)
  f.wall.show=false;await wait(20);const before=p.getOcclusionDiagnostics().queries;await wait(20)
  result.open={...p.getOcclusionDiagnostics(),newQueries:p.getOcclusionDiagnostics().queries-before}
  f.wall.show=true;await wait(30)
  const group=p.occlusionCulling.groups.find(g=>g.owner===f.wall),buffer=group.commands[0].vertexArray._attributes.find(a=>a.vertexBuffer)?.vertexBuffer
  // A real GPU buffer upload invalidates the trusted bounds, even for unchanged bytes.
  const bytes=new Uint8Array(buffer.sizeInBytes);buffer.getBufferData(bytes);buffer.copyFromArrayView(bytes);await wait(1)
  result.bufferMutation=p.getOcclusionDiagnostics()
  p.setOcclusionCulling({enabled:false});p.setOcclusionCulling({enabled:true});await wait(25)
  p.setScreenSpaceAO({enabled:true});p.setHdrBloom({enabled:true});await wait(15)
  const pool=p.hdrBloom.pooled.pool,leases=pool.entries.map(e=>e.lease).filter(Boolean),textures=pool.entries.map(e=>e.texture)
  const loss=s.context._gl.getExtension('WEBGL_lose_context');loss.loseContext();await new Promise(resolve=>setTimeout(resolve,150))
  result.contextLoss={hidden:p.getOcclusionDiagnostics().hidden,enabled:p.getOcclusionDiagnostics().enabled,live:pool.getDiagnostics().live,
   handlesExpired:leases.every(l=>!l.valid),texturesReleased:textures.every(t=>t.isDestroyed())}
  p.destroy();result.errors=f.errors;return result
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B06',{recursive:true});fs.writeFileSync('docs/verification/stage1-B06/'+(umd?'boundaries-umd':'boundaries')+'.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.ok(report.budget.hidden>128);assert.equal(report.budget.delta,0)
 assert.ok(Math.max(...report.budget.batches)<=128);assert.ok(report.budget.batches.filter(n=>n>0).length>=3)
 for(const name of ['near','inside']){assert.equal(report[name].projected,null);assert.equal(report[name].hidden,false)}
 assert.equal(report.open.hidden,0);assert.equal(report.open.newQueries,0);assert.equal(report.open.needsDepth,false)
 assert.equal(report.bufferMutation.hidden,0);assert.equal(report.bufferMutation.needsDepth,false)
 assert.equal(report.contextLoss.enabled,false);assert.equal(report.contextLoss.hidden,0);assert.equal(report.contextLoss.live,0)
 assert.equal(report.contextLoss.handlesExpired,true);assert.equal(report.contextLoss.texturesReleased,true)
 console.log(JSON.stringify({hidden:report.budget.hidden,maxBatch:Math.max(...report.budget.batches),open:report.open.reason,contextLoss:report.contextLoss}))
}finally{await b.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1})
