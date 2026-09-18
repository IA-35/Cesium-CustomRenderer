const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startOcclusionFixture}=await import('/tests/rendering/occlusion-fixture.js'),{waitFrames,planeGlb}=await import('/tests/rendering/deferred-lighting-fixture.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js'),{cubeUrl}=await import('/tests/rendering/stage1-scene.js')
  await startOcclusionFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors),result={}
  p.setLighting({mode:'deferred'});await wait(16);const original=framePixels(C,s),before=p.getLightingDiagnostics().stats.materialDraws
  p.setOcclusionCulling({enabled:true});await wait(30);const pixels=framePixels(C,s)
  result.deferred={before,after:p.getLightingDiagnostics().stats.materialDraws,hidden:p.getOcclusionDiagnostics().hidden,delta:original.reduce((n,v,i)=>Math.max(n,Math.abs(v-pixels[i])),0)}
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(0,20,5)),new C.Matrix4());C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(5,5,10),matrix)
  const tileset={asset:{version:'1.1',gltfUpAxis:'Z'},geometricError:500,root:{boundingVolume:{box:[0,0,0,1,0,0,0,1,0,0,0,1]},transform:Array.from(matrix),geometricError:0,refine:'ADD',content:{uri:cubeUrl(C)}}}
  const oldRevision=p.getOcclusionDiagnostics().revision,tiles=await C.Cesium3DTileset.fromUrl('data:application/json,'+encodeURIComponent(JSON.stringify(tileset)));let loaded=0
  tiles.tileLoad.addEventListener(()=>loaded++);s.primitives.add(tiles);await wait(40)
  result.tile={loaded,revision:p.getOcclusionDiagnostics().revision,oldRevision,hidden:!!p.occlusionCulling.states.get(tiles.root.content._model)?.hidden}
  const beforeUnload=p.getOcclusionDiagnostics().revision;s.primitives.remove(tiles);await wait(1);result.unload={changed:p.getOcclusionDiagnostics().revision>beforeUnload,hidden:p.getOcclusionDiagnostics().hidden}
  await wait(25)
  const animated=await C.Model.fromGltfAsync({url:planeGlb(C,{id:'animated',baseColor:[1,1,1,1],metallic:0,roughness:.8,skinned:true}),modelMatrix:matrix,upAxis:C.Axis.Z,forwardAxis:C.Axis.X});s.primitives.add(animated);await wait(20)
  result.animation=p.getOcclusionDiagnostics();animated.getNode('joint').matrix=C.Matrix4.fromTranslation(new C.Cartesian3(1,0,0));await wait(1);result.animationMoved=p.getOcclusionDiagnostics();s.primitives.remove(animated)
  await wait(25);const culling=p.occlusionCulling
  p.setOcclusionCulling({enabled:false});p.setOcclusionCulling({enabled:true});await wait(2)
  // Force a draw failure after allocation; recovery must leave the scene visible.
  if(!culling.fill)culling.createCommands()
  culling.fill.execute=()=>{throw new Error('injected query fill failure')};s.requestRender();await wait(4)
  result.failure=p.getOcclusionDiagnostics();p.setOcclusionCulling({enabled:false});p.setOcclusionCulling({enabled:true});await wait(25);result.retry=p.getOcclusionDiagnostics()
  p.destroy();result.errors=f.errors;return result
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B06',{recursive:true});fs.writeFileSync('docs/verification/stage1-B06/content.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.deferred.delta,0);assert.ok(report.deferred.after<report.deferred.before*.8);assert.ok(report.deferred.hidden>10)
 assert.ok(report.tile.loaded>0);assert.ok(report.tile.revision>report.tile.oldRevision);assert.equal(report.tile.hidden,true);assert.equal(report.unload.changed,true);assert.equal(report.unload.hidden,0)
 assert.equal(report.animation.hidden,0);assert.equal(report.animationMoved.hidden,0);assert.equal(report.failure.failed,true);assert.equal(report.failure.hidden,0);assert.ok(report.retry.hidden>10)
 console.log(JSON.stringify({deferred:report.deferred,tile:report.tile,unload:report.unload,animation:report.animation.reason,failure:report.failure.reason,retry:report.retry.hidden}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
