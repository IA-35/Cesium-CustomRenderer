import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createEnvironmentStages } from '../../src/environment/environmentStages.js'
import createNoiseAtlas from '../../src/environment/noiseAtlas.js'
import { PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M, MIE_SCALE_HEIGHT, RAYLEIGH_SCALE_HEIGHT } from '../../src/environment/atmosphereScattering143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

function create(quality = 'balanced') {
  const sourceSize = new C.Cartesian2(801, 603)
  const originalHdr = () => ({ hdr: true })
  // The rewrite marches in metres, so the fixture supplies the same uniform set
  // EnvironmentRenderer builds rather than the old fog profile.
  const uniforms = {
    sourceSize: () => sourceSize,
    originalHdr,
    sunDirectionLocal: () => new C.Cartesian3(0, 0, 1),
    sunRadiance: () => new C.Cartesian3(1, 0.95, 0.85),
    skyRadiance: () => new C.Cartesian3(0.4, 0.5, 0.7),
    eyeToLocal: () => C.Matrix4.IDENTITY,
    cloudParams: () => new C.Cartesian4(0.42, 1600, 2800, 0.02),
    windOffset: () => new C.Cartesian3(0, 0, 0),
    noiseTexture: () => null,
    atmosphereParams: () => new C.Cartesian4(PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M,
      1 / MIE_SCALE_HEIGHT, 1 / RAYLEIGH_SCALE_HEIGHT),
    surfaceDepthTexture: () => null,
    surfaceDepthAvailable: () => false,
    shellEmptyScene: () => false
  }
  return { ...createEnvironmentStages(C, uniforms, quality), sourceSize, originalHdr }
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
  const low = create('performance')
  const high = create('high')
  assert.notEqual(low.composite.name, high.composite.name)
  assert.notEqual(low.raymarchStage.name, high.raymarchStage.name)
  // Both marches must scale with the tier, and the product is what actually costs.
  assert.match(low.raymarchStage.fragmentShader, /#define ATMOS_OUTER_STEPS 8/)
  assert.match(low.raymarchStage.fragmentShader, /#define CLOUD_STEPS 24/)
  assert.match(high.raymarchStage.fragmentShader, /#define ATMOS_OUTER_STEPS 16/)
  assert.match(high.raymarchStage.fragmentShader, /#define CLOUD_STEPS 80/)
  low.composite.destroy()
  high.composite.destroy()
})

test('the cloud tier replaces the per-step density integral with a binary sun count', () => {
  const balanced = create('balanced')
  const performance = create('performance')
  const shader = balanced.raymarchStage.fragmentShader
  // Balanced and high keep six sun taps; performance halves them.
  assert.match(shader, /#define CLOUD_LIGHT_STEPS 6/)
  assert.match(performance.raymarchStage.fragmentShader, /#define CLOUD_LIGHT_STEPS 4/)
  // The article's count-then-transmit formulation is what replaced the optical depth integral:
  // the sun march must not call the full density function at all.
  const sunBody = shader.slice(shader.indexOf('float ccrCloudSunVisibility'), shader.indexOf('float ccrCloudJitter'))
  assert.match(sunBody, /inside \+= 1\.0/)
  assert.doesNotMatch(sunBody, /ccrCloudDensity\(/)
  // The atmosphere must not texture-fetch anywhere on its scattering path. Slice only up to the
  // cloud module, which legitimately samples the noise atlas.
  const atmosphereBody = shader.slice(shader.indexOf('vec3 ccrAtmosphere('), shader.indexOf('float ccrNoiseVoxel'))
  assert.ok(atmosphereBody.length > 200, 'the atmosphere body must be found')
  assert.doesNotMatch(atmosphereBody, /texture\(|texelFetch\(/)
  balanced.composite.destroy()
  performance.composite.destroy()
})

test('real Cesium generates reconstruction builtins and the half-res resolve stays linear', () => {
  const s = create()
  // Only the stages that read scene depth pull in the reconstruction builtins; the resolve stage
  // is a plain full-screen copy of the environment colour.
  for (const stage of [s.raymarchStage, s.occlusionStage]) {
    for (const defines of [[], ['LOG_DEPTH']]) {
      const combined = new C.ShaderSource({ defines, sources: [stage.fragmentShader] })
        .createCombinedFragmentShader({ webgl2: true })
      assert.match(combined, /vec4 czm_windowToEyeCoordinates\(vec2 fragmentCoordinateXY, float depthOrLogDepth\)/)
      assert.match(combined, /vec4 czm_screenToEyeCoordinates\(vec2 screenCoordinateXY, float depthOrLogDepth\)/)
    }
    assert.doesNotMatch(stage.fragmentShader, /czm_gammaCorrect|czm_acesTonemapping/)
    // windowToEyeCoordinates divides by the active viewport before applying inverseProjection, so
    // the uv must be normalised back even though this pass renders at half size.
    assert.match(stage.fragmentShader, /uv \* czm_viewport\.zw \+ czm_viewport\.xy, rawDepth/)
    assert.doesNotMatch(stage.fragmentShader, /czm_windowToEyeCoordinates\(uv \* sourceSize/)
  }
  // The resolve adds the premultiplied environment over the scene without touching its alpha.
  assert.match(s.resolveStage.fragmentShader, /original\.rgb \+ environment\.rgb \* original\.a/)
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
