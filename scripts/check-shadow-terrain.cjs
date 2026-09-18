const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={};try{
 const page=await b.newPage({viewport:{width:800,height:500}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/stage1-fixture.html');await page.waitForFunction(()=>window.fixture)
 Object.assign(report,await page.evaluate(async()=>{
  const C=Cesium,f=fixture,{startCascadeFixture}=await import('/tests/rendering/shadow-cascades-fixture.js'),{waitFrames}=await import('/tests/rendering/deferred-lighting-fixture.js'),{cubeUrl}=await import('/tests/rendering/stage1-scene.js'),{readHdr}=await import('/tests/rendering/deferred-transparency-fixture.js')
  await startCascadeFixture(f);const p=f.pipeline,s=f.viewer.scene,wait=n=>waitFrames(s,n,f.errors)
  f.models.forEach(m=>s.primitives.remove(m));s.screenSpaceCameraController.enableCollisionDetection=false
  const lon=C.Math.toRadians(100),lat=C.Math.toRadians(35),scheme=new C.GeographicTilingScheme(),height=(x,y)=>2000+200*Math.sin((x-lon)*1000)*Math.cos((y-lat)*1000)
  let tiles=0
  s.terrainProvider=new C.CustomHeightmapTerrainProvider({width:32,height:32,tilingScheme:scheme,callback(x,y,level){
   tiles++;const r=scheme.tileXYToRectangle(x,y,level),data=new Float32Array(1024)
   for(let j=0;j<32;j++)for(let i=0;i<32;i++)data[j*32+i]=height(C.Math.lerp(r.west,r.east,i/31),C.Math.lerp(r.north,r.south,j/31))
   return data
  }})
  const origin=C.Cartesian3.fromRadians(lon,lat,2000),frame=C.Transforms.eastNorthUpToFixedFrame(origin)
  const matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(0,0,100)),new C.Matrix4());C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(40,40,200),matrix)
  const tower=await C.Model.fromGltfAsync({url:cubeUrl(C),modelMatrix:matrix});s.primitives.add(tower)
  const toLight=C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame,new C.Cartesian3(-.7,-.5,1),new C.Cartesian3()),new C.Cartesian3())
  const light=new C.DirectionalLight({direction:C.Cartesian3.negate(toLight,new C.Cartesian3()),intensity:2});s.light=light
  s.camera.lookAt(origin,new C.HeadingPitchRange(0,-.6,1200));s.camera.lookAtTransform(C.Matrix4.IDENTITY)
  await wait(100);for(let i=0;i<20&&!s.globe.tilesLoaded;i++)await wait(10)
  const point=C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(70,50,0),new C.Cartesian3()),carto=C.Cartographic.fromCartesian(point)
  const actualHeight=s.globe.getHeight(carto);carto.height=actualHeight
  const ground=C.Cartesian3.fromRadians(carto.longitude,carto.latitude,carto.height),q=C.SceneTransforms.worldToWindowCoordinates(s,ground),read=()=>readHdr(C,s,Math.round(q.x),Math.round(q.y))
  const shadow=read(),stats=structuredClone(p.customShadow.stats),receiver=p.customShadow.adapter.commands.size
  p.setOptions({shadows:false});s.light=light;await wait(10);const lit=read()
  p.setOptions({shadows:true});s.light=light;await wait(20);const restored=read()
  return {tiles,loaded:s.globe.tilesLoaded,actualHeight,terrainSpan:s.globe._surface._tilesToRender.map(t=>[t.data.tileBoundingRegion.minimumHeight,t.data.tileBoundingRegion.maximumHeight]),shadow,lit,restored,stats,receiver,errors:f.errors}
 }))
 report.pageErrors=errors;fs.mkdirSync('docs/verification/stage1-B04',{recursive:true});fs.writeFileSync('docs/verification/stage1-B04/terrain.json',JSON.stringify(report,null,2));await page.screenshot({path:'docs/verification/stage1-B04/terrain.png'})
 assert.deepEqual(errors,[]);assert.deepEqual(report.errors,[]);assert.ok(report.loaded&&report.tiles>0);assert.ok(report.actualHeight>1800)
 assert.equal(report.stats.cascades.length,3);assert.equal(report.stats.error,null);assert.ok(report.receiver>1)
 assert.ok(report.lit.some((v,i)=>v-report.shadow[i]>.02),'elevated Globe must receive a real shadow')
 assert.ok(report.shadow.every((v,i)=>Math.abs(v-report.restored[i])<.01))
 console.log(JSON.stringify({tiles:report.tiles,height:report.actualHeight,shadow:report.shadow,lit:report.lit}))
}finally{await b.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1})
