import test from 'node:test'
import assert from 'node:assert/strict'
import BindingScope143, { withBindings143 } from '../../src/renderer/BindingScope143.js'

function fixture() {
  const calls = []
  const gl = Object.fromEntries(['useProgram', 'activeTexture', 'bindTexture', 'deleteTexture', 'deleteProgram']
    .map(name => [name, (...args) => calls.push([name, ...args])]))
  gl.isContextLost = () => false
  return { gl, calls }
}
test('deduplication preserves state changes, per-unit textures and nested scopes', () => {
  const { gl, calls } = fixture(), before = { ...gl }, stats = {}, a = {}, b = {}
  withBindings143(gl, () => {
    gl.useProgram(a); gl.useProgram(a)
    gl.activeTexture(33984); gl.bindTexture(3553, a); gl.bindTexture(3553, a)
    withBindings143(gl, () => { gl.useProgram(b); gl.activeTexture(33985); gl.bindTexture(3553, b) })
    gl.useProgram(a); gl.activeTexture(33984); gl.bindTexture(3553, a)
    gl.bindTexture(34067, a); gl.bindTexture(34067, a)
  }, stats)
  assert.equal(stats.programRequests, 4); assert.equal(stats.programBinds, 3)
  assert.equal(stats.textureRequests, 6); assert.equal(stats.textureBinds, 3)
  const wrappers = { ...gl }
  let prior = calls.length
  gl.useProgram(a); gl.useProgram(a)
  assert.equal(calls.length, prior + 2, 'outside a scope the resident wrappers pass every call through')
  prior = calls.length
  withBindings143(gl, () => gl.useProgram(a))
  assert.equal(calls.length, prior + 1, 'a new scope starts with unknown GL state')
  assert.deepEqual(gl, wrappers, 'wrappers are installed once, never added and deleted per scope')
  assert.notEqual(gl.useProgram, before.useProgram)
})
test('a tool restoring the original method gets the resident wrapper reinstalled', () => {
  const { gl, calls } = fixture(), a = {}
  withBindings143(gl, () => {})
  const ours = gl.useProgram
  // 模拟绑定计数：包住我们，停止时恢复到包之前的函数（也就是我们）。
  const counting = gl.useProgram = function(value) { return ours.call(this, value) }
  withBindings143(gl, () => { gl.useProgram(a); gl.useProgram(a) })
  assert.equal(gl.useProgram, counting, 'a wrapper above ours is left alone')
  assert.equal(calls.filter(c => c[0] === 'useProgram').length, 1)
  gl.useProgram = ours
  const stats = {}
  withBindings143(gl, () => { gl.useProgram(a); gl.useProgram(a) }, stats)
  assert.equal(stats.programBinds, 1)
})
test('texture/program deletion invalidates cached bindings and errors restore wrappers', () => {
  const { gl, calls } = fixture(), before = { ...gl }, a = {}
  assert.throws(() => withBindings143(gl, () => {
    gl.activeTexture(33984); gl.bindTexture(3553, a); gl.deleteTexture(a); gl.bindTexture(3553, a)
    gl.useProgram(a); gl.deleteProgram(a); gl.useProgram(a)
    throw Error('draw failed')
  }), /draw failed/)
  assert.equal(calls.filter(c => c[0] === 'bindTexture').length, 2)
  assert.equal(calls.filter(c => c[0] === 'useProgram').length, 2)
  const prior = calls.length
  gl.useProgram(a); gl.useProgram(a)
  assert.equal(calls.length, prior + 2, 'an aborted scope leaves the wrappers in pass-through mode')
  assert.ok(before)
})
test('scene integration skips pick frames and restores even when another wrapper owns the method', () => {
  const { gl } = fixture(), passes = { render: true }, draws = []
  const scene = { context: { _gl: gl }, frameState: { frameNumber: 1, passes },
    updateAndExecuteCommands() { for (let i = 0; i < 3; i++) { gl.useProgram(1); draws.push(i) } } }
  const native = scene.updateAndExecuteCommands
  const scope = new BindingScope143(scene, () => true)
  scene.updateAndExecuteCommands()
  assert.deepEqual(draws, [0, 1, 2])
  assert.equal(scope.getDiagnostics().programBinds, 1)
  scene.frameState.frameNumber++; passes.pick = true
  scene.updateAndExecuteCommands()
  assert.equal(scope.getDiagnostics().measured, false)
  const inner = scene.updateAndExecuteCommands
  scene.updateAndExecuteCommands = () => inner()
  scope.destroy()
  assert.notEqual(scene.updateAndExecuteCommands, native)
  scene.updateAndExecuteCommands()
  assert.equal(draws.length, 9)
})
