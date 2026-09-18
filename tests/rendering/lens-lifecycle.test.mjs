import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
import Lens from '../../src/stages/LensEffectPipeline143.js'
import VisualPipeline from '../../src/VisualPipeline.js'
import {normalizeOptions} from '../../src/presets.js'

function fixture() {
  let calls=0
  const collection={_tonemapping:{enabled:true},update(){calls++;this._tonemapping.enabled=true;return 7},execute(){}}
  const scene={context:{webgl2:true,floatingPointTexture:true,colorBufferFloat:true,_gl:{isContextLost:()=>false}},
    postProcessStages:collection,frameState:{passes:{render:true},frameNumber:1},requestRender(){}}
  const options=normalizeOptions({toneMappingCurve:'unrealFilmicApprox'})
  return {scene,collection,lens:new Lens(C,scene,()=>options),calls:()=>calls}
}
test('tone ownership preserves foreign wrappers and prepares native fallback across reenabling',()=>{
  const f=fixture();f.lens.setEnabled(true)
  const retired=f.collection.update
  let external=0
  const foreign=function(...args){external++;return retired.apply(this,args)}
  f.collection.update=foreign
  assert.equal(f.collection.update(),7);assert.equal(f.collection._tonemapping.enabled,true)
  f.lens.setEnabled(false)
  assert.equal(f.collection.update,foreign)
  assert.equal(retired.call(f.collection),7);assert.equal(f.collection._tonemapping.enabled,true)
  f.lens.setEnabled(true)
  assert.equal(f.collection.update(),7);assert.equal(f.collection._tonemapping.enabled,true)
  f.lens.destroy();assert.equal(f.collection.update,foreign)
  assert.equal(f.collection.update(),7);assert.equal(f.calls(),4);assert.equal(external,3)
})
test('sun NDC projects into bottom-left texture coordinates',()=>{
  const f=fixture(),frustum=new C.PerspectiveFrustum({fov:Math.PI/2,aspectRatio:1,near:1,far:100})
  f.scene.camera={directionWC:new C.Cartesian3(0,0,-1),viewMatrix:C.Matrix4.IDENTITY,frustum}
  f.scene.context.uniformState={sunPositionWC:new C.Cartesian3(0,.2,-1)}
  assert.ok(Math.abs(f.lens._sunScreen().y-.6)<1e-12)
  f.scene.context.uniformState.sunPositionWC.y=-.2
  assert.ok(Math.abs(f.lens._sunScreen().y-.4)<1e-12)
  f.scene.context.uniformState.sunPositionWC.z=1
  assert.deepEqual(f.lens._sunScreen(),new C.Cartesian2(-1,-1))
})

test('release does not overwrite a foreign tonemapper or an untouched native fallback',()=>{
 const f=fixture();f.collection.tonemapper=C.Tonemapper.ACES
 f.lens.getOptions=()=>({toneMappingCurve:'filmic'});f.lens.setEnabled(true)
 f.collection.tonemapper=C.Tonemapper.REINHARD;f.lens.destroy()
 assert.equal(f.collection.tonemapper,C.Tonemapper.REINHARD)
 const g=fixture();g.collection._tonemapping.enabled=false;g.lens.setEnabled(true)
 g.collection._tonemapping.enabled=true;g.lens.destroy()
 assert.equal(g.collection._tonemapping.enabled,true)
})
test('public lens setter updates dependencies and cannot enable effects while suspended',()=>{
  const p=Object.create(VisualPipeline.prototype),demands=[],active=[]
  Object.assign(p,{options:normalizeOptions(),enabled:true,destroyed:false,suspensions:new Set(),
    applyMaterialChannels(){demands.push(this.options.depthOfFieldEnabled)},
    applyLensEffects(){this.lensEffects.setEnabled(this.enabled && !this.suspensions.size)},getLensEffectsDiagnostics(){return {}},
    lensEffects:{setEnabled(value){active.push(value)},_release(){},getDiagnostics(){return {}}}})
  p.setLensEffects({depthOfFieldEnabled:true});p.setLensEffects({depthOfFieldEnabled:false})
  assert.deepEqual(demands,[true,false])
  p.suspensions.add('test');p.setLensEffects({depthOfFieldEnabled:true});assert.equal(active.at(-1),false)
})
