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
    atmosphereSunRadiance: () => new C.Cartesian3(20, 20, 20),
    atmosphereMieParameters: () => new C.Cartesian2(0.65, 0.9),
    skyRadiance: () => new C.Cartesian3(0.4, 0.5, 0.7),
    eyeToLocal: () => C.Matrix4.IDENTITY,
    atmosphereOrigin: () => new C.Cartesian3(0, 0, PLANET_RADIUS_M + 100),
    cloudNoiseOrigin: () => new C.Cartesian3(0, 0, 100),
    effectFlags: () => new C.Cartesian4(1, 1, 1, 1),
    cloudParams: () => new C.Cartesian4(0.42, 1600, 2800, 0.02),
    windOffset: () => new C.Cartesian3(0, 0, 0),
    noiseTexture: () => null,
    atmosphereParams: () => new C.Cartesian4(PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M,
      1 / MIE_SCALE_HEIGHT, 1 / RAYLEIGH_SCALE_HEIGHT),
    surfaceDepthTexture: () => null,
    surfaceDepthAvailable: () => false,
    shellEmptyScene: () => false
  }
  const stages = createEnvironmentStages(C, uniforms, quality)
  return { ...stages, sourceSize, originalHdr, destroy() {
    for (const stage of [stages.composite, stages.cloudComposite, stages.occlusionStage]) {
      if (!stage.isDestroyed()) stage.destroy()
    }
  } }
}

test('volume, RGB transmission and resolve are float stages with borrowed original HDR', () => {
  const s = create()
  assert.equal(s.composite.inputPreviousStageTexture, true)
  assert.equal(s.composite.get(0), s.raymarchStage)
  assert.equal(s.composite.length, 3)
  assert.equal(s.composite.get(1), s.transmissionStage)
  assert.equal(s.composite.get(2), s.resolveStage)
  for (const stage of [s.raymarchStage, s.transmissionStage, s.resolveStage]) {
    assert.equal(stage.pixelFormat, C.PixelFormat.RGBA)
    assert.equal(stage.pixelDatatype, C.PixelDatatype.FLOAT)
  }
  assert.equal(s.raymarchStage.textureScale, 0.5)
  assert.equal(s.transmissionStage.textureScale, 0.5)
  assert.equal(s.resolveStage.textureScale, 1)
  assert.equal(s.resolveStage.uniforms.originalHdr, s.originalHdr)
  assert.deepEqual(s.resolveStage.uniforms.effectSize(), new C.Cartesian2(401, 302))
  s.sourceSize.x = 1200
  assert.equal(s.resolveStage.uniforms.effectSize().x, 600)
  s.destroy()
})

test('cloud color and weighted depth are independent float targets with separate ownership', () => {
  const s = create()
  try {
    assert.equal(s.cloudComposite.inputPreviousStageTexture, false)
    assert.equal(s.cloudComposite.length, 2)
    assert.equal(s.cloudComposite.get(0), s.cloudStage)
    assert.equal(s.cloudComposite.get(1), s.cloudDepthStage)
    for (const stage of [s.cloudStage, s.cloudDepthStage]) {
      assert.equal(stage.pixelFormat, C.PixelFormat.RGBA)
      assert.equal(stage.pixelDatatype, C.PixelDatatype.FLOAT)
      assert.equal(stage.textureScale, s.raymarchStage.textureScale)
      assert.equal(stage.uniforms.cloudFrame, s.raymarchStage.uniforms.cloudFrame)
      assert.match(stage.fragmentShader, /effectFlags\.y > 0\.5 \? ccrCloud/)
    }
    assert.match(s.cloudStage.fragmentShader, /ccrClouds\(atmosphereOrigin,direction,distance\)/)
    assert.match(s.cloudDepthStage.fragmentShader, /ccrCloudGeometry\(atmosphereOrigin,direction,distance\)/)
    assert.match(s.cloudDepthStage.fragmentShader, /geometry\.y >= 0\.99999\) geometry\.x = DEPTH_LIMIT/)
    const color = { width: 401, height: 302 }, depth = { width: 401, height: 302 }
    s.cloudStage._textureCache = { getFramebuffer: () => ({ getColorTexture: () => color }) }
    s.cloudDepthStage._textureCache = { getFramebuffer: () => ({ getColorTexture: () => depth }) }
    assert.equal(s.raymarchStage.uniforms.cloudColor(), color)
    assert.equal(s.raymarchStage.uniforms.cloudDepth(), depth)
    assert.equal(s.transmissionStage.uniforms.cloudColor(), color)
    assert.equal(s.transmissionStage.uniforms.cloudDepth(), depth)
    s.composite.destroy()
    assert.equal(s.cloudComposite.isDestroyed(), false)
    assert.equal(s.cloudStage.isDestroyed(), false)
    assert.equal(s.cloudDepthStage.isDestroyed(), false)
  } finally {
    s.cloudStage._textureCache = undefined
    s.cloudDepthStage._textureCache = undefined
    s.destroy()
  }
  assert.equal(s.cloudStage.isDestroyed(), true)
  assert.equal(s.cloudDepthStage.isDestroyed(), true)
})

