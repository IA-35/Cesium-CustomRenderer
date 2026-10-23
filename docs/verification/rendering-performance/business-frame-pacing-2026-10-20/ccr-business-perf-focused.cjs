const fs=require('fs'),path=require('path'),os=require('os'),{chromium}=require('C:/Users/Administrator/node_modules/playwright')
const out=path.join(os.tmpdir(),'ccr-business-perf-20261020-focused');fs.mkdirSync(out,{recursive:true})
const timerSource=fs.readFileSync('src/diagnostics/GpuTimer.js','utf8').replace('export default class','return class')
async function main(){const browser=await chromium.connectOverCDP('http://127.0.0.1:62386');let page
try{
 page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:81/'));if(!page)throw Error('Business page unavailable')
 await page.exposeFunction('__ccrPerfProgress',v=>console.log(JSON.stringify(v)))
 const report=await page.evaluate(async timerSource=>{
  const v=__getViewer(),p=CCR.getVisualPipeline(v),s=v.scene,C=Cesium,gl=s.context._gl
  if(!p||p.destroyed)throw Error('No current live pipeline')
  const original={...p.getOptions()},originalScale=v.resolutionScale,trees=[],models=[],textures=new Map(),treeMemory=[]
  function walk(o){if(o.isDestroyed?.())return;if(o instanceof C.Model){const st=o.statistics;models.push({name:o.name||o.id?.file||'model',geometry:st.geometryByteLength,textures:st.texturesByteLength});for(const id of st.getTextureIds())textures.set(id,st.getTextureByteLengthById(id))}if(o._externalLodGroups){trees.push(o);const r=o._resources;treeMemory.push({draws:o._submittedRecords?.length,bufferBytes:(r?.meshGpuMemoryBytes||0)+(r?.instanceGpuMemoryBytes||0),groups:o._externalLodGroups.size})}for(const child of o._primitives||[])walk(child)}walk(s.primitives)
  const originalTreeShow=trees.map(t=>t.show),Timer=new Function(timerSource)(),timer=new Timer(gl),restores=[],samples=[],longTasks=[]
  let row=null,recording=false,selected='',queryStart=0,draws=0,moving=false
  const camera={position:C.Cartesian3.clone(s.camera.positionWC),direction:C.Cartesian3.clone(s.camera.directionWC),up:C.Cartesian3.clone(s.camera.upWC)}
  const observer=typeof PerformanceObserver==='function'?new PerformanceObserver(list=>{for(const e of list.getEntries())if(recording)longTasks.push({time:e.startTime,duration:e.duration})}):null
  observer?.observe({type:'longtask',buffered:false})
  const wrap=(owner,key,label,gpu=true)=>{if(!owner||typeof owner[key]!=='function')return;const old=owner[key];const hook=function(...args){if(!recording||!row)return old.apply(this,args);const start=performance.now();try{return selected===label&&gpu?timer.measure(`${label}:${row.index}`,()=>old.apply(this,args)):old.apply(this,args)}finally{row.cpu[label]=(row.cpu[label]||0)+performance.now()-start}};owner[key]=hook;restores.push(()=>{if(owner[key]===hook)owner[key]=old})}
  wrap(p.customShadow,'render','shadow');wrap(p.environmentRenderer?.hdr,'_execute','environment');wrap(p.smaa,'_execute','aa');wrap(p.taa,'_execute','aa');wrap(s,'updateAndExecuteCommands','submit',false);wrap(s,'resolveFramebuffers','resolve',false)
  const oldRender=s.render
  const render=function(...args){if(!recording)return oldRender.apply(this,args);timer.poll();const now=performance.now();if(row)row.interval=now-row.start;row={index:samples.length,start:now,cpu:{},shadowUpdate:0};selected=['frame','shadow','environment','aa'][samples.length%4];draws=0;const updates=p.customShadow?.levels.reduce((n,l)=>n+l.updates,0)||0,start=performance.now();if(moving)s.camera.lookRight(samples.length<150?.0005:-.0005);try{return selected==='frame'?timer.measure(`frame:${row.index}`,()=>oldRender.apply(this,args)):oldRender.apply(this,args)}finally{row.cpu.frame=performance.now()-start;row.draws=draws;row.commands=s.frameState.commandList.length;row.shadowUpdate=(p.customShadow?.levels.reduce((n,l)=>n+l.updates,0)||0)-updates;row.heap=performance.memory?.usedJSHeapSize;row.casters=p.customShadow?.stats.casters||0;samples.push(row)}}
  s.render=render;restores.push(()=>{if(s.render===render)s.render=oldRender})
  const off=null
  for(const key of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){const old=gl[key];if(!old)continue;const hook=function(...args){if(recording)draws++;return old.apply(this,args)};gl[key]=hook;restores.push(()=>{if(gl[key]===hook)gl[key]=old})}
  const waitFrames=n=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{remove();reject(Error('Frame timeout'))},60000);const remove=s.postRender.addEventListener(()=>{if(--n===0){remove();clearTimeout(timeout);resolve()}})})
  const stats=arr=>{const a=arr.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,mean:a.reduce((s,x)=>s+x,0)/(a.length||1),p50:a[Math.floor(a.length*.5)]||0,p95:a[Math.floor(a.length*.95)]||0,p99:a[Math.floor(a.length*.99)]||0,max:a.at(-1)||0}}
  const cases=[['baseline',{}],['shadow-static',{shadowStatic:true}],['no-shadow',{shadows:false}],['baseline-moving',{}],['shadow-static-moving',{shadowStatic:true}],['baseline-repeat',{}]]
  const results=[];let lastApplied={}
  try{
   for(const [label,options] of cases){
    if(p.destroyed||CCR.getVisualPipeline(__getViewer())!==p)throw Error('Scene switched during sampling')
    const settings={shadows:original.shadows,shadowStatic:original.shadowStatic,shadowSize:original.shadowSize,shadowDistance:original.shadowDistance,shadowUpdateInterval:original.shadowUpdateInterval,clouds:original.clouds,...options}
    if(Object.keys(settings).some(k=>p.getOptions()[k]!==settings[k]))p.setOptions(settings);lastApplied=settings;moving=label.endsWith('-moving');s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}})
    await waitFrames(120);samples.length=0;row=null;queryStart=timer.samples.length;const cpuStart=performance.now();recording=true
    await waitFrames(300);recording=false;await waitFrames(4);timer.poll();for(let i=0;timer.pending.length&&i<30;i++){await waitFrames(1);timer.poll()}
    const queries=timer.samples.slice(queryStart),gpu={};for(const scope of ['frame','shadow','environment','aa'])gpu[scope]=stats(queries.filter(q=>q.label.startsWith(scope+':')).map(q=>q.milliseconds))
    const intervals=samples.slice(0,-1).map(f=>f.interval),heavy=samples.filter(f=>f.shadowUpdate>0),light=samples.filter(f=>!f.shadowUpdate)
    const result={label,settings,resolution:[s.drawingBufferWidth,s.drawingBufferHeight],elapsed:performance.now()-cpuStart,frames:samples.map(f=>({...f,cpu:{...f.cpu}})),gpu,queries,summary:{interval:stats(intervals),cpu:stats(samples.map(f=>f.cpu.frame)),shadowCpu:stats(samples.map(f=>f.cpu.shadow||0)),environmentCpu:stats(samples.map(f=>f.cpu.environment||0)),draws:stats(samples.map(f=>f.draws)),heavy:{count:heavy.length,cpu:stats(heavy.map(f=>f.cpu.frame)),interval:stats(heavy.map(f=>f.interval))},light:{count:light.length,cpu:stats(light.map(f=>f.cpu.frame)),interval:stats(light.map(f=>f.interval))}},pending:timer.pending.length,discarded:timer.discarded}
    if(!result.summary.draws.mean||result.pending||result.discarded)throw Error('Incomplete measurement')
    results.push(result);await __ccrPerfProgress({label,interval:result.summary.interval,cpu:result.summary.cpu,gpu:result.gpu,draws:result.summary.draws,heavy:result.summary.heavy.count})
   }
  }finally{
   recording=false;off?.();restores.reverse().forEach(fn=>fn());observer?.disconnect();timer.destroy()
   if(!p.destroyed){const restore={};for(const k of Object.keys(lastApplied))if(p.getOptions()[k]===lastApplied[k])restore[k]=original[k];p.setOptions(restore);s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}});s.requestRender()}
  }
  return {url:location.href,original,originalScale,treeMemory,models:models.sort((a,b)=>b.textures-a.textures),deduplicatedModelTextureBytes:[...textures.values()].reduce((a,b)=>a+b,0),uniqueTextures:textures.size,results,longTasks,restored:p.getOptions(),gpuSupported:timer.supported,contextLost:gl.isContextLost()}
 },timerSource)
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,restored:report.restored.shadowSize,gpuSupported:report.gpuSupported}))
}finally{try{await page?.removeExposedFunction('__ccrPerfProgress')}catch{}await browser.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})

