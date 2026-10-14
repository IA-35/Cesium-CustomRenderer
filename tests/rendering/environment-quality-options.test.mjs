import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOptions } from '../../src/presets.js'

test('environmentQuality accepts the performance tier and keeps the others', () => {
  // Call with the module default current, the way the pipeline does.
  const base = normalizeOptions({})
  assert.equal(base.environmentQuality, 'balanced')
  assert.equal(normalizeOptions({ environmentQuality: 'performance' }).environmentQuality, 'performance')
  assert.equal(normalizeOptions({ environmentQuality: 'high' }).environmentQuality, 'high')
  // An unknown tier must not be silently accepted.
  assert.equal(normalizeOptions({ environmentQuality: 'bogus' }).environmentQuality, 'balanced')
})
