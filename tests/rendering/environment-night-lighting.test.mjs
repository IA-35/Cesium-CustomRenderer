import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolveEnvironmentState } from '../../src/environment/environmentState.js'
import EnvironmentLighting143 from '../../src/environment/EnvironmentLighting143.js'
import EnvironmentRenderer from '../../src/environment/EnvironmentRenderer.js'

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('night radiance fades with moon phase and altitude while preserving daylight state', () => {
  const full = resolveEnvironmentState({}, -0.3, 0, { moonHeight: 0.7, moonPhase: 1 })
  assert.equal(full.nightWeight, 1)
  assert.deepEqual(full.moonRadiance, [0.65 * 0.15, 0.8 * 0.15, 0.15])
  assert.deepEqual(full.nightSkyRadiance, [0.012, 0.022, 0.045])
  for (const celestial of [{ moonHeight: 0.7, moonPhase: 0 }, { moonHeight: -0.1, moonPhase: 1 }]) {
    assert.deepEqual(resolveEnvironmentState({}, -0.3, 0, celestial).moonRadiance, [0, 0, 0])
  }
  const twilight = resolveEnvironmentState({}, -0.065, 0, { moonHeight: 0.7, moonPhase: 0.5 })
  assert.ok(Math.abs(twilight.nightWeight - 0.5) < 1e-12)
  assert.ok(Math.abs(twilight.moonRadiance[2] - 0.0375) < 1e-12)
  for (const height of [-0.01, 0, 0.5, 1]) {
    const day = resolveEnvironmentState({}, height, 30)
    const withMoon = resolveEnvironmentState({}, height, 30, { moonHeight: 1, moonPhase: 1 })
    assert.equal(withMoon.nightWeight, 0)
    assert.deepEqual(withMoon.moonRadiance, [0, 0, 0])
    assert.deepEqual(withMoon.nightSkyRadiance, [0, 0, 0])
    for (const key of ['daylight', 'sunIntensity', 'sunColor', 'sunRadiance', 'atmosphereSunRadiance', 'skyRadiance']) {
      assert.deepEqual(withMoon[key], day[key])
    }
  }
  assert.deepEqual(resolveEnvironmentState({ skyLightIntensity: 0 }, -0.3, 0).nightSkyRadiance, [0, 0, 0])
})

function lightingFixture() {
  const C = Cesium
  const original = new C.SunLight()
  const scene = { light: original, globe: {}, skyBox: { show: false }, moon: { show: false },
    skyAtmosphere: { show: false }, primitives: new C.PrimitiveCollection({ destroyPrimitives: false }) }
  const lighting = new EnvironmentLighting143(C, scene)
  lighting.setEnabled(true)
  return { C, scene, lighting, original }
}

test('night uses actual native directional moonlight and restores the original scene light', () => {
  const { C, scene, lighting, original } = lightingFixture()
  const moonDirectionWC = C.Cartesian3.normalize(new C.Cartesian3(1, 2, 3), new C.Cartesian3())
  lighting.apply({ nightWeight: 1, moonDirectionWC, moonRadiance: [0.0975, 0.12, 0.15] })
  assert.ok(scene.light instanceof C.DirectionalLight)
  assert.deepEqual(scene.light.direction, C.Cartesian3.negate(moonDirectionWC, new C.Cartesian3()))
  assert.equal(scene.light.intensity, 0.15)
  assert.ok(C.Math.equalsEpsilon(scene.light.color.red, 0.65, 1e-12))
  assert.equal(scene.skyBox.show, false)
  assert.equal(scene.moon.show, false)
  assert.equal(scene.skyAtmosphere.show, false)
  assert.equal(lighting.getDiagnostics().activeLight, 'moon')
  lighting.apply({ nightWeight: 0, sunIntensity: 2.2 })
  assert.equal(scene.light, lighting.sun)
  lighting.setEnabled(false)
  assert.equal(scene.light, original)
  lighting.destroy()
})

test('moon direction updates every frame and external scene light keeps ownership', () => {
  const { C, scene, lighting } = lightingFixture()
  lighting.apply({ nightWeight: 1, moonDirectionWC: C.Cartesian3.UNIT_X, moonRadiance: [0.065, 0.08, 0.1] })
  lighting.apply({ moonDirectionWC: C.Cartesian3.UNIT_Y })
  assert.ok(C.Cartesian3.equals(scene.light.direction, new C.Cartesian3(0, -1, 0)))
  const external = new C.DirectionalLight({ direction: C.Cartesian3.UNIT_Z })
  scene.light = external
  lighting.apply({ moonDirectionWC: C.Cartesian3.UNIT_Z })
  lighting.destroy()
  assert.equal(scene.light, external)
})

