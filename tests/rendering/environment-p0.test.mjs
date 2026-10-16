import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import EnvironmentRenderer from '../../src/environment/EnvironmentRenderer.js'
import { createEnvironmentStages } from '../../src/environment/environmentStages.js'
import { cloudGLSL } from '../../src/environment/volumetricClouds143.js'
import { PLANET_RADIUS_M } from '../../src/environment/atmosphereScattering143.js'
import noise from '../../src/environment/cloudNoiseData.js'
import { resolveEnvironmentState, ATMOSPHERE_HDR_INTENSITY } from '../../src/environment/environmentState.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('daylight atmosphere uses measured HDR calibration without cloud tint', () => {
  const day = resolveEnvironmentState({}, 1)
  assert.deepEqual(day.atmosphereSunRadiance, Array(3).fill(ATMOSPHERE_HDR_INTENSITY))
  assert.notDeepEqual(day.atmosphereSunRadiance, day.sunRadiance)
  assert.deepEqual(resolveEnvironmentState({ sunIntensity: 0 }, 1).atmosphereSunRadiance, [0, 0, 0])
})

test('atmosphere solar radiance dims through dusk and vanishes at night', () => {
  // The integral owns the solar spectrum and horizon extinction, but it still needs the sun to
  // actually go down: without this the sky stayed at full noon brightness after sunset.
  const noon = resolveEnvironmentState({}, 1).atmosphereSunRadiance[0]
  const dusk = resolveEnvironmentState({}, 0).atmosphereSunRadiance[0]
  const night = resolveEnvironmentState({}, -0.3).atmosphereSunRadiance[0]
  assert.ok(dusk > 0 && dusk < noon, `dusk ${dusk} must sit strictly between night and noon`)
  assert.equal(night, 0, 'the sky must be dark once the sun is well below the horizon')
  // A just-set sun keeps a small amount of light: this is the sunset band, not daylight.
  const justSet = resolveEnvironmentState({}, -0.05).atmosphereSunRadiance[0]
  assert.ok(justSet > 0 && justSet < dusk, `just-set ${justSet} must be dimmer than dusk`)
  // The preset still scales it, and the reported sunIntensity stays gated by `direct`.
  assert.equal(resolveEnvironmentState({}, -0.02).sunIntensity, 0)
  const overcast = resolveEnvironmentState({ environmentPreset: 'overcast' }, 1).atmosphereSunRadiance[0]
  assert.ok(overcast < noon, `overcast ${overcast} must be dimmer than clear noon`)
})

test('runtime atmosphere frame preserves WGS84 camera height and a stable ENU noise origin', () => {
  for (const [longitude, latitude] of [[0, 0], [123.410315, 41.761969], [0, 90]]) {
    const renderer = Object.create(EnvironmentRenderer.prototype)
    renderer.C = C
    renderer.scene = { globe: { ellipsoid: C.Ellipsoid.WGS84 } }
    renderer.inverseFrame = C.Matrix4.inverseTransformation(
      C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(longitude, latitude, 0)), new C.Matrix4())
    renderer.viewer = { camera: { positionWC: C.Cartesian3.fromDegrees(longitude, latitude, 2000) } }
    renderer.atmosphereOrigin = new C.Cartesian3()
    renderer.cloudNoiseOrigin = new C.Cartesian3()
    renderer.updateAtmosphereCamera()
    assert.ok(Math.abs(C.Cartesian3.magnitude(renderer.atmosphereOrigin) - PLANET_RADIUS_M - 2000) < 1e-5)
    assert.ok(Math.abs(renderer.cloudNoiseOrigin.z - 2000) < 1e-5)
    assert.ok(Math.abs(renderer.atmosphereOrigin.z - PLANET_RADIUS_M - 2000) < 1e-5)
  }
})

