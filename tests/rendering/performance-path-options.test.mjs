import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOptions } from '../../src/presets.js'

test('performance path options survive normalization', () => {
  const options = normalizeOptions({
    renderItemDirectSubmit: true,
    transparentDirectSubmit: true,
    materialBatchingEnabled: true,
  })
  assert.equal(options.renderItemDirectSubmit, true)
  assert.equal(options.transparentDirectSubmit, true)
  assert.equal(options.materialBatchingEnabled, true)
})
