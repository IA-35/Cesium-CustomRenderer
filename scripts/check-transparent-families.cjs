const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report=[];try{
 for(const oit of [true,false]){
  const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/deferred-transparency-fixture.html?oit='+(oit?1:0));await page.waitForFunction(()=>window.fixture)
  const r=await page.evaluate(async()=>{
   const C=Cesium,f=fixture,m=await import('/tests/rendering/deferred-transparency-fixture.js');await m.startTransparencyFixture(f)
   const p=f.pipeline,s=f.viewer.scene,wait=n=>m.waitFrames(s,n,f.errors),point=m.stackScreenPoint(f),read=()=>m.readHdr(C,s,point.x,point.y)
   for(const layer of f.layers)if(layer.id!=='backdrop')layer.model.show=false
   f.backdrop.show=false
   const image=(r,g,b)=>{const c=document.createElement('canvas');c.width=c.height=4;const ctx=c.getContext('2d');ctx.fillStyle=`rgb(${r},${g},${b})`;ctx.fillRect(0,0,4,4);return c.toDataURL()}
   const modelMatrix=C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(f.origin),C.Matrix4.fromTranslation(new C.Cartesian3(0,0,30)),new C.Matrix4())
   const matrix=C.Matrix4.multiplyByScale(modelMatrix,new C.Cartesian3(60,60,1),new C.Matrix4())
   const water=s.primitives.add(new C.Primitive({asynchronous:false,geometryInstances:new C.GeometryInstance({geometry:new C.PlaneGeometry({vertexFormat:C.MaterialAppearance.MaterialSupport.ALL.vertexFormat}),modelMatrix:matrix,id:'water'}),appearance:new C.MaterialAppearance({materialSupport:C.MaterialAppearance.MaterialSupport.ALL,translucent:true,material:C.Material.fromType('Water',{baseWaterColor:new C.Color(.1,.3,.5,.5),blendColor:new C.Color(.1,.3,.5,.5),normalMap:image(128,128,255),specularMap:image(255,255,255),animationSpeed:0,frequency:1,amplitude:1})})}))
   const depth=new C.Texture({context:s.context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.UNSIGNED_BYTE,source:{width:1,height:1,arrayBufferView:new Uint8Array([0,0,0,255])}})
   let shadow=null;p._deferredShadowVisibility=()=>shadow;p.setLighting({mode:'deferred'});await wait(45)
   const waterLit=read();shadow={texture:depth,matrix:C.Matrix4.fromUniformScale(.001),params:new C.Cartesian4(1/1024,0,100,1)};await wait(8)
   const waterShadow=read(),waterDiagnostics=p.getLightingDiagnostics().transparentForward
   water.show=false;f.backdrop.show=true;shadow=null;await wait(8);const background=read()
   C.Math.setRandomNumberSeed(11)
   const particles=s.primitives.add(new C.ParticleSystem({image:image(255,180,40),modelMatrix,emissionRate:0,bursts:[new C.ParticleBurst({time:0,minimum:1,maximum:1})],particleLife:1000,speed:0,startColor:new C.Color(1,1,1,.5),endColor:new C.Color(1,1,1,.5),imageSize:new C.Cartesian2(50,50),emitter:new C.CircleEmitter(.01)}))
   particles._currentTime=1
   await wait(35);const particleLit=read(),particleDiagnostics=p.getLightingDiagnostics().transparentForward
   p.setLighting({emissive:false});await wait(8);const particleOff=read()
   p.setLighting({emissive:true});await wait(8);const particleRestored=read()
   particles.show=false
   const opaque=s.primitives.add(new C.ParticleSystem({image:image(255,180,40),modelMatrix,emissionRate:0,bursts:[new C.ParticleBurst({time:0,minimum:1,maximum:1})],particleLife:1000,speed:0,startColor:C.Color.WHITE,endColor:C.Color.WHITE,imageSize:new C.Cartesian2(50,50),emitter:new C.CircleEmitter(.01)}));opaque._currentTime=1
   await wait(24);const opaqueLit=read();p.setLighting({emissive:false});await wait(8);const opaqueOff=read();p.setLighting({emissive:true});await wait(8)
   const result={oit:s._environmentState.useOIT,waterLit,waterShadow,waterDiagnostics,background,particleLit,particleOff,particleRestored,opaqueLit,opaqueOff,particleCount:particles._particles.length,particleDiagnostics,lighting:p.getLightingDiagnostics(),errors:f.errors.slice()}
   if(result.oit)f.viewer.destroy()
   p.destroy();if(!depth.isDestroyed())depth.destroy();result.destroyed=true;return result
  })
  r.pageErrors=errors;report.push(r);await page.close()
 }
 fs.mkdirSync('docs/verification/stage1-B03-fixed',{recursive:true});fs.writeFileSync('docs/verification/stage1-B03-fixed/families.json',JSON.stringify(report,null,2))
 for(const r of report){assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.errors,[]);assert.ok(r.waterLit.some((v,i)=>v-r.waterShadow[i]>.01),'water must receive CCR shadow');assert.ok(r.particleCount>0);assert.ok(r.particleLit.some((v,i)=>v-r.particleOff[i]>.01),'particles consume emissive control');assert.ok(r.opaqueLit.some((v,i)=>v-r.opaqueOff[i]>.01),'opaque particle cores consume emissive control');assert.ok(r.particleRestored.every((v,i)=>Math.abs(v-r.particleLit[i])<.001));if(r.oit)assert.equal(r.lighting.valid,true,'particles must not disable opaque deferred')}
 console.log(JSON.stringify(report.map(r=>({oit:r.oit,water:r.waterDiagnostics,particles:r.particleDiagnostics}))))
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})
