import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import test from 'node:test'
import { readGlbJson } from '../../examples/shared-glb-textures.js'

const require = createRequire(import.meta.url)
const source = fs.readFileSync(new URL('../../scripts/prepare-traffic-demo.cjs', import.meta.url), 'utf8')
  .split("if (process.argv.includes('--cars-only'))")[0]

function generate(root, packed) {
  vm.runInNewContext(packed ? source : source.replace('], true)', '], false)'), {
    require, __dirname: path.join(root, 'scripts'), process: { argv: [] }, Buffer
  })
  return name => readGlbJson(fs.readFileSync(path.join(root, 'examples/traffic-assets', `car-${name}.glb`)))
}

function values(model, index) {
  const accessor = model.gltf.accessors[index], view = model.gltf.bufferViews[accessor.bufferView]
  const offset = model.binaryOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0)
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type]
  const bytes = new DataView(model.bytes.buffer, model.bytes.byteOffset + offset)
  return Array.from({ length: accessor.count * components }, (_, i) =>
    accessor.componentType === 5126 ? bytes.getFloat32(i*4, true) : bytes.getUint16(i*2, true))
}

test('one-draw traffic meshes preserve every triangle, normal and linear PBR material', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-car-packing-'))
  try {
    const original = generate(path.join(root, 'original'), false), packed = generate(path.join(root, 'packed'), true)
    for (const name of ['blue', 'ivory', 'orange']) {
      const a = original(name), b = packed(name), parts = a.gltf.meshes[0].primitives, merged = b.gltf.meshes[0].primitives
      assert.equal(parts.length, 4); assert.equal(merged.length, 1)
      const p = merged[0], positions = values(b, p.attributes.POSITION), normals = values(b, p.attributes.NORMAL)
      const colors = values(b, p.attributes.COLOR_0), uv = values(b, p.attributes.TEXCOORD_0), indices = values(b, p.indices)
      const png = Buffer.from(b.gltf.images[0].uri.split(',')[1], 'base64'), idat = []
      for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset)
        if (png.toString('ascii', offset+4, offset+8) === 'IDAT') idat.push(png.subarray(offset+8, offset+8+length))
        offset += length+12
      }
      const pixels = zlib.inflateSync(Buffer.concat(idat))
      assert.equal(png.readUInt32BE(16), 4); assert.equal(png.readUInt32BE(20), 1)
      assert.equal(pixels[0], 0, 'the constant material row uses PNG filter None')
      let vertex = 0, index = 0
      for (const [part, primitive] of parts.entries()) {
        const oldPositions = values(a, primitive.attributes.POSITION), oldNormals = values(a, primitive.attributes.NORMAL)
        const oldIndices = values(a, primitive.indices), material = a.gltf.materials[primitive.material].pbrMetallicRoughness
        assert.deepEqual(positions.slice(vertex*3, vertex*3+oldPositions.length), oldPositions)
        assert.deepEqual(normals.slice(vertex*3, vertex*3+oldNormals.length), oldNormals)
        assert.deepEqual(indices.slice(index, index+oldIndices.length), oldIndices.map(value => value+vertex))
        for (let n = 0; n < oldPositions.length/3; n++) {
          assert.deepEqual(colors.slice((vertex+n)*3, (vertex+n+1)*3), material.baseColorFactor.slice(0,3).map(Math.fround))
          assert.deepEqual(uv.slice((vertex+n)*2, (vertex+n+1)*2), [(part+.5)/4,.5])
        }
        assert(Math.abs(pixels[1+part*4+1]/255*.85-material.roughnessFactor) < 1e-12)
        assert(Math.abs(pixels[1+part*4+2]/255*.85-material.metallicFactor) < 1e-12)
        vertex += oldPositions.length/3; index += oldIndices.length
      }
      assert.equal(indices.length, index)
      assert.deepEqual(b.gltf.nodes, a.gltf.nodes)
      assert.equal(b.gltf.samplers[0].minFilter, 9728)
    }
  } finally { fs.rmSync(root, { recursive: true }) }
})
