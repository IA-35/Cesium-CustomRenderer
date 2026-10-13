import test from 'node:test'
import assert from 'node:assert/strict'
import { keepPrimitiveLast } from '../../src/pipeline/PrimitiveOrder143.js'

test('primitive order guard avoids redundant raises and repairs order after insertion', () => {
  const proxy = { id: 'proxy' }
  const other = { id: 'other' }
  const collection = {
    _primitives: [other, proxy],
    raiseCount: 0,
    raiseToTop(value) {
      this.raiseCount++
      this._primitives = this._primitives.filter(item => item !== value)
      this._primitives.push(value)
    }
  }

  keepPrimitiveLast(collection, proxy)
  assert.equal(collection.raiseCount, 0)

  collection._primitives.push({ id: 'new' })
  keepPrimitiveLast(collection, proxy)
  assert.equal(collection.raiseCount, 1)
  assert.equal(collection._primitives.at(-1), proxy)
})

test('primitive order guard supports public collection accessors', () => {
  const proxy = {}
  const collection = {
    values: [proxy],
    get length() { return this.values.length },
    get(index) { return this.values[index] },
    raiseCount: 0,
    raiseToTop(value) {
      this.raiseCount++
      this.values = this.values.filter(item => item !== value)
      this.values.push(value)
    }
  }
  keepPrimitiveLast(collection, proxy)
  assert.equal(collection.raiseCount, 0)
  collection.values.push({})
  keepPrimitiveLast(collection, proxy)
  assert.equal(collection.raiseCount, 1)
})
