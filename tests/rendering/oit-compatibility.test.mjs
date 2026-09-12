import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installOitCompatibility143 } from '../../src/reflections/OitCompatibility143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('native WebGL2 OIT multipass gets its missing output without mutating input or MRT', () => {
  const calls = []
  const original = function(...args) { calls.push(args); return 7 }
  const scene = { context: { webgl2: true, shaderCache: { createDerivedShaderProgram: original } } }
  const release = installOitCompatibility143(C, scene)
  const fs = new C.ShaderSource({ sources: ['vec4 czm_out_FragColor; void czm_translucent_main() {}\nvoid main(){czm_translucent_main();out_FragColor=czm_out_FragColor;}'] })
  const options = { fragmentShaderSource: fs }
  assert.equal(scene.context.shaderCache.createDerivedShaderProgram({}, 'translucentMultipass', options), 7)
  assert.match(calls[0][2].fragmentShaderSource.createCombinedFragmentShader({ webgl2: true }), /layout\(location = 0\) out vec4 out_FragColor;/)
  assert.doesNotMatch(fs.sources.join(''), /layout/)
  scene.context.shaderCache.createDerivedShaderProgram({}, 'translucentMRT', options)
  assert.equal(calls[1][2], options)
  release(); release()
  assert.equal(scene.context.shaderCache.createDerivedShaderProgram, original)
})

test('compatibility ownership is shared and a foreign wrapper stays intact', () => {
  const scene = { context: { webgl2: true, shaderCache: { createDerivedShaderProgram() {} } } }
  const a = installOitCompatibility143(C, scene), hook = scene.context.shaderCache.createDerivedShaderProgram
  const b = installOitCompatibility143(C, scene)
  a(); assert.equal(scene.context.shaderCache.createDerivedShaderProgram, hook)
  const foreign = (...args) => hook(...args)
  scene.context.shaderCache.createDerivedShaderProgram = foreign
  b(); assert.equal(scene.context.shaderCache.createDerivedShaderProgram, foreign)
})
