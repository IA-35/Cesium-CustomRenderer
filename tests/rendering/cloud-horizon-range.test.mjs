import test from 'node:test'
import assert from 'node:assert/strict'

test('camera height alone releases the local range and nothing else can',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  assert.equal(cloudHorizonBlend(300),1)
  assert.equal(cloudHorizonBlend(12000),1)
  assert.equal(cloudHorizonBlend(40000),1,'the local neighbourhood keeps the full range')
  assert.equal(cloudHorizonBlend(60000),.5)
  assert.equal(cloudHorizonBlend(80000),0)
  assert.equal(cloudHorizonBlend(100000),0)
})

test('orientation is not an input and cannot suppress the extension',async()=>{
  // The old pitch/FOV form hid distant clouds from steep downward views at
  // 40-80 km. Height is the only gate now, so those views keep the layer.
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  assert.equal(cloudHorizonBlend.length,1,'the signature must not take pitch or fov')
  assert.equal(cloudHorizonBlend(3500),cloudHorizonBlend(3500))
  assert.ok(cloudHorizonBlend(3500)>0)
})

test('orbital cameras retain local clipping without a pitch branch',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  for(const height of [100000,1000000,8000000])assert.equal(cloudHorizonBlend(height),0)
})

test('the ramp is monotone and stays inside the unit interval',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  let previous=1
  for(let height=-100;height<=120000;height+=100){
    const weight=cloudHorizonBlend(height)
    assert.ok(Number.isFinite(weight)&&weight>=0&&weight<=1)
    assert.ok(weight<=previous,'height must never raise the weight')
    assert.ok(previous-weight<.02,'the ramp must not step')
    previous=weight
  }
})

test('quality-specific proximity limits stay editable and bounded',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  for(const range of [30000,40000,50000]){
    assert.equal(cloudHorizonBlend(range*2,range),0)
    for(const height of [300,12000,range,range*1.5]){
      const weight=cloudHorizonBlend(height,range)
      assert.ok(Number.isFinite(weight)&&weight>=0&&weight<=1)
    }
  }
})

test('a missing or non-finite height stays clipped instead of opening the range',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  for(const value of [Number.NaN,Infinity,-Infinity,undefined,null]){
    assert.equal(cloudHorizonBlend(value),0)
  }
})
