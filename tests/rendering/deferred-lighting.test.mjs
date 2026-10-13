import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import DeferredLighting143 from '../../src/lighting/DeferredLighting143.js'
import { compactMaterialSources } from '../../src/lighting/DeferredGeometry143.js'
import { deferredLightingShaderSource, DEFERRED_DEBUG_MODES } from '../../src/lighting/deferredLightingShader143.js'
import { materialTargetSupport } from '../../src/channels/MaterialTarget143.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const program=defines=>({vertexShaderSource:new C.ShaderSource({sources:[C._shadersModelVS]}),
 fragmentShaderSource:new C.ShaderSource({defines,sources:[C._shadersMaterialStageFS,C._shadersModelFS]})})

test('compact material data fits exactly four color output locations',()=>{
 const p=compactMaterialSources(C,program(['LIGHTING_PBR','USE_METALLIC_ROUGHNESS','HAS_NORMALS']))
 assert.equal(p.supported,true)
 const fs=p.fragmentShaderSource.sources.join('\n')
 assert.deepEqual([...fs.matchAll(/layout\(location = (\d+)\)/g)].map(m=>+m[1]).sort(),[1,2,3])
 assert.ok(!fs.includes('campus_transparentCoverage'))
 assert.ok(!fs.includes('lightingStage(material, attributes);'))
 const max=16383*1024+1023
 assert.equal(new Float32Array([max])[0],max,'group + all material bits must be exact')
})
test('compact baseline support uses four slots rather than the optional five-slot albedo layout',()=>{
 const context=Object.fromEntries(['webgl2','depthTexture','floatingPointTexture','halfFloatingPointTexture','colorBufferFloat','colorBufferHalfFloat','drawBuffers'].map(k=>[k,true]))
 context._gl={MAX_DRAW_BUFFERS:1,MAX_COLOR_ATTACHMENTS:2,getParameter:()=>4}
 assert.equal(materialTargetSupport(context).supported,true)
 assert.equal(materialTargetSupport(context,false,false,true).supported,false)
})
test('unlit and extended PBR keep native colors and invalidate deferred data',()=>{
 for(const defines of [['HAS_NORMALS'],['LIGHTING_PBR','USE_METALLIC_ROUGHNESS','HAS_NORMALS','USE_CLEARCOAT']]){
  const result=compactMaterialSources(C,program(defines))
  assert.equal(result.supported,false)
  assert.match(result.fragmentShaderSource.sources.join('\n'),/campus_materialDepth = vec4\(-1.0/)
 }
})
test('lighting variants use native IBL and native eye-space coordinates without window-depth reinterpretation',()=>{
 for(const options of [{},{diffuse:true},{specular:true},{diffuse:true,specular:true}]){
  const source=deferredLightingShaderSource(C,options)
  const text=source.sources.join('\n')
  assert.ok(source.sources.includes(C._shadersImageBasedLightingStageFS))
  assert.match(text,/vec3\(positionMetal.yz,-depth\)/)
  assert.doesNotMatch(text,/czm_windowToEyeCoordinates/)
  assert.equal(source.defines.includes('DIFFUSE_IBL'),!!options.diffuse)
  assert.equal(source.defines.includes('SPECULAR_IBL'),!!options.specular)
 }
})
function scene(){
 const primitives=new C.PrimitiveCollection()
 return {context:{draw(){}},primitives,preUpdate:new C.Event(),requestRender(){},
  frameState:{frameNumber:1,passes:{render:true}},_view:{},_environmentState:{},
  updateAndExecuteCommands(){},resolveFramebuffers(){}}
}
test('constructor works with an injected engine and no global Cesium',()=>{
 assert.equal(globalThis.Cesium,undefined)
 const s=scene(),d=new DeferredLighting143({Cesium:C,scene:s})
 d.setEnabled(true);assert.equal(d.getDiagnostics().enabled,true)
 d.destroy();assert.equal(s.primitives.length,0)
})
test('failure remains visible and explicit disable permits reactivation',()=>{
 const s=scene(),d=new DeferredLighting143({Cesium:C,scene:s})
 d.setEnabled(true);d.fail(new Error('allocation failed'))
 assert.equal(d.failed,true);assert.match(d.reason,/allocation failed/)
 d.setEnabled(true);assert.equal(d.enabled,false)
 d.setEnabled(false);d.setEnabled(true)
 assert.equal(d.failed,false);assert.equal(d.enabled,true)
 d.destroy()
})
test('uniform-only updates retain compiled programs and bound values',()=>{
 const d=new DeferredLighting143({Cesium:C,scene:scene()})
 const marker={}
 d.programs.set('variant',marker)
 d.setTerms({direct:false})
 assert.equal(d.programs.get('variant'),marker)
 d.set({aoStrength:9,debugMode:20})
 assert.equal(d.aoStrength,1);assert.equal(d.debugMode,7)
 d.programs.clear();d.destroy()
 assert.equal(new Set(Object.values(DEFERRED_DEBUG_MODES)).size,8)
})

test('native atmospheric fog remains on the compatibility path',()=>{
 const d=new DeferredLighting143({Cesium:C,scene:scene()})
 d.ensureProgram=()=>{}
 assert.equal(d.environmentGroup({shaderProgram:{fragmentShaderSource:{defines:['HAS_ATMOSPHERE']}},
   uniformMap:{u_isInFog:()=>true}}),null)
 d.destroy()
})

test('direct-only models share one deferred lighting group despite distinct local frames',()=>{
 const d=new DeferredLighting143({Cesium:C,scene:scene()})
 d.ensureProgram=()=>{}
 const command=matrix=>({shaderProgram:{fragmentShaderSource:{defines:['LIGHTING_PBR']}},
   uniformMap:{model_iblReferenceFrameMatrix:()=>matrix}})
 const first=d.environmentGroup(command(C.Matrix3.IDENTITY))
 const second=d.environmentGroup(command(C.Matrix3.fromRotationX(.5,new C.Matrix3())))
 assert.equal(second,first)
 assert.equal(d.groups.length,1)
 d.destroy()
})

test('failed shader compilation releases every temporary program before retry',()=>{
 const s=scene(),released=[]
 s.context._gl={CURRENT_PROGRAM:1,getParameter:()=>null,useProgram(){}}
 s.context.createViewportQuadCommand=()=>{
   const p={dead:false,_bind(){throw new Error('injected link failure')},isDestroyed(){return this.dead},destroy(){this.dead=true;released.push(this)}}
   return {shaderProgram:p}
 }
 const d=new DeferredLighting143({Cesium:C,scene:s})
 for(let i=0;i<5;i++)assert.throws(()=>d.ensureProgram({diffuse:false,specular:false}),/injected link failure/)
 assert.equal(released.length,5)
 assert.equal(d.programs.size,0)
 d.destroy()
})

test('over-budget frames never allocate compact targets and resume when environments merge',()=>{
 const s=scene(),d=new DeferredLighting143({Cesium:C,scene:s}),geometry=d.materials
 let allocated=0,cleared=0,currentProgram={}
 s.context.uniformState={}
 s.context._gl={CURRENT_PROGRAM:1,getParameter:()=>currentProgram,useProgram(value){currentProgram=value}}
 const initialProgram=currentProgram
 const commands=Array.from({length:33},()=>({
   shaderProgram:program(['LIGHTING_PBR','SPECULAR_IBL']),uniformMap:{model_specularEnvironmentMaps:()=>({})}
 }))
 const bin={indices:{[C.Pass.OPAQUE]:commands.length},commands:{[C.Pass.OPAQUE]:commands}}
 s._view.frustumCommandsList=[bin]
 geometry.scopeReason=()=>null
 geometry.programFor=()=>({supported:true,_program:{_bind(){}},_invalid:{_bind(){}},_recovery:{_bind(){}}})
 d.ensureProgram=()=>{}
 geometry.allocate=()=>{allocated++;geometry.target={clear:{execute(){cleared++}},clearCoverage:{execute(){cleared++}}}}
 geometry.releaseTarget=()=>{geometry.target=null}
 for(let frame=1;frame<=3;frame++){
   s.frameState.frameNumber=frame;geometry.prepare()
   assert.equal(geometry.ready,false)
   assert.match(geometry.reason,/group budget exceeded/)
   assert.equal(allocated,0,'fallback must be decided before any texture allocation')
   assert.equal(cleared,0)
   assert.equal(currentProgram,initialProgram)
 }
 bin.indices[C.Pass.OPAQUE]=1
 s.frameState.frameNumber++;geometry.prepare()
 assert.equal(geometry.ready,true)
 assert.equal(allocated,1)
 assert.equal(cleared,2)
 geometry.target=null;d.destroy()
})

test('partially constructed geometry variants remain owned by failure cleanup',()=>{
 const s=scene(),d=new DeferredLighting143({Cesium:C,scene:s})
 let created=0,released=0
 d.materials.C={...C,ShaderProgram:{fromCache(){
   if(++created===2)throw new Error('variant allocation failed')
   return {isDestroyed:()=>false,destroy(){released++}}
 }}}
 const source=program(['LIGHTING_PBR','USE_METALLIC_ROUGHNESS','HAS_NORMALS']);source.id=123
 d.materials.setEnabled(true)
 assert.throws(()=>d.materials.programFor({shaderProgram:source,renderState:{stencilTest:{enabled:false}}}),/variant allocation failed/)
 d.fail(new Error('variant allocation failed'))
 assert.equal(released,1);assert.equal(d.materials.programs.size,0)
 d.destroy()
})
