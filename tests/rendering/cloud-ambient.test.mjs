import test from 'node:test'
import assert from 'node:assert/strict'
import {cloudGLSL} from '../../src/environment/volumetricClouds143.js'

test('cloud ambient follows the same density to both hemisphere boundaries',()=>{
  const shader=cloudGLSL('balanced')
  assert.ok(shader.includes('ccrCloudAmbientVisibility(vec2'))
  assert.ok(shader.includes('ccrCloudOpticalDepth(position,up,'))
  assert.ok(shader.includes('ccrCloudOpticalDepth(position,-up,'))
  assert.ok(shader.includes('ccrCloudSkyScatteringSource(skyIrradiance) * skyGradient * ambientVisibility'))
})

test('LUT full-sphere mean does not receive an additional diffuse ground term',()=>{
  const shader=cloudGLSL('balanced')
  assert.ok(shader.includes('if(!atmosphereLutReady) lighting += ccrCloudGroundBounce('))
})
