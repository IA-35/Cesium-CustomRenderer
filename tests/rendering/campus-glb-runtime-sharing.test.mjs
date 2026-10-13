import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { loadCampusGlbs } from '../../examples/campus-glb.js'
import { readGlbJson, SharedGlbTextureCache } from '../../examples/shared-glb-textures.js'

function align4(value) { return (value + 3) & ~3 }

function createImageGlb(imageBytes) {
  const binary = Uint8Array.from(imageBytes)
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: binary.byteLength }],
    images: [{ bufferView: 0, mimeType: 'image/ktx2' }],
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    extensionsUsed: ['KHR_texture_basisu'],
    materials: []
  }
  const encoded = new TextEncoder().encode(JSON.stringify(gltf))
  const json = new Uint8Array(align4(encoded.byteLength)); json.fill(0x20); json.set(encoded)
  const binaryLength = align4(binary.byteLength)
  const total = 12 + 8 + json.byteLength + 8 + binaryLength
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  bytes.set([0x67, 0x6c, 0x54, 0x46]); view.setUint32(4, 2, true); view.setUint32(8, total, true)
  view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20)
  const binHeader = 20 + json.byteLength
  view.setUint32(binHeader, binaryLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(binary, binHeader + 8)
  return bytes
}

function createCesiumStub(captured) {
  const ResourceCacheKey = {
    getImageCacheKey: () => 'original-image',
    getTextureCacheKey: () => 'original-texture'
  }
  return {
    ResourceCacheKey,
    GltfLoaderUtil: { getImageIdFromTexture: () => 0 },
    Cartesian3: { fromDegrees: () => ({}) },
    Transforms: { eastNorthUpToFixedFrame: () => ({}) },
    Matrix3: { fromRotationZ: () => ({}) },
    Matrix4: { multiplyByMatrix3: value => value, clone: value => value },
    Math: { toRadians: value => value },
    ShadowMode: { ENABLED: 1 },
    Model: {
      fromGltfAsync: async options => {
        const gltf = readGlbJson(options.gltf).gltf
        options.gltfCallback(gltf)
        captured.push({ options, gltf })
        return { ready: true, destroy() {} }
      }
    }
  }
}

test('campus GLB loading hashes embedded images once and shares them across model URLs', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const glb = createImageGlb([0xab, 0x4b, 1, 2, 3])
  globalThis.fetch = async url => {
    requests.push(url)
    return new Response(glb, { status: 200 })
  }
  const captured = []
  const C = createCesiumStub(captured)
  const originalImageKey = C.ResourceCacheKey.getImageCacheKey
  const models = []
  const viewer = {
    isDestroyed: () => false,
    scene: { primitives: { add() {} }, requestRender() {} }
  }
  const manifest = {
    origin: { longitude: 123, latitude: 41, height: 0 },
    headingDegrees: 90,
    models: [
      { file: 'a.glb', name: 'A', dielectricMaterials: [] },
      { file: 'b.glb', name: 'B', dielectricMaterials: [] }
    ]
  }

  try {
    const sharedTextures = new SharedGlbTextureCache(C)
    const loadedCache = await loadCampusGlbs(C, viewer, manifest, 'https://example.test/models', models, () => {}, sharedTextures)
    assert.deepEqual(requests.sort(), [
      'https://example.test/models/a.glb',
      'https://example.test/models/b.glb'
    ])
    assert.equal(captured.length, 2)
    assert.ok(captured.every(item => item.options.gltf instanceof Uint8Array))
    assert.deepEqual(captured.map(item => item.options.basePath).sort(), requests)
    assert.equal(captured[0].options.url, undefined)
    assert.equal(
      captured[0].gltf.images[0].extras._ccrSharedTextureHash,
      captured[1].gltf.images[0].extras._ccrSharedTextureHash
    )
    assert.equal(loadedCache, sharedTextures)
    assert.deepEqual(loadedCache.getDiagnostics(), { embeddedImages: 2, uniqueImages: 1, reusedImages: 1 })
    assert.equal(models.length, 2)
    sharedTextures.destroy()
    assert.equal(C.ResourceCacheKey.getImageCacheKey, originalImageKey)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('campus registers shared texture teardown before asynchronous model loading', () => {
  const source = fs.readFileSync(new URL('../../examples/campus.js', import.meta.url), 'utf8')
  const teardown = source.indexOf('sharedGlbTextures?.destroy()')
  const loading = source.indexOf('await loadCampusGlbs(')
  assert.ok(teardown >= 0)
  assert.ok(loading >= 0)
  assert.ok(teardown < loading, 'pagehide teardown must be installed before GLB loading starts')
})
