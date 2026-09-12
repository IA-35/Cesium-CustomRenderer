import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import EnvironmentLighting143 from '../../src/environment/EnvironmentLighting143.js'

const require = createRequire(import.meta.url)
const C = require('cesium/Build/Cesium/index.cjs')
const settings = { skyIntensity: 2.8, sunIntensity: 2, sunColor: new C.Color(1, 0.95, 0.9),
  rayleighScale: 1.2, mieScale: 1.4, atmosphereIntensity: 11, skyAtmosphereIntensity: 45 }

function fixture() {
  const scene = { light: new C.DirectionalLight({ direction: C.Cartesian3.UNIT_X }),
    atmosphere: new C.Atmosphere(), skyAtmosphere: new C.SkyAtmosphere(),
    globe: { enableLighting: false, dynamicAtmosphereLighting: false, dynamicAtmosphereLightingFromSun: false },
    primitives: new C.PrimitiveCollection({ destroyPrimitives: false }),
    context: { halfFloatingPointTexture: true } }
  return { scene, lighting: new EnvironmentLighting143(C, scene) }
}

function tileset() { return new C.Cesium3DTileset() }

test('daylight hides the star background and night and cleanup restore its original visibility', () => {
  const { scene, lighting } = fixture()
  scene.skyBox = { show: true }
  lighting.setEnabled(true)
  lighting.apply({ daylight: 1 })
  assert.equal(scene.skyBox.show, false)
  assert.equal(scene.skyAtmosphere.perFragmentAtmosphere, true)
  lighting.apply({ daylight: 0 })
  assert.equal(scene.skyBox.show, true)
  lighting.apply({ daylight: 1 })
  lighting.setEnabled(false)
  assert.equal(scene.skyBox.show, true)
  assert.equal(scene.skyAtmosphere.perFragmentAtmosphere, false)
  scene.skyBox.show = false
  lighting.setEnabled(true)
  lighting.apply({ daylight: 0 })
  assert.equal(scene.skyBox.show, false)
  lighting.destroy()
})

test('legacy campus base-color assets keep diffuse sky lighting without grazing sky glare', () => {
  const { scene, lighting } = fixture()
  const campus = tileset()
  campus._resource = new C.Resource('http://localhost/Dongda/SM_NH_Terr/tileset.json')
  const original = campus.imageBasedLighting.imageBasedLightingFactor
  scene.primitives.add(campus)
  lighting.setEnabled(true)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor.x, 1)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor.y, 0)
  const applied = campus.imageBasedLighting.imageBasedLightingFactor
  lighting.apply(settings)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor, applied)
  lighting.setEnabled(false)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor, original)
  lighting.setEnabled(true)
  const external = new C.Cartesian2(.7, .5)
  campus.imageBasedLighting.imageBasedLightingFactor = external
  const assigned = campus.imageBasedLighting.imageBasedLightingFactor
  lighting.apply(settings)
  lighting.setEnabled(false)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor, assigned)
  assert.deepEqual(assigned, external)
  lighting.destroy(); campus.destroy(); scene.primitives.destroy()
})

test('campus material compatibility preserves explicit IBL settings and other PBR assets', () => {
  const { scene, lighting } = fixture()
  const campus = tileset(), pbr = tileset()
  campus._resource = new C.Resource('http://localhost/Dongda/SM_NH_Building/tileset.json')
  campus.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(.8, .6)
  const original = campus.imageBasedLighting.imageBasedLightingFactor
  pbr._resource = new C.Resource('http://localhost/glass/tileset.json')
  scene.primitives.add(campus); scene.primitives.add(pbr)
  lighting.setEnabled(true)
  assert.equal(campus.imageBasedLighting.imageBasedLightingFactor, original)
  assert.equal(pbr.imageBasedLighting.imageBasedLightingFactor.y, 1)
  lighting.destroy(); campus.destroy(); pbr.destroy(); scene.primitives.destroy()
})

test('uses the shipped 1.143 public API and restores owned sunlight and atmosphere', () => {
  assert.equal(C.VERSION, '1.143.0')
  const { scene, lighting } = fixture()
  const original = { light: scene.light, rayleigh: scene.atmosphere.rayleighCoefficient,
    skyMie: scene.skyAtmosphere.atmosphereMieCoefficient }
  lighting.apply(settings)
  assert.equal(scene.light, original.light)
  lighting.setEnabled(true)
  assert.ok(scene.light instanceof C.SunLight)
  assert.equal(scene.light.intensity, 2)
  assert.ok(C.Color.equals(scene.light.color, settings.sunColor))
  assert.equal(scene.atmosphere.dynamicLighting, C.DynamicAtmosphereLightingType.SUNLIGHT)
  assert.equal(scene.globe.dynamicAtmosphereLightingFromSun, true)
  assert.equal(scene.atmosphere.lightIntensity, 11)
  assert.equal(scene.skyAtmosphere.atmosphereLightIntensity, 45)
  assert.notEqual(scene.atmosphere.rayleighCoefficient, original.rayleigh)
  assert.equal(original.rayleigh.x, 5.5e-6)
  lighting.apply({ ...settings, sunIntensity: 0 })
  assert.equal(scene.light.intensity, 0)
  lighting.setEnabled(false)
  assert.equal(scene.light, original.light)
  assert.equal(scene.atmosphere.rayleighCoefficient, original.rayleigh)
  assert.equal(scene.skyAtmosphere.atmosphereMieCoefficient, original.skyMie)
  assert.equal(scene.atmosphere.lightIntensity, 10)
  assert.equal(scene.globe.enableLighting, false)
  lighting.setEnabled(true)
  assert.ok(scene.light instanceof C.SunLight)
  assert.equal(scene.light.intensity, 0)
  lighting.destroy()
  assert.equal(scene.light, original.light)
  lighting.destroy()
  assert.equal(lighting.isDestroyed(), true)
})