test('production resolve reconstructs FLOAT RGB transmission without decoding packed alpha', () => {
  const s = create()
  try {
    const transmission = { width: 401, height: 302 }
    s.transmissionStage._textureCache = { getFramebuffer: () => ({ getColorTexture: () => transmission }) }
    assert.equal(s.resolveStage.uniforms.environmentTransmission(), transmission)
    assert.match(s.transmissionStage.fragmentShader, /out_FragColor = vec4\(transmission \* clouds\.a,1\.0\)/)
    assert.match(s.resolveStage.fragmentShader, /transmittance \+= texture\(environmentTransmission,sampleUv\)\.rgb \* weight/)
    assert.doesNotMatch(s.transmissionStage.fragmentShader, /ccrPackTransmittance|ccrUnpackTransmittance/)
    assert.doesNotMatch(s.resolveStage.fragmentShader, /ccrPackTransmittance|ccrUnpackTransmittance|sampleMedium\.a/)
  } finally { s.transmissionStage._textureCache = undefined; s.destroy() }
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
  assert.match(high.raymarchStage.fragmentShader, /#define CLOUD_STEPS 128/)
  low.destroy()
  high.destroy()
})

test('the cloud tier integrates continuous sun extinction against the visible density field', () => {
  const balanced = create('balanced')
  const performance = create('performance')
  const shader = balanced.raymarchStage.fragmentShader
  // The balanced tier uses six sun taps, while performance uses four.
  assert.match(shader, /#define CLOUD_LIGHT_STEPS 6/)
  assert.match(performance.raymarchStage.fragmentShader, /#define CLOUD_LIGHT_STEPS 4/)
  // The sun path delegates to the shared optical-depth integral over spherical intervals.
  const sunBody = shader.slice(shader.indexOf('float ccrCloudSunOpticalDepth'), shader.indexOf('float ccrCloudSunVisibility'))
  assert.match(sunBody, /ccrCloudShellIntervals\(position, sunDirectionAtmo, 1\.0e9\)/)
  assert.match(sunBody, /return ccrCloudOpticalDepth\(position, sunDirectionAtmo, intervals, sampleCount\)/)
  const opticalBody = shader.slice(shader.indexOf('float ccrCloudOpticalDepth'), shader.indexOf('float ccrCloudSunOpticalDepth'))
  assert.match(opticalBody, /opticalDepth \+= ccrCloudDensity\(samplePosition\) \* stepLength/)
  assert.doesNotMatch(sunBody, /inside \+=/)
  // The atmosphere must not texture-fetch anywhere on its scattering path. Slice only up to the
  // cloud module, which legitimately samples the noise atlas.
  const atmosphereBody = shader.slice(shader.indexOf('vec3 ccrAtmosphereIntegral('), shader.indexOf('vec3 ccrCloudNoise3D'))
  assert.ok(atmosphereBody.length > 200, 'the atmosphere body must be found')
  assert.doesNotMatch(atmosphereBody, /texture\(|texelFetch\(/)
  balanced.destroy()
  performance.destroy()
})

test('real Cesium generates reconstruction builtins and the half-res resolve stays linear', () => {
  const s = create()
  // Depth-aware reconstruction is shared by cloud data, medium and full-resolution resolve.
  for (const stage of [s.cloudStage, s.cloudDepthStage, s.raymarchStage,
    s.transmissionStage, s.resolveStage, s.occlusionStage]) {
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
  // Cloud shadows affect the reconstructed surface; atmosphere/cloud view T is applied once.
  assert.match(s.resolveStage.fragmentShader, /vec3 surface = original\.rgb/)
  assert.match(s.resolveStage.fragmentShader, /surface \*= ccrCloudSurfaceTransmission/)
  assert.match(s.resolveStage.fragmentShader, /radiance \+ surface \* transmittance, original\.a/)
  assert.match(s.resolveStage.fragmentShader, /original\.a/)
  s.destroy()
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

test('resolve dimensions follow the actual volume target, including a diagnostic scale change', () => {
  const s = create()
  const texture = { width: 399, height: 299 }
  s.raymarchStage._textureCache = { getFramebuffer: () => ({ getColorTexture: () => texture }) }
  try {
    assert.deepEqual(s.resolveStage.uniforms.effectSize(), new C.Cartesian2(399, 299))
    texture.width = 801; texture.height = 603
    assert.deepEqual(s.resolveStage.uniforms.effectSize(), new C.Cartesian2(801, 603))
  } finally { s.raymarchStage._textureCache = undefined; s.destroy() }
})
