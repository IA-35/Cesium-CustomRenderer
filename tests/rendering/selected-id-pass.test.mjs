import test from 'node:test'
import assert from 'node:assert/strict'
import SelectedIdPass143, { selectedOwners, keepIdCommand, attachSelectedStageCache } from '../../src/selection/SelectedIdPass143.js'

const C={Model:class{},Cesium3DTileset:class{},Cesium3DTileFeature:class{},Pass:{TRANSLUCENT:8}}

function selectedStageFixture() {
  let references = 0, uploads = 0
  const program = { destroy() { references--; assert.ok(references >= 0) } }
  const stage = {
    enabled: true, _parentSelected: [{}],
    update() {
      if (!this.enabled) {
        this._command?.shaderProgram.destroy()
        this._command = this._selectedIdTexture = undefined
        return
      }
      // Reproduce the pinned engine's parent-array/length comparison and command replacement.
      const dirty = this._parentSelected !== this._parentSelectedShadow ||
        this._parentSelected !== this._parentSelectedLength
      this._parentSelectedShadow = this._parentSelected
      this._parentSelectedLength = this._parentSelected.length
      if (dirty) {
        this._selectedIdTexture = { upload: ++uploads }
        references++
        this._command = { shaderProgram: program }
      }
    }
  }
  const collection = { length: 1, get: () => stage, update() { stage.update() } }
  const restore = attachSelectedStageCache(collection)
  return { stage, collection, restore, get uploads() { return uploads }, get references() { return references } }
}

test('unchanged selected parent reuses its ID texture and shader reference across frames', () => {
  const f = selectedStageFixture()
  for (let i = 0; i < 120; i++) f.collection.update()
  assert.equal(f.uploads, 1)
  assert.equal(f.references, 1)
  assert.equal(f.stage._parentSelectedLength, 1)
  f.stage.enabled = false; f.collection.update()
  assert.equal(f.references, 0)
  f.restore()
})

test('selection replacement, in-place edits and re-enable upload correctly without leaking old commands', () => {
  const f = selectedStageFixture()
  f.collection.update()
  f.stage._parentSelected[0] = {}; f.collection.update()
  f.stage._parentSelected.push({}); f.collection.update()
  f.stage._parentSelected = [{}]; f.collection.update()
  assert.equal(f.uploads, 4)
  assert.equal(f.references, 1)
  f.stage.enabled = false; f.collection.update()
  assert.equal(f.references, 0)
  f.stage.enabled = true; f.collection.update()
  assert.equal(f.uploads, 5)
  assert.equal(f.references, 1)
  f.stage.enabled = false; f.collection.update(); f.restore()
})

test('selection cache teardown preserves later wrappers and stops retaining selected objects', () => {
  const f = selectedStageFixture()
  f.collection.update()
  const original = f.collection.update, later = (...args) => original(...args)
  f.collection.update = later
  f.restore()
  assert.equal(f.collection.update, later)
  f.stage.enabled = false; f.collection.update()
  assert.equal(f.references, 0)
})

test('stage removal holes are left for the native collection to compact', () => {
  const f = selectedStageFixture()
  f.collection.update()
  f.stage.enabled = false; f.collection.update()
  f.collection.get = () => undefined
  assert.doesNotThrow(() => f.collection.update())
  assert.equal(f.references, 0)
  f.restore()
})

test('an unchanged selected model still updates when asynchronous content changes its pick IDs', () => {
  const f = selectedStageFixture(), model = { pickIds: [] }
  f.stage._parentSelected = [model]
  f.collection.update()
  model.pickIds.push({}); f.collection.update()
  assert.equal(f.uploads, 2)
  model.pickIds[0] = {}; f.collection.update()
  assert.equal(f.uploads, 3)
  f.collection.update()
  assert.equal(f.uploads, 3)
  assert.equal(f.references, 1)
  f.stage.enabled = false; f.collection.update(); f.restore()
})
test('feature selection includes its content model, not unrelated tiles in the same tileset',()=>{
 const model=new C.Model(),other=new C.Model(),feature=new C.Cesium3DTileFeature()
 feature.content={_model:model}
 const owners=selectedOwners(C,[feature])
 const command=owner=>({owner,pass:4,renderState:{depthMask:true,depthTest:{enabled:true}}})
 assert.equal(keepIdCommand(C,command(model),owners),true)
 assert.equal(keepIdCommand(C,command(other),owners),false)
 assert.equal(keepIdCommand(C,{...command(other),pass:8},owners),true)
 assert.equal(keepIdCommand(C,{...command(other),renderState:{depthMask:false}},owners),true)
})
test('whole tileset selection follows asynchronous content identity and unknown selection fails open',()=>{
 const tileset=new C.Cesium3DTileset(),model=new C.Model();model.content={tileset}
 const command={owner:model,pass:4,renderState:{depthMask:true,depthTest:{enabled:true}}}
 assert.equal(keepIdCommand(C,command,selectedOwners(C,[tileset])),true)
 assert.equal(selectedOwners(C,[{}]),null)
 assert.equal(keepIdCommand(C,command,null),true)
})

