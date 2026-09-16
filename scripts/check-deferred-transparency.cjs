// B03: generic blend, dynamic lighting, compatibility and lifecycle acceptance.
const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright'),fs=require('node:fs'),assert=require('node:assert/strict')
const negative=process.argv.includes('--disable-forward'),modes=['mrt','multipass','sorted','umd','no-global']
;(async()=>{const b=await chromium.launch({channel:'chrome',headless:true}),report={modes:[],valid:false,negative};try{
 for(const mode of modes){
  const page=await b.newPage({viewport:{width:640,height:420}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/tests/rendering/deferred-transparency-fixture.html?oit='+(mode==='sorted'?0:1));await page.waitForFunction(()=>window.fixture)
  if(mode==='umd'){await page.addScriptTag({url:'http://127.0.0.1:'+(process.env.CCR_TEST_PORT||8877)+'/build/0.1.0/CCR.min.js'});await page.evaluate(()=>{fixture.CCR=window.CCR})}
  const r=await page.evaluate(async({mode,negative})=>{
   const C=Cesium,f=fixture,m=await import('/tests/rendering/deferred-transparency-fixture.js'),s=f.viewer.scene
   if(mode==='multipass'){const old=s._view.oit;s._view.oit=new old.constructor(new Proxy(s.context,{get:(t,k)=>k==='drawBuffers'?false:Reflect.get(t,k,t)}));old.destroy()}
   await m.startTransparencyFixture(f)
   const p=f.pipeline,wait=n=>m.waitFrames(s,n,f.errors),point=m.stackScreenPoint(f),front=f.layers.find(x=>x.id==='front').model,back=f.layers.find(x=>x.id==='back').model
   if(mode==='no-global')delete window.Cesium
   const read=()=>m.readHdr(C,s,point.x,point.y),delta=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])))
   p.setLighting({mode:'deferred'});if(negative)p.transparentForward.setEnabled(false)
   const r={mode,mrt:s._view.oit?._translucentMRTSupport,multipass:s._view.oit?._translucentMultipassSupport}
   const show=async(bd,ft,bk)=>{f.backdrop.show=bd;front.show=ft;back.show=bk;await wait(10)}
   await show(true,false,false)
   const background=read()
   if(mode!=='sorted'){
    const sample=()=>{const t=p.deferredLighting.materials.getTextures();return {albedo:m.readTexture(C,s,t.albedoOcclusion,point.x,point.y).slice(0,3),depth:m.readTexture(C,s,t.eyeDepth,point.x,point.y)[0]}}
    const before=sample();await show(true,true,true);r.gbuffer={before,after:sample()}
   }
   const twin=await C.Model.fromGltfAsync({url:m.planeGlb(C,{baseColor:[.9,.25,.2,1],metallic:0,roughness:.15}),modelMatrix:front.modelMatrix.clone(),upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
   twin.show=false;s.primitives.add(twin);await show(false,false,false);twin.show=true;await wait(16);const frontColor=read();twin.show=false
   await show(true,true,false);r.singleError=delta(read(),m.expectedBlend(background,[{color:frontColor,alpha:.5}]))
   const backTwin=await C.Model.fromGltfAsync({url:m.planeGlb(C,{baseColor:[.2,.45,.9,1],metallic:0,roughness:.15}),modelMatrix:back.modelMatrix.clone(),upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
   backTwin.show=false;s.primitives.add(backTwin);await show(false,false,false);backTwin.show=true;await wait(16);const backColor=read();backTwin.show=false
   await show(true,true,true);const stack=read();r.stackedError=delta(stack,m.expectedBlend(background,[{color:frontColor,alpha:.5},{color:backColor,alpha:.5}]))
   p.transparentForward.setEnabled(false);await wait(8);r.nativeOitDelta=delta(stack,read());if(!negative)p.transparentForward.setEnabled(true)
   await show(true,false,false)
   for(const alpha of [0,1]){
    const model=await C.Model.fromGltfAsync({url:m.planeGlb(C,{baseColor:[.9,.25,.2,alpha],metallic:0,roughness:.15,blend:true}),modelMatrix:front.modelMatrix.clone(),upAxis:C.Axis.Z,forwardAxis:C.Axis.X});s.primitives.add(model);await wait(16)
    r['alpha'+alpha]=delta(read(),alpha?frontColor:background);s.primitives.remove(model)
   }
   // Opaque in front of glass must occlude it; the reverse ordering was sampled above.
   const foreground=await C.Model.fromGltfAsync({url:m.planeGlb(C,{baseColor:[.3,.6,.1,1],metallic:0,roughness:.7}),modelMatrix:C.Matrix4.clone(front.modelMatrix),upAxis:C.Axis.Z,forwardAxis:C.Axis.X})
   const up=C.Cartesian3.normalize(f.origin,new C.Cartesian3());const pos=C.Matrix4.getTranslation(foreground.modelMatrix,new C.Cartesian3());C.Cartesian3.add(pos,C.Cartesian3.multiplyByScalar(up,10,new C.Cartesian3()),pos);C.Matrix4.setTranslation(foreground.modelMatrix,pos,foreground.modelMatrix)
   s.primitives.add(foreground);await show(true,false,false);const occluder=read();await show(true,true,true);r.foregroundDelta=delta(read(),occluder);s.primitives.remove(foreground)
   // A real output difference is required. Same inputs with B03 disabled must fail this gate.
   await show(false,true,false)
   let shadow=null;p._deferredShadowVisibility=()=>shadow
   const unshadowed=read(),depth=new C.Texture({context:s.context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.UNSIGNED_BYTE,source:{width:1,height:1,arrayBufferView:new Uint8Array([0,0,0,255])}})
   shadow={texture:depth,matrix:C.Matrix4.fromUniformScale(.001),params:new C.Cartesian4(1/1024,0,100,1)};await wait(8);r.shadowDelta=delta(unshadowed,read())
   p.setLighting({shadow:false});if(negative)p.transparentForward.setEnabled(false);await wait(8);r.shadowOffDelta=delta(unshadowed,read())
   p.setLighting({shadow:true});if(negative)p.transparentForward.setEnabled(false);shadow=null;await wait(8);r.shadowRemovedDelta=delta(unshadowed,read())
   p.setLighting({direct:false,indirect:false,emissive:false});if(negative)p.transparentForward.setEnabled(false);await wait(8);r.termsDelta=delta(read(),unshadowed)
   p.setLighting({direct:true,indirect:true,emissive:true});if(negative)p.transparentForward.setEnabled(false);await wait(8)
   const identity=s.pick(new C.Cartesian2(point.x,point.y))?.id
   p.setLighting({mode:'enhanced'});await wait(8);r.pickPreserved=s.pick(new C.Cartesian2(point.x,point.y))?.id===identity
   p.setLighting({mode:'deferred'});if(negative)p.transparentForward.setEnabled(false);await wait(8)
   r.forward=p.getLightingDiagnostics().transparentForward
   const tf=p.transparentForward,bridge=tf.bridge;tf.destroy();r.bridgeReleased=!bridge?.installed
   depth.destroy();r.errors=f.errors.slice();return r
  },{mode,negative})
  r.pageErrors=errors;report.modes.push(r);await page.close()
 }
 for(const r of report.modes){
  assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.errors,[])
  assert.ok(r.singleError<=.01,r.mode+' single-layer 0.01 gate');assert.ok(r.alpha0<=.01);assert.ok(r.alpha1<=.01);assert.ok(r.foregroundDelta<=.01)
  if(r.mode==='sorted')assert.ok(r.stackedError<=.01,'sorted stack');else assert.ok(r.nativeOitDelta<=.01,'OIT preserves native weighted composition')
  if(r.mode==='multipass'){assert.equal(r.mrt,false);assert.equal(r.multipass,true)}
  if(r.gbuffer){assert.ok(r.gbuffer.before.albedo.every((v,i)=>Math.abs(v-[.55,.58,.62][i])<.001),'actual backdrop sampled');assert.ok(Math.abs(r.gbuffer.before.depth-150)<.1);assert.deepEqual(r.gbuffer.before,r.gbuffer.after)}
  assert.ok(r.shadowDelta>.03,'transparent lighting negative-control gate');assert.ok(r.shadowOffDelta<.001);assert.ok(r.shadowRemovedDelta<.001);assert.ok(r.termsDelta>.03)
  assert.equal(r.forward.valid,true);assert.ok(r.forward.stats.patchedCommands>0);assert.equal(r.pickPreserved,true);assert.equal(r.bridgeReleased,true)
 }
 report.valid=true;console.log(JSON.stringify(report.modes.map(r=>({mode:r.mode,single:r.singleError,stack:r.stackedError,shadow:r.shadowDelta}))))
 }finally{fs.mkdirSync('docs/verification/stage1-B03-fixed',{recursive:true});fs.writeFileSync('docs/verification/stage1-B03-fixed/'+(negative?'negative':'report')+'.json',JSON.stringify(report,null,2));await b.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
