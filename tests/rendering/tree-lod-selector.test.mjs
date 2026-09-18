import assert from 'node:assert/strict'
import test from 'node:test'
import { projectedTreePixels, selectTreeLod } from '../../src/instances/lodSelector.js'

test('projects world height into drawing-buffer pixels', () => {
  assert.equal(projectedTreePixels({ height: 10, distance: 100, viewportHeight: 1080, fovY: Math.PI / 3 }).toFixed(2), '93.53')
  assert.equal(projectedTreePixels({ height: 10, distance: 0, viewportHeight: 1080, fovY: Math.PI / 3 }), Infinity)
})

test('selects all four LODs at the configured projected-size thresholds', () => {
  assert.equal(selectTreeLod({ pixels: 120 }), 0)
  assert.equal(selectTreeLod({ pixels: 80 }), 1)
  assert.equal(selectTreeLod({ pixels: 30 }), 2)
  assert.equal(selectTreeLod({ pixels: 8 }), 3)
})

test('uses 15 percent hysteresis around both directions of each boundary', () => {
  assert.equal(selectTreeLod({ pixels: 90, currentLod: 0 }), 0)
  assert.equal(selectTreeLod({ pixels: 80, currentLod: 0 }), 1)
  assert.equal(selectTreeLod({ pixels: 105, currentLod: 1 }), 1)
  assert.equal(selectTreeLod({ pixels: 112, currentLod: 1 }), 0)
  assert.equal(selectTreeLod({ pixels: 37, currentLod: 1 }), 1)
  assert.equal(selectTreeLod({ pixels: 33, currentLod: 1 }), 2)
})
