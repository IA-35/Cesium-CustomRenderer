const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const output=path.join(__dirname,'../docs/verification/stage1-B02-matrix')
const port=process.env.CCR_TEST_PORT||8877
const cases=['default','direct','ibl','emissive','four-slot','no-global','southern','polar','typed','highlight','multi-frustum','msaa','sorted','lifecycle','umd','resize','viewer-destroy','context-loss','draw-overrides','fog','no-log-depth','model-ibl']
;(async()=>{
 fs.mkdirSync(output,{recursive:true})
 const browser=await chromium.launch({channel:'chrome',headless:true}),report={cases:[],errors:[]}
 try{
  const selected=process.argv.includes('--case')?process.argv[process.argv.indexOf('--case')+1]:null
  if(selected)assert.ok(cases.includes(selected),'unknown case')
  for(const name of cases.filter(name=>!selected||name===selected)){
   const page=await browser.newPage({viewport:{width:800,height:500}}),pageErrors=[]
   page.on('pageerror',e=>pageErrors.push(e.message))
   await page.goto('http://127.0.0.1:'+port+'/tests/rendering/deferred-lighting-fixture.html'+(name==='sorted'?'?oit=0':''))
   await page.waitForFunction(()=>window.fixture)
   if(name==='umd'){
    await page.addScriptTag({url:'http://127.0.0.1:'+port+'/build/0.1.0/CCR.min.js'})
    await page.evaluate(()=>{fixture.CCR=window.CCR})
   }
   const result=await page.evaluate(async name=>{
    const C=Cesium,mod=await import('/tests/rendering/deferred-lighting-fixture.js'),f=fixture
    const scene=f.viewer.scene,ctx=scene.context,gl=ctx._gl
    const options=name==='southern'?{longitude:120,latitude:-45}:name==='polar'?{longitude:-60,latitude:78}:{}
    if(name==='typed'){
      options.cases=['normalMap','mask','backFacing','instanced','skinned','unlit','clearcoat'].map(type=>({id:type,baseColor:[.4,.5,.6,1],metallic:.2,roughness:.5,[type]:true}))
      options.spacing=3;options.height=650
    }
    if(name==='highlight'){
      options.cases=[{id:'highlight',baseColor:[1,.77,.34,1],metallic:1,roughness:.04}]
      options.columns=1;options.normalLocal=new C.Cartesian3(-.0477,-.3137,1.9483)
    }
    await mod.startDeferredFixture(f,options)
    if(name==='typed')f.models.find(x=>x.id==='skinned').model.getNode('joint').matrix=C.Matrix4.fromTranslation(new C.Cartesian3(0,0,5))
    const expectedSupported=name==='fog'?[]:(options.cases||mod.MATERIAL_CASES).filter(m=>!m.unlit&&!m.clearcoat).map(m=>m.id)
    const pipeline=f.pipeline,wait=n=>mod.waitFrames(scene,n,f.errors)
    if(name==='direct'||name==='emissive')for(const x of f.models)x.model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0)
    if(name==='ibl'||name==='emissive')scene.light.intensity=0
    if(name==='fog'){
      scene.fog.enabled=true;scene.fog.renderable=true;scene.fog.density=.01
      scene.camera.lookAt(f.origin,new C.HeadingPitchRange(0,-Math.PI/4,340));scene.camera.lookAtTransform(C.Matrix4.IDENTITY)
    }
    if(name==='no-log-depth')scene.logarithmicDepthBuffer=false
    if(name==='model-ibl')for(const [i,{model}] of f.models.entries()){
      model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(i/7,1-i/7)
      model.imageBasedLighting.sphericalHarmonicCoefficients=Array.from({length:9},(_,j)=>new C.Cartesian3(j===0?.1+i*.01:0,j===0?.2:0,j===0?.3:0))
    }
    if(name==='four-slot'){
     const original=gl.getParameter.bind(gl)
     gl.getParameter=p=>p===gl.MAX_DRAW_BUFFERS||p===gl.MAX_COLOR_ATTACHMENTS?4:original(p)
    }
    if(name==='msaa')pipeline.setAntiAliasing({mode:'msaa',msaaSamples:4})
    if(name==='multi-frustum'){scene.farToNearRatio=1.05;scene.logarithmicDepthFarToNearRatio=1.05}
    await wait(40)
    let points=mod.samplePoints(f).points
    const target=new C.Texture({context:ctx,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
    const fb=new C.Framebuffer({context:ctx,colorTextures:[target],destroyAttachments:false})
    const stateOptions={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false}
    let input,uv=new C.Cartesian2()
    const probe=ctx.createViewportQuadCommand('uniform sampler2D u_input; uniform vec2 u_uv; void main(){out_FragColor=texture(u_input,u_uv);}',{
      framebuffer:fb,renderState:C.RenderState.fromCache(stateOptions),uniformMap:{u_input:()=>input,u_uv:()=>uv}})
    const pixel=(texture,point)=>{
     const rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=ctx._currentFramebuffer
     const viewport=C.BoundingRectangle.clone(ctx.uniformState.viewport)
     input=texture;uv.x=(point.x+.5)/texture.width;uv.y=(texture.height-1-point.y+.5)/texture.height
     try{probe.execute(ctx);return Array.from(ctx.readPixels({framebuffer:fb,width:1,height:1}))}
     finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,rd);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dr);ctx._currentFramebuffer=cached;ctx.uniformState.viewport=viewport}
    }
    const samples=()=>points.map(point=>({id:point.id,color:pixel(scene._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0),point).slice(0,3)}))
    const native=samples()
    const identities=points.slice(0,f.models.length).map(p=>scene.pick(new C.Cartesian2(p.x,p.y))?.id)
    await wait(2)
    const counts={native:0,compact:0,nativeById:{}},originalDraw=ctx.draw,modelSet=new Set(f.models.map(x=>x.model))
    ctx.draw=function(command,ps,...args){
      if(modelSet.has(command.owner)&&scene.frameState.passes.render&&!scene.frameState.passes.pick){
       const target=command.framebuffer||ps?.framebuffer
       const nativeTarget=target===scene._view.oit?._opaqueFBO?.framebuffer||target===scene._view.sceneFramebuffer._colorFramebuffer.framebuffer
       if(nativeTarget){counts.native++;const id=command.owner.id;counts.nativeById[id]=(counts.nativeById[id]||0)+1}
       if(command.shaderProgram.fragmentShaderSource.sources.join('\n').includes('ccr_lightingGroup'))counts.compact++
      }
      return originalDraw.call(this,command,ps,...args)
    }
    if(name==='no-global')delete window.Cesium
    pipeline.setLighting({mode:'deferred'})
    if(name==='draw-overrides'){
      const capture=ctx.draw
      ctx.draw=function(command,ps,...args){return capture.call(this,command,ps,args[0]||command.shaderProgram,args[1]||command.uniformMap)}
    }
    await wait(12)
    const d=pipeline.deferredLighting,diagnostics=pipeline.getLightingDiagnostics()
    const actual=samples(),data=d.materials.getTextures()
    const flags=data?points.slice(0,f.models.length).map(p=>pixel(data.emissiveFlags,p)[3]):[]
    const errors=actual.flatMap((x,i)=>x.color.map((v,c)=>({id:x.id,channel:c,actual:v,native:native[i].color[c],
      pass:Number.isFinite(v)&&Math.abs(v-native[i].color[c])<=Math.max(.01,Math.abs(native[i].color[c])*.02)})))
    const result={name,diagnostics,counts:structuredClone(counts),flags,expectedSupported,frustums:scene._view.frustumCommandsList.length,
      comparisons:errors,allSamplesPass:errors.every(e=>e.pass),failedSamples:errors.filter(e=>!e.pass),modelIds:identities,
      explicitMaterial:pipeline.getOptions().materialChannelsEnabled,explicitAlbedo:pipeline.getOptions().albedoEnabled,
      attachmentCount:d.materials.target?.framebuffer.numberOfColorAttachments||0,renderErrors:f.errors.slice()}
    if(data){
      const eye=pixel(data.eyeDepth,points[1])[0]
      result.metricDepth=eye
      result.positionExpectedZ=-eye
    }
    window.Cesium=C
    if(name==='lifecycle'){
      pipeline.setLighting({debugMode:7})
      result.partialUpdateKeepsMode=pipeline.getOptions().lightingMode==='deferred'
      pipeline.setLighting({debugMode:0})
      await wait(2)
      const g=d.materials,targetTexture=g.target.eyeDepth,alias=g.aliases.values().next().value.material
      const nativeDepth=alias.depthStencilTexture
      const oldProgram=d.programs.values().next().value.command.shaderProgram
      pipeline.setLighting({mode:'enhanced'});await wait(4)
      result.release={ownedTexture:targetTexture.isDestroyed(),ownedFramebuffer:alias.isDestroyed(),
        nativeDepthAlive:!nativeDepth.isDestroyed(),programReleased:oldProgram.isDestroyed()||oldProgram._cachedShader?.count===0,
        materialPrograms:g.programs.size,lightingPrograms:d.programs.size}
      pipeline.setLighting({mode:'deferred'});await wait(4)
      const write=d.writeTarget
      d.writeTarget=()=>{throw new Error('injected target failure')}
      await wait(1)
      const recovered=samples()
      result.failure={failed:d.failed,reason:d.reason,nativeColorRecovered:recovered.every((x,i)=>x.color.every((v,c)=>Math.abs(v-native[i].color[c])<.01))}
      d.writeTarget=write
      pipeline.setLighting({mode:'enhanced'});pipeline.setLighting({mode:'deferred'});await wait(5)
      result.retryWorks=d.getDiagnostics().valid
      for(let i=0;i<20;i++){pipeline.setLighting({mode:'enhanced'});pipeline.setLighting({mode:'deferred'});await wait(2)}
      result.repeatedResources=d.getDiagnostics().resources
    }
    const picked=points.slice(0,f.models.length).map(p=>scene.pick(new C.Cartesian2(p.x,p.y))?.id)
    result.pickPreserved=identities.every((id,i)=>id===picked[i])
    probe.shaderProgram.destroy();C.RenderState.removeFromCache(stateOptions);fb.destroy();target.destroy()
    if(name==='resize'){
      const old=d.materials.target.eyeDepth
      f.viewer.resolutionScale=.75;await wait(8)
      result.resize={released:old.isDestroyed(),valid:d.getDiagnostics().valid,
        width:d.materials.target.width,expected:scene.drawingBufferWidth,framebuffers:d.targets.size}
    }
    if(name==='viewer-destroy'){
      f.viewer.destroy();pipeline.destroy()
      result.terminal={destroyed:d.destroyed,targets:d.targets.size,programs:d.programs.size}
    }
    if(name==='context-loss'){
      const lose=gl.getExtension('WEBGL_lose_context')
      if(!lose)throw new Error('WEBGL_lose_context unavailable')
      await new Promise(resolve=>{scene.canvas.addEventListener('webglcontextlost',resolve,{once:true});lose.loseContext()})
      result.terminal={failed:d.failed,reason:d.reason,targets:d.targets.size,programs:d.programs.size}
    }
    return result
   },name)
   result.pageErrors=pageErrors;report.cases.push(result)
   assert.deepEqual(pageErrors,[],name+' page errors')
   assert.deepEqual(result.renderErrors,[],name+' render errors')
   assert.equal(result.allSamplesPass,true,name+' parity '+JSON.stringify(result.failedSamples))
   assert.equal(result.pickPreserved,true,name+' picking')
   assert.equal(result.explicitMaterial,false,name+' explicit material request changed')
   assert.equal(result.explicitAlbedo,false,name+' explicit albedo request changed')
   if(['msaa','sorted','fog'].includes(name)){assert.equal(result.diagnostics.activeMode,'enhanced');assert.equal(result.diagnostics.valid,false)}
   else{
    assert.equal(result.diagnostics.valid,true,name+' valid: '+result.diagnostics.reason)
    assert.equal(result.attachmentCount,4,name+' four attachments')
    for(const id of result.expectedSupported)assert.equal(result.counts.nativeById[id]||0,0,name+' original main color draw ran: '+id)
    assert.ok(result.counts.compact>=result.expectedSupported.length,name+' actual compact draw missing')
    assert.equal(result.flags.length,result.modelIds.length)
    assert.equal(result.flags.filter(f=>(Math.floor((f%1024)/512)%2)===1).length,result.expectedSupported.length,name+' expected material coverage')
   }
   if(name==='multi-frustum')assert.ok(result.frustums>1,'actual multi-frustum required')
   if(result.resize){assert.equal(result.resize.released,true);assert.equal(result.resize.valid,true);assert.equal(result.resize.width,result.resize.expected);assert.equal(result.resize.framebuffers,1)}
   if(result.terminal){assert.equal(result.terminal.targets,0);assert.equal(result.terminal.programs,0);assert.equal(result.terminal.failed||result.terminal.destroyed,true)}
   if(result.release){
    assert.equal(result.partialUpdateKeepsMode,true)
    for(const k of ['ownedTexture','ownedFramebuffer','nativeDepthAlive','programReleased'])assert.equal(result.release[k],true,k)
    assert.equal(result.release.materialPrograms,0);assert.equal(result.release.lightingPrograms,0)
    assert.equal(result.failure.nativeColorRecovered,true,'same-frame native recovery')
    assert.equal(result.retryWorks,true,'retry')
    assert.equal(result.repeatedResources.lightingFramebuffers,1)
   }
   await page.close()
  }
 }catch(e){report.errors.push(e.message);throw e}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close()}
 console.log(JSON.stringify(report.cases.map(c=>({name:c.name,parity:c.allSamplesPass,mainNative:c.counts.native,frustums:c.frustums}))))
})().catch(e=>{console.error(e.message);process.exitCode=1})
