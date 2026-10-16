import test from 'node:test'
import assert from 'node:assert/strict'

test('visible distant clouds release the local range while steep downward views stay local',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  const rad=d=>d*Math.PI/180
  assert.equal(cloudHorizonBlend(-Math.PI/2,rad(60),12000),0)
  assert.equal(cloudHorizonBlend(-Math.PI/2,rad(75),8000000),0)
  assert.equal(cloudHorizonBlend(rad(-60),rad(60),3500),0)
  assert.equal(cloudHorizonBlend(0,rad(60),300),1)
  assert.equal(cloudHorizonBlend(rad(-10),rad(60),12000),1)
  let previous=0
  for(let pitch=-60;pitch<=0;pitch+=.1){
    const blend=cloudHorizonBlend(rad(pitch),rad(60),3500)
    assert.ok(blend>=previous&&blend<=1)
    assert.ok(blend-previous<.04,'orientation must not toggle the distance abruptly')
    previous=blend
  }
})

test('vertical field of view and geometric horizon dip determine when clouds extend',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  const rad=d=>d*Math.PI/180
  assert.equal(cloudHorizonBlend(rad(-35),rad(40),300),0)
  assert.ok(cloudHorizonBlend(rad(-35),rad(80),300)>0)
  assert.ok(cloudHorizonBlend(rad(-32),rad(60),12000)>cloudHorizonBlend(rad(-32),rad(60),300))
})

test('leaving the ground horizon does not retract clouds still visible beyond the local range',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  const rad=d=>d*Math.PI/180
  assert.equal(cloudHorizonBlend(rad(-21.5),rad(38.2),12000),1)
  assert.equal(cloudHorizonBlend(rad(-30),rad(38.2),12000),1)
})

test('orbital cameras retain local clipping at every orientation',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  for(const height of [100000,1000000,8000000])for(let pitch=-90;pitch<=90;pitch+=5)
    assert.equal(cloudHorizonBlend(pitch*Math.PI/180,Math.PI/3,height),0)
})

test('below-layer views do not lose distant clouds while the horizon is still on screen',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  const rad=d=>d*Math.PI/180
  assert.ok(cloudHorizonBlend(rad(-18),rad(38.2132),300)>0)
})

test('quality-specific proximity limits and editable cloud base stay finite and bounded',async()=>{
  const {cloudHorizonBlend}=await import('../../src/environment/cloudHorizon143.js')
  for(const range of [30000,40000,50000])for(const base of [50,1600,12000]){
    assert.equal(cloudHorizonBlend(0,1,range*2,6371000,base,range),0)
    for(const height of [300,12000,range,range*1.5]){
      const weight=cloudHorizonBlend(-.3,1,height,6371000,base,range)
      assert.ok(Number.isFinite(weight)&&weight>=0&&weight<=1)
    }
  }
})
