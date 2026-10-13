import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createRequire } from 'node:module'

import {
  hashBytesSha256,
  SharedGlbTextureCache,
  readGlbJson
} from '../../examples/shared-glb-textures.js'

const Cesium = createRequire(import.meta.url)('cesium')

function align4(value) { return (value + 3) & ~3 }

function createGlb(images, { sampler = {} } = {}) {
  const offsets = []
  let byteOffset = 0
  const parts = images.map(bytes => {
    const data = Uint8Array.from(bytes)
    offsets.push(byteOffset)
    byteOffset += align4(data.byteLength)
    return data
  })
  const binary = new Uint8Array(byteOffset)
  parts.forEach((part, index) => binary.set(part, offsets[index]))
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: parts.map((part, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: part.byteLength })),
    images: parts.map((part, index) => ({ bufferView: index, mimeType: 'image/ktx2' })),
    samplers: [sampler],
    textures: parts.map((part, index) => ({ sampler: 0, extensions: { KHR_texture_basisu: { source: index } } })),
    extensionsUsed: ['KHR_texture_basisu']
  }
  let json = new TextEncoder().encode(JSON.stringify(gltf))
  const paddedJson = new Uint8Array(align4(json.byteLength)); paddedJson.fill(0x20); paddedJson.set(json); json = paddedJson
  const total = 12 + 8 + json.byteLength + 8 + binary.byteLength
  const glb = new Uint8Array(total)
  const view = new DataView(glb.buffer)
  glb.set([0x67, 0x6c, 0x54, 0x46]); view.setUint32(4, 2, true); view.setUint32(8, total, true)
  view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); glb.set(json, 20)
  const binHeader = 20 + json.byteLength
  view.setUint32(binHeader, binary.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); glb.set(binary, binHeader + 8)
  return glb
}

function textureKey(cache, gltf, url, textureIndex = 0) {
  return Cesium.ResourceCacheKey.getTextureCacheKey({
    gltf,
    textureInfo: { index: textureIndex },
    gltfResource: new Cesium.Resource({ url }),
    baseResource: new Cesium.Resource({ url }),
    supportedImageFormats: { basis: true, webp: false },
    frameState: { context: { id: 'test-context' } }
  })
}

test('SHA-256 fallback works without secure-context Web Crypto', async () => {
  assert.equal(
    await hashBytesSha256(new TextEncoder().encode('abc'), null),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 1024 * 1024]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 17) & 0xff)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(await hashBytesSha256(bytes, null), expected, `length ${length}`)
  }
})

test('shares byte-identical embedded images across different GLB URLs', async () => {
  const cache = new SharedGlbTextureCache(Cesium)
  try {
    const first = createGlb([[0xab, 0x4b, 1, 2, 3]])
    const second = createGlb([[0xab, 0x4b, 1, 2, 3]])
    const firstHashes = await cache.hashEmbeddedImages(first)
    const secondHashes = await cache.hashEmbeddedImages(second)
    assert.equal(firstHashes[0], secondHashes[0])

    const firstGltf = readGlbJson(first).gltf
    const secondGltf = readGlbJson(second).gltf
    cache.annotate(firstGltf, firstHashes)
    cache.annotate(secondGltf, secondHashes)

    const firstImageKey = Cesium.ResourceCacheKey.getImageCacheKey({
      gltf: firstGltf, imageId: 0,
      gltfResource: new Cesium.Resource({ url: 'https://example.test/a.glb' }),
      baseResource: new Cesium.Resource({ url: 'https://example.test/a.glb' })
    })
    const secondImageKey = Cesium.ResourceCacheKey.getImageCacheKey({
      gltf: secondGltf, imageId: 0,
      gltfResource: new Cesium.Resource({ url: 'https://example.test/b.glb' }),
      baseResource: new Cesium.Resource({ url: 'https://example.test/b.glb' })
    })
    assert.equal(firstImageKey, secondImageKey)
    assert.equal(textureKey(cache, firstGltf, 'https://example.test/a.glb'), textureKey(cache, secondGltf, 'https://example.test/b.glb'))
    assert.deepEqual(cache.getDiagnostics(), { embeddedImages: 2, uniqueImages: 1, reusedImages: 1 })
  } finally {
    cache.destroy()
  }
})

test('keeps different content and different samplers in separate texture cache entries', async () => {
  const cache = new SharedGlbTextureCache(Cesium)
  try {
    const first = createGlb([[0xab, 0x4b, 1]], { sampler: { wrapS: 10497 } })
    const differentContent = createGlb([[0xab, 0x4b, 2]], { sampler: { wrapS: 10497 } })
    const differentSampler = createGlb([[0xab, 0x4b, 1]], { sampler: { wrapS: 33071 } })
    const inputs = [first, differentContent, differentSampler]
    const gltfs = []
    for (const input of inputs) {
      const gltf = readGlbJson(input).gltf
      cache.annotate(gltf, await cache.hashEmbeddedImages(input))
      gltfs.push(gltf)
    }
    assert.notEqual(textureKey(cache, gltfs[0], 'https://example.test/a.glb'), textureKey(cache, gltfs[1], 'https://example.test/b.glb'))
    assert.notEqual(textureKey(cache, gltfs[0], 'https://example.test/a.glb'), textureKey(cache, gltfs[2], 'https://example.test/c.glb'))
    const firstContext = textureKey(cache, gltfs[0], 'https://example.test/a.glb')
    const secondContext = Cesium.ResourceCacheKey.getTextureCacheKey({
      gltf: gltfs[0], textureInfo: { index: 0 },
      gltfResource: new Cesium.Resource({ url: 'https://example.test/a.glb' }),
      baseResource: new Cesium.Resource({ url: 'https://example.test/a.glb' }),
      supportedImageFormats: { basis: true, webp: false },
      frameState: { context: { id: 'another-context' } }
    })
    assert.notEqual(firstContext, secondContext)
  } finally {
    cache.destroy()
  }
})

test('ignores external images and restores Cesium cache-key functions on destroy', async () => {
  const originalImageKey = Cesium.ResourceCacheKey.getImageCacheKey
  const originalTextureKey = Cesium.ResourceCacheKey.getTextureCacheKey
  const cache = new SharedGlbTextureCache(Cesium)
  const glb = createGlb([[0xab, 0x4b, 1]])
  const { gltf } = readGlbJson(glb)
  gltf.images[0] = { uri: 'shared.ktx2' }
  const options = {
    gltf, imageId: 0,
    gltfResource: new Cesium.Resource({ url: 'https://example.test/model.glb' }),
    baseResource: new Cesium.Resource({ url: 'https://example.test/model.glb' })
  }
  const expectedNativeKey = originalImageKey(options)
  assert.deepEqual(await cache.hashEmbeddedImages(glb, gltf), [undefined])
  assert.equal(Cesium.ResourceCacheKey.getImageCacheKey(options), expectedNativeKey)
  cache.destroy()
  assert.equal(Cesium.ResourceCacheKey.getImageCacheKey, originalImageKey)
  assert.equal(Cesium.ResourceCacheKey.getTextureCacheKey, originalTextureKey)
})

test('rejects overlapping cache owners and permits a new owner after destroy', () => {
  const first = new SharedGlbTextureCache(Cesium)
  try {
    assert.throws(() => new SharedGlbTextureCache(Cesium), /already active/i)
  } finally {
    first.destroy()
  }
  const replacement = new SharedGlbTextureCache(Cesium)
  replacement.destroy()
})
