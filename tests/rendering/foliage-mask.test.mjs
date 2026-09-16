import test from 'node:test'
import assert from 'node:assert/strict'
import FoliageMask143 from '../../examples/compat/LegacyFoliageMask.js'

test('verified foliage cutoff applies to copied draw maps and restores on disable', () => {
  const scene = { frameState: { frameNumber: 1 }, updateDerivedCommands() {} }
  const native = scene.updateDerivedCommands, owner = new FoliageMask143(scene)
  const getter = () => .5, command = { owner: { _resource: { url: 'http://assets/SM_NH_Shu/NoLod_0.glb' } }, uniformMap: { u_alphaCutoff: getter } }
  owner.setEnabled(true); scene.updateDerivedCommands(command)
  assert.equal(command.uniformMap.u_alphaCutoff(), .25)
  const copied = { ...command.uniformMap }; command.uniformMap = copied
  for (let i = 0; i < 10; i++) scene.updateDerivedCommands(command)
  assert.equal(copied.u_alphaCutoff(), .25)
  owner.setEnabled(false)
  assert.equal(copied.u_alphaCutoff(), .5)
  assert.equal(scene.updateDerivedCommands, native)
  owner.destroy(); owner.destroy()
})

test('other assets, explicit cutoffs and externally replaced getters are retained', () => {
  const scene = { frameState: { frameNumber: 1 }, updateDerivedCommands() {} }, owner = new FoliageMask143(scene)
  owner.setEnabled(true)
  const other = { owner: { _resource: { url: '/building.glb' } }, uniformMap: { u_alphaCutoff: () => .5 } }
  scene.updateDerivedCommands(other); assert.equal(other.uniformMap.u_alphaCutoff(), .5)
  const tree = { owner: { _resource: { url: '/SM_NH_Shu/NoLod_0.glb' } }, uniformMap: { u_alphaCutoff: () => .2 } }
  scene.updateDerivedCommands(tree); assert.equal(tree.uniformMap.u_alphaCutoff(), .2)
  const external = () => .5; tree.uniformMap.u_alphaCutoff = external
  scene.updateDerivedCommands(tree); assert.equal(tree.uniformMap.u_alphaCutoff, external)
  owner.destroy(); assert.equal(tree.uniformMap.u_alphaCutoff, external)
})
