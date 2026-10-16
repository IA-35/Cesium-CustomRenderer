#!/usr/bin/env node
// Accepted visual milestone: instrument the real SDK; never change rendering quality to improve a score.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFile}=require('node:child_process')
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'docs/verification/rendering-performance/milestone-2026-10-16')
const arg=(name,fallback)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback
const definitions=[
  {id:'campus-day-full',view:'campus',time:'2026-09-08T11:00:00+08:00'},
  {id:'campus-day-no-clouds',view:'campus',time:'2026-09-08T11:00:00+08:00',clouds:false},
  {id:'campus-day-no-environment',view:'campus',time:'2026-09-08T11:00:00+08:00',environment:false},
  {id:'horizon-day-full',view:'horizon',time:'2026-09-08T11:00:00+08:00'},
  {id:'horizon-day-no-clouds',view:'horizon',time:'2026-09-08T11:00:00+08:00',clouds:false},
  {id:'horizon-sunset-full',view:'horizon',time:'2026-09-08T17:45:00+08:00'},
  {id:'campus-full-moon',view:'campus',time:'2026-09-26T23:00:00+08:00'},
  {id:'horizon-full-moon',view:'horizon',time:'2026-09-26T23:00:00+08:00'},
  {id:'horizon-moonless',view:'horizon',time:'2026-09-10T23:00:00+08:00'},
  {id:'campus-day-pan',view:'campus',time:'2026-09-08T11:00:00+08:00',pan:true},
  {id:'horizon-day-4k',view:'horizon',time:'2026-09-08T11:00:00+08:00',width:3840,height:2160},
  {id:'campus-day-clock',view:'campus',time:'2026-09-08T11:00:00+08:00',clockStep:1/60}
]

