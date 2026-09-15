import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {normalizeAntiAliasing,spatialQuality} from '../../src/antialiasing/settings143.js'
import FxaaPass143 from '../../src/antialiasing/FxaaPass143.js'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('quality defaults are explicit; MSAA-only selection has actual samples unless one was requested',()=>{
 assert.equal(normalizeAntiAliasing().spatialAaQuality,'balanced')
 assert.equal(normalizeAntiAliasing({antialiasing:'msaa'}).msaaSamples,4)
 assert.equal(normalizeAntiAliasing({antialiasing:'msaa',msaaSamples:1}).msaaSamples,1)
 assert.equal(normalizeAntiAliasing({spatialAaQuality:'invalid'}).spatialAaQuality,'balanced')
 assert.equal(spatialQuality('balanced').smaaThreshold,.05)
 assert.ok(spatialQuality('sharp').fxaaSubpix<spatialQuality('smooth').fxaaSubpix)
})
test('FXAA reuses the final-color pass lifecycle without SMAA lookups, tone mapping, or temporal state',async()=>{
 const native=new C.PostProcessStageCollection(),execute=native.execute,copy=native.copy
 const scene={postProcessStages:native,context:{webgl2:true},frameState:{frameNumber:1},requestRender(){},isDestroyed:()=>false}
 const pass=new FxaaPass143(C,scene)
 pass.setEnabled(true);await pass.readyPromise
 assert.equal(pass.ready,true);assert.equal(pass.areaTexture,undefined)
 assert.equal(pass.composite.length,1);assert.equal(pass.collection._tonemapping.enabled,false)
 const first=pass.collection
 pass.setQuality('smooth')
 assert.equal(first.isDestroyed(),true);assert.equal(pass.quality,'smooth')
 assert.equal(pass.getDiagnostics().resourceCounts.lookupTextures,0)
 pass.destroy();pass.destroy()
 assert.equal(native.execute,execute);assert.equal(native.copy,copy)
 native.destroy()
})
