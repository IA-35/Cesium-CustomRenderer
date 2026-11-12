import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  DEFAULT_GRASS_PALETTE, grassVariationAt, resolveGrassVariation, valueNoise,
} from '../../src/instances/grassVariation.js'
import { sampleGrassGroundGrid } from '../../src/instances/grassGroundSampler.js'

const require = createRequire(import.meta.url)
const C = require('cesium/Build/Cesium/index.cjs')

const lawn = (settings = resolveGrassVariation()) => {
  const out = []
  for (let i = 0; i < 4000; i++) out.push(grassVariationAt((i % 80) * 0.5, Math.floor(i / 80) * 0.5, i, 20260908, settings))
  return out
}

test('grass variation is deterministic for the same position, index and seed', () => {
  const settings = resolveGrassVariation()
  assert.deepEqual(grassVariationAt(12.3, -4.5, 77, 9, settings), grassVariationAt(12.3, -4.5, 77, 9, settings))
  assert.notDeepEqual(grassVariationAt(12.3, -4.5, 77, 9, settings), grassVariationAt(12.3, -4.5, 77, 10, settings))
})

test('value noise stays in [0, 1] and is continuous across cell borders', () => {
  for (let i = 0; i < 500; i++) {
    const value = valueNoise(i * 0.37 - 50, i * 0.11 + 3, 5)
    assert.ok(value >= 0 && value <= 1)
  }
  assert.ok(Math.abs(valueNoise(2 - 1e-6, 3.5, 1) - valueNoise(2 + 1e-6, 3.5, 1)) < 1e-4)
})

test('lawn colours vary in patches but stay green-dominant (grayscale card needs a green tint)', () => {
  const samples = lawn()
  for (const { color } of samples) {
    assert.ok(color[1] > color[0] && color[1] > color[2], `green must dominate: ${color}`)
  }
  const greens = samples.map(sample => sample.color[1])
  const spread = Math.max(...greens) - Math.min(...greens)
  assert.ok(spread > 0.08, `expected visible colour variation, got spread ${spread}`)
})

test('heights vary by roughly the configured amount and stay clamped', () => {
  const heights = lawn().map(sample => sample.heightScale)
  assert.ok(Math.min(...heights) >= 0.4 && Math.max(...heights) <= 1.8)
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.4, 'clumps need visibly different heights')
})

test('variation can be switched off to restore a uniform lawn', () => {
  const flat = lawn(resolveGrassVariation({ colorVariation: 0, heightVariation: 0, widthJitter: 0 }))
  for (const sample of flat) {
    assert.deepEqual(sample.color, [...DEFAULT_GRASS_PALETTE.base])
    assert.equal(sample.heightScale, 1)
    assert.equal(sample.widthScale, 1)
  }
})

test('out-of-range variation options are clamped', () => {
  const settings = resolveGrassVariation({ colorVariation: 5, heightVariation: -2, colorPatchSize: 0 })
  assert.equal(settings.colorVariation, 1)
  assert.equal(settings.heightVariation, 0)
  assert.equal(settings.colorPatchSize, 0.5)
})

// Identity frame: local ENU metres are passed straight through to a fake globe.
function flatFrame(heightAt) {
  const identity = C.Matrix4.IDENTITY
  const scene = {
    calls: 0,
    sampleHeight(cartographic) {
      this.calls++
      return heightAt(cartographic)
    },
  }
  const origin = C.Cartesian3.fromDegrees(123.4, 41.76, 0)
  const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(origin)
  const inverseModelMatrix = C.Matrix4.inverseTransformation(modelMatrix, new C.Matrix4())
  return { scene, modelMatrix, inverseModelMatrix, identity, origin }
}

function localPoint(frame, cartographic) {
  const world = C.Cartographic.toCartesian(new C.Cartographic(cartographic.longitude, cartographic.latitude, 0))
  return C.Matrix4.multiplyByPoint(frame.inverseModelMatrix, world, new C.Cartesian3())
}
const localEast = (frame, cartographic) => localPoint(frame, cartographic).x

const clumps = points => points.map(([x, y]) => ({ translation: new C.Cartesian3(x, y, 0) }))

