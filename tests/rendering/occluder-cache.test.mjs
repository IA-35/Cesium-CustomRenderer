import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import OccluderCache143 from '../../src/visibility/OccluderCache143.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
function setup(){
 const scene={frameState:{frameNumber:1},context:{_gl:{getParameter(){},useProgram(){}}}}
 const texture={copyFrom(){}},uniforms={u_alpha:1,u_texture:texture}
 const command={owner:Object.create(C.Model.prototype),pass:C.Pass.OPAQUE,primitiveType:C.PrimitiveType.TRIANGLES,
  shaderProgram:{id:1,vertexShaderSource:{defines:[]},fragmentShaderSource:{defines:[]},_manualUniforms:Object.keys(uniforms).map(name=>({name}))},
  uniformMap:Object.fromEntries(Object.keys(uniforms).map(name=>[name,()=>uniforms[name]])),vertexArray:{_attributes:[]},
  renderState:{id:1,depthTest:{enabled:true},depthMask:true},boundingVolume:new C.BoundingSphere(new C.Cartesian3(0,0,-10),1),modelMatrix:C.Matrix4.clone(C.Matrix4.IDENTITY),count:6}
 return {scene,command,uniforms,texture,cache:new OccluderCache143(C,scene)}
}
test('static revisions ignore time but detect LOD, style, topology and disappearing commands',()=>{
 const {scene,command,uniforms,cache}=setup();let state=cache.update([command]);assert.equal(state.unsafe,false)
 scene.frameState.frameNumber++;assert.equal(cache.update([command]).revision,state.revision)
 for(const change of [()=>{command.vertexArray={_attributes:[]}},()=>{uniforms.u_alpha=.4},()=>{command.primitiveType=C.PrimitiveType.LINES},()=>{command.modelMatrix[12]=1}]){
  change();const next=cache.update([command]);assert.ok(next.revision>state.revision);state=next
 }
 assert.ok(cache.update([]).revision>state.revision);cache.destroy()
})
test('same texture upload changes revision and cleanup restores the original resource method',()=>{
 const {command,texture,cache}=setup(),original=texture.copyFrom,state=cache.update([command])
 texture.copyFrom({});assert.ok(cache.update([command]).revision>state.revision)
 cache.destroy();assert.equal(texture.copyFrom,original)
})
test('a geometry upload flags one unsafe frame then re-stabilizes instead of staying unsafe forever',()=>{
  const {scene,command,cache}=setup()
  const buffer={copyFrom(){}},originalBuffer=buffer.copyFrom
  command.vertexArray={_attributes:[{vertexBuffer:buffer}]}
  const first=cache.update([command]);assert.equal(first.unsafe,false)
  buffer.copyFrom({})
  const flagged=cache.update([command]);assert.equal(flagged.unsafe,true);assert.ok(flagged.revision>first.revision)
  scene.frameState.frameNumber++
  const stable=cache.update([command]);assert.equal(stable.unsafe,false)
  cache.destroy();assert.equal(buffer.copyFrom,originalBuffer)
})
