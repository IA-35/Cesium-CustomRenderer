import test from 'node:test'
import assert from 'node:assert/strict'
import {cloudGLSL} from '../../src/environment/volumetricClouds143.js'

test('cloud multiple scattering retains the reference high-order tail in optically thick light paths',()=>{
  const shader=cloudGLSL('balanced')
  const fn=shader.slice(shader.indexOf('float ccrCloudScattering('),shader.indexOf('// Hash jitter'))
  const count=Number(shader.match(/#define CLOUD_SCATTERING_OCTAVES (\d+)/)?.[1])
  assert.equal(count,8)
  assert.match(fn,/i < CLOUD_SCATTERING_OCTAVES/)
})

test('isotropic Hillaire mean radiance is not treated as hemispherical irradiance in the cloud source',()=>{
  const shader=cloudGLSL('balanced')
  assert.match(shader,/vec3 ccrCloudSkyScatteringSource\(/)
  const body=shader.slice(shader.indexOf('vec3 ccrCloudSkyScatteringSource('),shader.indexOf('// Hash jitter'))
  assert.match(body,/if\(atmosphereLutReady\)return hemisphereIrradiance\/3\.14159265359/)
  assert.doesNotMatch(body,/ccrLutMultipleScattering\(/)
  assert.doesNotMatch(body,/max\([^;]*ccrLutTransmittance|exposure|sunIntensity/)
})
