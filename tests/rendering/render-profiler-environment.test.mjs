import test from 'node:test'
import assert from 'node:assert/strict'
import RenderProfiler143 from '../../src/diagnostics/RenderProfiler143.js'

const texture=()=>({width:4,height:2,sizeInBytes:128,isDestroyed:()=>false})
const stage=value=>({outputTexture:value,isDestroyed:()=>false})

test('source diagnostics count the SDK-owned RHI pool without relying on a shared module registry',()=>{
  const physical=texture(),profiler=Object.create(RenderProfiler143.prototype)
  profiler.scene={context:{}};profiler.peakTextureBytes=0
  profiler.pipeline={rhi:{pool:{entries:[{id:42,texture:physical}]}},environmentRenderer:{
    stages:{raymarchStage:stage(physical)}}}
  const report=profiler._textures()
  assert.equal(report.entries.length,1)
  assert.equal(report.entries[0].name,'pool.42')
  assert.equal(report.currentBytes,128)
})

test('profiler counts all environment stages, both cloud histories and LUT publication/staging once',()=>{
  const cloud=texture(),depth=texture(),ray=texture(),transmission=texture(),resolve=texture(),medium=texture()
  const history=Array.from({length:2},()=>({color:texture(),depth:texture()}))
  const targets=Array.from({length:2},()=>Object.fromEntries(['transmittance','multiScatter','skyView'].map(name=>[name,{texture:texture()}])))
  const profiler=Object.create(RenderProfiler143.prototype)
  profiler.scene={context:{}};profiler.peakTextureBytes=0
  profiler.pipeline={environmentRenderer:{noise:texture(),stages:{cloudStage:stage(cloud),cloudDepthStage:stage(depth),raymarchStage:stage(ray),
    transmissionStage:stage(transmission),resolveStage:stage(resolve),occlusionStage:stage(medium)},
    atmosphereLut:{targets,published:{transmittance:targets[0].transmittance.texture}},hdr:{cloudOutput:history[0].color,cloudTemporal:{targets:history}}}}
  const report=profiler._textures()
  assert.equal(report.entries.length,17)
  assert.equal(report.currentBytes,17*128)
  assert.equal(new Set(report.entries.map(entry=>entry.name)).size,17)
  assert.ok(report.entries.some(entry=>entry.name==='environment.cloudStage'))
  assert.ok(report.entries.some(entry=>entry.name==='environment.transmissionStage'))
  assert.ok(report.entries.some(entry=>entry.name==='environment.occlusionStage'))
  assert.ok(report.entries.some(entry=>entry.name==='environment.lut.1.skyView'))
  targets[1].skyView.texture.isDestroyed=()=>true
  assert.equal(profiler._textures().currentBytes,16*128)
  assert.equal(profiler.peakTextureBytes,17*128)
})

test('Graph GPU timing alternates with frame timing instead of nesting queries every pass',()=>{
  const measured=[],graph={passes:[{name:'cloud.march'}],setGpuTimer(timer){this.gpuTimer=timer}}
  const scene={context:{_gl:{getExtension:()=>null},draw(){}},frameState:{commandList:[]},render(){graph.gpuTimer.measure('graph:cloud.march',()=>{})}}
  const profiler=new RenderProfiler143({VERSION:'1.143.0'},{viewer:{scene},renderGraph:graph})
  profiler.timer.measure=(label,invoke)=>{measured.push(label);return invoke()}
  scene.render();scene.render()
  assert.deepEqual(measured,['frame','graph:cloud.march'])
  assert.equal(profiler.frames.length,2)
  profiler.destroy()
  assert.equal(graph.gpuTimer,null)
})
