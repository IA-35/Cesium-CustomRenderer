import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import HdrBloom143 from '../../src/bloom/HdrBloom143.js'
import { normalizeOptions } from '../../src/presets.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('Bloom settings clamp finite values and keep disabled defaults', () => {
  const defaults = normalizeOptions()
  assert.equal(defaults.hdrBloomEnabled, false)
  const o = normalizeOptions({ hdrBloomLevels: 99, hdrBloomThreshold: -1, hdrBloomStrength: Infinity, hdrBloomKnee: 2 })
  assert.equal(o.hdrBloomLevels, 6)
  assert.equal(o.hdrBloomThreshold, 0)
  assert.equal(o.hdrBloomStrength, defaults.hdrBloomStrength)
  assert.equal(o.hdrBloomKnee, 1)
})

test('Bloom scenes own independent stages and changing levels releases the old chain', () => {
  const native = new C.PostProcessStageCollection(), execute = native.execute
  const options = normalizeOptions({ hdrBloomLevels: 3 })
  const scene = { postProcessStages: native, requestRender() {}, isDestroyed: () => false,
    context: { webgl2: true, floatingPointTexture: true, colorBufferFloat: true } }
  const a = new HdrBloom143(C, scene, () => options)
  const otherNative = new C.PostProcessStageCollection(), otherExecute = otherNative.execute
  const b = new HdrBloom143(C, { ...scene, postProcessStages: otherNative }, () => options)
  a.setEnabled(true); b.setEnabled(true)
  assert.notEqual(a.composite.name, b.composite.name)
  assert.equal(a.stages.length, 6)
  const before = a.collection
  options.hdrBloomLevels = 4
  a.setEnabled(true)
  assert.equal(before.isDestroyed(), true)
  assert.equal(a.stages.length, 8)
  a.destroy(); b.destroy()
  assert.equal(native.execute, execute)
  assert.equal(otherNative.execute, otherExecute)
  native.destroy(); otherNative.destroy()
})

test('Bloom render failure releases its hook and retries only after disable', () => {
  const native=new C.PostProcessStageCollection(), execute=native.execute
  const context={webgl2:true,floatingPointTexture:true,colorBufferFloat:true,_gl:{isContextLost:()=>false},
    uniformState:{viewport:new C.BoundingRectangle(0,0,64,64)}}
  const scene={context,postProcessStages:native,highDynamicRange:true,frameState:{frameNumber:1},requestRender(){},isDestroyed:()=>false}
  const bloom=new HdrBloom143(C,scene,()=>normalizeOptions())
  bloom.setEnabled(true)
  const collection=bloom.collection
  Object.defineProperty(collection,'ready',{get:()=>true})
  Object.defineProperty(bloom.composite,'ready',{get:()=>true})
  collection.update=()=>{};collection.clear=()=>{}
  collection.execute=()=>{throw new Error('injected draw failure')}
  const input={hdr:4}
  assert.equal(bloom._execute(context,input),input)
  assert.equal(collection.isDestroyed(),true)
  assert.equal(native.execute,execute)
  assert.equal(bloom.failed,true)
  bloom.setEnabled(true);assert.equal(bloom.collection,undefined)
  bloom.setEnabled(false);bloom.setEnabled(true);assert.ok(bloom.collection)
  bloom.destroy();native.destroy()
})

test('unsupported Bloom is lazy and never changes exposure or gamma', () => {
  const scene = { gamma: 2.2, postProcessStages: { exposure: 1.4 }, context: {}, requestRender() {}, isDestroyed: () => false }
  const bloom = new HdrBloom143(C, scene, () => normalizeOptions())
  bloom.setEnabled(true)
  assert.equal(bloom.collection, undefined)
  assert.equal(bloom.getDiagnostics().supported, false)
  assert.equal(scene.gamma, 2.2)
  assert.equal(scene.postProcessStages.exposure, 1.4)
  bloom.destroy(); bloom.destroy()
})
