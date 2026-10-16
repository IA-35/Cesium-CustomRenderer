import test from 'node:test'
import assert from 'node:assert/strict'
import EnvironmentGraph143 from '../../src/environment/EnvironmentGraph143.js'

test('HDR and medium outputs remain readable for native and B09 consumers until frame end',()=>{
  const leases=[]
  const graph=new RenderGraph143({transientAllocator:{acquire(){const lease={valid:true,
    texture:{},release(){this.valid=false}};leases.push(lease);return lease},release(lease){lease.release()}}})
  const adapter=new EnvironmentGraph143({}, {drawingBufferWidth:16,drawingBufferHeight:8})
  adapter.declareGraph(graph);graph.beginFrame()
  const color=graph.leaseOf(adapter.resources.get('environment.composite'))
  const medium=graph.leaseOf(adapter.resources.get('environment.medium'))
  adapter.run('environment.composite',()=>{})
  adapter.run('environment.medium',()=>{})
  assert.equal(color.valid,true)
  assert.equal(medium.valid,true)
  graph.endFrame()
  assert.equal(color.valid,false)
  assert.equal(medium.valid,false)
  adapter.destroy()
})
import RenderGraph143 from '../../src/pipeline/RenderGraph143.js'

test('environment callbacks submit once through the shared Graph and retain explicit dependencies', () => {
  const adapter = new EnvironmentGraph143({}, {drawingBufferWidth:16,drawingBufferHeight:8})
  const graph = new RenderGraph143()
  adapter.declareGraph(graph)
  graph.beginFrame()
  let submissions=0
  assert.equal(adapter.run('cloud.temporal',()=>++submissions),1)
  assert.equal(adapter.run('cloud.temporal',()=>++submissions),1)
  assert.equal(submissions,1)
  assert.ok(graph.describe().activeFrame.executed.includes('cloud.temporal'))
  const temporal=graph.passes.find(p=>p.name==='cloud.temporal')
  assert.ok(temporal.reads.has(adapter.resources.get('cloud.march').id))
  assert.ok(temporal.reads.has(adapter.resources.get('cloud.depth').id))
  const ray=graph.passes.find(p=>p.name==='atmosphere.raymarch')
  assert.ok(ray.reads.has(adapter.resources.get('cloud.temporal').id))
  const aliases=new Map(graph.describe().aliases.map(alias=>[alias.resource,alias.aliasSlot]))
  assert.equal(aliases.get('atmosphere.raymarch'),aliases.get('environment.medium'))
  assert.notEqual(aliases.get('cloud.depth'),aliases.get('atmosphere.raymarch'))
  for(const name of ['cloud.history.colorA','cloud.history.depthA','atmosphere.transmittanceLut'])
    assert.equal(adapter.resources.get(name).kind,'external')
  graph.endFrame();adapter.destroy()
})

test('environment imports rebind after resize and a failed submission releases Graph targets at frame end', () => {
  let releases=0
  const graph=new RenderGraph143({transientAllocator:{acquire(){return {release(){releases++}}},release(lease){lease.release()}}})
  const adapter=new EnvironmentGraph143({}, {drawingBufferWidth:16,drawingBufferHeight:8})
  adapter.declareGraph(graph)
  adapter.bindFrame({color:{width:16,height:8},depth:{width:16,height:8}})
  const input=adapter.resources.get('environment.input')
  assert.equal(graph.externalOf(input).width,16)
  adapter.bindFrame({color:{width:32,height:16}})
  assert.equal(graph.externalOf(input).width,32)
  assert.equal(graph.externalOf(adapter.resources.get('environment.depth')),undefined)
  graph.beginFrame()
  assert.throws(()=>adapter.run('cloud.march',()=>{graph.resolve(adapter.resources.get('cloud.march'));throw new Error('submit failed')}),/submit failed/)
  graph.endFrame()
  assert.equal(releases,1)
  assert.equal(graph.activeFrame,null)
  adapter.destroy()
})

test('environment cache acquires actual Graph leases and preserves cloud inputs through all consumers',()=>{
  let draws=0,nativeDestroyed=0
  const C={ClearCommand:class{execute(){}},PixelFormat:{RGBA:6408},PixelDatatype:{FLOAT:5126}}
  const context={_gl:{canvas:new EventTarget()}},scene={context,drawingBufferWidth:16,drawingBufferHeight:8}
  const stage=()=>({name:`cloud-${draws++}`,textureScale:0.5,pixelFormat:6408,pixelDatatype:5126,uniforms:{},execute(){draws++}})
  const color=stage(),depth=stage();draws=0
  const collection={_textureCache:{destroy(){nativeDestroyed++}},getStageByName(name){return [color,depth].find(stage=>stage.name===name)}}
  const adapter=new EnvironmentGraph143(C,scene)
  const cache=adapter.installCollection(collection,[{key:'cloud.march',stage:color},{key:'cloud.depth',stage:depth}])
  const leases=[]
  const graph=new RenderGraph143({transientAllocator:{
    acquire(descriptor){const lease={id:leases.length,valid:true,texture:{width:descriptor.width,height:descriptor.height},
      framebuffer:{getColorTexture(){return lease.texture}},release(){this.valid=false}};leases.push(lease);return lease},
    release(lease){lease.release()}
  }})
  adapter.declareGraph(graph);graph.beginFrame({drawingBuffer:{width:16,height:8}})
  adapter.beginFrame({color:{},depth:{}});cache.update(context)
  assert.equal(nativeDestroyed,1)
  assert.equal(leases.length,2)
  assert.notEqual(cache.getFramebuffer(color.name),cache.getFramebuffer(depth.name))
  color.execute(context,{});depth.execute(context,{})
  assert.equal(draws,2)
  assert.ok(leases.every(lease=>lease.valid),'main atmosphere may still sample raw color/depth after temporal bypass')
  adapter.run('cloud.temporal',()=>({}))
  adapter.run('atmosphere.raymarch',()=>{})
  adapter.run('atmosphere.transmission',()=>{})
  assert.ok(leases.every(lease=>lease.valid))
  adapter.run('environment.medium',()=>{})
  assert.ok(leases.every(lease=>!lease.valid))
  adapter.endFrame();graph.endFrame()
  assert.ok(cache.slots.every(slot=>slot.lease===null))
  adapter.destroy();assert.equal(cache.isDestroyed(),true)
})
