#!/usr/bin/env node
// Integrated visual/resource correctness; deliberately no timing benchmark.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const {createHash}=require('node:crypto')
async function main(){
  const horizon=process.argv.includes('--horizon')
  const orbit=process.argv.includes('--orbit'),planar=process.argv.includes('--planar')
  const cloudLighting=process.argv.includes('--cloud-lighting')
  const nightLighting=process.argv.includes('--night-lighting')
  const nightGrid=process.argv.includes('--night-grid')
  const nightDisabled=process.argv.includes('--night-disabled')
  const sdkSha256=createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../build/0.1.0/CCR.min.js'))).digest('hex')
  const focused=horizon||orbit||cloudLighting||nightLighting
  const label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)||'after'
  if(!/^[a-z-]+$/.test(label))throw new Error('Invalid label')
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
  const directory=path.resolve(__dirname,'../../docs/verification/rendering-performance')
  const server=spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8967'],{stdio:'ignore'})
  let browser
  try{
    await new Promise(r=>setTimeout(r,1500))
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage({viewport:orbit?{width:1200,height:900}:(horizon||cloudLighting||nightLighting)?{width:1200,height:720}:{width:960,height:540}}),errors=[]
    if(horizon)await page.addInitScript(()=>{window.CCR_HORIZON_DIAG=true})
    if(planar)await page.addInitScript(()=>{window.CCR_FORCE_PLANAR_FOG=true})
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:8967/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid,null,{timeout:120000})
    await page.waitForTimeout(7000)
    await page.evaluate(({orbit,nightGrid,nightDisabled})=>{
      document.getElementById('hud')?.style.setProperty('display','none')
      document.querySelector('.lil-gui')?.style.setProperty('display','none')
      if(campus.stats?.dom)campus.stats.dom.style.setProperty('display','none')
      campus.viewer.clock.shouldAnimate=false
      campus.pipeline.setOptions({environmentAnimation:false})
      if(orbit||nightGrid){
        campus.viewer.terrainProvider=new Cesium.EllipsoidTerrainProvider()
        campus.viewer.imageryLayers.removeAll()
        campus.viewer.imageryLayers.addImageryProvider(new Cesium.GridImageryProvider({cells:12,
          color:new Cesium.Color(.15,.6,.2,1),backgroundColor:new Cesium.Color(.03,.13,.32,1),glowWidth:0}))
      }
      if(nightGrid)campus.pipeline.setOptions({clouds:false,fog:false,volumetricFog:false})
      if(nightDisabled){
        const renderer=campus.pipeline.environmentRenderer,update=renderer.update
        renderer.update=function(...args){
          update.apply(this,args)
          this.state.nightWeight=0;this.state.moonRadiance=[0,0,0];this.state.nightSkyRadiance=[0,0,0]
          this.lighting.apply({nightWeight:0,moonRadiance:[0,0,0],nightSkyRadiance:[0,0,0]})
          this.nativeMoonLighting?.setActive(false)
        }
      }
      const keys={'cloud.march':'cloudStage','cloud.depth':'cloudDepthStage','atmosphere.raymarch':'raymarchStage',
        'atmosphere.transmission':'transmissionStage','environment.composite':'resolveStage','environment.medium':'occlusionStage'}
      window.captureEnvironmentFrame=()=>{
        const {viewer,pipeline}=campus,e=pipeline.environmentRenderer,context=viewer.scene.context,gl=context._gl
        const adapter=e.environmentGraph,run=adapter.run,execute=e.hdr._execute,records={},arrays={}
        const defaultLoop=viewer.useDefaultRenderLoop;viewer.useDefaultRenderLoop=false
        adapter.run=function(key,invoke){return run.call(this,key,()=>{
          const value=invoke(),stage=e.stages[keys[key]],fb=stage?._command?.framebuffer
          if(window.CCR_FORCE_PLANAR_FOG && (key==='atmosphere.raymarch'||key==='atmosphere.transmission')){
            const shader=stage.fragmentShader.replace('return ccrSphericalFogTransport(origin,direction,atmosphereParams.x,distance,source,noiseSample);',
              'return ccrEnvironmentFogTransport(length(origin)-atmosphereParams.x,dot(normalize(origin),direction),distance,source,noiseSample);')
            const command=context.createViewportQuadCommand(new Cesium.ShaderSource({defines:viewer.scene.frameState.useLogDepth?['LOG_DEPTH']:[],sources:[shader]}),{
              framebuffer:fb,renderState:stage._command.renderState,uniformMap:stage._command.uniformMap})
            command.execute(context);command.shaderProgram.destroy()
          }
          if(window.CCR_HORIZON_DIAG && key==='atmosphere.raymarch'){
            const C=window.Cesium,texture=fb.getColorTexture(0)
            const target=new C.Texture({context,width:texture.width,height:texture.height,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
            const targetFb=new C.Framebuffer({context,colorTextures:[target],destroyAttachments:false})
            const state=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,target.width,target.height),depthTest:{enabled:false},depthMask:false})
            for(const [name,replacement]of [['geometry','out_FragColor=vec4(distance,finiteSurface?1.0:0.0,clouds.a,1.0);'],
              ['view','out_FragColor=vec4(ccrAtmosphereScene(origin,direction,distance,vec3(0.0),transmittance),1.0);'],
              ['sky','out_FragColor=vec4(ccrLutSkyView(origin,direction,sunDirectionAtmo)*atmosphereSunRadiance,1.0);']]){
              const shader=stage.fragmentShader.replace('out_FragColor = vec4(color, ccrPackTransmittance(sceneTransmittance));',replacement)
              const command=context.createViewportQuadCommand(new C.ShaderSource({defines:viewer.scene.frameState.useLogDepth?['LOG_DEPTH']:[],sources:[shader]}),{
                framebuffer:targetFb,renderState:state,uniformMap:stage._command.uniformMap})
              command.execute(context)
              const values=new Float32Array(target.width*target.height*4)
              const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
              gl.bindFramebuffer(gl.FRAMEBUFFER,targetFb._framebuffer)
              gl.readPixels(0,0,target.width,target.height,gl.RGBA,gl.FLOAT,values)
              gl.bindFramebuffer(gl.FRAMEBUFFER,previous)
              const scanline=[]
              for(let y=0;y<target.height;y++){
                const i=(y*target.width+Math.floor(target.width*.35))*4
                scanline.push(Array.from(values.subarray(i,i+4)))
              }
              records['probe.'+name]={scanline}
              command.shaderProgram.destroy()
            }
            targetFb.destroy();target.destroy();C.RenderState.removeFromCache(state)
          }
          if(fb){
            const texture=fb.getColorTexture(0),pixels=new Float32Array(texture.width*texture.height*4)
            const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
            gl.bindFramebuffer(gl.FRAMEBUFFER,fb._framebuffer)
            gl.readPixels(0,0,texture.width,texture.height,gl.RGBA,gl.FLOAT,pixels)
            gl.bindFramebuffer(gl.FRAMEBUFFER,previous)
            const samples=[];let minAlpha=Infinity,maxAlpha=-Infinity,meanL=0,skyL=0,n=0,skyN=0,cloudN=0
            const cloudRgb=[0,0,0]
            for(let y=0;y<texture.height;y+=4)for(let x=0;x<texture.width;x+=4){
              const i=(y*texture.width+x)*4,l=pixels[i]*.2126+pixels[i+1]*.7152+pixels[i+2]*.0722
              meanL+=l;n++;if(y>texture.height*.75){skyL+=l;skyN++}
              minAlpha=Math.min(minAlpha,pixels[i+3]);maxAlpha=Math.max(maxAlpha,pixels[i+3])
              if(key==='cloud.march'&&pixels[i+3]<.95){cloudN++;for(let c=0;c<3;c++)cloudRgb[c]+=pixels[i+c]}
            }
            for(const [u,v]of [[.5,.9],[.5,.6],[.5,.25]]){
              const i=(Math.floor(texture.height*v)*texture.width+Math.floor(texture.width*u))*4
              samples.push(Array.from(pixels.subarray(i,i+4)))
            }
            const scanline=[]
            for(let y=0;y<texture.height;y++){
              const i=(y*texture.width+Math.floor(texture.width*.35))*4
              scanline.push(Array.from(pixels.subarray(i,i+4)))
            }
            records[key]={textureId:texture.id,size:[texture.width,texture.height],finite:pixels.every(Number.isFinite),scanline,
              meanL:meanL/n,skyL:skyL/skyN,minAlpha,maxAlpha,samples,cloudPixels:cloudN,cloudRgb:cloudRgb.map(v=>cloudN?v/cloudN:0)}
            arrays[key]=pixels
          }
          if(key==='environment.composite'){
            const C=window.Cesium,input=e.hdr.inputColor
            const nativeFb=new C.Framebuffer({context,colorTextures:[input],destroyAttachments:false})
            const nativePixels=new Float32Array(input.width*input.height*4),previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
            gl.bindFramebuffer(gl.FRAMEBUFFER,nativeFb._framebuffer)
            gl.readPixels(0,0,input.width,input.height,gl.RGBA,gl.FLOAT,nativePixels)
            gl.bindFramebuffer(gl.FRAMEBUFFER,previous);nativeFb.destroy()
            let sum=0,count=0,lit=0,maximum=0
            const center=[]
            for(let y=Math.floor(input.height*.4);y<input.height*.6;y++)for(let x=Math.floor(input.width*.4);x<input.width*.6;x++){
              const i=(y*input.width+x)*4;maximum=Math.max(maximum,nativePixels[i],nativePixels[i+1],nativePixels[i+2])
            }
            for(const [u,v]of [[.5,.5],[.5,.9]]){
              const i=(Math.floor(v*input.height)*input.width+Math.floor(u*input.width))*4;center.push(Array.from(nativePixels.subarray(i,i+4)))
            }
            for(let y=Math.floor(input.height*.75);y<input.height;y++)for(let x=0;x<input.width;x++){
              const i=(y*input.width+x)*4,l=nativePixels[i]*.2126+nativePixels[i+1]*.7152+nativePixels[i+2]*.0722
              sum+=l;count++;if(l>.001)lit++
            }
            records.nativeSky={meanL:sum/count,litPixels:lit,maximum,center}
            const moon=viewer.scene.moon
            if(moon&&viewer.scene._environmentState.isMoonVisible){
              const world=C.Matrix4.getTranslation(moon._ellipsoidPrimitive.modelMatrix,new C.Cartesian3())
              const point=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,world)
              if(point){
                const cx=Math.round(point.x*input.width/viewer.canvas.clientWidth),cy=input.height-1-Math.round(point.y*input.height/viewer.canvas.clientHeight)
                let peak=0,lit=0
                for(let y=Math.max(0,cy-10);y<Math.min(input.height,cy+11);y++)for(let x=Math.max(0,cx-10);x<Math.min(input.width,cx+11);x++){
                  const i=(y*input.width+x)*4,l=nativePixels[i]*.2126+nativePixels[i+1]*.7152+nativePixels[i+2]*.0722
                  peak=Math.max(peak,l);if(l>.04)lit++
                }
                records.nativeMoon={pixel:[cx,cy],peak,litPixels:lit}
              }
            }
            records.graph=e.environmentGraph.getDiagnostics()
            records.leases=[...pipeline.renderGraph.activeFrame.groupLeases.values()].map(lease=>({id:lease.id,textureId:lease.texture?.id}))
          }
          return value
        })}
        e.hdr._execute=function(...args){
          const output=execute.apply(this,args)
          records.downstream={hdrValid:this._valid,outputTextureId:output?.id,
            mediumValid:e.getMediumOcclusionDiagnostics().valid}
          return output
        }
        try{viewer.render()}finally{adapter.run=run;e.hdr._execute=execute;viewer.useDefaultRenderLoop=window.CCR_FORCE_PLANAR_FOG?false:defaultLoop}
        const previousRead=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),previousDraw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
        gl.bindFramebuffer(gl.FRAMEBUFFER,null)
        const display=new Uint8Array(viewer.canvas.width*viewer.canvas.height*4)
        gl.readPixels(0,0,viewer.canvas.width,viewer.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,display)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previousRead);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,previousDraw)
        let white=0,displayCount=0,earthCount=0,coloredEarth=0,visible=0,skyVisible=0,skyPixelCount=0,skyPeaks=0
        const displayRgb=[0,0,0]
        for(let y=0;y<viewer.canvas.height;y++)for(let x=0;x<viewer.canvas.width;x++){
          const i=(y*viewer.canvas.width+x)*4,rgb=display.subarray(i,i+3),l=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722
          for(let c=0;c<3;c++)displayRgb[c]+=rgb[c]
          if(l>3)visible++
          if(y>viewer.canvas.height*.75){skyPixelCount++;if(l>3)skyVisible++;
            if(l>20&&x>1&&x<viewer.canvas.width-2){const j=i+8,k=i-8;
              if(l>(display[j]+display[j+1]+display[j+2]+display[k]+display[k+1]+display[k+2])/6+12)skyPeaks++}}
        }
        for(let y=Math.floor(viewer.canvas.height*.55);y<viewer.canvas.height;y++)for(let x=0;x<viewer.canvas.width;x++){
          const i=(y*viewer.canvas.width+x)*4;displayCount++
          if(display[i]>=250&&display[i+1]>=250&&display[i+2]>=250)white++
        }
        for(let y=0;y<viewer.canvas.height;y++)for(let x=0;x<viewer.canvas.width;x++){
          if(Math.hypot((x/viewer.canvas.width-.5)*viewer.canvas.width/viewer.canvas.height,y/viewer.canvas.height-.5)>.3)continue
          const i=(y*viewer.canvas.width+x)*4,rgb=display.subarray(i,i+3)
          earthCount++;if(Math.max(...rgb)-Math.min(...rgb)>=30)coloredEarth++
        }
        const glError=gl.getError()
        let cloudDepthError=0
        if(arrays['cloud.march']&&arrays['cloud.depth'])for(let i=0;i<arrays['cloud.march'].length;i+=4)
          cloudDepthError=Math.max(cloudDepthError,Math.abs(arrays['cloud.march'][i+3]-arrays['cloud.depth'][i+1]))
        return {records,display:{rgb:displayRgb.map(v=>v/(viewer.canvas.width*viewer.canvas.height)),visibleRatio:visible/(viewer.canvas.width*viewer.canvas.height),skyVisibleRatio:skyVisible/skyPixelCount,skyPeaks},
          native:{skyBox:viewer.scene.skyBox?.show,moon:viewer.scene.moon?.show,skyAtmosphere:viewer.scene.skyAtmosphere?.show,
            moonVisible:viewer.scene._environmentState.isMoonVisible,moonCommand:!!viewer.scene._environmentState.moonCommand,
            moonMaterial:viewer.scene.moon?._ellipsoidPrimitive?.material?.type},
          night:e.getDiagnostics(),lighting:e.lighting.getDiagnostics(),whiteRatio:white/displayCount,earthColorRatio:coloredEarth/earthCount,cloudDepthError,glError,hdr:e.hdr.getDiagnostics(),lut:e.atmosphereLut.getDiagnostics(),pool:pipeline.getResourcePoolDiagnostics()}
      }
    },{orbit,nightGrid,nightDisabled})
    const cases=[]
    const times=nightLighting?['2026-09-26T23:00','2026-09-18T19:30','2026-09-10T23:00','2026-09-08T11:00']:cloudLighting?['1735','1745','1755','1100','0000']:focused?['1100','1800']:['0530','1100','1800','0000']
    const views=nightLighting?[{name:'sky',height:300,pitch:35},{name:'campus',height:500,pitch:-20},{name:'clouds',height:3500,pitch:-12}]:cloudLighting?[{name:'above',height:3500,pitch:-12},{name:'high',height:12000,pitch:-10},
      {name:'side',height:3500,pitch:-12,headingOffset:Math.PI/2}]:orbit?[{name:'orbit',height:8000000,pitch:-90}]:horizon?[{name:'horizon',height:12000,pitch:-10}]:[{name:'below',height:300,pitch:10},
      {name:'inside',height:2200,pitch:0},{name:'above',height:3500,pitch:-15},{name:'high',height:12000,pitch:0}]
    if(process.argv.includes('--first-case')){times.splice(1);views.splice(1)}
    if(nightGrid){times.splice(0,times.length,'2026-09-10T23:00');views.splice(0,views.length,{name:'grid',height:20000,pitch:-90})}
    for(const time of times)for(const view of views){
      await page.evaluate(({time,view,horizon,orbit,cloudLighting,nightLighting})=>{
        const {viewer,pipeline}=campus
        viewer.clock.currentTime=Cesium.JulianDate.fromIso8601(nightLighting?time+':00+08:00':'2026-09-08T'+time.slice(0,2)+':'+time.slice(2)+':00+08:00')
        pipeline.environmentRenderer.update()
        const c=viewer.camera.positionCartographic
        let s=pipeline.environmentRenderer.sunLocal
        if(nightLighting){
          const C=Cesium,t=viewer.clock.currentTime,r=C.Transforms.computeIcrfToFixedMatrix(t)||C.Transforms.computeTemeToPseudoFixedMatrix(t)
          const moon=C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t)
          C.Matrix3.multiplyByVector(r,moon,moon);C.Cartesian3.normalize(moon,moon)
          C.Matrix4.multiplyByPointAsVector(pipeline.environmentRenderer.inverseFrame,moon,moon)
          s=moon
          if(view.name==='sky')view.pitch=Math.max(20,C.Math.toDegrees(Math.asin(moon.z)))
          pipeline.setOptions({clouds:view.name!=='sky'&&view.name!=='grid'})
        }
        viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,view.height),
          orientation:{heading:Math.atan2(s.x,s.y)+(view.headingOffset||0),pitch:Cesium.Math.toRadians(view.pitch),roll:0}})
        if(horizon||cloudLighting){viewer.camera.frustum.near=1000;viewer.camera.frustum.far=1000000}
        if(orbit){viewer.camera.frustum.near=20000;viewer.camera.frustum.far=20000000;viewer.camera.frustum.fov=Cesium.Math.toRadians(75)}
      },{time,view,horizon,orbit,cloudLighting,nightLighting})
      await page.waitForTimeout(1100)
      const result=await page.evaluate(()=>window.captureEnvironmentFrame())
      if(!result.hdr.valid||!result.lut.ready||result.glError||result.whiteRatio>.1||result.cloudDepthError>1e-5||
        Object.entries(result.records).some(([k,r])=>k.includes('.')&&r.finite===false))throw new Error(JSON.stringify({time,view,...result}))
      if(nightLighting&&label==='after'){
        const night=time.slice(11)!=='11:00'
        if(night){
          if(result.display.visibleRatio<.2||result.night.nightWeight<.95)throw new Error('Night remains black: '+JSON.stringify({time,view,display:result.display}))
          if(result.display.rgb[2]<=result.display.rgb[0]&&!nightGrid)throw new Error('Night lost its cold illumination')
          if(view.name==='clouds'&&result.records['cloud.march'].meanL<1e-4)throw new Error('Cloud night source is zero')
          if(view.name==='sky'&&time.startsWith('2026-09-10')&&result.display.skyPeaks<10)throw new Error('Native starfield is not visible')
          if(view.name==='sky'&&!time.startsWith('2026-09-10')&&!(result.records.nativeMoon?.peak>.04&&result.records.nativeMoon?.litPixels>=3))throw new Error('Native moon disc is not visible')
          if(result.night.moonHeight<0&&result.night.moonRadiance.some(v=>v!==0))throw new Error('Moon shines through the planet')
        }else if(result.night.nightWeight!==0||result.night.moonRadiance.some(v=>v!==0)||result.night.nightSkyRadiance.some(v=>v!==0)||result.lighting.activeLight!=='sun')throw new Error('Night lighting leaked into day')
      }
      if(nightGrid&&label==='grid-after'&&(!(result.records.nativeSky.meanL>1e-5)||!(result.night.globeNight.draws>0)))
        throw new Error('Globe night imagery remains black before atmosphere: '+JSON.stringify({native:result.records.nativeSky,globe:result.night.globeNight}))
      if(horizon){
        const geometry=result.records['probe.geometry'].scanline,viewL=result.records['probe.view'].scanline
        const color=result.records['atmosphere.raymarch'].scanline,ratios=[]
        const luminance=p=>p[0]*.2126+p[1]*.7152+p[2]*.0722
        for(let y=0;y<geometry.length;y++){
          if(geometry[y][1]>.5&&geometry[y][2]>.999&&geometry[y][0]>100000&&geometry[y][0]<300000&&luminance(viewL[y])>1e-5)
            ratios.push(luminance(color[y])/luminance(viewL[y]))
        }
        result.horizonScatterRetention={samples:ratios.length,min:Math.min(...ratios)}
        if(label.endsWith('after')&&!planar&&(ratios.length<10||Math.min(...ratios)<.8))
          throw new Error('Surface fog erased horizon scattering: '+JSON.stringify(result.horizonScatterRetention))
      }
      if(orbit&&time==='1100'&&!planar&&result.earthColorRatio<.95)
        throw new Error('Orbit surface imagery was replaced by gray fog: '+result.earthColorRatio)
      const file=nightLighting?`night-lighting-${label}-${time.replaceAll(':','')}-${view.name}.png`:cloudLighting?`cloud-lighting-${label}-${time}-${view.name}.png`:focused?`atmosphere-${orbit?'orbit':'horizon'}-${label}-${time}.png`:`environment-lut-${time}-${view.name}.png`
      await page.screenshot({path:path.join(directory,file)})
      cases.push({time,view:view.name,file,...result})
      console.log(JSON.stringify({time,view:view.name,lut:result.lut.ready,graph:result.records.graph?.registered,mean:result.records['environment.composite']?.meanL}))
    }
    if(focused){
      fs.writeFileSync(path.join(directory,nightLighting?`night-lighting-${label}.json`:cloudLighting?`cloud-lighting-${label}.json`:`atmosphere-${orbit?'orbit':'horizon'}-${label}.json`),JSON.stringify({sdkSha256,nightDisabled,cases,errors},null,2))
      if(errors.length)throw new Error(errors.join('\n'))
      return
    }
    // Shader bypass is insufficient: the disabled cloud collection must not submit.
    await page.evaluate(()=>campus.pipeline.setOptions({clouds:false}))
    await page.waitForTimeout(350)
    const cloudsOff=await page.evaluate(()=>window.captureEnvironmentFrame())
    if(cloudsOff.records['cloud.march']||cloudsOff.records['cloud.depth']||cloudsOff.hdr.cloudTemporal.valid)throw new Error('Disabled clouds still submit')
    // Actual finite-depth fog controls change surface transport, sky remains unchanged.
    const fog=[]
    for(const density of [0,0.0002]){
      await page.evaluate(density=>{
        const {viewer,pipeline}=campus,c=viewer.camera.positionCartographic
        viewer.clock.currentTime=Cesium.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
        viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,300),orientation:{heading:0,pitch:0,roll:0}})
        pipeline.setOptions({clouds:false,fog:true,volumetricFog:false,fogDensity:density})
      },density)
      await page.waitForTimeout(350)
      fog.push(await page.evaluate(()=>window.captureEnvironmentFrame()))
    }
    const skyDelta=Math.abs(fog[0].records['atmosphere.raymarch'].skyL-fog[1].records['atmosphere.raymarch'].skyL)
    const surfaceDelta=Math.abs(fog[0].records['environment.composite'].meanL-fog[1].records['environment.composite'].meanL)
    if(skyDelta>1e-5||surfaceDelta<1e-5)throw new Error('Fog controls failed: '+JSON.stringify({skyDelta,surfaceDelta}))
    await page.evaluate(()=>campus.pipeline.setOptions({clouds:true,fogDensity:.000025,volumetricFog:true,lightShaftEnabled:true,lightShaftStrength:.5}))
    await page.waitForTimeout(450)
    const medium=await page.evaluate(()=>window.captureEnvironmentFrame())
    if(!medium.records['environment.medium']||!medium.hdr.valid||!medium.records.downstream.mediumValid)
      throw new Error('Medium or HDR output was released before downstream consumers: '+JSON.stringify(medium.records.downstream))
    const physicalAlias=medium.records['environment.medium'].textureId===medium.records['atmosphere.raymarch'].textureId
    if(!physicalAlias)throw new Error('Declared ray/medium alias did not reuse a physical texture')
    // Validate resource bookkeeping at the deployment baseline resolution.
    await page.setViewportSize({width:1920,height:1080})
    await page.evaluate(()=>campus.viewer.resize())
    await page.waitForTimeout(600)
    const resized=await page.evaluate(()=>window.captureEnvironmentFrame())
    if(resized.hdr.cloudTemporal.bytes!==12441600||resized.hdr.cloudTemporal.depthFormat!=='r32f'||!resized.hdr.valid)
      throw new Error('1080p R32F history budget/resize failed: '+JSON.stringify(resized.hdr))
    const resources=await page.evaluate(async()=>{
      const {default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js')
      const inspector=Object.create(Profiler.prototype)
      inspector.pipeline=campus.pipeline;inspector.scene=campus.viewer.scene;inspector.peakTextureBytes=0
      return inspector._textures()
    })
    if(resources.entries.filter(e=>e.name.startsWith('environment.lut')).length<6||
      resources.entries.filter(e=>e.name.startsWith('environment.cloudHistory')).length<4||
      resources.entries.filter(e=>e.name.startsWith('pool.')).length<5)
      throw new Error('Profiler omitted LUT/history textures: '+JSON.stringify(resources.entries.map(e=>e.name)))
    const transitions=await page.evaluate(()=>{
      const {viewer,pipeline}=campus,e=pipeline.environmentRenderer,loop=viewer.useDefaultRenderLoop
      viewer.useDefaultRenderLoop=false
      const draw=()=>{viewer.render();return e.hdr.cloudTemporal.getDiagnostics()}
      for(let i=0;i<12;i++)draw()
      const before=draw();viewer.camera.moveRight(10);const smallMove=draw()
      viewer.camera.moveRight(1000);const cameraCut=draw()
      for(let i=0;i<12;i++)draw()
      viewer.clock.currentTime=Cesium.JulianDate.addSeconds(viewer.clock.currentTime,3600,new Cesium.JulianDate())
      e.update();const timeJump=draw()
      for(let i=0;i<12;i++)draw()
      pipeline.setOptions({skyLightIntensity:0});const skyChange=draw()
      viewer.useDefaultRenderLoop=loop
      return {before,smallMove,cameraCut,timeJump,skyChange}
    })
    if(transitions.smallMove.age<=transitions.before.age||transitions.cameraCut.age!==1||transitions.timeJump.age!==1||transitions.skyChange.age!==1)
      throw new Error('Integrated history reset failed: '+JSON.stringify(transitions))
    // No timer/profiler run: this is identity, update and physical allocation evidence.
    const report={cases,cloudsOff,fog:{skyDelta,surfaceDelta},medium,physicalAlias,resized,resources,transitions,errors}
    fs.writeFileSync(path.join(directory,'environment-lut-integration.json'),JSON.stringify(report,null,2))
    if(errors.length)throw new Error(errors.join('\n'))
    console.log('environment LUT/Graph/finite fog integration passed')
  }finally{if(browser)await browser.close();server.kill()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
