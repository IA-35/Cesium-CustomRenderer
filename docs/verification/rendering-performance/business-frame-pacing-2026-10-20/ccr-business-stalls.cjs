const fs=require('fs'),path=require('path'),os=require('os'),{chromium}=require('C:/Users/Administrator/node_modules/playwright')
const out=path.join(os.tmpdir(),'ccr-business-perf-20261020-focused')
async function main(){const b=await chromium.connectOverCDP('http://127.0.0.1:62386');let page,client
try{
 page=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:81/'));client=await page.context().newCDPSession(page)
 await page.evaluate(()=>{
  const v=__getViewer(),s=v.scene,C=Cesium,gl=s.context._gl,p=CCR.getVisualPipeline(v),events=[],restores=[],frames=[]
  let active=true,index=0
  const camera={position:C.Cartesian3.clone(s.camera.positionWC),direction:C.Cartesian3.clone(s.camera.directionWC),up:C.Cartesian3.clone(s.camera.upWC)}
  const wrap=(o,k,label)=>{const old=o[k];if(typeof old!=='function')return;const hook=function(...args){const t=performance.now();try{return old.apply(this,args)}finally{const ms=performance.now()-t;if(active&&ms>3)events.push({label,ms,index,time:t,name:this.name||this.id?.file,stack:new Error().stack.split('\n').slice(2,7).join('\n')})}};o[k]=hook;restores.push(()=>{if(o[k]===hook)o[k]=old})}
  for(const k of ['compileShader','linkProgram','getProgramParameter','getShaderParameter','getActiveUniform','getUniformLocation','getParameter','bufferData','bufferSubData','texImage2D','texSubImage2D','compressedTexImage2D','drawElements','drawElementsInstanced','drawArrays','drawArraysInstanced','readPixels','finish','flush'])wrap(gl,k,k)
  wrap(C.Model.prototype,'update','Model.update');wrap(C.Cesium3DTileset.prototype,'updateForPass','Tileset.updateForPass');wrap(C.ShaderProgram.prototype,'_bind','ShaderProgram.bind')
  const old=s.render,render=function(...args){if(index<420)s.camera.lookLeft(index<210?.0005:-.0005);const t=performance.now();try{return old.apply(this,args)}finally{frames.push({index,cpu:performance.now()-t});index++}};s.render=render
  globalThis.__ccrStalls={events,frames,stop(){active=false;if(s.render===render)s.render=old;restores.reverse().forEach(fn=>fn());s.camera.setView({destination:camera.position,orientation:{direction:camera.direction,up:camera.up}})}}
 })
 await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:1000});await client.send('Profiler.start')
 await page.waitForFunction(()=>__ccrStalls.frames.length>=420,null,{timeout:60000})
 const {profile}=await client.send('Profiler.stop');const result=await page.evaluate(()=>{const r=__ccrStalls;r.stop();delete globalThis.__ccrStalls;return {events:r.events,frames:r.frames}})
 const nodes=new Map(profile.nodes.map(n=>[n.id,{name:n.callFrame.functionName,file:n.callFrame.url.split('/').at(-1),line:n.callFrame.lineNumber,col:n.callFrame.columnNumber,selfUs:0}]))
 for(let i=0;i<profile.samples.length;i++)nodes.get(profile.samples[i]).selfUs+=profile.timeDeltas[i]||0
 result.top=[...nodes.values()].sort((a,b)=>b.selfUs-a.selfUs).slice(0,30)
 fs.writeFileSync(path.join(out,'stalls.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(out,'cpu.cpuprofile'),JSON.stringify(profile))
 console.log(JSON.stringify({worst:result.frames.sort((a,b)=>b.cpu-a.cpu).slice(0,4),events:result.events.sort((a,b)=>b.ms-a.ms).slice(0,8),top:result.top.slice(0,12)}))
}finally{try{await page?.evaluate(()=>{globalThis.__ccrStalls?.stop();delete globalThis.__ccrStalls});await client?.send('Profiler.disable');await client?.detach()}catch{}await b.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})
