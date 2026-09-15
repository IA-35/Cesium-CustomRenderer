import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudShellIntervals } from '../../src/environment/cloudShell143.js'
import { normalizeEnvironmentOptions } from '../../src/environment/environmentState.js'

const R = 6378137
const near = (a, b) => assert.ok(Math.abs(a - b) < .001, `${a} != ${b}`)
test('shell selects only clouds in front of the camera and before the surface', () => {
  near(cloudShellIntervals([0,0,R+20], [0,0,1], R, 1000, 2000)[0], 980)
  near(cloudShellIntervals([0,0,R+20], [0,0,1], R, 1000, 2000)[1], 1980)
  assert.deepEqual(cloudShellIntervals([0,0,R+20], [0,0,-1], R, 1000, 2000), [])
  assert.deepEqual(cloudShellIntervals([0,0,R+20], [0,0,1], R, 1000, 2000, 500), [])
})
test('inside and above clouds preserve both forward intersections without far-side Earth leakage', () => {
  near(cloudShellIntervals([0,0,R+1500], [0,0,1], R, 1000, 2000)[1], 500)
  near(cloudShellIntervals([0,0,R+1500], [0,0,-1], R, 1000, 2000)[1], 500)
  const above = cloudShellIntervals([0,0,R+20000], [0,0,-1], R, 1000, 2000)
  assert.equal(above.length, 2)
  near(above[0], 18000); near(above[1], 19000)
  assert.deepEqual(cloudShellIntervals([0,0,R+20000], [0,0,1], R, 1000, 2000), [])
})
test('tangent and limb rays produce finite intervals and default mode is shell', () => {
  const horizon = cloudShellIntervals([0,0,R+20], [1,0,0], R, 1000, 2000)
  assert.equal(horizon.length, 2)
  assert.ok(horizon[1] > horizon[0] && horizon.every(Number.isFinite))
  // A ray above the surface but through the cloud shell crosses two lobes.
  const limb = cloudShellIntervals([-200000,0,R+500], [1,0,0], R, 1000, 2000)
  assert.equal(limb.length, 4)
  assert.equal(normalizeEnvironmentOptions().cloudGeometry, 'shell')
  assert.equal(normalizeEnvironmentOptions({cloudGeometry:'shell'}).cloudGeometry, 'shell')
})
