import test from 'node:test'
import assert from 'node:assert/strict'
import RenderItemExecutor143 from '../../src/renderer/RenderItemExecutor143.js'
import { createRenderItem143 } from '../../src/renderer/RenderItem143.js'
import ContextDrawDispatcher143 from '../../src/pipeline/ContextDrawDispatcher143.js'

test('executor owns command overrides without mutating RenderItem command', () => {
  const calls = []
  const C = { DrawCommand: { shallowClone(command) { return { ...command } } } }
  const command = { framebuffer: 'old', execute(context, passState) { calls.push([this.framebuffer, passState]) } }
  const item = createRenderItem143(command, { pass: 'deferred.geometry' })
  const executor = new RenderItemExecutor143(C)
  executor.execute(item, {}, {}, { framebuffer: 'new' })
  assert.equal(command.framebuffer, 'old')
  assert.deepEqual(calls[0], ['new', {}])
  assert.equal(executor.getDiagnostics().deferred, 1)
})

test('executor submits a command through the dispatcher without recursively re-entering handlers', () => {
  let nativeDraws = 0
  const context = { draw() { nativeDraws++; return 'native' } }
  const dispatcher = new ContextDrawDispatcher143(context).install()
  const C = { DrawCommand: { shallowClone(command) { return { ...command } } } }
  const command = { execute(ctx, passState) { return ctx.draw(this, passState) } }
  const executor = new RenderItemExecutor143(C)
  dispatcher.addHandler(event => {
    executor.execute({ command: event.command, pass: 'transparent.forward' }, event.context, event.passState)
    return 'skip'
  }, { name: 'direct-submit', priority: 1 })
  context.draw(command, {})
  assert.equal(nativeDraws, 1)
  assert.equal(dispatcher.getDiagnostics().drawHookInvocations, 1)
  dispatcher.destroy()
})

// 这条用例的假命令必须模拟 Cesium 的真实绑定行为：
// `Context.beginDraw`（1.143 `Source/Renderer/Context.js:1313`）对每条命令
// 无条件 `shaderProgram._bind()`。早先的假命令 `execute()` 里不绑，
// 于是「一批一次绑定」的假象通过了测试，而真实运行时是 n+1 次（预绑定 + 每条再绑）。
// 现在执行器不再预绑定，所以断言应是「恰好每条一次，没有多余的那一次」。
test('executeBatch does not add a redundant program bind on top of Cesium native binds', () => {
  const binds = [], executed = []
  const program = { _bind() { binds.push('bind'); return true } }
  const executor = new RenderItemExecutor143(null, { label: 'test' })
  const command = n => ({
    shaderProgram: program,
    execute() { program._bind(); executed.push(n); return n }
  })
  const items = [
    { pass: 'opaque.forward', command: command(1) },
    { pass: 'opaque.forward', command: command(2) }
  ]
  const result = executor.executeBatch({ items }, {}, {})
  assert.equal(result.submitted, 2)
  assert.equal(result.failedAt, -1)
  assert.equal(binds.length, 2, 'one bind per item, and no extra pre-bind')
  assert.deepEqual(executed, [1, 2])
  assert.equal(executor.getDiagnostics().batched, 2)
})

test('executeBatch refuses a stale batch whose program no longer matches the plan', () => {
  const executor = new RenderItemExecutor143(null, { label: 'test' })
  const items = [
    { pass: 'opaque.forward', command: { shaderProgram: { _bind() {} } } },
    { pass: 'opaque.forward', command: { shaderProgram: { _bind() {} } } }
  ]
  const result = executor.executeBatch({ items }, { draw() {} }, {})
  assert.equal(result.submitted, 1)
  assert.equal(result.failedAt, 1)
  assert.equal(executor.getDiagnostics().batchBroken, 1)
})
