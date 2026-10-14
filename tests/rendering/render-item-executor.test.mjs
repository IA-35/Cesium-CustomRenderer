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
