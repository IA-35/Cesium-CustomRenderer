import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireSharedImageTexture, releaseSharedImageTexture } from '../../vendor/cesium-ez-tree/src/EzTree/EzTreeGltfAsset.js'

const record = (alpha = false, bytes = [1, 2, 3]) => ({ bytes: Uint8Array.from(bytes), mimeType: 'image/png',
  preMultiplyAlpha: alpha, image: { width: 4, height: 4 } })
test('equal images share GPU texture across collections until their last owner releases it', () => {
  let created = 0, destroyed = 0
  const create = () => { created++; return { destroy() { destroyed++ } } }, context = {}
  const a = record(), b = record()
  const first = acquireSharedImageTexture(a, context, create)
  assert.equal(acquireSharedImageTexture(b, context, create), first)
  assert.equal(created, 1)
  releaseSharedImageTexture(a)
  assert.equal(destroyed, 0)
  releaseSharedImageTexture(b)
  assert.equal(destroyed, 1)
  releaseSharedImageTexture(b)
  assert.equal(destroyed, 1)
  assert.notEqual(acquireSharedImageTexture(record(), context, create), first)
})
test('different content, decode alpha policy and WebGL contexts never share textures', () => {
  const create = () => ({}), context = {}, a = record()
  const first = acquireSharedImageTexture(a, context, create)
  assert.notEqual(acquireSharedImageTexture(record(true), context, create), first)
  assert.notEqual(acquireSharedImageTexture(record(false, [4, 5, 6]), context, create), first)
  assert.notEqual(acquireSharedImageTexture(record(), {}, create), first)
})

test('a content-hash collision is checked byte for byte before sharing', () => {
  const context = {}, a = record(), b = record(false, [4, 5, 6])
  a.sharedKey = b.sharedKey = 'collision'
  const create = () => ({ destroy() {} })
  assert.notEqual(acquireSharedImageTexture(a, context, create), acquireSharedImageTexture(b, context, create))
  releaseSharedImageTexture(a); releaseSharedImageTexture(b)
})
