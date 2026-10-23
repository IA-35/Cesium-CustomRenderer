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

// 统计会同步回读驱动状态的查询；镜像方案下，看过一次的绑定状态不应再查询。
const QUERIES = ['getParameter', 'getIndexedParameter', 'getActiveUniformBlockParameter', 'getProgramParameter', 'getUniformBlockIndex']
function counted(f) {
  const counts = Object.fromEntries(QUERIES.map(name => [name, 0]))
  for (const name of QUERIES) { const original = f.gl[name]; f.gl[name] = (...args) => { counts[name]++; return original(...args) } }
  const calls = { uniformBlockBinding: 0, bindBufferBase: 0 }
  for (const name of Object.keys(calls)) { const original = f.gl[name]; f.gl[name] = (...args) => { calls[name]++; return original(...args) } }
  return { counts, calls, total: () => QUERIES.reduce((n, name) => n + counts[name], 0), reset: () => QUERIES.forEach(name => { counts[name] = 0 }) }
}

test('repeated binds of a seen program make no driver queries and still bind and restore every time', () => {
  const f = fixture(), buffer = new UniformBuffer143(f.gl, 16), program = { _program: {} }, foreign = {}
  f.gl.bindBufferRange(f.gl.UNIFORM_BUFFER, 23, foreign, 64, 16)
  const q = counted(f)
  withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer }], () => {})
  q.reset()
  for (let i = 0; i < 100; i++) {
    withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer }], () => {
      assert.equal(f.indexed.get(23).buffer, buffer.buffer)
      assert.equal(f.blockBindings.get(program._program), 23)
    })
    assert.deepEqual(f.indexed.get(23), { buffer: foreign, offset: 64, size: 16 })
    assert.equal(f.blockBindings.get(program._program), 0)
  }
  assert.deepEqual(q.counts, Object.fromEntries(QUERIES.map(name => [name, 0])), 'per-draw binds must not query the driver')
  assert.equal(q.calls.uniformBlockBinding, 202, 'each of the 101 binds still maps and restores the block')
  assert.equal(q.calls.bindBufferBase, 101)
  buffer.destroy()
})

test('nested binds on the same binding point and program restore the outer binding exactly', () => {
  const f = fixture(), outer = new UniformBuffer143(f.gl, 16), inner = new UniformBuffer143(f.gl, 16)
  const a = { _program: {} }, b = { _program: {} }, generic = {}
  f.gl.bindBuffer(f.gl.UNIFORM_BUFFER, generic)
  const run = () => withUniformBlocks(f.gl, [a], [{ name: 'Frame', buffer: outer }], () => {
    for (const program of [a, b]) {
      withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer: inner }], () => {
        assert.equal(f.indexed.get(23).buffer, inner.buffer)
        assert.equal(f.blockBindings.get(program._program), 23)
      })
      assert.equal(f.indexed.get(23).buffer, outer.buffer, 'the outer buffer is back on the shared point')
      assert.equal(f.blockBindings.get(a._program), 23, 'the outer program still reads the outer point')
    }
  })
  run(); run() // 第二轮全部走镜像
  assert.equal(f.indexed.get(23).buffer, null)
  assert.equal(f.blockBindings.get(a._program), 0)
  assert.equal(f.blockBindings.get(b._program), 0)
  assert.equal(f.bound, generic, 'the generic binding is restored without re-reading it')
  outer.destroy(); inner.destroy()
})

test('a second buffer on the same context reuses the mirrored point and block state', () => {
  const f = fixture(), first = new UniformBuffer143(f.gl, 16), data = new Float32Array(4), program = { _program: {} }
  first.update(data)
  withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer: first }], () => {})
  const q = counted(f), second = new UniformBuffer143(f.gl, 16)
  second.update(data)
  withUniformBlocks(f.gl, [program], [{ name: 'Frame', buffer: second }], () => assert.equal(f.indexed.get(23).buffer, second.buffer))
  assert.equal(q.counts.getIndexedParameter + q.counts.getActiveUniformBlockParameter, 0)
  first.destroy(); second.destroy()
})
