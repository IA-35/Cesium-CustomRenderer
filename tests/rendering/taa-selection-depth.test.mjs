import test from 'node:test'
import assert from 'node:assert/strict'
import {attachTaaSelectionDepth} from '../../src/antialiasing/TaaSelectionDepth143.js'

function fixture() {
  const input = {}, id = {}, stable = {isDestroyed: () => false}, calls = []
  const edge = {name:'czm_edge_detection_test',uniforms:{length:0.04},_combinedSelected:[{}],
    execute(context,color,depth) {calls.push(depth)}}
  const other = {...edge,name:'application_depth_stage'}
  const composite = {get:i=>[edge,other][i],length:2}
  const collection = {get:()=>composite,length:1,execute() {
    for(let i=0;i<composite.length;i++) composite.get(i).execute({}, {}, input, id)
  }}
  const scene = {postProcessStages:collection,_environmentState:{usePostProcessSelected:true},
    _view:{sceneFramebuffer:{idFramebuffer:{depthStencilTexture:stable,getColorTexture:()=>id}}}}
  return {scene,collection,edge,other,calls,input,stable,id}
}

test('only selected native edge detection uses the matching stable depth, without changing other stages',()=>{
  const f=fixture(), original=f.edge.execute, detach=attachTaaSelectionDepth(f.scene,()=>true)
  f.collection.execute()
  assert.deepEqual(f.calls,[f.stable,f.input])
  assert.equal(f.edge.execute,original,'temporary wrapper must be released after every frame')
  detach();f.collection.execute()
  assert.deepEqual(f.calls.slice(-2),[f.input,f.input])
})

test('inactive TAA, empty selection, stale ID and unavailable depth keep native behavior',()=>{
  for(const condition of ['inactive','empty','noIdPass','staleId','destroyed','noTexture']) {
    const f=fixture(), fb=f.scene._view.sceneFramebuffer.idFramebuffer
    if(condition==='empty')f.edge._combinedSelected=[]
    if(condition==='noIdPass')f.scene._environmentState.usePostProcessSelected=false
    if(condition==='staleId')fb.getColorTexture=()=>({})
    if(condition==='destroyed')f.stable.isDestroyed=()=>true
    if(condition==='noTexture')fb.depthStencilTexture=undefined
    const detach=attachTaaSelectionDepth(f.scene,()=>condition!=='inactive')
    f.collection.execute();assert.deepEqual(f.calls,[f.input,f.input],condition);detach()
  }
})

test('late stages are discovered and exceptions restore inherited execute methods',()=>{
  const f=fixture(), inherited={execute(){throw Error('draw failed')}}
  Object.setPrototypeOf(f.edge,inherited);delete f.edge.execute
  const detach=attachTaaSelectionDepth(f.scene,()=>true)
  assert.throws(()=>f.collection.execute(),/draw failed/)
  assert.equal(Object.hasOwn(f.edge,'execute'),false)
  f.edge.execute=function(c,color,depth){f.calls.push(depth)}
  f.collection.execute();assert.deepEqual(f.calls,[f.stable,f.input])
  detach()
})

test('detach respects a foreign outer hook and leaves the retained inner hook inert',()=>{
  const f=fixture(),detach=attachTaaSelectionDepth(f.scene,()=>true),hook=f.collection.execute
  const foreign=function(...args){return hook.apply(this,args)}
  f.collection.execute=foreign;detach();detach()
  assert.equal(f.collection.execute,foreign)
  f.collection.execute();assert.deepEqual(f.calls,[f.input,f.input])
})
