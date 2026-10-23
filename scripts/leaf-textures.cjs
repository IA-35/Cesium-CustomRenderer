// Leaf card textures for the generated tree prototypes. They are authored white so
// the glTF baseColorFactor can tint a whole species without re-baking the image;
// tree.js orients a leaf card with the tip at v=0 and the attachment at v=1.
const zlib = require('node:zlib')

const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
const crc32 = buffer => {
  let c = -1
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

// Deterministic PRNG so regenerating the assets produces identical bytes.
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

// Shapes are described in normalised card space: x in [-1, 1] across the card,
// y in [0, 1] from the attachment (0) to the tip (1).
const shapes = {
  // Ginkgo: a fan swept around a pivot, split by a notch at the middle of the rim.
  ginkgo({ x, y }) {
    const pivotY = 0.12
    const dy = y - pivotY, r = Math.hypot(x, dy)
    const angle = Math.atan2(Math.abs(x), dy) // 0 straight up, grows to the sides
    const maxAngle = 1.18
    if (y < pivotY) return Math.abs(x) < 0.014 && y > 0.01 ? 1 : 0 // petiole
    if (angle > maxAngle || r < 0.19) return 0
    // Rim is a shallow arc; the central notch splits the fan at the top.
    const rim = 0.86 * (1 - 0.1 * (angle / maxAngle) ** 2) *
      (1 - 0.5 * Math.exp(-((angle / 0.075) ** 2)))
    if (r > rim) return 0
    // Radiating veins survive the alpha test and read at close range.
    return Math.abs(Math.sin(angle * 11)) < 0.3 ? 0.82 : 1
  },
  // Cherry: five rounded petals around a small eye, held by a short stalk.
  sakura({ x, y }) {
    if (y < 0.1) return Math.abs(x) < 0.011 && y > 0.02 ? 1 : 0 // stalk
    const cx = x, cy = y - 0.54
    if (Math.hypot(cx, cy) < 0.035) return 0.72 // eye
    let best = 0
    for (let petal = 0; petal < 5; petal++) {
      const angle = (petal / 5) * Math.PI * 2 - Math.PI / 2
      const px = cx * Math.cos(angle) - cy * Math.sin(angle)
      const py = cx * Math.sin(angle) + cy * Math.cos(angle) - 0.19
      // Rounded petal: the outline is an ellipse narrowed at the base, with a
      // shallow notch only at the outer tip.
      const ellipse = Math.hypot(px / 0.165, py / 0.225)
      const notch = py > 0.16 && Math.abs(px) < 0.045 ? 0.08 : 0
      if (ellipse < 1 - notch) best = 1
    }
    return best
  },
}

function render(kind, size = 256, superSample = 3) {
  const shape = shapes[kind]
  if (!shape) throw new Error(`Unknown leaf texture: ${kind}`)
  const big = size * superSample
  const alpha = new Float32Array(big * big)
  for (let y = 0; y < big; y++) {
    // Image row 0 is the leaf tip, so flip y while sampling card space.
    const cardY = 1 - (y + 0.5) / big
    for (let x = 0; x < big; x++) {
      const cardX = ((x + 0.5) / big) * 2 - 1
      alpha[y * big + x] = shape({ x: cardX, y: cardY })
    }
  }
  const cover = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0
    for (let sy = 0; sy < superSample; sy++) for (let sx = 0; sx < superSample; sx++) {
      sum += alpha[(y * superSample + sy) * big + x * superSample + sx]
    }
    cover[y * size + x] = sum / (superSample * superSample)
  }
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, cover[i])
    // Shade veins slightly so the card is not a flat silhouette.
    const shade = 255 * (0.72 + 0.28 * Math.min(1, a))
    rgba[i * 4] = shade; rgba[i * 4 + 1] = shade; rgba[i * 4 + 2] = shade
    rgba[i * 4 + 3] = Math.round(a * 255)
  }
  return encodePng(size, size, rgba)
}

module.exports = { render }
