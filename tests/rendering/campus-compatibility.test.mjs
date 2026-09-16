import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import EnvironmentLighting143 from '../../examples/compat/CampusAssetCompatibility.js'

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
