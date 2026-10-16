import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import ContextDrawDispatcher143 from '../../src/pipeline/ContextDrawDispatcher143.js'
import GlobeNightLighting143 from '../../src/environment/GlobeNightLighting143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const globeFS = readFileSync(new URL('../../node_modules/@cesium/engine/Source/Shaders/GlobeFS.glsl', import.meta.url), 'utf8')

function fixture() {
  assert.equal(typeof GlobeNightLighting143, 'function', 'globe material night-light adapter exists')
  const calls = [], derived = new WeakMap()
  let created = 0, failDraw = false
  const context = { draw(command) {
    calls.push({ program: command.shaderProgram, uniforms: command.uniformMap })
    if (failDraw) throw new Error('draw failed')
    return 'drawn'
  }, shaderCache: {
    getDerivedShaderProgram(source, keyword) { return derived.get(source)?.get(keyword) },
    createDerivedShaderProgram(source, keyword, options) {
      created++
      const program = { ...options, isDestroyed: () => false, destroy: () => assert.fail('cache-owned programs must not be destroyed') }
      let map = derived.get(source)
      if (!map) derived.set(source, map = new Map())
      map.set(keyword, program)
      return program
    }
  } }
  const dispatcher = new ContextDrawDispatcher143(context).install()
  let siblingCalls = 0
  dispatcher.addHandler(() => { siblingCalls++; return 'continue' }, { name: 'sibling' })
  const scene = { context, frameState: { passes: { render: true, pick: false } }, globe: {} }
  const state = { nightWeight: 1, nightSkyRadiance: [0.012, 0.022, 0.045] }
  const program = { vertexShaderSource: new C.ShaderSource({ sources: ['void main() {}'] }),
    fragmentShaderSource: new C.ShaderSource({ defines: ['ENABLE_VERTEX_LIGHTING'], sources: ['// imagery prelude', globeFS] }),
    _attributeLocations: { position: 0 } }
  const uniforms = { imagery: () => 'native-imagery' }
  const command = { pass: C.Pass.GLOBE, shaderProgram: program, uniformMap: uniforms }
  const lighting = new GlobeNightLighting143(C, scene, () => state)
  lighting.setActive(true)
  return { context, dispatcher, scene, state, program, uniforms, command, lighting, calls,
    created: () => created, siblingCalls: () => siblingCalls, failDraw: () => { failDraw = true } }
}

test('night globe material multiplies decoded imagery albedo and preserves native alpha and clipping', () => {
  const f = fixture(), wrapper = f.context.draw
  assert.equal(f.context.draw(f.command), 'drawn')
  assert.equal(f.context.draw, wrapper)
  const drawn = f.calls[0], fs = drawn.program.fragmentShaderSource
  assert.notEqual(drawn.program, f.program)
  assert.deepEqual(fs.defines, f.program.fragmentShaderSource.defines)
  const patch = 'finalColor.rgb += color.rgb * ccrGlobeNightSky;'
  const text = fs.sources.join('\n')
  assert.match(text, /uniform vec3 ccrGlobeNightSky;/)
  assert.ok(text.indexOf(patch) > text.indexOf('color.rgb * czm_lightColor * diffuseIntensity'))
  assert.ok(text.indexOf(patch) < text.indexOf('vec4 clippingPlanesEdgeColor'))
  assert.ok(text.includes('vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);'))
  assert.ok(text.includes('out_FragColor =  finalColor;'))
  assert.equal((text.match(/finalColor\.rgb \+= color\.rgb \* ccrGlobeNightSky;/g) || []).length, 1)
  assert.deepEqual(drawn.uniforms.ccrGlobeNightSky(), new C.Cartesian3(...f.state.nightSkyRadiance))
  assert.equal(drawn.uniforms.imagery, f.uniforms.imagery)
  assert.equal(f.command.shaderProgram, f.program)
  assert.equal(f.command.uniformMap, f.uniforms)
  assert.equal(f.program.fragmentShaderSource.sources[1], globeFS)
  assert.equal(f.siblingCalls(), 1, 'other handlers continue to run')
  f.context.draw(f.command)
  assert.equal(f.created(), 1)
  assert.equal(f.calls[1].program, drawn.program)
  assert.equal(f.calls[1].uniforms, drawn.uniforms)
  f.state.nightSkyRadiance = [0.02, 0.03, 0.04]
  assert.deepEqual(drawn.uniforms.ccrGlobeNightSky(), new C.Cartesian3(0.02, 0.03, 0.04))
  f.lighting.destroy(); f.dispatcher.destroy()
})

test('day, zero sky, disabled, pick, shadow, overridden and foreign draws stay unchanged', () => {
  const f = fixture()
  const unchanged = () => { f.context.draw(f.command); assert.equal(f.calls.at(-1).program, f.command.shaderProgram) }
  f.state.nightWeight = 0; unchanged()
  f.state.nightWeight = 1; f.state.nightSkyRadiance = [0, 0, 0]; unchanged()
  f.state.nightSkyRadiance = [0.012, 0.022, 0.045]
  f.scene.globe.enableLighting = false; unchanged(); f.scene.globe.enableLighting = true
  f.program.fragmentShaderSource.defines.push('SHADOW_MAP'); unchanged(); f.program.fragmentShaderSource.defines.pop()
  f.lighting.setActive(false); unchanged(); f.lighting.setActive(true)
  f.scene.frameState.passes.pick = true; unchanged(); f.scene.frameState.passes.pick = false
  f.command.renderState = { colorMask: { red: false, green: false, blue: false, alpha: false } }; unchanged()
  delete f.command.renderState
  f.command.pass = C.Pass.OPAQUE; unchanged(); f.command.pass = C.Pass.GLOBE
  f.dispatcher.withBypass(unchanged)
  f.context.draw(f.command, {}, { externalOverride: true })
  assert.equal(f.calls.at(-1).program, f.program)
  f.command.shaderProgram = { fragmentShaderSource: new C.ShaderSource({ sources: ['void main() {}'] }) }; unchanged()
  assert.equal(f.created(), 0)
  f.lighting.destroy(); f.dispatcher.destroy()
})

test('draw exceptions restore command references and cleanup keeps the shared dispatcher alive', () => {
  const f = fixture(), wrapper = f.context.draw
  f.failDraw()
  assert.throws(() => f.context.draw(f.command), /draw failed/)
  assert.equal(f.command.shaderProgram, f.program)
  assert.equal(f.command.uniformMap, f.uniforms)
  f.lighting.destroy(); f.lighting.destroy()
  assert.equal(f.context.draw, wrapper)
  assert.equal(f.dispatcher.destroyed, false)
  assert.deepEqual(f.dispatcher.getDiagnostics().activeHandlers, ['sibling'])
  f.dispatcher.destroy()
})

test('missing draw capability reports unsupported without creating a wrapper or scene globe', () => {
  assert.equal(typeof GlobeNightLighting143, 'function', 'globe material night-light adapter exists')
  const scene = { context: {} }
  const lighting = new GlobeNightLighting143(C, scene, () => ({ nightWeight: 1, nightSkyRadiance: [1, 1, 1] }))
  lighting.setActive(true)
  assert.equal(lighting.getDiagnostics().supported, false)
  assert.deepEqual(scene, { context: {} })
  lighting.destroy()
})
