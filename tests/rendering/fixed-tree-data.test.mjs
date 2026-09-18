import assert from 'node:assert/strict'
import test from 'node:test'
import { stableTreeVariation, validateFixedTreePoints } from '../../src/instances/fixedTreeData.js'

const typeMap = { 松柏: 'pine-02b', 松树: 'pine-02c', 松树01: 'pine-02i' }
const exportData = {
  coordinateSystem: { origin: { longitude: 123.410315, latitude: 41.761969 }, geographicPositionOrder: ['longitude', 'latitude'] },
  summary: { objectCount: 4, countsByType: { 松柏: 2, 松树: 1, 松树01: 1 } },
  objects: [
    { type: '松柏', object: 'tree-a', relativePosition: [0, 0], geographicPosition: [123.410315, 41.761969] },
    { type: '松柏', object: 'tree-b', relativePosition: [191, 20], geographicPosition: [123.412, 41.762] },
    { type: '松树', object: 'tree-c', relativePosition: [192, 20], geographicPosition: [123.413, 41.762] },
    { type: '松树01', object: 'tree-d', relativePosition: [-1, -193], geographicPosition: [123.409, 41.760] }
  ]
}

test('validates WGS84 point order and maps every stable id to a prototype', () => {
  const result = validateFixedTreePoints(exportData, typeMap)
  assert.equal(result.points.length, 4)
  assert.deepEqual(result.origin, { longitude: 123.410315, latitude: 41.761969 })
  assert.deepEqual(result.points.map(point => point.id), ['tree-a', 'tree-b', 'tree-c', 'tree-d'])
  assert.deepEqual(result.points.map(point => point.prototypeId), ['pine-02b', 'pine-02b', 'pine-02c', 'pine-02i'])
  assert.deepEqual(result.points[0].geographicPosition, [123.410315, 41.761969])
})

test('rejects reversed coordinate order, unknown types, and duplicate ids', () => {
  assert.throws(() => validateFixedTreePoints({ ...exportData, coordinateSystem: { ...exportData.coordinateSystem, geographicPositionOrder: ['latitude', 'longitude'] } }, typeMap), /longitude.*latitude/i)
  const unknown = structuredClone(exportData); unknown.objects[0].type = 'unknown'
  assert.throws(() => validateFixedTreePoints(unknown, typeMap), /unknown tree type/i)
  const duplicate = structuredClone(exportData); duplicate.objects[1].object = 'tree-a'
  assert.throws(() => validateFixedTreePoints(duplicate, typeMap), /duplicate tree id/i)
})

test('stable variation is deterministic and remains within the visual limits', () => {
  const first = stableTreeVariation('tree-a'); const second = stableTreeVariation('tree-a')
  assert.deepEqual(first, second)
  assert.ok(first.heading >= 0 && first.heading < Math.PI * 2)
  assert.ok(first.scale >= 0.92 && first.scale <= 1.08)
  assert.notDeepEqual(first, stableTreeVariation('tree-b'))
})
