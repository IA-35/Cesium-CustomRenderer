// 64 periodic z slices, each with one wrapped texel on all four sides.
// The caller owns the returned texture; stages must borrow it through a function uniform.
import pixels from './cloudNoiseData.js'
export default function createNoiseAtlas(C, context) {
  const width = 528
  return new C.Texture({ context, flipY: false, pixelFormat: C.PixelFormat.RGBA,
    pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
    source: { width, height: width, arrayBufferView: pixels },
    sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE,
      minificationFilter: C.TextureMinificationFilter.LINEAR,
      magnificationFilter: C.TextureMagnificationFilter.LINEAR }) })
}