async function main(){
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'C:/Users/Administrator/node_modules/playwright')
  const frames=Number(arg('frames',360)),repeat=Number(arg('repeat',3)),warmup=Number(arg('warmup',90)),port=Number(arg('port',8977))
  const selected=arg('cases','all').split(','),cases=selected.includes('all')?definitions:definitions.filter(c=>selected.includes(c.id))
  if(!cases.length||![frames,repeat,warmup,port].every(Number.isFinite)||frames<1||repeat<1)throw new Error('Invalid measurement arguments')
  fs.mkdirSync(directory,{recursive:true})
  const sdk=fs.readFileSync(path.join(root,'build/0.1.0/CCR.min.js')),sdkSha256=crypto.createHash('sha256').update(sdk).digest('hex')
  const harnessSha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const server=spawn(process.execPath,[path.join(root,'scripts/dev-server.cjs'),'--port',String(port)],{stdio:'ignore'})
  const url=`http://127.0.0.1:${port}/examples/campus.html?traffic=none&imagery=none&singleFrustum=1&glbAssets=http://localhost:8083/Dongda/DongdaModel_PBR/SM_NH/&assets=http://localhost:8083/Dongda`
  const report={schema:'ccr-environment-milestone-1',createdAt:new Date().toISOString(),sdkSha256,harnessSha256,sdkBytes:sdk.length,
    url,protocol:{frames,repeat,warmup,width:1920,height:1080,dpr:1,minimumQueryAvailability:.8,
      gpu:'One elapsed query at a time; rotating frame/environment/actual Graph pass scopes, drain without new rendering.',
      memory:'Deduplicated CCR resident textures; includes pool/history/LUT, excludes native MSAA, assets and driver. Engine asset bytes listed separately.',
      animation:'Frozen simulation clock and cloud wind except explicit clockStep case; cloud jitter/history still execute. Pan is a deterministic heading sweep, not real input latency.'},runs:[]}
  let browser,page
  let pageErrors=[],failedRequests=[]
  const boardSamples=[];let pollingBoard=false,currentCase=null
  const pollBoard=()=>{
    if(pollingBoard)return
    pollingBoard=true
    execFile('nvidia-smi',['--query-gpu=memory.used,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000},(error,stdout)=>{
      pollingBoard=false
      if(!error){const [memoryUsedMiB,utilizationPercent,temperatureC]=stdout.trim().split(',').map(Number)
        boardSamples.push({time:new Date().toISOString(),caseId:currentCase,memoryUsedMiB,utilizationPercent,temperatureC})}
    })
  }
  const boardInterval=setInterval(pollBoard,1000);pollBoard()
  try{
    await new Promise(r=>setTimeout(r,1500))
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
    for(const definition of cases)for(let round=1;round<=repeat;round++){
      currentCase=definition.id
      const file=path.join(directory,`${definition.id}-r${round}.json`)
      if(arg('resume','0')==='1'&&fs.existsSync(file)){
        const saved=JSON.parse(fs.readFileSync(file));if(saved.sdkSha256!==sdkSha256||saved.harnessSha256!==harnessSha256||saved.measurement.cpuMs.length!==frames)throw new Error('Resume protocol mismatch')
        report.runs.push(saved);continue
      }
      pageErrors=[];failedRequests=[]
      const loadStart=Date.now()
      if(!page){
        page=await browser.newPage({viewport:{width:definition.width||1920,height:definition.height||1080},deviceScaleFactor:1})
        await page.route('**/build/0.1.0/CCR.min.js',route=>route.fulfill({body:sdk,contentType:'application/javascript'}))
        page.on('pageerror',e=>pageErrors.push(e.message));page.on('requestfailed',request=>failedRequests.push({url:request.url(),reason:request.failure()?.errorText}))
        page.on('console',message=>{if(message.text().startsWith('MILESTONE_WARMUP '))console.log(message.text())})
        await page.goto(url,{waitUntil:'domcontentloaded'})
        await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid,null,{timeout:180000})
        await page.waitForFunction(()=>campus.models.length===campus.expectedModels&&campus.models.every(model=>model.ready),null,{timeout:120000})
      }
      await page.setViewportSize({width:definition.width||1920,height:definition.height||1080})
      const result=await page.evaluate(async({definition,frames,warmup,round})=>{
        const C=Cesium,{viewer,pipeline}=campus,scene=viewer.scene,gl=scene.context._gl
        const {default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js')
        viewer.resize()
        viewer.clock.shouldAnimate=false;viewer.useDefaultRenderLoop=false
        viewer.clock.currentTime=C.JulianDate.fromIso8601(definition.time)
        document.getElementById('hud')?.style.setProperty('display','none')
        document.querySelectorAll('.lil-gui').forEach(e=>e.style.setProperty('display','none'))
        if(campus.stats?.dom)campus.stats.dom.style.setProperty('display','none')
        pipeline.setOptions({environment:definition.environment!==false,clouds:definition.clouds!==false,environmentAnimation:true})
        pipeline.environmentRenderer.update()
        const camera=viewer.camera,pose=definition.view==='campus'?{height:700,pitch:-35,heading:0}:{height:12000,pitch:-8,
          heading:Math.atan2(pipeline.environmentRenderer.sunLocal.x,pipeline.environmentRenderer.sunLocal.y)*180/Math.PI}
        if(definition.view==='campus'){
          camera.lookAt(campus.cameraCenter,new C.HeadingPitchRange(0,C.Math.toRadians(pose.pitch),1600))
          camera.lookAtTransform(C.Matrix4.IDENTITY)
        }else{
          const center=C.Cartographic.fromCartesian(campus.cameraCenter)
          camera.setView({destination:C.Cartesian3.fromRadians(center.longitude,center.latitude,pose.height),orientation:{heading:C.Math.toRadians(pose.heading),pitch:C.Math.toRadians(pose.pitch),roll:0}})
        }
        camera.frustum.near=definition.view==='campus'?100:1000;camera.frustum.far=1000000
        const raf=()=>new Promise(requestAnimationFrame)
        const ready=()=>campus.assetsReady()&&campus.contextTiles.length===1&&campus.contextTiles.every(tile=>tile.tilesLoaded)
          &&campus.trees?.getDiagnostics?.().state==='ready'&&campus.water?.getDiagnostics?.().state==='ready'
        const waitStart=performance.now();let stable=0,warmupFrames=0
        while(warmupFrames<warmup||stable<30){
          await raf();viewer.render();warmupFrames++
          stable=ready()?stable+1:0
          if(warmupFrames%120===0)console.log('MILESTONE_WARMUP '+JSON.stringify({case:definition.id,stable,models:campus.models.length,
            tiles:campus.tiles.map(t=>({loaded:t.tilesLoaded,memory:t.totalMemoryUsageInBytes})),context:campus.contextTiles.map(t=>({loaded:t.tilesLoaded,memory:t.totalMemoryUsageInBytes})),
            trees:campus.trees?.getDiagnostics?.().state,water:campus.water?.getDiagnostics?.().state,position:[camera.positionWC.x,camera.positionWC.y,camera.positionWC.z]}))
          if(performance.now()-waitStart>90000)throw new Error('Warmup readiness timed out: '+JSON.stringify({models:campus.models.length,
            tiles:campus.tiles.map(t=>t.tilesLoaded),context:campus.contextTiles.map(t=>t.tilesLoaded),trees:campus.trees?.getDiagnostics?.(),water:campus.water?.getDiagnostics?.()}))
        }
        const debug=gl.getExtension('WEBGL_debug_renderer_info')
        const culling=camera.frustum.computeCullingVolume(camera.positionWC,camera.directionWC,camera.upWC)
        const visibleModels=campus.models.filter(model=>model.ready&&culling.computeVisibility(model.boundingSphere)!==C.Intersect.OUTSIDE).length
        if(definition.view==='campus'&&visibleModels<20)throw new Error('Campus view misses model cluster: '+JSON.stringify({visibleModels,
          position:[camera.positionWC.x,camera.positionWC.y,camera.positionWC.z],heading:camera.heading,pitch:camera.pitch,
          sampleSphere:campus.models[0]?.boundingSphere,models:campus.models.length}))
        const identity={renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
          vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),version:gl.getParameter(gl.VERSION),
          userAgent:navigator.userAgent,viewport:[viewer.canvas.width,viewer.canvas.height],dpr:devicePixelRatio,cesiumVersion:C.VERSION,
          pose:{...pose,positionWC:[camera.positionWC.x,camera.positionWC.y,camera.positionWC.z],headingRadians:camera.heading,pitchRadians:camera.pitch},clock:C.JulianDate.toIso8601(viewer.clock.currentTime),options:pipeline.getOptions(),assets:{models:campus.models.length,visibleModels,
            tilesets:campus.tiles.length,contextTiles:campus.contextTiles.length,errors:campus.errors.slice(),trees:campus.trees?.getDiagnostics?.(),
            grass:campus.grass?.getDiagnostics?.(),water:campus.water?.getDiagnostics?.()}}
        const assetMemory=()=>{
          let tilesetBytes=0,glbGeometryBytes=0,glbTextureBytes=0
          for(const tile of [...campus.tiles,...campus.contextTiles])tilesetBytes+=tile.totalMemoryUsageInBytes||0
          for(const model of campus.models){const s=model.statistics||{};glbGeometryBytes+=s.geometryByteLength||0;glbTextureBytes+=s.texturesByteLength||0}
          return{tilesetBytes,glbGeometryBytes,glbTextureBytes,scope:'Engine-reported; shared model textures may overlap; not added to tracked pipeline textures as board VRAM.'}
        }
        const coldMemory=assetMemory(),profiler=new Profiler(C,pipeline),timer=profiler.timer
        const environment=definition.environment!==false,clouds=environment&&definition.clouds!==false
        const scopes=['frame','environment','frame','graph:cloud.march','graph:cloud.depth','frame','graph:cloud.temporal',
          'graph:atmosphere.raymarch','graph:atmosphere.transmission','graph:environment.composite','shadow','smaa']
          .filter(label=>environment?clouds||!label.startsWith('graph:cloud.'):!label.startsWith('graph:')&&label!=='environment')
        if(definition.clockStep)scopes.push('graph:atmosphere.skyViewLut')
        profiler.labels=[...scopes]
        // Avoid RenderProfiler automatically extending the rotation to inactive Graph nodes.
        const originalMeasure=profiler._measure
        profiler._measure=function(label,invoke){
          const frame=this.index-1
          // Shift scope placement each cycle to avoid always measuring the same
          // odd/even shadow-update phase (or another periodic render cadence).
          this.selected=scopes[(frame+Math.floor(frame/scopes.length))%scopes.length]
          return originalMeasure.call(this,label,invoke)
        }
        let collecting=true,index=0,disjointPolls=0,contextLosses=0
        const issuedByLabel={},attemptsByLabel={},queryFrames=[],gpuMeasure=timer.measure.bind(timer),gpuPoll=timer.poll.bind(timer)
        timer.measure=function(label,invoke){
          if(!collecting)return invoke()
          attemptsByLabel[label]=(attemptsByLabel[label]||0)+1
          const before=this.pending.length
          const shadowBefore=pipeline.customShadow?.stats?.updates||0
          const value=gpuMeasure(label,invoke)
          if(this.pending.length>before){issuedByLabel[label]=(issuedByLabel[label]||0)+1;queryFrames.push({label,frame:index,shadowUpdates:(pipeline.customShadow?.stats?.updates||0)-shadowBefore})}
          return value
        }
        timer.poll=function(){
          if(this.supported){if(gl.isContextLost())contextLosses++;if(gl.getParameter(this.extension.GPU_DISJOINT_EXT))disjointPolls++}
          return gpuPoll()
        }
        const cpuMs=[],rafMs=[],drawCalls=[],commands=[],hiddenFrames=[],notReadyFrames=[],longTasks=[],resources=[]
        const allocations={},glHooks=[]
        for(const method of ['createTexture','createBuffer','createShader','createProgram','compileShader','linkProgram']){
          const previous=gl[method]
          const hook=function(...args){allocations[method]=(allocations[method]||0)+1;return previous.apply(this,args)}
          gl[method]=hook;glHooks.push({method,previous,hook})
        }
        const longObserver=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(x=>({startTime:x.startTime,duration:x.duration}))))
        try{longObserver.observe({type:'longtask',buffered:false})}catch{}
        const resourceObserver=new PerformanceObserver(list=>resources.push(...list.getEntries().map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize}))))
        resourceObserver.observe({type:'resource',buffered:false})
        let poolWindowPeak=0,heapPeak=0,previous=null
        const originalHeading=camera.heading,initialTime=C.JulianDate.clone(viewer.clock.currentTime)
        const begin=performance.now()
        for(index=0;index<frames;index++){
          const timestamp=await raf()
          if(previous!==null)rafMs.push(timestamp-previous)
          previous=timestamp
          if(definition.pan){const heading=originalHeading+Math.sin(index/frames*Math.PI*2)*.18;camera.setView({orientation:{heading,pitch:C.Math.toRadians(pose.pitch),roll:0}})}
          if(definition.clockStep)viewer.clock.currentTime=C.JulianDate.addSeconds(initialTime,index*definition.clockStep,new C.JulianDate())
          viewer.render()
          const frame=profiler.frames.at(-1)
          cpuMs.push(frame.milliseconds);drawCalls.push(frame.drawCalls);commands.push(frame.submittedCommands)
          if(document.hidden)hiddenFrames.push(index)
          if(!ready())notReadyFrames.push(index)
          const pool=pipeline.getResourcePoolDiagnostics();poolWindowPeak=Math.max(poolWindowPeak,pool.currentBytes)
          heapPeak=Math.max(heapPeak,performance.memory?.usedJSHeapSize||0)
        }
        collecting=false
        for(const {method,previous,hook}of glHooks)if(gl[method]===hook)gl[method]=previous
        const end=performance.now(),drainStart=performance.now()
        while(timer.pending.length&&performance.now()-drainStart<10000){await raf();timer.poll()}
        longTasks.push(...longObserver.takeRecords().map(x=>({startTime:x.startTime,duration:x.duration})))
        resources.push(...resourceObserver.takeRecords().map(x=>({name:x.name,startTime:x.startTime,duration:x.duration,transferSize:x.transferSize})))
        resourceObserver.disconnect();longObserver.disconnect()
        const result=profiler.getReport(),pool=pipeline.getResourcePoolDiagnostics(),endAssets=assetMemory()
        const validity={frames:cpuMs.length,hiddenFrames,notReadyFrames,disjointPolls,contextLosses,assetsReady:campus.assetsReady(),
          nonzeroDraws:drawCalls.every(x=>x>0),environmentValid:!environment||pipeline.environmentRenderer.hdr.getDiagnostics().valid,
          frustumCount:scene._view.frustumCommandsList.length,glError:gl.getError(),gpuSupported:result.gpuSupported}
        const activeEnvironment=pipeline.environmentRenderer.getDiagnostics()
        profiler.destroy()
        return {caseId:definition.id,repeat:round,definition,identity,warmupFrames,warmupMs:begin-waitStart,windowMs:end-begin,
          measurement:{cpuMs,rafMs,drawCalls,commands,longTasks:longTasks.filter(x=>x.startTime>=begin&&x.startTime<=end),resources,
            cpuPasses:result.cpu.filter(x=>x.label!=='frame'),gpu:result.gpu,
            gpuStatus:{supported:result.gpuSupported,pending:result.pending,discarded:result.discarded,skipped:result.skipped,
              issuedByLabel,attemptsByLabel,queryFrames,disjointPolls},counters:{bindTracking:false,allocations}},
          memory:{trackedTextures:result.textures,pool:{...pool,windowPeakBytes:poolWindowPeak},uniformBuffers:result.uniformBuffers,
            assetsBefore:coldMemory,assetsAfter:endAssets,jsHeapPeakBytes:heapPeak||null,actualVramBytes:null,
            graphPhysicalBytes:null,graphPhysicalReason:'Graph allocator shares the RHI pool; separate graph physical byte high-water mark is not exposed.'},
          diagnostics:{environment:activeEnvironment,capabilities:pipeline.getCapabilities?.()||null},validity}
      },{definition,frames,warmup,round})
      result.sdkSha256=sdkSha256;result.harnessSha256=harnessSha256;result.loadMs=Date.now()-loadStart-result.windowMs;result.validity.pageErrors=pageErrors;result.failedRequests=failedRequests
      const gpuStatus=result.measurement.gpuStatus,gpuCounts={}
      for(const sample of result.measurement.gpu)gpuCounts[sample.label]=(gpuCounts[sample.label]||0)+1
      result.validity.queryAvailability=Object.fromEntries(Object.entries(gpuStatus.issuedByLabel).map(([label,count])=>[label,(gpuCounts[label]||0)/count]))
      result.validity.accepted=!pageErrors.length&&!result.validity.glError&&result.validity.nonzeroDraws&&result.validity.environmentValid
        &&!result.validity.hiddenFrames.length&&!result.validity.notReadyFrames.length&&!result.validity.disjointPolls&&!result.validity.contextLosses
        &&gpuStatus.supported&&gpuStatus.pending===0&&gpuCounts.frame>0&&Object.values(result.validity.queryAvailability).every(ratio=>ratio>=.8)
      result.wallClockCompletedAt=new Date().toISOString()
      await page.screenshot({path:path.join(directory,`${definition.id}-r${round}.png`)})
      fs.writeFileSync(file,JSON.stringify(result,null,2));report.runs.push(result)
      report.boardTelemetry={scope:'Whole GPU including desktop and other apps; 1 Hz nvidia-smi samples, not isolated browser VRAM.',samples:boardSamples}
      fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(report,null,2))
      const {summarizeRun}=require('./summarize-milestone.cjs'),summary=summarizeRun(result)
      console.log(JSON.stringify({case:definition.id,repeat:round,cpuP95:summary.cpuMs?.p95,gpuScopes:result.measurement.gpuStatus.issuedByLabel,
        gpuSamples:result.measurement.gpu.length,texturesMiB:result.memory.trackedTextures.peakBytes/1048576,validity:result.validity}))
      if(!result.validity.accepted)
        throw new Error('Invalid run; see '+file)
    }
  }finally{clearInterval(boardInterval);await browser?.close();server.kill()}
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(report,null,2))
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={definitions}