test('moonless native models receive material diffuse night IBL and regain native daylight IBL', () => {
  const { C, scene, lighting } = lightingFixture()
  const model = scene.primitives.add(new C.Cesium3DTileset())
  const ibl = model.imageBasedLighting, originalFactor = ibl.imageBasedLightingFactor
  lighting.apply({ nightWeight: 1, nightSkyRadiance: [0.012, 0.022, 0.045], moonDirectionWC: C.Cartesian3.UNIT_Z,
    moonRadiance: [0, 0, 0] })
  const sh = ibl.sphericalHarmonicCoefficients
  assert.equal(sh?.length, 9)
  assert.deepEqual(sh[0], new C.Cartesian3(0.012, 0.022, 0.045))
  assert.ok(sh.slice(1).every(v => C.Cartesian3.equals(v, C.Cartesian3.ZERO)))
  assert.equal(scene.light.intensity, 0)
  assert.equal(ibl.imageBasedLightingFactor, originalFactor)
  lighting.apply({ nightWeight: 0, nightSkyRadiance: [0, 0, 0] })
  assert.equal(ibl.sphericalHarmonicCoefficients, undefined)
  lighting.destroy(); model.destroy()
})

test('night IBL preserves custom SH and relinquishes ownership when externally changed', () => {
  const { C, scene, lighting } = lightingFixture()
  const custom = scene.primitives.add(new C.Cesium3DTileset())
  const managed = scene.primitives.add(new C.Cesium3DTileset())
  const userSh = Array.from({ length: 9 }, () => new C.Cartesian3(0.2, 0.3, 0.4))
  custom.imageBasedLighting.sphericalHarmonicCoefficients = userSh
  lighting.apply({ nightWeight: 1, nightSkyRadiance: [0.012, 0.022, 0.045] })
  assert.equal(custom.imageBasedLighting.sphericalHarmonicCoefficients, userSh)
  assert.notEqual(managed.imageBasedLighting.sphericalHarmonicCoefficients, undefined)
  managed.imageBasedLighting.sphericalHarmonicCoefficients = userSh
  lighting.apply({ nightSkyRadiance: [0.013, 0.023, 0.046] })
  lighting.setEnabled(false)
  assert.equal(managed.imageBasedLighting.sphericalHarmonicCoefficients, userSh)
  assert.equal(custom.imageBasedLighting.sphericalHarmonicCoefficients, userSh)
  lighting.destroy(); custom.destroy(); managed.destroy()
})

test('paused twilight refreshes managed native SH without traversing the primitive tree', () => {
  const { C, scene, lighting } = lightingFixture()
  const model = scene.primitives.add(new C.Cesium3DTileset())
  const manager = model.environmentMapManager
  manager._sphericalHarmonicCoefficients = Array.from({ length: 9 }, () => new C.Cartesian3(2, 4, 6))
  lighting.apply({ nightWeight: 0.5, nightSkyRadiance: [0.006, 0.011, 0.0225] })
  const sh = model.imageBasedLighting.sphericalHarmonicCoefficients
  assert.equal(sh[0].x, 1.006)
  const get = scene.primitives.get
  scene.primitives.get = () => assert.fail('unchanged primitive membership must not trigger a tree traversal')
  try {
    manager._sphericalHarmonicCoefficients = Array.from({ length: 9 }, () => new C.Cartesian3(8, 10, 12))
    lighting.apply({})
    assert.equal(model.imageBasedLighting.sphericalHarmonicCoefficients, sh)
    assert.deepEqual(sh[0], new C.Cartesian3(4.006, 5.011, 6.0225))
    assert.deepEqual(sh[1], new C.Cartesian3(4, 5, 6))
  } finally {
    scene.primitives.get = get
    lighting.destroy(); model.destroy()
  }
})

function rendererFixture(moon, sun) {
  const C = { ...Cesium, Simon1994PlanetaryPositions: {
    computeSunPositionInEarthInertialFrame: (_, result) => Cesium.Cartesian3.clone(sun, result),
    computeMoonPositionInEarthInertialFrame: (_, result) => Cesium.Cartesian3.clone(moon, result),
  }, Transforms: { ...Cesium.Transforms, computeIcrfToFixedMatrix: () => undefined,
    computeTemeToPseudoFixedMatrix: () => Cesium.Matrix3.IDENTITY } }
  const renderer = Object.create(EnvironmentRenderer.prototype)
  Object.assign(renderer, { C, enabled: true, destroyed: false,
    viewer: { isDestroyed: () => false, clock: { currentTime: C.JulianDate.fromIso8601('2026-10-15T00:00:00Z') } },
    scene: {}, epoch: C.JulianDate.fromIso8601('2026-01-01T00:00:00Z'), getOptions: () => ({}),
    frame: C.Matrix4.IDENTITY, inverseFrame: C.Matrix4.IDENTITY, origin: new C.Cartesian3(),
    fixedRotation: new C.Matrix3(), sunInertial: new C.Cartesian3(), sunWorld: new C.Cartesian3(), sunLocal: new C.Cartesian3(),
    moonInertial: new C.Cartesian3(), moonWorld: new C.Cartesian3(), moonLocal: new C.Cartesian3(),
    state: resolveEnvironmentState(), lighting: { apply(settings) { renderer.applied = settings } },
    hdr: { enabled: false, error: 'skip GPU allocation', _scopeReason: () => null }, integrations: {} })
  return renderer
}