test('discovers late nested tilesets without replacing IBL or changing disabled managers', () => {
  const { scene, lighting } = fixture()
  lighting.setEnabled(true)
  const group = scene.primitives.add(new C.PrimitiveCollection({ destroyPrimitives: false }))
  const active = group.add(tileset()), disabled = group.add(tileset())
  const ibl = active.imageBasedLighting
  ibl.imageBasedLightingFactor = new C.Cartesian2(0.4, 0.7)
  ibl.sphericalHarmonicCoefficients = Array.from({ length: 9 }, () => new C.Cartesian3(1, 1, 1))
  ibl.specularEnvironmentMaps = 'user-environment.ktx2'
  const sh = ibl.sphericalHarmonicCoefficients
  disabled.environmentMapManager.enabled = false
  lighting.apply(settings)
  assert.equal(active.environmentMapManager.atmosphereScatteringIntensity, 2.8)
  assert.equal(active.environmentMapManager.maximumSecondsDifference, 60)
  assert.equal(active.imageBasedLighting, ibl)
  assert.equal(ibl.sphericalHarmonicCoefficients, sh)
  assert.equal(ibl.specularEnvironmentMaps, 'user-environment.ktx2')
  assert.deepEqual(ibl.imageBasedLightingFactor, new C.Cartesian2(0.4, 0.7))
  assert.equal(disabled.environmentMapManager.atmosphereScatteringIntensity, 2)
  assert.equal(disabled.environmentMapManager.enabled, false)
  lighting.destroy()
  assert.equal(active.environmentMapManager.atmosphereScatteringIntensity, 2)
  assert.equal(active.environmentMapManager.maximumSecondsDifference, 3600)
  assert.equal(active.isDestroyed(), false)
  assert.equal(ibl.isDestroyed(), false)
  active.destroy(); disabled.destroy()
})

test('refreshes environment only on changed configuration and restores on removal', () => {
  const { scene, lighting } = fixture()
  const model = scene.primitives.add(tileset()), manager = model.environmentMapManager
  lighting.apply(settings)
  lighting.setEnabled(true)
  assert.equal(manager.position, undefined)
  manager.position = new C.Cartesian3(6378137, 0, 0)
  const position = manager.position
  lighting.apply(settings)
  assert.equal(manager.position, position)
  lighting.apply({ ...settings, mieScale: 2 })
  assert.equal(manager.position, undefined)
  manager.position = new C.Cartesian3(6378137, 0, 0)
  lighting.apply({ ...settings, mieScale: 2 })
  assert.notEqual(manager.position, undefined)
  scene.primitives.remove(model)
  lighting.apply(settings)
  assert.equal(manager.atmosphereScatteringIntensity, 2)
  assert.equal(manager.maximumSecondsDifference, 3600)
  assert.equal(manager.position, undefined)
  lighting.destroy(); model.destroy()
})

test('external scene and manager changes retain ownership through apply and cleanup', () => {
  const { scene, lighting } = fixture()
  const model = scene.primitives.add(tileset()), manager = model.environmentMapManager
  lighting.setEnabled(true)
  const external = new C.DirectionalLight({ direction: C.Cartesian3.UNIT_Y })
  scene.light = external
  manager.atmosphereScatteringIntensity = 7
  scene.atmosphere.lightIntensity = 4
  lighting.apply(settings)
  assert.equal(scene.light, external)
  assert.equal(manager.atmosphereScatteringIntensity, 7)
  assert.equal(scene.atmosphere.lightIntensity, 4)
  lighting.destroy()
  assert.equal(scene.light, external)
  assert.equal(manager.atmosphereScatteringIntensity, 7)
  assert.equal(scene.atmosphere.lightIntensity, 4)
  model.destroy()
})

test('independent Models retain their IBL and regain their original manager settings', () => {
  const { scene, lighting } = fixture()
  // No rendering or network is required to exercise the shipped Model's public
  // environment properties; only its unloaded resource loader is stubbed.
  const model = scene.primitives.add(new C.Model({ loader: { destroy() {} } }))
  const manager = model.environmentMapManager, ibl = model.imageBasedLighting
  lighting.setEnabled(true)
  assert.equal(manager.atmosphereScatteringIntensity, 2.8)
  lighting.destroy()
  assert.equal(model.environmentMapManager, manager)
  assert.equal(model.imageBasedLighting, ibl)
  assert.equal(manager.atmosphereScatteringIntensity, 2)
  assert.equal(model.isDestroyed(), false)
  model.destroy()
})

test('unsupported dynamic mapping leaves manager configuration untouched', () => {
  const { scene } = fixture()
  scene.context = {}
  const model = scene.primitives.add(tileset())
  const lighting = new EnvironmentLighting143(C, scene)
  lighting.setEnabled(true)
  assert.equal(lighting.getDiagnostics().supported, false)
  assert.equal(lighting.getDiagnostics().managerCount, 0)
  assert.equal(model.environmentMapManager.atmosphereScatteringIntensity, 2)
  lighting.destroy(); model.destroy()
})

test('dead assets and missing capabilities are safe and unsupported status is explicit', () => {
  const { scene, lighting } = fixture()
  const model = scene.primitives.add(tileset())
  lighting.setEnabled(true)
  model.destroy()
  lighting.apply(settings)
  lighting.destroy()
  const minimal = new EnvironmentLighting143({ SunLight: class {} }, { light: {} })
  minimal.setEnabled(true)
  minimal.apply(settings)
  assert.equal(minimal.getDiagnostics().supported, false)
  minimal.destroy()
  assert.equal(lighting.getDiagnostics().supported, true)
})
