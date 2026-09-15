import test from 'node:test'
import assert from 'node:assert/strict'
import VisualPipeline from '../../src/VisualPipeline.js'
import { defaultFilters, normalizeOptions, resolveSavedFilters, colorGradingPresets } from '../../src/presets.js'

function pipeline() {
  // Exercise the real API on an initialized option owner; GPU lifecycle has its own tests.
  const p = Object.create(VisualPipeline.prototype)
  p.options = normalizeOptions({ fog: true, environmentPreset: 'morning' })
  p.destroyed = false
  p.apply = () => {}
  p.restore = () => {}
  return p
}

test('partial color grading preserves unrelated adjustments and scene options', () => {
  const p = pipeline()
  p.setColorGrading({ brightness: 1.2, saturation: 1.1 })
  const result = p.setColorGrading({ contrast: 1.15, fog: false })
  assert.equal(result.brightness, 1.2)
  assert.equal(result.saturation, 1.1)
  assert.equal(result.contrast, 1.15)
  assert.equal(p.options.fog, true)
  assert.equal(p.options.environmentPreset, 'morning')
  result.hue = 0.5
  assert.equal(p.getColorGrading().hue, 0)
})

test('AA API preserves color grading and reports the normalized requested settings', () => {
  const p = pipeline()
  p.setColorGrading({ brightness: 1.2 })
  assert.deepEqual(p.setAntiAliasing({ mode: 'fxaa', msaaSamples: 8, resolutionMode: 'css', resolutionScale: 1.25 }),
    { mode: 'fxaa', msaaSamples: 8, resolutionMode: 'css', resolutionScale: 1.25 })
  assert.equal(p.getColorGrading().brightness, 1.2)
  p.setAntiAliasing('off')
  assert.equal(p.getAntiAliasing().mode, 'off')
})

test('spatial quality is independently configurable and MSAA mode does not silently keep one sample', () => {
  const p = pipeline()
  p.setAntiAliasing({ mode: 'msaa' })
  assert.equal(p.getAntiAliasing().msaaSamples, 4)
  p.setAntiAliasing({ mode: 'smaa', quality: 'smooth' })
  assert.equal(p.options.spatialAaQuality, 'smooth')
  p.setAntiAliasing({ quality: 'invalid' })
  assert.equal(p.options.spatialAaQuality, 'smooth')
  const before = [p.options.taaHistoryBlend, p.options.taaMotionBlend, p.options.taaJitterSamples]
  p.setAntiAliasing({ quality: 'sharp' })
  assert.deepEqual([p.options.taaHistoryBlend, p.options.taaMotionBlend, p.options.taaJitterSamples], before)
})

test('diagnostics report active FXAA after retaining a disabled SMAA instance', () => {
  const p = pipeline()
  p.enabled = true
  p.suspensions = new Set()
  p.smaa = { enabled: false, getDiagnostics: () => ({ effective: 'off' }) }
  p.viewer = { scene: { msaaSamples: 4, postProcessStages: { fxaa: { enabled: true } } } }
  assert.equal(p.getRenderDiagnostics().antiAliasing.postProcess.effective, 'fxaa')
})

test('color grading bounds invalid input and reset restores only color controls', () => {
  const p = pipeline()
  p.setColorGrading({ hue: 99, exposure: -1, brightness: NaN })
  assert.equal(p.getColorGrading().hue, 1)
  assert.equal(p.getColorGrading().exposure, 0.05)
  assert.equal(p.getColorGrading().brightness, defaultFilters.brightness)
  assert.doesNotThrow(() => p.setColorGrading(null))
  assert.deepEqual(p.resetColorGrading(), defaultFilters)
  assert.equal(p.options.environmentPreset, 'morning')
})

test('factory clear preset upgrades the exact old defaults while preserving manual and neutral presets', () => {
  assert.deepEqual(defaultFilters, colorGradingPresets.clear)
  const previous = { contrast: 1, brightness: 1, exposure: 1.6, saturation: 0.95, hue: 0 }
  assert.deepEqual(resolveSavedFilters(previous), colorGradingPresets.clear)
  assert.deepEqual(resolveSavedFilters(colorGradingPresets.neutral), colorGradingPresets.neutral)
  assert.deepEqual(resolveSavedFilters({ ...previous, brightness: 1.02 }), { ...previous, brightness: 1.02 })
})
