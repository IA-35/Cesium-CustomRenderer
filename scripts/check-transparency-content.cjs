const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report=[];try{
 for(const oit of [true,false]){
  const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/deferred-transparency-fixture.html?oit='+(oit?1:0));await page.waitForFunction(()=>window.fixture)
  const r=await page.evaluate(async()=>{
   const C=Cesium,f=fixture,m=await import('/tests/rendering/deferred-transparency-fixture.js'),tilesFixture=await import('/tests/rendering/deferred-lighting-fixture.js');await m.startTransparencyFixture(f)
   const p=f.pipeline,s=f.viewer.scene,wait=n=>m.waitFrames(s,n,f.errors),center=m.stackScreenPoint(f),front=f.layers.find(x=>x.id==='front').model,back=f.layers.find(x=>x.id==='back').model
   const read=point=>m.readHdr(C,s,point.x,point.y),delta=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])))
   p.setLighting({mode:'deferred'});back.show=false;await wait(10)
   const matrix=C.Matrix4.clone(front.modelMatrix),pos=C.Matrix4.getTranslation(matrix,new C.Cartesian3()),up=C.Cartesian3.normalize(f.origin,new C.Cartesian3())
   C.Cartesian3.add(pos,C.Cartesian3.multiplyByScalar(up,15,new C.Cartesian3()),pos);C.Matrix4.setTranslation(matrix,pos,matrix)
   const mask=await C.Model.fromGltfAsync({url:m.planeGlb(C,{baseColor:[.1,.7,.2,1],metallic:0,roughness:.6,mask:true}),modelMatrix:matrix,upAxis:C.Axis.Z,forwardAxis:C.Axis.X});mask.show=false;s.primitives.add(mask)
   const q=C.SceneTransforms.worldToWindowCoordinates(s,C.Matrix4.multiplyByPoint(matrix,new C.Cartesian3(-.85,0,0),new C.Cartesian3())),hole={x:Math.round(q.x),y:Math.round(q.y)}
   const throughGlass=read(hole);mask.show=true;await wait(16);const holeWithMask=read(hole),solidWithGlass=read(center);front.show=false;await wait(8);const solidAlone=read(center)
   const r={oit:s._environmentState.useOIT,mask:{holeDelta:delta(throughGlass,holeWithMask),solidDelta:delta(solidAlone,solidWithGlass)}}
   s.primitives.remove(mask);f.backdrop.show=false
   // A real asynchronously loaded tile, arriving after the forward pass is already running.
   const json={asset:{version:'1.1',gltfUpAxis:'Z'},geometricError:500,root:{boundingVolume:{box:[0,0,0,2,0,0,0,2,0,0,0,2]},transform:Array.from(front.modelMatrix),geometricError:0,refine:'ADD',content:{uri:tilesFixture.planeGlb(C,{id:'late-tile',baseColor:[.4,.5,.6,.5],metallic:0,roughness:.4,features:true,blend:true})}}}
   const tiles=await C.Cesium3DTileset.fromUrl('data:application/json,'+encodeURIComponent(JSON.stringify(json)))
   let loaded=0;tiles.tileLoad.addEventListener(()=>loaded++);s.primitives.add(tiles);await wait(50)
   const neutral=read(center),identity=s.pick(new C.Cartesian2(center.x,center.y)),feature=tiles.root.content.getFeature(0)
   r.tile={loaded,patched:p.getLightingDiagnostics().transparentForward.stats.patchedCommands,picked:identity?.primitive===tiles||identity===feature}
   tiles.style=new C.Cesium3DTileStyle({color:'color("red",0.4)'});await wait(12);const styled=read(center)
   p.setLighting({mode:'enhanced'});await wait(10);r.tile.styleNativeDelta=delta(styled,read(center))
   tiles.style=undefined;p.setLighting({mode:'deferred'});await wait(14);r.tile.restoreDelta=delta(neutral,read(center));r.tile.styleChanged=delta(neutral,styled)>.005
   tiles.show=false;front.show=false
   json.root.content.uri=tilesFixture.planeGlb(C,{id:'switch-tile',baseColor:[.4,.5,.6,1],metallic:0,roughness:.4,features:true})
   const switching=await C.Cesium3DTileset.fromUrl('data:application/json,'+encodeURIComponent(JSON.stringify(json)));s.primitives.add(switching);await wait(45)
   const originalOpaque=read(center)
   switching.style=new C.Cesium3DTileStyle({color:'color("white",0.4)'});await wait(12);const asTransparent=read(center)
   r.tile.passSwitchPatched=p.getLightingDiagnostics().transparentForward.stats.patchedCommands
   switching.style=undefined;await wait(14);r.tile.passSwitchRestored=delta(originalOpaque,read(center));r.tile.passSwitchChanged=delta(originalOpaque,asTransparent)>.01
   s.primitives.remove(switching)
   const camera={position:C.Cartesian3.clone(s.camera.positionWC),direction:C.Cartesian3.clone(s.camera.directionWC),up:C.Cartesian3.clone(s.camera.upWC)}
   const {cubeUrl}=await import('/tests/rendering/stage1-scene.js')
   const cubeMatrix=C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(f.origin),C.Matrix4.fromTranslation(new C.Cartesian3(0,0,15)),new C.Matrix4())
   const cubeCenter=C.Matrix4.getTranslation(cubeMatrix,new C.Cartesian3());C.Matrix4.multiplyByScale(cubeMatrix,new C.Cartesian3(30,30,30),cubeMatrix)
   const cube=await C.Model.fromGltfAsync({url:cubeUrl(C,[.2,.4,.8,1]),modelMatrix:cubeMatrix,id:'selection-cube'});s.primitives.add(cube)
   s.camera.lookAt(cubeCenter,new C.HeadingPitchRange(0,-.6,180));s.camera.lookAtTransform(C.Matrix4.IDENTITY);await wait(16)
   const beforeId=s.pick(new C.Cartesian2(center.x,center.y))?.id
   cube.silhouetteSize=4;cube.silhouetteColor=C.Color.YELLOW;await wait(14)
   const pixels=s.context.readPixels({width:s.drawingBufferWidth,height:s.drawingBufferHeight});let outlinePixels=0
   for(let i=0;i<pixels.length;i+=4)if(pixels[i]>180&&pixels[i+1]>180&&pixels[i+2]<100)outlinePixels++
   r.outline={pixels:outlinePixels,pickPreserved:s.pick(new C.Cartesian2(center.x,center.y))?.id===beforeId,mode:p.getLightingDiagnostics().activeMode,reason:p.getLightingDiagnostics().reason}
   s.primitives.remove(cube);s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}})
   front.show=true;f.backdrop.show=true;await wait(14);r.recovered={lighting:p.getLightingDiagnostics(),forward:p.getLightingDiagnostics().transparentForward}
   // Custom Primitive stays native, with an observable contribution and stable picking.
   front.show=false;const primitive=s.primitives.add(new C.Primitive({asynchronous:false,geometryInstances:new C.GeometryInstance({id:'custom',geometry:new C.PlaneGeometry({vertexFormat:C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT}),modelMatrix:matrix,attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(new C.Color(.2,.8,.4,.5))}}),appearance:new C.PerInstanceColorAppearance({flat:true,translucent:true,fragmentShaderSource:'void main(){out_FragColor=vec4(.2,.8,.4,.5);}'})}))
   await wait(16);const compatible=read(center),pick=s.pick(new C.Cartesian2(center.x,center.y))?.id;p.setLighting({mode:'enhanced'});await wait(10);r.compatibility={delta:delta(compatible,read(center)),pick:pick===s.pick(new C.Cartesian2(center.x,center.y))?.id,id:pick}
   s.primitives.remove(primitive);front.show=false;back.show=false;f.backdrop.show=false
   // A generated imagery layer exercises Globe compatibility without a network provider.
   s.globe.show=true;s.imageryLayers.removeAll();s.imageryLayers.addImageryProvider(new C.GridImageryProvider({color:new C.Color(.3,.6,.8,1),backgroundColor:new C.Color(.1,.2,.3,1)}));await wait(60)
   const imageryNative=read(center);p.setLighting({mode:'deferred'});await wait(18)
   r.globe={loaded:s.globe.tilesLoaded,delta:delta(imageryNative,read(center)),visible:imageryNative.some(v=>v>.02)}
   const classification=s.primitives.add(new C.ClassificationPrimitive({asynchronous:false,classificationType:C.ClassificationType.TERRAIN,
     geometryInstances:new C.GeometryInstance({geometry:C.BoxGeometry.fromDimensions({dimensions:new C.Cartesian3(100,100,20),vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),modelMatrix:C.Transforms.eastNorthUpToFixedFrame(f.origin),attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(new C.Color(1,.1,.1,.5))}})}))
   await wait(20);const classified=read(center),classifiedMode=p.getLightingDiagnostics();p.setLighting({mode:'enhanced'});await wait(10)
   r.classification={delta:delta(classified,read(center)),visibleDelta:delta(classified,imageryNative),mode:classifiedMode.activeMode,reason:classifiedMode.reason}
   s.primitives.remove(classification);r.errors=f.errors.slice();return r
  })
  r.pageErrors=errors;report.push(r);await page.close()
 }
 fs.mkdirSync('docs/verification/stage1-B03-fixed',{recursive:true});fs.writeFileSync('docs/verification/stage1-B03-fixed/content.json',JSON.stringify(report,null,2))
 for(const r of report){assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.errors,[]);assert.ok(r.mask.holeDelta<.01);assert.ok(r.mask.solidDelta<.01);assert.ok(r.tile.loaded>0);assert.ok(r.tile.patched>0);assert.equal(r.tile.picked,true);assert.ok(r.tile.styleNativeDelta<.01);assert.ok(r.tile.restoreDelta<.01);assert.equal(r.tile.styleChanged,true);assert.ok(r.outline.pixels>10);assert.equal(r.outline.pickPreserved,true);assert.equal(r.recovered.lighting.failed,false);if(r.oit)assert.equal(r.recovered.lighting.valid,true);assert.equal(r.recovered.forward.valid,true);assert.ok(r.compatibility.delta<.01);assert.equal(r.compatibility.pick,true);assert.equal(r.compatibility.id,'custom');assert.ok(r.globe.visible);assert.ok(r.globe.delta<.01);assert.ok(r.classification.delta<.01);assert.ok(r.classification.visibleDelta>.005);assert.equal(r.classification.mode,'enhanced')}
 for(const r of report){assert.ok(r.tile.passSwitchPatched>0);assert.ok(r.tile.passSwitchRestored<.01);assert.equal(r.tile.passSwitchChanged,true)}
 console.log(JSON.stringify(report.map(r=>({oit:r.oit,mask:r.mask,tile:r.tile,outline:r.outline,compatibility:r.compatibility}))))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
