import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { traceShader, resolveShader, traceFunctions } from '../../src/reflections/ssrShaders143.js'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('reflection stages compile Cesium WebGL2 sources without native log-depth reconstruction', () => {
  for (const source of [traceShader, resolveShader]) {
    const combined = new C.ShaderSource({ sources: [source] }).createCombinedFragmentShader({ webgl2: true })
    assert.match(combined, /void main/)
    assert.doesNotMatch(source, /czm_windowToEyeCoordinates|czm_reverseLogDepth/)
  }
  assert.match(traceFunctions, /traceReflection/)
})
