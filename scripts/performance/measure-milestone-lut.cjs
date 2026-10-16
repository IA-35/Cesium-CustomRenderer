#!/usr/bin/env node
// Diagnostic forced rebuilds of the accepted milestone SDK, not steady-state frame cost.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process')
const {summarize}=require('./summarize-milestone.cjs')
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'docs/verification/rendering-performance/milestone-2026-10-16')
const expectedSdkSha256='cc76afb2828f56600aafc54ac28788ca4fe719d99e59929739d44e5ef475e5ec'
const scopes=['graph:atmosphere.transmittanceLut','graph:atmosphere.multiscatterLut','graph:atmosphere.skyViewLut']
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex')
const arg=(name,fallback)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)??fallback

async function main(){
  const frames=Number(arg('frames',300)),repeat=Number(arg('repeat',3)),warmup=Number(arg('warmup',90)),port=Number(arg('port',8978))
  if(![frames,repeat,warmup,port].every(Number.isInteger)||frames<300||frames%3||repeat<3||warmup<1||port<1||port>65535)
    throw new Error('Require >=300 frames divisible by 3, >=3 repeats, positive warmup and valid port')
  const sdkPath=path.join(root,'build/0.1.0/CCR.min.js'),sdk=fs.readFileSync(sdkPath),sdkSha256=hash(sdk)
  if(sdkSha256!==expectedSdkSha256)throw new Error('SDK changed from the accepted cc76 milestone: '+sdkSha256)
  const sourceFiles=['examples/campus.html','examples/campus.js','examples/campus-glb-manifest.json','src/diagnostics/RenderProfiler143.js',
    'src/diagnostics/GpuTimer.js','src/pipeline/RenderGraph143.js','src/environment/AtmosphereLut143.js','src/environment/EnvironmentGraph143.js']
  const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))
  const url=`http://127.0.0.1:${port}/examples/campus.html?traffic=none&imagery=none&singleFrustum=1&glbAssets=http://localhost:8083/Dongda/DongdaModel_PBR/SM_NH/&assets=http://localhost:8083/Dongda`
  const report={schema:'ccr-milestone-lut-forced-rebuild-1',createdAt:new Date().toISOString(),sdkSha256,sdkBytes:sdk.length,
    harnessSha256:hash(fs.readFileSync(__filename)),source:{sdkPath,gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes},url,
    protocol:{forcedRebuild:true,frames,repeat,warmup,width:1920,height:1080,dpr:1,minimumQueryAvailability:.8,scopes,
      invalidation:"atmosphereLut.keys.medium='' immediately before each measured viewer.render(); no atmosphere physics, exposure or quality options changed",
      scope:'Actual Graph pass callbacks in the pinned UMD SDK; one selected scope per frame, rotating T/M/Sky. Source-loaded profiler only instruments the SDK.',
      scheduling:'At most one pending elapsed query. Between measured renders, RAF polling waits for it; final drain polls RAF without rendering or new queries.',
      interpretation:'Forced rebuild diagnostic, not steady state or usual per-frame LUT cost. Different scope medians must not be summed into a total.',
      cpu:'CPU scene.render submission and RAF intervals include diagnostic overhead; RAF includes query completion pacing.'},runs:[]}
  fs.mkdirSync(directory,{recursive:true})
  const output=path.join(directory,'lut-updates.json'),save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  const server=spawn(process.execPath,[path.join(root,'scripts/dev-server.cjs'),'--port',String(port)],{stdio:'ignore',windowsHide:true})
  let browser,serverError
  server.on('error',error=>{serverError=error})
  server.on('exit',code=>{serverError=new Error('Diagnostic server exited: '+code)})
  try{
    for(let attempt=0;attempt<40;attempt++){
      if(serverError)throw serverError
      try{const response=await fetch(`http://127.0.0.1:${port}/examples/campus.html`);if(response.ok)break}catch{}
      if(attempt===39)throw new Error('Diagnostic server did not become ready')
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'C:/Users/Administrator/node_modules/playwright')
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
    for(let round=1;round<=repeat;round++){
      const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1}),pageErrors=[],failedRequests=[]
      page.on('pageerror',error=>pageErrors.push(error.message))
      page.on('requestfailed',request=>failedRequests.push({url:request.url(),reason:request.failure()?.errorText}))
      await page.route('**/build/0.1.0/CCR.min.js',route=>route.fulfill({body:sdk,contentType:'application/javascript'}))
      await page.goto(url,{waitUntil:'domcontentloaded'})
      await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid&&campus.assetsReady(),null,{timeout:180000})
      const run=await page.evaluate(async({frames,warmup,round,scopes})=>{
        const C=Cesium,{viewer,pipeline}=campus,scene=viewer.scene,gl=scene.context._gl,e=pipeline.environmentRenderer,lut=e.atmosphereLut
        const {default:Profiler}=await import('/src/diagnostics/RenderProfiler143.js')
        viewer.useDefaultRenderLoop=false;viewer.clock.shouldAnimate=false
        viewer.clock.currentTime=C.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
        document.querySelectorAll('#hud,.lil-gui').forEach(element=>element.style.setProperty('display','none'))
        campus.stats?.dom?.style.setProperty('display','none')
        viewer.camera.lookAt(campus.cameraCenter,new C.HeadingPitchRange(0,C.Math.toRadians(-35),1600))
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);viewer.camera.frustum.near=100;viewer.camera.frustum.far=1000000
        const raf=()=>new Promise(requestAnimationFrame)
        const ready=()=>campus.assetsReady()&&campus.contextTiles.length===1&&campus.contextTiles.every(tile=>tile.tilesLoaded)
          &&campus.trees?.getDiagnostics?.().state==='ready'&&campus.water?.getDiagnostics?.().state==='ready'&&lut.ready
        const warmupStart=performance.now();let warmupFrames=0,stable=0
        while(warmupFrames<warmup||stable<30){
          await raf();viewer.render();warmupFrames++;stable=ready()?stable+1:0
          if(performance.now()-warmupStart>120000)throw new Error('LUT warmup assets/readiness timed out')
        }
        const debug=gl.getExtension('WEBGL_debug_renderer_info'),camera=viewer.camera
        const culling=camera.frustum.computeCullingVolume(camera.positionWC,camera.directionWC,camera.upWC)
        const visibleModels=campus.models.filter(model=>model.ready&&culling.computeVisibility(model.boundingSphere)!==C.Intersect.OUTSIDE).length
        if(campus.models.length!==70||visibleModels<20)throw new Error('LUT benchmark did not load the fixed 70-GLB scene')
        const identity={renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
          vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),version:gl.getParameter(gl.VERSION),
          cesiumVersion:C.VERSION,userAgent:navigator.userAgent,viewport:[viewer.canvas.width,viewer.canvas.height],dpr:devicePixelRatio,
          clock:C.JulianDate.toIso8601(viewer.clock.currentTime),pose:{positionWC:[camera.positionWC.x,camera.positionWC.y,camera.positionWC.z],heading:camera.heading,pitch:camera.pitch},
          options:pipeline.getOptions(),assets:{models:campus.models.length,expectedModels:campus.expectedModels,visibleModels,tiles:campus.tiles.length,contextTiles:campus.contextTiles.length,errors:campus.errors.slice()}}
        const initialState=JSON.stringify(lut.committed),initialOptions=JSON.stringify(pipeline.getOptions()),before=lut.getDiagnostics()
        const profiler=new Profiler(C,pipeline),timer=profiler.timer,originalMeasure=profiler._measure
        profiler.labels=[...scopes]
        let index=0,collecting=true,disjointPolls=0,contextLosses=0,maxPending=0
        const attemptsByLabel={},issuedByLabel={},queryFrames=[],graphExecutions=Object.fromEntries(scopes.map(label=>[label,0]))
        profiler._measure=function(label,invoke){
          this.selected=scopes[index%scopes.length]
          if(collecting&&Object.hasOwn(graphExecutions,label))graphExecutions[label]++
          return originalMeasure.call(this,label,invoke)
        }
        const measure=timer.measure.bind(timer),poll=timer.poll.bind(timer)
        timer.measure=function(label,invoke){
          if(!collecting)return invoke()
          attemptsByLabel[label]=(attemptsByLabel[label]||0)+1
          if(this.pending.length)throw new Error('Elapsed query overlap/pending query before new measurement')
          const value=measure(label,invoke)
          maxPending=Math.max(maxPending,this.pending.length)
          if(this.pending.length){issuedByLabel[label]=(issuedByLabel[label]||0)+1;queryFrames.push({label,frame:index})}
          return value
        }
        timer.poll=function(){
          if(this.supported){if(gl.isContextLost())contextLosses++;if(gl.getParameter(this.extension.GPU_DISJOINT_EXT))disjointPolls++}
          return poll()
        }
        const drain=async()=>{
          const start=performance.now();let polls=0
          while(timer.pending.length&&performance.now()-start<10000){await raf();timer.poll();polls++}
          return {milliseconds:performance.now()-start,polls,pending:timer.pending.length}
        }
        const cpuMs=[],renderCallMs=[],rafMs=[],drawCalls=[],commands=[],hiddenFrames=[],notReadyFrames=[],stateChangedFrames=[],queryWaits=[]
        let previous=null;const begin=performance.now()
        try{
          for(index=0;index<frames;index++){
            if(timer.pending.length){const wait=await drain();queryWaits.push({beforeFrame:index,...wait});if(wait.pending)throw new Error('GPU query timed out between renders')}
            const timestamp=await raf();if(previous!==null)rafMs.push(timestamp-previous);previous=timestamp
            lut.keys.medium=''
            const renderStart=performance.now();viewer.render();renderCallMs.push(performance.now()-renderStart)
            const frame=profiler.frames.at(-1);cpuMs.push(frame.milliseconds);drawCalls.push(frame.drawCalls);commands.push(frame.submittedCommands)
            if(document.hidden)hiddenFrames.push(index)
            if(!ready())notReadyFrames.push(index)
            if(JSON.stringify(lut.committed)!==initialState||JSON.stringify(pipeline.getOptions())!==initialOptions)stateChangedFrames.push(index)
          }
          collecting=false
          const end=performance.now(),finalDrain=await drain(),result=profiler.getReport(),after=lut.getDiagnostics()
          const updateDeltas=Object.fromEntries(Object.keys(before.stats).map(key=>[key,after.stats[key]-before.stats[key]]))
          return {caseId:'lut-forced-rebuild',forcedRebuild:true,repeat:round,identity,warmupFrames,warmupMs:begin-warmupStart,windowMs:end-begin,
            measurement:{cpuMs,renderCallMs,rafMs,drawCalls,commands,cpuPasses:result.cpu,gpu:result.gpu,
              gpuStatus:{supported:result.gpuSupported,pending:result.pending,discarded:result.discarded,skipped:result.skipped,
                attemptsByLabel,issuedByLabel,queryFrames,disjointPolls,maxPending,queryWaits,finalDrain}},
            diagnostics:{before,after,updateDeltas,graphExecutions,capabilities:pipeline.getCapabilities?.()||null},
            validity:{frames:cpuMs.length,hiddenFrames,notReadyFrames,stateChangedFrames,disjointPolls,contextLosses,assetsReady:campus.assetsReady(),
              nonzeroDraws:drawCalls.every(value=>value>0),environmentValid:e.hdr.getDiagnostics().valid,lutReady:lut.ready,
              frustumCount:scene._view.frustumCommandsList.length,glError:gl.getError(),errors:campus.errors.slice()}}
        }finally{collecting=false;profiler.destroy()}
      },{frames,warmup,round,scopes})
      run.sdkSha256=sdkSha256;run.harnessSha256=report.harnessSha256;run.pageErrors=pageErrors;run.failedRequests=failedRequests
      const status=run.measurement.gpuStatus,v=run.validity
      const gpuByLabel=Object.fromEntries(scopes.map(label=>{
        const stats=summarize(run.measurement.gpu.filter(sample=>sample.label===label).map(sample=>sample.milliseconds)),issued=status.issuedByLabel[label]||0
        return [label,{...stats,queryAvailability:{valid:stats.n,issued,ratio:issued?stats.n/issued:0}}]
      }))
      run.summary={cpuMs:summarize(run.measurement.cpuMs),renderCallMs:summarize(run.measurement.renderCallMs),rafMs:summarize(run.measurement.rafMs),gpuByLabel}
      v.queryAvailability=Object.fromEntries(scopes.map(label=>[label,gpuByLabel[label].queryAvailability.ratio]))
      v.accepted=!pageErrors.length&&!v.errors.length&&!v.glError&&v.nonzeroDraws&&v.environmentValid&&v.lutReady&&v.assetsReady&&v.frustumCount===1
        &&!v.hiddenFrames.length&&!v.notReadyFrames.length&&!v.stateChangedFrames.length&&!v.disjointPolls&&!v.contextLosses
        &&status.supported&&status.pending===0&&status.discarded===0&&status.skipped===0&&status.maxPending===1
        &&scopes.every(label=>status.issuedByLabel[label]===frames/3&&v.queryAvailability[label]>=.8&&run.diagnostics.graphExecutions[label]===frames)
        &&['transmittance','multipleScattering','skyView','updates'].every(key=>run.diagnostics.updateDeltas[key]===frames)
        &&run.diagnostics.updateDeltas.failures===0
      run.wallClockCompletedAt=new Date().toISOString();report.runs.push(run);save()
      console.log(JSON.stringify({repeat:round,accepted:v.accepted,gpuByLabel,updateDeltas:run.diagnostics.updateDeltas}))
      await page.close()
      if(!v.accepted)throw new Error('Invalid forced-rebuild LUT run; see '+output)
    }
    report.completedAt=new Date().toISOString();report.sdkUnchanged=hash(fs.readFileSync(sdkPath))===sdkSha256
    report.accepted=report.sdkUnchanged&&report.runs.length===repeat&&report.runs.every(run=>run.validity.accepted)
    save()
    if(!report.accepted)throw new Error('SDK changed during LUT benchmark')
  }catch(error){report.error=error.stack||error.message;save();throw error}
  finally{await browser?.close();server.kill()}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
