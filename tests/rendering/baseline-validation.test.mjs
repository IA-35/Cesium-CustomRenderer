import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const fixtureUtils=await import('./stage1-baseline-fixture.js')
let utils={}
try{utils=require('../../scripts/baseline-utils.cjs')}catch{}
test('golden comparison is read-only and detects stable changed output',()=>{
 assert.equal(typeof utils.compareGolden,'function')
 const a={target:'fixtures',configuration:'ccr-default',captures:[{shot:'near',hash:'original'}]}
 assert.doesNotThrow(()=>utils.compareGolden(a,structuredClone(a)))
 const changed={...a,captures:[{shot:'near',hash:'regressed'}]}
 assert.throws(()=>utils.compareGolden(a,changed),/baseline mismatch/)
 assert.equal(a.captures[0].hash,'original')
 assert.throws(()=>utils.compareGolden(a,{...a,target:'campus-geometry'}),/baseline mismatch/)
})
test('content fingerprints change while porcelain status stays identical',()=>{
 assert.equal(typeof utils.sourceSnapshot,'function')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccr-baseline-'))
 try{
  execFileSync('git',['init','-q',root])
  fs.mkdirSync(path.join(root,'src'))
  const file=path.join(root,'src','有 空格.js')
  fs.writeFileSync(file,'export const a=1')
  const a=utils.sourceSnapshot(root)
  fs.writeFileSync(file,'export const a=2')
  const b=utils.sourceSnapshot(root)
  assert.notEqual(a.contentHash,b.contentHash)
  assert.equal(a.files[0].path,'src/有 空格.js')
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('every HTTP error is fatal for required resources and URLs are redacted',()=>{
 assert.equal(typeof utils.safeUrl,'function')
 assert.ok(!utils.safeUrl('https://tiles.test/map?token=secret').includes('secret'))
 assert.throws(()=>utils.assertRequests({httpErrors:[{url:'https://tiles.test/map',status:503}],failed:[],providerErrors:[]}),/resource/)
})

test('imagery readiness rejects empty layers, provider errors and newly loading views',()=>{
 assert.equal(typeof fixtureUtils.baselineReadiness,'function')
 const layer={show:true,alpha:1,imageryProvider:{}}
 const host={tiles:[],errors:[],viewer:{scene:{globe:{tilesLoaded:true},imageryLayers:{length:0,get:()=>layer}}}}
 assert.equal(fixtureUtils.baselineReadiness(host,true).ready,false)
 host.viewer.scene.imageryLayers.length=1
 assert.equal(fixtureUtils.baselineReadiness(host,true).ready,true)
 host.viewer.scene.globe.tilesLoaded=false
 assert.equal(fixtureUtils.baselineReadiness(host,true).ready,false)
 host.viewer.scene.globe.tilesLoaded=true;host.baselineProviderErrors=['503']
 assert.equal(fixtureUtils.baselineReadiness(host,true).ready,false)
})

test('opaque alpha does not make a solid black image nonblank',()=>{
 assert.equal(typeof fixtureUtils.hasColorVariation,'function')
 assert.equal(fixtureUtils.hasColorVariation(new Uint8Array([0,0,0,255,0,0,0,255])),false)
 assert.equal(fixtureUtils.hasColorVariation(new Uint8Array([0,0,0,255,1,0,0,255])),true)
})

test('a generic baseline does not borrow an unrelated global campus camera', () => {
 const before=globalThis.campus
 let calls=0
 globalThis.campus={look(){calls++}}
 try {
  assert.throws(()=>fixtureUtils.applyShot({}, {pitch:0,range:1}, null), /origin/)
  assert.equal(calls,0)
 } finally { if(before===undefined)delete globalThis.campus;else globalThis.campus=before }
})
