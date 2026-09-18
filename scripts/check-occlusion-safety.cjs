const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startOcclusionFixture}=await import('/tests/rendering/occlusion-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js'),{framePixels}=await import('/tests/rendering/shadow-cascades-fixture.js'),{cubeUrl}=await import('/tests/rendering/stage1-scene.js')
  await startOcclusionFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors),result={}
  const enable=async()=>{p.setOcclusionCulling({enabled:true});await wait(25)}
  const parity=async()=>{const a=framePixels(C,s);p.setOcclusionCulling({enabled:false});await wait(5);const b=framePixels(C,s);let delta=0;for(let i=0;i<a.length;i++)delta=Math.max(delta,Math.abs(a[i]-b[i]));return delta}
  await enable();const target=f.models.find(m=>m.id==='object-0-0'),q=C.SceneTransforms.worldToWindowCoordinates(s,target.boundingSphere.center)
  result.picking=s.drillPick(new C.Cartesian2(q.x,q.y),60).some(x=>x.id===target.id)
  const camera={position:C.Cartesian3.clone(s.camera.positionWC),direction:C.Cartesian3.clone(s.camera.directionWC),up:C.Cartesian3.clone(s.camera.upWC)}
  s.debugCommandFilter=command=>command.owner!==f.wall;await wait(1)
  result.filtered={hidden:p.getOcclusionDiagnostics().hidden,parity:await parity()};s.debugCommandFilter=undefined;await enable()
  s.camera.moveRight(60);await wait(1);result.cameraRestore=p.getOcclusionDiagnostics().hidden;result.cameraParity=await parity()
  s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}});await enable()
  const matrix=C.Matrix4.clone(f.wall.modelMatrix);C.Matrix4.multiplyByTranslation(matrix,new C.Cartesian3(3,0,0),f.wall.modelMatrix);await wait(1);result.transformRestore=p.getOcclusionDiagnostics().hidden;result.transformParity=await parity()
  f.wall.modelMatrix=matrix;await enable();f.wall.color=new C.Color(1,1,1,.4);await wait(1);result.styleRestore=p.getOcclusionDiagnostics().hidden;result.styleParity=await parity()
  f.wall.color=undefined;await enable();f.wall.clippingPlanes=new C.ClippingPlaneCollection({planes:[new C.ClippingPlane(C.Cartesian3.UNIT_X,0)]});await wait(2)
  result.clipping={...p.getOcclusionDiagnostics(),parity:await parity()};f.wall.clippingPlanes=undefined
  // Door and sub-metre slit: broad bounds may overlap the gap, actual depth must not.
  f.wall.show=false;const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin);result.gaps=[]
  for(const gap of [4,.4]){
    const panels=[]
    for(const sign of [-1,1]){const m=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(sign*(24+gap/4),-20,25)),new C.Matrix4());C.Matrix4.multiplyByScale(m,new C.Cartesian3(48-gap/2,4,55),m)
      const model=await C.Model.fromGltfAsync({url:cubeUrl(C),modelMatrix:m});model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0);s.primitives.add(model);panels.push(model)}
    await enable();const state=p.getOcclusionDiagnostics(),visibleColumn=f.models.filter(m=>m.id?.startsWith('object-0-')).every(m=>!p.occlusionCulling.states.get(m)?.hidden)
    result.gaps.push({gap,state,visibleColumn,parity:await parity()});panels.forEach(m=>s.primitives.remove(m));await wait(3)
  }
  f.wall.show=true;await enable()
  p.setOptions({shadows:true,shadowMode:'custom'});await wait(30);const withCulling=p.customShadow.stats.casters,hiddenWithShadows=p.getOcclusionDiagnostics().hidden
  p.setOcclusionCulling({enabled:false});await wait(10);result.shadow={withCulling,without:p.customShadow.stats.casters,hiddenWithShadows}
  p.setOptions({shadows:false});await wait(3)
  // Pending GPU results must not sustain an unbounded requestRender loop.
  s.requestRenderMode=true;s.maximumRenderTimeChange=Infinity
  const gl=s.context._gl,original=gl.getQueryParameter.bind(gl);gl.getQueryParameter=(q,pname)=>pname===gl.QUERY_RESULT_AVAILABLE?false:original(q,pname)
  let frames=0;const off=s.postRender.addEventListener(()=>frames++)
  p.setOcclusionCulling({enabled:true});s.requestRender();await new Promise(resolve=>setTimeout(resolve,1000))
  const first=frames;await new Promise(resolve=>setTimeout(resolve,400));result.requestRender={frames:first,extra:frames-first,state:p.getOcclusionDiagnostics()}
  off();gl.getQueryParameter=original;p.destroy();result.errors=f.errors;return result
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B06',{recursive:true});fs.writeFileSync('docs/verification/stage1-B06/safety.json',JSON.stringify(report,null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.equal(report.picking,true)
 assert.equal(report.filtered.hidden,0);assert.equal(report.filtered.parity,0)
 for(const key of ['cameraRestore','transformRestore','styleRestore'])assert.equal(report[key],0,key)
 for(const key of ['cameraParity','transformParity','styleParity'])assert.equal(report[key],0,key)
 assert.equal(report.clipping.hidden,0);assert.equal(report.clipping.parity,0)
 for(const gap of report.gaps){assert.equal(gap.visibleColumn,true);assert.equal(gap.parity,0)}
 assert.equal(report.shadow.withCulling,report.shadow.without);assert.ok(report.shadow.withCulling>0);assert.ok(report.shadow.hiddenWithShadows>10)
 assert.ok(report.requestRender.frames<=12);assert.equal(report.requestRender.extra,0);assert.equal(report.requestRender.state.hidden,0);assert.equal(report.requestRender.state.pending,0)
 console.log(JSON.stringify({picking:report.picking,gaps:report.gaps.map(g=>({gap:g.gap,hidden:g.state.hidden,parity:g.parity})),shadow:report.shadow,requestRender:report.requestRender}))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
