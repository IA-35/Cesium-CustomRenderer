import test from 'node:test'
import assert from 'node:assert/strict'
import SelectedIdPass143, { selectedOwners, keepIdCommand } from '../../src/selection/SelectedIdPass143.js'

const C={Model:class{},Cesium3DTileset:class{},Cesium3DTileFeature:class{},Pass:{TRANSLUCENT:8}}
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
