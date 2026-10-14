import test from 'node:test'
import assert from 'node:assert/strict'
import DeferredGeometry143 from '../../src/lighting/DeferredGeometry143.js'

test('geometry submission exposes immutable render items and lighting batches', () => {
  const first = { id: 'first' }, second = { id: 'second' }
  const owner = { renderItemFor(command) { return command === first ? { command: first } : { command: second } } }
  const geometry = { owner, frame: 7, captured: [
    { command: first, group: { id: 3 } },
    { command: second, group: { id: 3 } },
  ] }
  const submission = DeferredGeometry143.prototype.getGeometrySubmission.call(geometry)
  assert.equal(submission.frame, 7)
  assert.equal(submission.items.length, 2)
  assert.equal(submission.lightingBatches.length, 1)
  assert.equal(submission.lightingBatches[0].items.length, 2)
  assert.throws(() => { submission.items.push({}) }, TypeError)
  assert.throws(() => { submission.lightingBatches[0].items.push({}) }, TypeError)
})