test('environment separates source radiance from full-resolution scene albedo and honours flags', () => {
  class Stage { constructor(options) { Object.assign(this, options) } }
  class Composite { constructor(options) { Object.assign(this, options) } }
  const bindings = Object.fromEntries(['eyeToLocal', 'atmosphereOrigin', 'cloudNoiseOrigin', 'originalHdr',
    'sunDirectionLocal', 'atmosphereSunRadiance', 'atmosphereMieParameters', 'sunRadiance', 'skyRadiance', 'cloudParams', 'cloudWind', 'noiseTexture',
    'atmosphereParams', 'effectFlags'].map(name => [name, () => null]))
  const stages = createEnvironmentStages({ ...C, PostProcessStage: Stage, PostProcessStageComposite: Composite }, bindings)
  assert.match(stages.raymarchStage.fragmentShader, /vec3 sceneColor = vec3\(0\.0\)/)
  assert.match(stages.resolveStage.fragmentShader, /vec3 surface = original\.rgb/)
  assert.match(stages.resolveStage.fragmentShader, /radiance \+ surface \* transmittance, original\.a/)
  assert.match(stages.resolveStage.fragmentShader, /texture\(environmentTransmission,sampleUv\)\.rgb \* weight/)
  assert.doesNotMatch(stages.resolveStage.fragmentShader, /ccrUnpackTransmittance|sampleMedium\.a/)
  assert.doesNotMatch(stages.resolveStage.fragmentShader, /environment\.rgb \* original\.a/)
  assert.match(stages.raymarchStage.fragmentShader, /effectFlags\.y/)
  assert.match(stages.raymarchStage.fragmentShader, /if \(effectFlags\.y > 0\.5\) \{\s*clouds = texture\(cloudColor,uv\)/)
  assert.match(stages.raymarchStage.fragmentShader, /bool atmosphereEnabled = effectFlags\.z > 0\.5;/)
  assert.match(stages.raymarchStage.fragmentShader, /bool fogEnabled\s*=\s*finiteSurface\s*&&\s*\(effectFlags\.x\s*>\s*0\.5\s*\|\|\s*effectFlags\.w\s*>\s*0\.5\);/)
  assert.match(stages.raymarchStage.fragmentShader, /clouds\.a \*/)
  assert.match(stages.raymarchStage.fragmentShader, /czm_unpackDepth\(texture\(surfaceDepthTexture/)
  assert.match(stages.occlusionStage.fragmentShader, /vec3 origin = atmosphereOrigin/)
  assert.equal(typeof stages.raymarchStage.uniforms.shellEmptyScene, 'function')
  assert.equal(typeof stages.resolveStage.uniforms.shellEmptyScene, 'function')
  assert.match(stages.resolveStage.fragmentShader, /if\(effectFlags\.y > 0\.5\) surface \*= ccrCloudSurfaceTransmission/)
  assert.match(stages.resolveStage.fragmentShader, /ccrCloudReceiverNormal\(uv,relativeSurface,direction\)/)
  assert.match(stages.resolveStage.fragmentShader, /dot\(left,left\)<dot\(right,right\)/)
  assert.doesNotMatch(stages.resolveStage.fragmentShader, /cross\(dFdx\(relativeSurface\),dFdy\(relativeSurface\)\)/)
  assert.match(stages.resolveStage.fragmentShader, /normal,centerDepth,50000\.0,centerDepth<DEPTH_LIMIT,sunRadiance,3\.14159265359\*skyRadiance/)
})

test('a cloud miss is transparent and scattering includes density in the source term', () => {
  const shader = cloudGLSL('balanced')
  assert.match(shader, /return vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/)
  assert.doesNotMatch(shader, /scatteringIntegral[^;]+\/ max\(density/)
  assert.match(shader, /vec4 intervals = ccrCloudShellIntervals\(origin, direction, limit\)/)
  assert.match(shader, /if \(pathLength <= 0\.0\) return vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/)
  assert.match(shader, /float sampleWeight = transmittance \* \(1\.0 - stepTransmittance\)/)
  assert.match(shader, /accumulated \+= lighting \* sampleWeight/)
})

test('custom sky restores native atmosphere on disable and respects external ownership', () => {
  const renderer = Object.create(EnvironmentRenderer.prototype)
  const sky = { show: true }
  renderer.nativeAtmosphere = { object: sky, before: true, applied: true }
  renderer.syncNativeAtmosphere(true)
  assert.equal(sky.show, false)
  renderer.syncNativeAtmosphere(false)
  assert.equal(sky.show, true)
  renderer.syncNativeAtmosphere(true)
  sky.show = true
  renderer.syncNativeAtmosphere(true)
  assert.equal(sky.show, true)
  assert.equal(renderer.nativeAtmosphere.released, true)
})

test('custom aerial perspective excludes native ground atmosphere and restores ownership', () => {
  const renderer = Object.create(EnvironmentRenderer.prototype)
  const globe = { showGroundAtmosphere: true }
  renderer.nativeGroundAtmosphere = { object: globe, before: true, applied: true }
  renderer.syncNativeGroundAtmosphere(true)
  assert.equal(globe.showGroundAtmosphere, false)
  renderer.syncNativeGroundAtmosphere(false)
  assert.equal(globe.showGroundAtmosphere, true)
  renderer.syncNativeGroundAtmosphere(true)
  globe.showGroundAtmosphere = true
  renderer.syncNativeGroundAtmosphere(true)
  assert.equal(globe.showGroundAtmosphere, true)
})

test('prepared cloud atlas has independent shape/detail/weather and wrapped RGB gutters', () => {
  assert.equal(noise.length, 528 * 528 * 4)
  let independent = 0
  for (let i = 0; i < noise.length; i += 4) {
    if (noise[i] !== noise[i + 1] && noise[i + 1] !== noise[i + 2]) independent++
    assert.equal(noise[i + 3], 255)
  }
  assert.ok(independent > 528 * 528 / 2, 'the channels must not duplicate one scalar random field')
  for (let slice = 0; slice < 64; slice++) for (let c = 0; c < 3; c++) {
    const x = slice % 8 * 66, y = Math.floor(slice / 8) * 66
    const pixel = (px, py) => noise[(py * 528 + px) * 4 + c]
    for (let i = 0; i < 66; i++) {
      assert.equal(pixel(x, y+i), pixel(x+64, y+i))
      assert.equal(pixel(x+65, y+i), pixel(x+1, y+i))
      assert.equal(pixel(x+i, y), pixel(x+i, y+64))
      assert.equal(pixel(x+i, y+65), pixel(x+i, y+1))
    }
  }
})
