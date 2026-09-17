import test from 'node:test'
import assert from 'node:assert/strict'
import {acquireSunUniforms} from '../../src/buffers/SunUniforms143.js'
function fixture(){
 let binding=null,uploads=0,deletes=0
 const gl={UNIFORM_BUFFER:1,UNIFORM_BUFFER_BINDING:2,MAX_UNIFORM_BLOCK_SIZE:3,MAX_UNIFORM_BUFFER_BINDINGS:4,
  getParameter:k=>k===3?65536:k===4?24:binding,createBuffer:()=>({}),bindBuffer:(t,b)=>{binding=b},bufferData(){},bufferSubData(){uploads++},deleteBuffer(){deletes++},
  getUniformBlockIndex:()=>0xffffffff,getProgramParameter:()=>0,uniformBlockBinding(){},bindBufferBase(){},bindBufferRange(){},getIndexedParameter:()=>null,getActiveUniformBlockParameter:()=>0}
 const original=()=>1,scene={context:{_gl:gl,webgl2:true,draw:original,uniformState:{lightDirectionEC:{x:0,y:0,z:1},lightDirectionWC:{x:1,y:0,z:0},lightColorHdr:{x:2,y:2,z:2}}},frameState:{frameNumber:1}}
 return {scene,original,uploads:()=>uploads,deletes:()=>deletes}
}
test('sun leases share one block, skip equal values and update within the same frame',()=>{
 const f=fixture(),a=acquireSunUniforms({},f.scene),b=acquireSunUniforms({},f.scene)
 assert.equal(a.buffer,b.buffer);assert.equal(a.update(),48);assert.equal(b.update(),0)
 f.scene.context.uniformState.lightDirectionEC.x=.5;assert.ok(a.update()>0);assert.equal(b.update(),0)
 f.scene.frameState.frameNumber++;assert.equal(a.update(),0);assert.equal(f.uploads(),2)
 a.release();assert.equal(f.deletes(),0);b.release();assert.equal(f.deletes(),1);assert.equal(f.scene.context.draw,f.original)
})
test('released sun leases reject updates and cannot reactivate retained draw wrappers',()=>{
 const f=fixture(),a=acquireSunUniforms({},f.scene),b=acquireSunUniforms({},f.scene),retired=f.scene.context.draw
 a.release();assert.throws(()=>a.update(),/released/);b.release()
 assert.equal(retired.call(f.scene.context,{shaderProgram:{fragmentShaderSource:{defines:['CCR_SUN_UBO']}}}),1)
})
