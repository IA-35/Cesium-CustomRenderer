const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BINARY_CHUNK = 0x004e4942
const SHARED_HASH = '_ccrSharedTextureHash'
const SHA256_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

let activeCache

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('GLB data must be an ArrayBuffer or Uint8Array')
}

export function readGlbJson(value) {
  const bytes = asUint8Array(value)
  if (bytes.byteLength < 20) throw new Error('Invalid GLB: file is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('Invalid GLB: expected a glTF 2.0 binary')
  }
  if (view.getUint32(8, true) > bytes.byteLength) throw new Error('Invalid GLB: declared length exceeds available data')

  let jsonBytes
  let binaryOffset
  let binaryLength
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const contentOffset = offset + 8
    if (contentOffset + chunkLength > bytes.byteLength) throw new Error('Invalid GLB: chunk exceeds available data')
    if (chunkType === JSON_CHUNK) jsonBytes = bytes.subarray(contentOffset, contentOffset + chunkLength)
    if (chunkType === BINARY_CHUNK) {
      binaryOffset = contentOffset
      binaryLength = chunkLength
    }
    offset = contentOffset + chunkLength
  }
  if (!jsonBytes) throw new Error('Invalid GLB: JSON chunk is missing')
  const json = new TextDecoder().decode(jsonBytes).replace(/\0+$/, '')
  return { gltf: JSON.parse(json), bytes, binaryOffset, binaryLength }
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount))
}

async function sha256Fallback(bytes) {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.byteLength] = 0x80
  const bitLength = bytes.byteLength * 8
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const words = new Uint32Array(64)
  let blocksSinceYield = 0
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index++) {
      const before15 = words[index - 15]
      const before2 = words[index - 2]
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0
    blocksSinceYield++
    // In non-secure HTTP deployments Web Crypto is unavailable. Yield the
    // fallback digest roughly every 256 KiB so a large KTX2 cannot monopolize
    // the Cesium render thread for an entire frame.
    if (blocksSinceYield >= 4096 && offset + 64 < paddedLength) {
      blocksSinceYield = 0
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  return Array.from(state, value => value.toString(16).padStart(8, '0')).join('')
}

export async function hashBytesSha256(bytes, subtle = globalThis.crypto?.subtle) {
  if (subtle?.digest) {
    try {
      const digest = await subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      // Plain HTTP LAN deployments may expose crypto without usable SubtleCrypto.
    }
  }
  return sha256Fallback(bytes)
}

function imageHash(gltf, imageId) {
  return gltf.images?.[imageId]?.extras?.[SHARED_HASH]
}

function textureImageHash(Cesium, options) {
  const imageId = Cesium.GltfLoaderUtil.getImageIdFromTexture({
    gltf: options.gltf,
    textureId: options.textureInfo.index,
    supportedImageFormats: options.supportedImageFormats
  })
  return imageId === undefined ? undefined : imageHash(options.gltf, imageId)
}

export class SharedGlbTextureCache {
  constructor(Cesium) {
    if (activeCache && !activeCache._destroyed) throw new Error('A shared GLB texture cache is already active')
    this._Cesium = Cesium
    this._seenHashes = new Set()
    this._embeddedImages = 0
    this._reusedImages = 0
    this._destroyed = false
    this._originalImageKey = Cesium.ResourceCacheKey.getImageCacheKey
    this._originalTextureKey = Cesium.ResourceCacheKey.getTextureCacheKey

    const originalImageKey = this._originalImageKey
    const originalTextureKey = this._originalTextureKey
    const owner = this
    this._imageKeyWrapper = function (options) {
      if (owner._destroyed) return originalImageKey(options)
      const hash = imageHash(options.gltf, options.imageId)
      return hash ? `image:ccr-content-${hash}` : originalImageKey(options)
    }
    this._textureKeyWrapper = function (options) {
      if (owner._destroyed) return originalTextureKey(options)
      const hash = textureImageHash(Cesium, options)
      if (!hash) return originalTextureKey(options)
      const original = originalTextureKey(options)
      const samplerSuffix = original.indexOf('-sampler-')
      return `texture:ccr-content-${hash}${original.slice(samplerSuffix)}`
    }
    Cesium.ResourceCacheKey.getImageCacheKey = this._imageKeyWrapper
    Cesium.ResourceCacheKey.getTextureCacheKey = this._textureKeyWrapper
    activeCache = this
  }

  async hashEmbeddedImages(value, suppliedGltf) {
    if (this._destroyed) throw new Error('Shared GLB texture cache is destroyed')
    const parsed = readGlbJson(value)
    const gltf = suppliedGltf ?? parsed.gltf
    const images = gltf.images ?? []
    const rangeHashes = new Map()
    return Promise.all(images.map(async image => {
      if (image.uri !== undefined || image.bufferView === undefined) return undefined
      if (parsed.binaryOffset === undefined) throw new Error('Invalid GLB: embedded image has no binary chunk')
      const bufferView = gltf.bufferViews?.[image.bufferView]
      if (!bufferView || bufferView.buffer !== 0) throw new Error('Unsupported GLB: embedded image must use buffer 0')
      const byteOffset = bufferView.byteOffset ?? 0
      const byteLength = bufferView.byteLength
      if (byteOffset + byteLength > parsed.binaryLength) throw new Error('Invalid GLB: embedded image exceeds the binary chunk')
      const rangeKey = `${byteOffset}:${byteLength}`
      let promise = rangeHashes.get(rangeKey)
      if (!promise) {
        const imageBytes = parsed.bytes.subarray(
          parsed.binaryOffset + byteOffset,
          parsed.binaryOffset + byteOffset + byteLength
        )
        promise = hashBytesSha256(imageBytes).then(hash => `${image.mimeType ?? 'application/octet-stream'}:${hash}`)
        rangeHashes.set(rangeKey, promise)
      }
      const hash = await promise
      this._embeddedImages++
      if (this._seenHashes.has(hash)) this._reusedImages++
      else this._seenHashes.add(hash)
      return hash
    }))
  }

  annotate(gltf, hashes) {
    for (let index = 0; index < hashes.length; index++) {
      const hash = hashes[index]
      if (!hash || !gltf.images?.[index]) continue
      gltf.images[index].extras = { ...gltf.images[index].extras, [SHARED_HASH]: hash }
    }
  }

  getDiagnostics() {
    return {
      embeddedImages: this._embeddedImages,
      uniqueImages: this._seenHashes.size,
      reusedImages: this._reusedImages
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    if (this._Cesium.ResourceCacheKey.getImageCacheKey === this._imageKeyWrapper) {
      this._Cesium.ResourceCacheKey.getImageCacheKey = this._originalImageKey
    }
    if (this._Cesium.ResourceCacheKey.getTextureCacheKey === this._textureKeyWrapper) {
      this._Cesium.ResourceCacheKey.getTextureCacheKey = this._originalTextureKey
    }
    if (activeCache === this) activeCache = undefined
  }
}
