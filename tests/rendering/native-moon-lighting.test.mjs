import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import NativeMoonLighting143 from '../../src/environment/NativeMoonLighting143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
  globalThis[name] ??= class {}
}
const source = path => readFileSync(new URL(`../../node_modules/@cesium/engine/Source/${path}`, import.meta.url), 'utf8')

function fixture() {
  assert.equal(typeof NativeMoonLighting143, 'function', 'native moon solar-light material adapter exists')
  const moon = new C.Moon({ textureUrl: C.Material.DefaultImageId, show: false })
  const original = moon._ellipsoidPrimitive.material
  const scene = { moon, skyAtmosphere: { show: false }, light: new C.DirectionalLight({ direction: C.Cartesian3.UNIT_X, intensity: 0 }) }
  return { scene, moon, original, adapter: new NativeMoonLighting143(C, scene) }
}

test('preexisting tinted or repeated Image materials remain owned by their caller',()=>{
  for(const overrides of [{color:new C.Color(.4,.5,.6,.2)},{repeat:new C.Cartesian2(2,1)}]) {
    const {moon,original,adapter}=fixture()
    Object.assign(original.uniforms,overrides)
    adapter.setActive(true)
    assert.equal(moon._ellipsoidPrimitive.material,original)
    adapter.destroy();original.destroy();moon.destroy()
  }
})

test('native Moon solar emission uses native texture gamma and alpha contracts independently of scene light', () => {
  const { scene, moon, original, adapter } = fixture()
  adapter.setActive(true)
  const material = moon._ellipsoidPrimitive.material
  assert.ok(material instanceof C.Material)
  assert.notEqual(material, original, 'a new material reference triggers native EllipsoidPrimitive recompilation')
  assert.match(material.shaderSource, /czm_gammaCorrect\(texel\.rgb\)/)
  assert.match(material.shaderSource, /material\.alpha\s*=\s*texel\.a/)
  assert.match(material.shaderSource, /material\.emission\s*=.*max\(dot\(.*czm_sunDirectionEC/)
  assert.match(material.shaderSource, /material\.diffuse\s*=\s*vec3\(0\.0\)/)
  assert.match(material.shaderSource, /material\.specular\s*=\s*0\.0/)
  assert.doesNotMatch(material.shaderSource, /czm_lightColor|czm_lightDirectionEC/)
  // Native environment draws precede geometry. A lunar depth beyond the short
  // single-frustum far plane must not reach czm_writeLogDepth and discard it.
  assert.equal(material.isTranslucent(), true)
  assert.equal(scene.light.intensity, 0)
  assert.equal(moon.show, false)
  assert.equal(scene.skyAtmosphere.show, false)
  const nativeImage = C.Material.fromType(C.Material.ImageType)
  assert.match(nativeImage.shaderSource, /czm_gammaCorrect\(texture\(image_\d+, fract\(repeat_\d+ \* materialInput.st\)\).rgb/)
  assert.match(source('Shaders/Builtin/Functions/phong.glsl'), /color = ambient \+ material.emission/)
  assert.match(source('Scene/EllipsoidPrimitive.js'), /this\._material !== this\.material/)
  adapter.destroy(); nativeImage.destroy(); original.destroy(); moon.destroy()
})

test('native Moon update continues to track textureUrl and preserves its geometry and rotation path', () => {
  const { moon, original, adapter } = fixture()
  adapter.setActive(true)
  const primitive = moon._ellipsoidPrimitive, radii = primitive.radii
  const material = primitive.material
  const update = primitive.update
  const icrf = C.Transforms.computeIcrfToFixedMatrix
  C.Transforms.computeIcrfToFixedMatrix = () => undefined
  primitive.update = () => {}
  moon.show = true
  moon.textureUrl = 'changed-moon-texture.jpg'
  try {
    moon.update({ time: C.JulianDate.fromIso8601('2026-10-15T00:00:00Z'), commandList: [] })
    assert.equal(material.uniforms.image, moon.textureUrl)
    assert.equal(primitive.radii, radii)
    assert.equal(primitive.onlySunLighting, true)
    assert.ok(C.Cartesian3.magnitude(C.Matrix4.getTranslation(primitive.modelMatrix, new C.Cartesian3())) > 300000000)
  } finally {
    primitive.update = update
    C.Transforms.computeIcrfToFixedMatrix = icrf
    adapter.destroy(); original.destroy(); moon.destroy()
  }
})

test('daylight and shutdown restore borrowed native material and destroy only the owned material', () => {
  const { moon, original, adapter } = fixture()
  adapter.setActive(true)
  const owned = moon._ellipsoidPrimitive.material
  adapter.setActive(false)
  assert.equal(moon._ellipsoidPrimitive.material, original)
  assert.equal(original.isDestroyed(), false)
  adapter.setActive(true)
  assert.equal(moon._ellipsoidPrimitive.material, owned)
  adapter.destroy(); adapter.destroy()
  assert.equal(moon._ellipsoidPrimitive.material, original)
  assert.equal(owned.isDestroyed(), true)
  assert.equal(original.isDestroyed(), false)
  original.destroy(); moon.destroy()
})

test('external material replacement retains ownership across updates, daylight and destroy', () => {
  const { moon, original, adapter } = fixture()
  adapter.setActive(true)
  const owned = moon._ellipsoidPrimitive.material
  const external = C.Material.fromType(C.Material.ImageType)
  moon._ellipsoidPrimitive.material = external
  adapter.setActive(true)
  adapter.setActive(false)
  adapter.setActive(true)
  adapter.destroy()
  assert.equal(moon._ellipsoidPrimitive.material, external)
  assert.equal(external.isDestroyed(), false)
  assert.equal(owned.isDestroyed(), true)
  external.destroy(); original.destroy(); moon.destroy()
})

test('absent Moon and unsupported Cesium versions do not create scene objects or materials', () => {
  assert.equal(typeof NativeMoonLighting143, 'function', 'native moon solar-light material adapter exists')
  const empty = {}
  const missing = new NativeMoonLighting143(C, empty)
  missing.setActive(true); missing.destroy()
  assert.deepEqual(empty, {})
  const { scene, moon, original, adapter } = fixture()
  const unsupported = new NativeMoonLighting143({ ...C, VERSION: '1.144.0' }, scene)
  unsupported.setActive(true)
  assert.equal(moon._ellipsoidPrimitive.material, original)
  assert.equal(unsupported.getDiagnostics().supported, false)
  unsupported.destroy(); adapter.destroy(); original.destroy(); moon.destroy()
})
