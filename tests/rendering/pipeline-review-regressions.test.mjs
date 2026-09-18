import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import Lens from '../../src/stages/LensEffectPipeline143.js'
import Overlay from '../../src/antialiasing/TaaOverlay143.js'
import Environment from '../../src/environment/EnvironmentRenderer.js'
import FixedTree from '../../src/instances/FixedTreeCollection.js'
import Grass from '../../src/instances/GrassCollection.js'
import {resolveDefaultPolicy} from '../../src/diagnostics/capabilityMatrix143.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('missing DoF depth skips only DoF and still maps HDR exactly once',()=>{
 const calls=[],native={enabled:true},texture={isDestroyed:()=>false}
 const stage=()=>({ready:true,isDestroyed:()=>false,outputTexture:texture})
 const scene={context:{_gl:{isContextLost:()=>false}},frameState:{frameNumber:1,passes:{render:true}},postProcessStages:{_tonemapping:native}}
 const lens=Object.assign(Object.create(Lens.prototype),{scene,supported:true,enabled:true,stages:{tone:stage(),depthOfField:stage()},order:['tone','depthOfField'],
  stats:{frames:0,stageExecutions:0,bypasses:0},_depthTexture:()=>undefined,
  _collectionFor:key=>({ready:true,update(){},clear(){},execute(){calls.push(key)}})})
 assert.equal(lens._execute(scene.context,{},null,null),texture)
 assert.deepEqual(calls,['tone']);assert.equal(native.enabled,false)
})

test('unready custom tone leaves the native fallback prepared and enabled',()=>{
 const native={enabled:true},collection={_tonemapping:native,execute(){},update(){native.enabled=true}}
 const scene={context:{webgl2:true,floatingPointTexture:true,colorBufferFloat:true,_gl:{isContextLost:()=>false}},postProcessStages:collection,
  frameState:{frameNumber:1,passes:{render:true}},requestRender(){}}
 const lens=new Lens(C,scene,()=>({toneMappingCurve:'unrealFilmicApprox'}));lens.setEnabled(true)
 lens._collectionFor=()=>({ready:false,update(){},clear(){}})
 collection.update();const color={};assert.equal(lens._execute(scene.context,color),color);assert.equal(native.enabled,true);lens.destroy()
})

test('TAA UI routing excludes particle billboards in nested collections',()=>{
 const particle=new C.ParticleSystem(),billboards=new C.BillboardCollection(),ui=new C.BillboardCollection()
 particle._billboardCollection=billboards
 const nested=new C.PrimitiveCollection(),primitives=new C.PrimitiveCollection();nested.add(particle);primitives.add(nested)
 const overlay=Object.assign(Object.create(Overlay.prototype),{C,scene:{primitives,frameState:{frameNumber:1}}})
 assert.equal(overlay.isOverlay({owner:billboards}),false);assert.equal(overlay.isOverlay({owner:ui}),true)
 primitives.destroy();ui.destroy()
})

test('medium textures cannot survive a producer bypass or advance to another frame',()=>{
 const texture={width:4,height:4,isDestroyed:()=>false},e=Object.assign(Object.create(Environment.prototype),{enabled:true,
  scene:{frameState:{frameNumber:10}},stages:{occlusionStage:{ready:true,outputTexture:texture,isDestroyed:()=>false}},
  hdr:{occlusionFrame:9,getDiagnostics:()=>({valid:true})}})
 assert.equal(e.getMediumOcclusionDiagnostics().valid,false)
 e.hdr.occlusionFrame=10;assert.equal(e.getMediumOcclusionDiagnostics().valid,true)
 e.hdr.getDiagnostics=()=>({valid:false});assert.equal(e.getMediumOcclusionDiagnostics().valid,false)
})

test('actual deferred rendering is independent of candidate-default coverage',()=>{
 const result=resolveDefaultPolicy({options:{lightingMode:'deferred'},coverage:{ssr:false},actual:{activeMode:'deferred',valid:true}})
 assert.equal(result.deferred.active,true);assert.equal(result.deferred.effectiveMode,'deferred');assert.equal(result.deferred.candidates,false)
})

test('offscreen trees finish loading without any cached draw commands',async()=>{
 const tree=Object.assign(Object.create(FixedTree.prototype),{scene:{postRender:new C.Event(),requestRender(){}},
  primitive:{_resources:{gltfRecordsBuilt:true,pendingTextureCount:0,cachedCommandCount:0,gltfAssetRecords:[],barkTextureRecords:new Map()}}})
 let ready=false;const promise=tree._waitForAssets().then(()=>ready=true,()=>{})
 tree.scene.postRender.raiseEvent();await Promise.resolve();tree._cancelReady?.();await promise
 assert.equal(ready,true)
})

test('grass apportions one shared integer budget and permits zero density',async()=>{
 const requests=[],grass=Object.assign(Object.create(Grass.prototype),{density:1,maxInstances:10,seed:1,
  _runtime:{createEzTreeVegetationInstances:o=>{requests.push(o.grassCount);return Array.from({length:o.grassCount},()=>({kind:'grass'}))}}})
 const polygons=Array.from({length:25},(_,id)=>({id,area:1,outer:[[0,0],[1,0],[1,1],[0,1]]}))
 assert.equal((await grass._samplePerPolygon(polygons)).length,10);assert.equal(requests.reduce((a,b)=>a+b,0),10)
 grass.density=0;assert.equal((await grass._samplePerPolygon(polygons)).length,0)
 grass.density=1;grass.maxInstances=2;assert.equal((await grass._samplePerPolygon(polygons)).length,2)
})
