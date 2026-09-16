const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/deferred-lighting-fixture.html')
  await page.waitForFunction(()=>window.fixture)
  const result=await page.evaluate(async()=>{
   const C=Cesium,m=await import('/tests/rendering/deferred-lighting-fixture.js'),f=fixture
   const mat={id:'tile',baseColor:[.4,.5,.6,1],metallic:.1,roughness:.5,features:true}
   await m.startDeferredFixture(f,{cases:[mat],columns:1,height:120})
   const scene=f.viewer.scene,p=f.pipeline,wait=n=>m.waitFrames(scene,n,f.errors)
   const matrix=C.Matrix4.clone(f.models[0].model.modelMatrix)
   scene.primitives.remove(f.models[0].model)
   const json={asset:{version:'1.1',gltfUpAxis:'Z'},geometricError:500,root:{boundingVolume:{box:[0,0,0,2,0,0,0,2,0,0,0,2]},
     transform:Array.from(matrix),geometricError:0,refine:'ADD',content:{uri:m.planeGlb(C,mat)}}}
   const tiles=await C.Cesium3DTileset.fromUrl('data:application/json,'+encodeURIComponent(JSON.stringify(json)))
   scene.primitives.add(tiles)
   const failures=[];tiles.tileFailed.addEventListener(e=>failures.push(e.message))
   await wait(60)
   const point={x:400,y:250},read=()=>m.readPixel(f.viewer,point.x,point.y)
   const original=read()
   p.setLighting({mode:'deferred'});await wait(12)
   const deferred=read(),neutral=p.getLightingDiagnostics()
   const content=tiles.root.content
   if(!content)return {loaded:tiles.tilesLoaded,failures,rootState:tiles.root._contentState,selected:tiles._selectedTiles.length,rootChildren:tiles.root.children.length,sphere:tiles.root.boundingSphere,projected:C.SceneTransforms.worldToWindowCoordinates(scene,tiles.root.boundingSphere.center),visible:tiles.root._visible,contentVisible:tiles.root._contentVisibility,geometricError:tiles.root.geometricError,neutral,errors:f.errors}
   const feature=content.getFeature(0)
   feature.color=C.Color.RED;await wait(8)
   const styledDeferred=read(),styled=p.getLightingDiagnostics()
   p.setLighting({mode:'enhanced'});await wait(8)
   const styledNative=read()
   feature.color=C.Color.WHITE
   p.setLighting({mode:'deferred'});await wait(8)
   const restored=p.getLightingDiagnostics()
   return {loaded:tiles.tilesLoaded,failures,original,deferred,neutral,styledDeferred,styledNative,styled,restored,errors:f.errors}
  })
  fs.writeFileSync(path.join(__dirname,'../docs/verification/B02-tiles.json'),JSON.stringify({...result,pageErrors:errors},null,2))
  assert.equal(result.loaded,true);assert.deepEqual(result.failures,[]);assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[])
  assert.equal(result.neutral.valid,true,'neutral feature must use deferred')
  assert.ok(result.neutral.stats.materialDraws>0)
  assert.ok(result.original.every((v,i)=>Math.abs(v-result.deferred[i])<=1),'neutral pixel parity')
  assert.deepEqual(result.styledDeferred,result.styledNative,'colored feature preserves native color')
  assert.equal(result.styled.stats.materialDraws,0,'colored feature must use compatibility')
  assert.equal(result.restored.valid,true,'neutral style restores deferred')
  console.log(JSON.stringify({neutral:result.neutral.valid,styled:result.styled.activeMode,restored:result.restored.valid,errors}))
 }finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
