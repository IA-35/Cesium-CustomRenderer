import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createEnvironmentStages } from '../../src/environment/environmentStages.js'
import createNoiseAtlas from '../../src/environment/noiseAtlas.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function create(quality = 'balanced') {
  const sourceSize = new C.Cartesian2(801, 603)
  const originalHdr = () => ({ hdr: true })
  return { ...createEnvironmentStages(C, { sourceSize: () => sourceSize, originalHdr }, quality),
    sourceSize, originalHdr }
}

test('volume and resolve are float stages in a sequential composite with borrowed original HDR', () => {
  const s = create()
  assert.equal(s.composite.inputPreviousStageTexture, true)
  assert.equal(s.composite.get(0), s.raymarchStage)
  assert.equal(s.composite.get(1), s.resolveStage)
  for (const stage of [s.raymarchStage, s.resolveStage]) {
    assert.equal(stage.pixelFormat, C.PixelFormat.RGBA)
    assert.equal(stage.pixelDatatype, C.PixelDatatype.FLOAT)
  }
  assert.equal(s.raymarchStage.textureScale, 0.5)
  assert.equal(s.resolveStage.textureScale, 1)
  assert.equal(s.resolveStage.uniforms.originalHdr, s.originalHdr)
  assert.deepEqual(s.resolveStage.uniforms.effectSize(), new C.Cartesian2(401, 302))
  s.sourceSize.x = 1200
  assert.equal(s.resolveStage.uniforms.effectSize().x, 600)
  s.composite.destroy()
})

test('quality changes finite march budgets and stage instances never collide', () => {
  const low = create()
  const high = create('high')
  assert.notEqual(low.composite.name, high.composite.name)
  assert.notEqual(low.raymarchStage.name, high.raymarchStage.name)
  assert.match(low.raymarchStage.fragmentShader, /#define FOG_STEPS 24/)
  assert.match(low.raymarchStage.fragmentShader, /#define CLOUD_STEPS 64/)
  assert.match(high.raymarchStage.fragmentShader, /#define FOG_STEPS 40/)
  assert.match(high.raymarchStage.fragmentShader, /#define CLOUD_STEPS 96/)
  low.composite.destroy()
  high.composite.destroy()
})

test('real Cesium generates reconstruction builtins in both depth modes and preserves linear output', () => {
  const s = create()
  for (const stage of [s.raymarchStage, s.resolveStage]) {
    for (const defines of [[], ['LOG_DEPTH']]) {
      const combined = new C.ShaderSource({ defines, sources: [stage.fragmentShader] })
        .createCombinedFragmentShader({ webgl2: true })
      assert.match(combined, /vec4 czm_windowToEyeCoordinates\(vec2 fragmentCoordinateXY, float depthOrLogDepth\)/)
      assert.match(combined, /vec4 czm_screenToEyeCoordinates\(vec2 screenCoordinateXY, float depthOrLogDepth\)/)
    }
    assert.doesNotMatch(stage.fragmentShader, /czm_gammaCorrect|czm_acesTonemapping/)
    // windowToEyeCoordinates divides by the active viewport before applying inverseProjection.
    assert.match(stage.fragmentShader, /uv \* czm_viewport\.zw \+ czm_viewport\.xy, rawDepth/)
    assert.doesNotMatch(stage.fragmentShader, /czm_windowToEyeCoordinates\(uv \* sourceSize/)
  }
  assert.match(s.resolveStage.fragmentShader, /original\.rgb \* integrated\.a \+ integrated\.rgb/)
  assert.match(s.resolveStage.fragmentShader, /original\.a/)
  s.composite.destroy()
})

test('noise atlas contains 64 periodic padded slices and a caller-owned linear RGBA texture', () => {
  let options
  class Texture { constructor(input) { options = input } }
  const context = {}
  const texture = createNoiseAtlas({ ...C, Texture }, context)
  assert.ok(texture instanceof Texture)
  assert.equal(options.context, context)
  assert.equal(options.pixelFormat, C.PixelFormat.RGBA)
  assert.equal(options.pixelDatatype, C.PixelDatatype.UNSIGNED_BYTE)
  assert.equal(options.flipY, false)
  assert.equal(options.sampler.minificationFilter, C.TextureMinificationFilter.LINEAR)
  assert.equal(options.sampler.magnificationFilter, C.TextureMagnificationFilter.LINEAR)
  const { width, height, arrayBufferView: data } = options.source
  assert.equal(width, 528)
  assert.equal(height, 528)
  assert.equal(data.length, width * height * 4)
  const pixel = (x, y) => data[(y * width + x) * 4]
  const samples = new Set()
  for (let slice = 0; slice < 64; slice++) {
    const x = slice % 8 * 66
    const y = Math.floor(slice / 8) * 66
    for (let k = 0; k < 66; k++) {
      assert.equal(pixel(x, y + k), pixel(x + 64, y + k))
      assert.equal(pixel(x + 65, y + k), pixel(x + 1, y + k))
      assert.equal(pixel(x + k, y), pixel(x + k, y + 64))
      assert.equal(pixel(x + k, y + 65), pixel(x + k, y + 1))
    }
    samples.add(pixel(x + 2, y + 2))
  }
  assert.ok(samples.size > 32, 'z slices must contain different spatial samples')
})
