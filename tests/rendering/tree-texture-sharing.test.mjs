import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireSharedImageTexture, releaseSharedImageTexture, getTextureWrap } from '../../vendor/cesium-ez-tree/src/EzTree/EzTreeGltfAsset.js'

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

test('树皮等平铺贴图按 glTF 采样器使用 REPEAT，未声明时保持 CLAMP_TO_EDGE', () => {
  const gltf = { textures: [{ sampler: 0 }, { sampler: 1 }, {}], samplers: [
    { wrapS: 33071, wrapT: 33071 }, { wrapS: 10497, wrapT: 33648 }] }
  assert.deepEqual(getTextureWrap(gltf, 0), { wrapS: 33071, wrapT: 33071 })
  assert.deepEqual(getTextureWrap(gltf, 1), { wrapS: 10497, wrapT: 33648 })
  // 未声明采样器：沿用 ez-tree 原有的钳边，不改变既有草地/树叶资产
  assert.deepEqual(getTextureWrap(gltf, 2), { wrapS: 33071, wrapT: 33071 })
})

test('平铺方式不同的同一图片不共享纹理，创建时传入平铺方式', () => {
  const wraps = []
  const create = (context, image, alpha, wrap) => { wraps.push(wrap); return {} }, context = {}
  const clamp = record(), repeat = record()
  repeat.wrap = { wrapS: 10497, wrapT: 10497 }
  assert.notEqual(acquireSharedImageTexture(repeat, context, create), acquireSharedImageTexture(clamp, context, create))
  assert.deepEqual(wraps[0], { wrapS: 10497, wrapT: 10497 })
})
