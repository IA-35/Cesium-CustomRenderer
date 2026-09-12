import test from 'node:test'
import assert from 'node:assert/strict'
import UniformBuffer143, { withUniformBlocks } from '../../src/buffers/UniformBuffer143.js'

function fixture() {
  let bound = null, storage, removed = 0
  const uploads = [], indexed = new Map(), blockBindings = new Map()
  const gl = { UNIFORM_BUFFER: 1, UNIFORM_BUFFER_BINDING: 2, MAX_UNIFORM_BLOCK_SIZE: 3,
    MAX_UNIFORM_BUFFER_BINDINGS: 4, UNIFORM_BUFFER_START: 5, UNIFORM_BUFFER_SIZE: 6,
    UNIFORM_BLOCK_DATA_SIZE: 7, UNIFORM_BLOCK_BINDING: 8, DYNAMIC_DRAW: 9, ACTIVE_UNIFORM_BLOCKS: 10, INVALID_INDEX: 0xffffffff,
    createBuffer: () => ({}), deleteBuffer: () => { removed++ }, isContextLost: () => false,
    getParameter: key => key === 3 ? 65536 : key === 4 ? 24 : bound,
    bindBuffer: (target, value) => { bound = value },
    bufferData: (target, size) => { storage = new Uint8Array(size) },
    bufferSubData: (target, offset, data) => { storage.set(data, offset); uploads.push([offset, data.length]) },
    getIndexedParameter: (key, index) => { const value = indexed.get(index) || { buffer: null, offset: 0, size: 0 }; return key === 2 ? value.buffer : key === 5 ? value.offset : value.size },
    bindBufferBase: (target, index, buffer) => { indexed.set(index, { buffer, offset: 0, size: buffer ? 16 : 0 }); bound = buffer },
    bindBufferRange: (target, index, buffer, offset, size) => { indexed.set(index, { buffer, offset, size }); bound = buffer },
    getUniformBlockIndex: (program, name) => name === 'Absent' ? 0xffffffff : 0,
    getProgramParameter: () => 1,
    getActiveUniformBlockParameter: (program, index, key) => key === 7 ? 16 : blockBindings.get(program) || 0,
    uniformBlockBinding: (program, index, point) => { blockBindings.set(program, point) }
  }
  return { gl, uploads, indexed, blockBindings, get storage() { return storage }, get bound() { return bound }, get removed() { return removed } }
}

test('UBO skips unchanged bytes and updates only the aligned dirty range', () => {
  const f = fixture(), buffer = new UniformBuffer143(f.gl, 16), data = new Float32Array([1, 2, 3, 4])
  assert.equal(buffer.update(data), 16)
  assert.equal(buffer.update(data), 0)
  data[2] = 7
  assert.equal(buffer.update(data), 4)
  assert.deepEqual(f.uploads, [[0, 16], [8, 4]])
  assert.deepEqual(Array.from(new Float32Array(f.storage.buffer)), [1, 2, 7, 4])
  assert.equal(buffer.getDiagnostics().uploadedBytes, 20)
  buffer.destroy(); buffer.destroy(); assert.equal(f.removed, 1)
  assert.throws(() => buffer.update(data), /destroyed/i)
})

test('uniform block binding restores external indexed ranges, program mappings and generic binding after failure', () => {
  const f = fixture(), buffer = new UniformBuffer143(f.gl, 16), foreign = {}, generic = {}, program = { _program: {} }
  f.gl.bindBufferRange(f.gl.UNIFORM_BUFFER, 23, foreign, 256, 16)
  f.gl.bindBuffer(f.gl.UNIFORM_BUFFER, generic)
  assert.throws(() => withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer }], () => {
    assert.equal(f.indexed.get(23).buffer, buffer.buffer)
    throw new Error('draw failure')
  }), /draw failure/)
  assert.deepEqual(f.indexed.get(23), { buffer: foreign, offset: 256, size: 16 })
  assert.equal(f.bound, generic)
  assert.equal(f.blockBindings.get(program._program), 0)
  assert.equal(withUniformBlocks(f.gl, [program], [{ name: 'Absent', buffer }], () => 42), 42)
  buffer.destroy()
})

test('invalid sizes and mismatched shader block layouts are rejected', () => {
  const f = fixture()
  assert.throws(() => new UniformBuffer143(f.gl, 0))
  assert.throws(() => new UniformBuffer143(f.gl, 17))
  const buffer = new UniformBuffer143(f.gl, 32)
  assert.throws(() => buffer.update(new Float32Array(4)), /size/i)
  assert.throws(() => withUniformBlocks(f.gl, [{ _program: {} }], [{ name: 'Frame', buffer }], () => {}), /layout|size/i)
  buffer.destroy()
})

test('failed GPU storage allocation releases the handle and restores the previous generic binding', () => {
  const f = fixture(), external = {}
  f.gl.bindBuffer(f.gl.UNIFORM_BUFFER, external)
  f.gl.getBufferParameter = () => 0
  assert.throws(() => new UniformBuffer143(f.gl, 16), /storage|allocation/i)
  assert.equal(f.removed, 1)
  assert.equal(f.bound, external)
})

test('binding selection avoids foreign blocks used by programs in the same batch', () => {
  const f = fixture(), buffer = new UniformBuffer143(f.gl, 16), foreign = {}, program = { _program: {} }
  f.gl.getProgramParameter = () => 2
  const previousParameter = f.gl.getActiveUniformBlockParameter
  f.gl.getActiveUniformBlockParameter = (p, index, key) => index === 1 && key === f.gl.UNIFORM_BLOCK_BINDING ? 23 : previousParameter(p, index, key)
  f.gl.bindBufferBase(f.gl.UNIFORM_BUFFER, 23, foreign)
  withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer }], () => {
    assert.equal(f.indexed.get(23).buffer, foreign)
    assert.equal(f.indexed.get(22).buffer, buffer.buffer)
    assert.equal(f.blockBindings.get(program._program), 22)
  })
  assert.equal(f.indexed.get(23).buffer, foreign)
  buffer.destroy()
})
