import test from 'node:test'
import assert from 'node:assert/strict'
import { groupShadowCommands, withShadowBindings } from '../../src/shadows/ShadowSubmit143.js'

test('depth-only submissions group programs/states without dropping commands or replacing live fields',()=>{
 const commands=Array.from({length:30},(_,i)=>({shaderProgram:{id:i%3},renderState:{id:i%2},modelMatrix:{frame:1},count:i+1}))
 const input=[...commands],result=groupShadowCommands(commands)
 assert.equal(result.length,input.length)
 assert.deepEqual(new Set(result),new Set(input))
 const transitions=result.filter((c,i)=>!i||c.shaderProgram.id!==result[i-1].shaderProgram.id).length
 assert.equal(transitions,3)
 input[0].modelMatrix.frame=2
 assert.equal(result.find(c=>c===input[0]).modelMatrix.frame,2)
})
test('shadow scope suppresses consecutive identical binds and restores native behavior on throw',()=>{
 const calls=[],gl={useProgram:p=>calls.push(p),activeTexture(){},bindTexture(){}},original=gl.useProgram,a={},b={}
 assert.throws(()=>withShadowBindings(gl,()=>{gl.useProgram(a);gl.useProgram(a);gl.useProgram(b);gl.useProgram(null);gl.useProgram(b);throw new Error('draw failed')}),/draw failed/)
 assert.deepEqual(calls,[a,b,null,b]);assert.equal(gl.useProgram,original)
 gl.useProgram(b);assert.equal(calls.length,5)
})
test('texture bindings are scoped by both unit and target and no state assumption survives the pass',()=>{
 const calls=[],gl={useProgram(){},activeTexture:u=>calls.push(['unit',u]),bindTexture:(t,v)=>calls.push(['texture',t,v])},a={},b={}
 withShadowBindings(gl,()=>{gl.activeTexture(10);gl.bindTexture(1,a);gl.bindTexture(1,a);gl.activeTexture(10);gl.bindTexture(2,a);gl.activeTexture(11);gl.bindTexture(1,a);gl.activeTexture(10);gl.bindTexture(1,b);gl.bindTexture(1,a)})
 assert.equal(calls.filter(x=>x[0]==='unit').length,3)
 assert.equal(calls.filter(x=>x[0]==='texture').length,5)
 withShadowBindings(gl,()=>{gl.activeTexture(10);gl.bindTexture(1,a)})
 assert.equal(calls.filter(x=>x[0]==='texture').length,6)
})
