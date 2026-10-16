import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveCloudMotion} from '../../src/environment/cloudMotion143.js'

test('new metric field periods wrap continuously without wrapping material displacement',()=>{
  const periods={weather:[32000,32000,1],shape:[16000,16000,16000],detail:[1200,1200,1]}
  const speeds={weather:[8*.37,2*.37,0],shape:[8,2,-Math.sqrt(68)*.25],detail:[8*1.73,2*1.73,0]}
  for(const field of Object.keys(periods))for(let axis=0;axis<3;axis++){
    const velocity=speeds[field][axis],period=periods[field][axis]
    if(!velocity)continue
    const time=period/Math.abs(velocity),epsilon=.001
    const before=resolveCloudMotion(time-epsilon),after=resolveCloudMotion(time+epsilon)
    const phase=(after[field][axis]-before[field][axis]-velocity*2*epsilon)/period
    assert.ok(Math.abs(phase-Math.round(phase))<1e-10,`${field} axis ${axis}`)
    assert.ok(after[field][axis]>=0&&after[field][axis]<period)
    assert.ok(Math.abs(after.displacement[0]-before.displacement[0])<.02)
  }
})

