// 64 periodic z slices, each with one wrapped texel on all four sides.
// The caller owns the returned texture; stages must borrow it through a function uniform.
export default function createNoiseAtlas(C, context) {
  const lattice = new Uint8Array(64 * 64 * 64)
  let seed = 0x65d9e23b
  for (let i = 0; i < lattice.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    lattice[i] = seed & 255
  }
  const width = 528
  const pixels = new Uint8Array(width * width * 4)
  for (let z = 0; z < 64; z++) {
    const tileX = z % 8 * 66
    const tileY = Math.floor(z / 8) * 66
    for (let y = 0; y < 66; y++) {
      for (let x = 0; x < 66; x++) {
        const value = lattice[z * 4096 + ((y + 63) % 64) * 64 + (x + 63) % 64]
        const offset = ((tileY + y) * width + tileX + x) * 4
        pixels[offset] = value
        pixels[offset + 1] = value
        pixels[offset + 2] = value
        pixels[offset + 3] = 255
      }
    }
  }
  return new C.Texture({ context, flipY: false, pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
    source: { width, height: width, arrayBufferView: pixels },
    sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE,
      minificationFilter: C.TextureMinificationFilter.LINEAR,
      magnificationFilter: C.TextureMagnificationFilter.LINEAR }) })
}
