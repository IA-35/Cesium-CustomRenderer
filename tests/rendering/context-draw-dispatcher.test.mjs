import test from 'node:test'
import assert from 'node:assert/strict'
import ContextDrawDispatcher143 from '../../src/pipeline/ContextDrawDispatcher143.js'

test('dispatcher installs one wrapper and records handler decisions', () => {
  const calls = [], context = { draw(command) { calls.push(command); return command } }
  const dispatcher = new ContextDrawDispatcher143(context).install()
  let restored = 0
  dispatcher.addHandler(event => { event.deferRestore(() => { restored++ }); return event.command === 'replacement' ? 'replace' : 'pass' }, { name: 'test', priority: 1 })
  dispatcher.addObserver(event => calls.push(`observe:${event.decision}`))
  assert.equal(context.draw('native'), 'native')
  assert.equal(context.draw('replacement'), undefined)
  assert.deepEqual(calls, ['native', 'observe:pass', 'observe:replace'])
  assert.equal(restored, 2)
  const report = dispatcher.getDiagnostics()
  assert.equal(report.drawHookInstallations, 1)
  assert.equal(report.drawHookInvocations, 2)
  assert.equal(report.nativeFallbackDraws, 1)
  assert.equal(report.shortCircuits, 1)
  dispatcher.destroy()
  assert.equal(context.draw, dispatcher.native)
})

test('dispatcher does not overwrite a foreign wrapper on uninstall', () => {
  const context = { draw() { return 'native' } }
  const foreign = () => 'foreign'
  const dispatcher = new ContextDrawDispatcher143(context).install()
  context.draw = foreign
  dispatcher.uninstall()
  assert.equal(context.draw, foreign)
})

test('dispatcher composes aroundDraw scopes before native execution', () => {
  const calls=[], context={draw(){calls.push('native');return 'ok'}}
  const dispatcher=new ContextDrawDispatcher143(context).install()
  dispatcher.addHandler(event=>{event.aroundDraw(invoke=>{calls.push('before');const result=invoke();calls.push('after');return result});return 'continue'},{name:'scope'})
  assert.equal(context.draw('command'),'ok')
  assert.deepEqual(calls,['before','native','after'])
  dispatcher.destroy()
})

test('dispatcher measures program and material binds from the GL entry points', () => {
  let useProgram = 0
  const gl = {
    useProgram() { useProgram++; return useProgram },
    drawElements() {}, drawArrays() {}, bindTexture() {}, uniform4fv() {}, uniformMatrix4fv() {}
  }
  const dispatcher = new ContextDrawDispatcher143({ draw() {}, _gl: gl }).install()
  const original = gl.useProgram
  dispatcher.startBindTracking()
  gl.useProgram('p'); gl.drawElements(); gl.drawElements()
  const measured = dispatcher.readBindCounters()
  assert.equal(measured.programBinds, 1)
  assert.equal(measured.materialBinds, 2)
  assert.equal(dispatcher.getDiagnostics().bindTracking, true)
  assert.equal(dispatcher.getDiagnostics().programBinds, 1)
  dispatcher.stopBindTracking()
  gl.useProgram('p')
  assert.equal(useProgram, 2, 'the original GL entry point must be restored')
  assert.equal(dispatcher.readBindCounters(), null)
  dispatcher.destroy()
  assert.equal(gl.useProgram, original)
})

test('destroy stops bind tracking instead of leaving wrapped GL methods', () => {
  const gl = { useProgram() {}, drawElements() {}, drawArrays() {}, bindTexture() {}, uniform4fv() {}, uniformMatrix4fv() {} }
  const original = gl.useProgram
  const dispatcher = new ContextDrawDispatcher143({ draw() {}, _gl: gl }).install()
  dispatcher.startBindTracking()
  assert.notEqual(gl.useProgram, original)
  dispatcher.destroy()
  assert.equal(gl.useProgram, original, 'a destroyed dispatcher must not keep wrapping GL')
})
