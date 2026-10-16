import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

// Execute the production GLSL selection statements with metric-depth texture
// fixtures. Real projection/packing is covered by the browser GPU regression.
const source=readFileSync(new URL('../../src/environment/environmentStages.js',import.meta.url),'utf8')
const start=source.indexOf('float sceneDistance(vec2 uv) {')
const open=source.indexOf('{',start)
let end=open+1,balance=1
while(balance){if(source[end]==='{')balance++;if(source[end]==='}')balance--;end++}
const body=source.slice(open+1,end-1).replace(/\bfloat\b/g,'let')
const choose=new Function('scene','globe','surfaceDepthAvailable','shellEmptyScene',`
  const DEPTH_LIMIT=20000000,uv=[.5,.5],depthTexture=scene,surfaceDepthTexture=globe;
  const texture=(value)=>({r:value}),czm_unpackDepth=value=>value.r;
  const depthDistance=(_uv,value)=>value,min=Math.min;
  ${body}
`)

test('foreground opaque depth wins over a valid terrain or Tiles depth behind it',()=>{
  assert.equal(choose(185.484,438.409,true,false),185.484)
  assert.equal(choose(170,20000,true,false),170)
})

test('a nearer globe surface and missing-surface fallbacks retain the closest real hit',()=>{
  assert.equal(choose(500,100,true,false),100)
  assert.equal(choose(20000000,100,true,false),100)
  assert.equal(choose(100,20000000,true,false),100)
  assert.equal(choose(100,50,false,false),100)
})

test('empty frame and two misses remain sky, with no invented finite receiver',()=>{
  assert.equal(choose(20000000,20000000,true,false),20000000)
  assert.equal(choose(100,50,true,true),20000000)
})