function fixture(){
 let draws=0,copies=0
 const gl={READ_FRAMEBUFFER_BINDING:1,DRAW_FRAMEBUFFER_BINDING:2,SCISSOR_TEST:3,READ_FRAMEBUFFER:4,DRAW_FRAMEBUFFER:5,
   DEPTH_BUFFER_BIT:6,NEAREST:7,getParameter:k=>k,isEnabled:()=>true,disable(){},enable(){},bindFramebuffer(){},blitFramebuffer(){copies++}}
 const depth={width:100,height:100,pixelFormat:1,pixelDatatype:2}
 const id={_framebuffer:{},depthStencilTexture:depth},source={_framebuffer:{},depthStencilTexture:depth}
 const model=new C.Model(),selected=[model]
 const scene={context:{webgl2:true,_gl:gl,draw(){draws++}},frameState:{frameNumber:1,passes:{render:true}},mode:3,msaaSamples:1,
   _environmentState:{usePostProcessSelected:true,useGlobeDepthFramebuffer:true},_view:{frustumCommandsList:[{}],sceneFramebuffer:{idFramebuffer:id},globeDepth:{framebuffer:source}},
   postProcessStages:{selected}}
 const pass=new SelectedIdPass143({...C,SceneMode:{SCENE3D:3}},scene)
 const command=owner=>({owner,pass:4,renderState:{depthMask:true,depthTest:{enabled:true}}})
 const submit=owner=>scene.context.draw(command(owner),{framebuffer:id})
 return {scene,pass,model,selected,submit,get draws(){return draws},get copies(){return copies}}
}
test('copy once per frame, follow changed selection, and never alter picking or multi-frustum rendering',()=>{
 const f=fixture(),other=new C.Model()
 f.submit(other);f.submit(f.model);assert.equal(f.copies,1);assert.equal(f.draws,1)
 f.selected[0]=other;f.scene.frameState.frameNumber++;f.submit(f.model);f.submit(other)
 assert.equal(f.copies,2);assert.equal(f.draws,2)
 f.scene.frameState.passes.pick=true;f.submit(f.model);assert.equal(f.draws,3);assert.equal(f.copies,2)
 f.scene.frameState.passes.pick=false;f.scene._view.frustumCommandsList.push({});f.scene.frameState.frameNumber++
 f.submit(f.model);assert.equal(f.draws,4);assert.equal(f.copies,2)
})
test('unknown selections and MSAA keep native ID drawing; teardown preserves later hooks',()=>{
 const f=fixture(),other=new C.Model()
 f.selected[0]={};f.submit(other);assert.equal(f.copies,0);assert.equal(f.draws,1)
 f.selected[0]=f.model;f.scene.msaaSamples=4;f.scene.frameState.frameNumber++;f.submit(other)
 assert.equal(f.copies,0);assert.equal(f.draws,2)
 const saved=f.scene.context.draw,foreign=(...args)=>saved(...args);f.scene.context.draw=foreign
 f.pass.destroy();f.scene.msaaSamples=1;f.submit(other)
 assert.equal(f.draws,3);assert.equal(f.scene.context.draw,foreign)
})
test('clearing selected post-processing releases retained model references on the next draw',()=>{
 const f=fixture();f.submit(f.model);assert.ok(f.pass.owners)
 f.scene._environmentState.usePostProcessSelected=false;f.submit(f.model)
 assert.equal(f.pass.owners,null)
})
