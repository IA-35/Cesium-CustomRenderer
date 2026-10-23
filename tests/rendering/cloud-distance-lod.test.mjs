import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudHorizonGLSL } from '../../src/environment/cloudHorizon143.js'
import { cloudGLSL, CLOUD_TIERS } from '../../src/environment/volumetricClouds143.js'

const scalar = cloudHorizonGLSL.slice(cloudHorizonGLSL.indexOf('float ccrCloudDistanceLod'),
  cloudHorizonGLSL.indexOf('float ccrCloudViewRange'))
  .replace(/float (\w+)\(([^)]*)\)/g, (_, name, args) => `function ${name}(${args.replaceAll('float ', '')})`)
const { lod, next } = new Function('smoothstep', 'mix', 'min', `${scalar}
  return {lod:ccrCloudDistanceLod,next:ccrCloudNextSample};`)(
  (a, b, x) => { const t = Math.max(0, Math.min(1, (x-a)/(b-a))); return t*t*(3-2*t) },
  (a, b, t) => a+(b-a)*t, Math.min)

test('distance LOD preserves nearby clouds and changes continuously', () => {
  assert.equal(lod(0), 0)
  assert.equal(lod(8000), 0)
  assert.equal(lod(24000), 0.5)
  assert.equal(lod(40000), 1)
  let previous = 0
  for (let distance = 0; distance <= 100000; distance += 10) {
    const current = lod(distance)
    assert(current >= previous && current <= 1)
    assert(current-previous < 0.001)
    previous = current
  }
})

test('all quality tiers cover the full cloud path with a quarter of far view samples', () => {
  for (const { steps } of Object.values(CLOUD_TIERS)) {
    for (const start of [0, 8000, 24000, 40000, 200000]) {
      let cursor = 0, count = 0, extinction = 0
      const pathLength = 1200, density = 0.0002
      while (cursor < steps) {
        const end = next(cursor, steps, start + cursor / steps * pathLength)
        assert(end > cursor && end <= steps)
        extinction += density * (end-cursor) / steps * pathLength
        cursor = end
        count++
        assert(count <= steps)
      }
      assert(Math.abs(Math.exp(-extinction)-Math.exp(-density*pathLength)) < 1e-12,
        'coarser sampling must integrate metres, not reduce cloud opacity')
      if (start === 0) assert.equal(count, steps)
      if (start >= 40000) assert.equal(count, Math.ceil(steps/4))
    }
  }
})

test('fractional light tap budgets integrate the complete shell, including the last segment', () => {
  const shader = cloudGLSL('balanced')
  const start = shader.indexOf('float ccrCloudOpticalDepth(')
  const end = shader.indexOf('// No planar', start)
  const source = shader.slice(start, end)
    .replace('float ccrCloudOpticalDepth(vec3 position, vec3 direction, vec4 intervals, float sampleCount)',
      'function opticalDepth(position,direction,intervals,sampleCount)')
    .replace('float ccrCloudOpticalDepth(vec3 position, vec3 direction, vec4 intervals)',
      'function ccrCloudOpticalDepth(position,direction,intervals)')
    .replace(/\b(float|int|vec3) /g, 'let ')
    .replaceAll('float(', 'Number(')
  const opticalDepth = new Function('ccrCloudIntervalLength', 'ccrCloudIntervalDistance',
    'ccrCloudDensity', 'min', 'CLOUD_LIGHT_STEPS', `${source};return opticalDepth;`)(
    intervals => intervals, (_, distance) => distance, () => 0.0002, Math.min, 6)
  for (const budget of [2, 2.01, 2.99, 3, 3.01, 5.5, 6]) {
    assert(Math.abs(opticalDepth(0, 1, 90000, budget)-18) < 1e-12)
  }
})