test('roots follow a sloped surface by bilinear interpolation of grid samples', async () => {
  // Ground rises 0.1 m per metre east (a 10% slope).
  const frame = flatFrame(cartographic => 0.1 * localEast(frame, cartographic))
  const instances = clumps([[0, 0], [5, 2], [10, 7], [19, 3]])
  const result = await sampleGrassGroundGrid({
    C, scene: frame.scene, modelMatrix: frame.modelMatrix, inverseModelMatrix: frame.inverseModelMatrix,
    instances, spacing: 10, sampleBudget: 100, rootOffset: 0,
  })
  assert.equal(result.fallback, false)
  assert.ok(result.samples <= 9, 'only touched grid corners are sampled')
  for (const instance of instances) {
    // Local z also contains Earth curvature (~x²/2R), negligible over 20 m.
    assert.ok(Math.abs(instance.translation.z - 0.1 * instance.translation.x) < 0.02,
      `root at x=${instance.translation.x} should be ~${0.1 * instance.translation.x}, got ${instance.translation.z}`)
  }
})

test('obstacle hits such as tree canopies are replaced by the polygon median', async () => {
  // Flat lawn with one tree canopy (8 m) over the grid corner at (20, 0).
  const frame = flatFrame(cartographic => {
    const p = localPoint(frame, cartographic)
    return Math.hypot(p.x - 20, p.y) < 3 ? 8 : 0
  })
  const instances = clumps([[0, 0], [9, 0], [12, 1], [29, 9], [21, 2], [5, 5], [18, 8]])
  await sampleGrassGroundGrid({
    C, scene: frame.scene, modelMatrix: frame.modelMatrix, inverseModelMatrix: frame.inverseModelMatrix,
    instances, spacing: 10, sampleBudget: 100, rootOffset: 0,
  })
  for (const instance of instances) assert.ok(Math.abs(instance.translation.z) < 0.05, `root lifted onto obstacle: ${instance.translation.z}`)
})

test('reports a fallback when nothing can be sampled or the budget is exhausted', async () => {
  const frame = flatFrame(() => undefined)
  const missing = await sampleGrassGroundGrid({
    C, scene: frame.scene, modelMatrix: frame.modelMatrix, inverseModelMatrix: frame.inverseModelMatrix,
    instances: clumps([[0, 0], [3, 3]]), spacing: 10, sampleBudget: 100,
  })
  assert.equal(missing.fallback, true)
  const tiny = await sampleGrassGroundGrid({
    C, scene: frame.scene, modelMatrix: frame.modelMatrix, inverseModelMatrix: frame.inverseModelMatrix,
    instances: clumps([[0, 0], [4000, 4000]]), spacing: 1, sampleBudget: 3,
  })
  assert.equal(tiny.fallback, true)
})

test('grass shader keeps the CCR shadow-receiver marker and only shades grass cutouts', () => {
  const fs_ = fs.readFileSync(new URL('../../vendor/cesium-ez-tree/src/EzTree/Shaders/EzTreeVegetationFS.js', import.meta.url), 'utf8')
  assert.ok(fs_.includes('float ccr_ezTreeVisibility = 1.0;'), 'shaderAdapter143 replaces this exact marker')
  assert.ok(fs_.includes('uniform vec4 u_grassShading;'))
  assert.match(fs_, /bool ccr_isGrass = u_cutoutType > 1\.5 && u_cutoutType < 2\.5;/)
  // Back-light must follow shadow visibility, so it has to come after the marker.
  assert.ok(fs_.indexOf('ccr_backLight') > fs_.indexOf('float ccr_ezTreeVisibility = 1.0;'))
})

test('grass commands never cast shadows and receive only when requested', () => {
  const source = fs.readFileSync(new URL('../../vendor/cesium-ez-tree/src/EzTree/EzTreePrimitive.js', import.meta.url), 'utf8')
  assert.match(source, /if \(cutoutType === CUTOUT_GRASS\) return \{ castShadows: false, receiveShadows: grassReceiveShadows === true \};/)
  assert.match(source, /this\.grassReceiveShadows = options\.grassReceiveShadows \?\? false;/)
  // Non-grass commands get the neutral shading so trees keep the upstream look.
  assert.match(source, /return cutoutType === CUTOUT_GRASS \? primitive\.grassShading : neutralGrassShading;/)
})