test('renderer computes independent moon direction and Lambert phase without a camera or moon API', () => {
  const full = rendererFixture(new Cesium.Cartesian3(0, 0, 10), new Cesium.Cartesian3(0, 0, -20))
  full.update()
  assert.deepEqual(full.moonWorld, Cesium.Cartesian3.UNIT_Z)
  assert.deepEqual(full.moonLocal, Cesium.Cartesian3.UNIT_Z)
  assert.equal(full.state.moonPhase, 1)
  assert.equal(full.state.moonHeight, 1)
  assert.deepEqual(full.applied.moonDirectionWC, Cesium.Cartesian3.UNIT_Z)
  const dark = rendererFixture(new Cesium.Cartesian3(0, 0, -10), new Cesium.Cartesian3(0, 0, -20))
  dark.update()
  assert.equal(dark.state.moonPhase, 0)
  const quarter = rendererFixture(new Cesium.Cartesian3(1, 0, 0), new Cesium.Cartesian3(0, 0, -20))
  quarter.update()
  assert.ok(Math.abs(quarter.state.moonPhase - 1 / Math.PI) < 1e-12)
})

test('near-horizon lunar parallax puts the native Moon below the observer horizon with zero direct energy', () => {
  const C = Cesium, radius = 6378137, distance = 384400000, elevation = 0.005
  const moon = new C.Cartesian3(distance * Math.sin(elevation), distance * Math.cos(elevation), 0)
  const renderer = rendererFixture(moon, new C.Cartesian3(-1e11, 0, 0))
  const observer = new C.Cartesian3(radius, 0, 0)
  renderer.origin = observer
  renderer.viewer.camera = { positionWC: observer }
  renderer.frame = C.Transforms.eastNorthUpToFixedFrame(observer)
  renderer.inverseFrame = C.Matrix4.inverseTransformation(renderer.frame, new C.Matrix4())
  renderer.update()
  assert.equal(renderer.withinRegion, true)
  assert.ok(Math.asin(moon.x / distance) > 0, 'geocentric Moon is above the horizon')
  const expected = C.Cartesian3.normalize(C.Cartesian3.subtract(moon, observer, new C.Cartesian3()), new C.Cartesian3())
  assert.ok(C.Cartesian3.equalsEpsilon(renderer.moonWorld, expected, 1e-12))
  assert.ok(renderer.state.moonHeight < 0, 'topocentric native Moon is below the horizon')
  assert.ok(Math.abs(C.Math.toDegrees(Math.asin(renderer.state.moonHeight)) + 0.664) < 0.002)
  assert.deepEqual(renderer.state.moonRadiance, [0, 0, 0])
  const expectedLocal = C.Matrix4.multiplyByPointAsVector(renderer.inverseFrame, expected, new C.Cartesian3())
  assert.ok(C.Cartesian3.equalsEpsilon(renderer.moonLocal, expectedLocal, 1e-12))
  const phaseAngle = Math.acos(Math.sin(elevation))
  const expectedPhase = (Math.sin(phaseAngle) + (Math.PI - phaseAngle) * Math.cos(phaseAngle)) / Math.PI
  assert.ok(Math.abs(renderer.state.moonPhase - expectedPhase) < 1e-12, 'phase retains the geocentric approximation')
})

test('moon height uses observer geodetic up within the region while its atmosphere direction uses the existing ENU frame', () => {
  const C = Cesium, moon = new C.Cartesian3(3.5e8, 1.1e8, 0.6e8)
  const renderer = rendererFixture(moon, new C.Cartesian3(-1e11, 0, -1e11))
  const observer = C.Cartesian3.fromDegrees(0, 45, 100)
  renderer.origin = C.Cartesian3.fromDegrees(0, 44.5)
  renderer.viewer.camera = { positionWC: observer }
  renderer.frame = C.Transforms.eastNorthUpToFixedFrame(renderer.origin)
  renderer.inverseFrame = C.Matrix4.inverseTransformation(renderer.frame, new C.Matrix4())
  renderer.update()
  const expected = C.Cartesian3.normalize(C.Cartesian3.subtract(moon, observer, new C.Cartesian3()), new C.Cartesian3())
  const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(observer, new C.Cartesian3())
  assert.equal(renderer.withinRegion, true)
  assert.ok(Math.abs(renderer.state.moonHeight - C.Cartesian3.dot(up, expected)) < 1e-12)
  assert.ok(Math.abs(renderer.state.moonHeight - renderer.moonLocal.z) > 1e-4)
  assert.ok(C.Cartesian3.equalsEpsilon(renderer.moonLocal,
    C.Matrix4.multiplyByPointAsVector(renderer.inverseFrame, expected, new C.Cartesian3()), 1e-12))
})
