// Guard against backticks inside GLSL template literals.
//
// This bug bit four separate times during B02: a comment written as `name` inside a template literal
// terminates the string, so the module either fails to parse or -- worse -- still parses while the
// GLSL is truncated mid-shader. Both were only caught by running a browser.
//
// The rule enforced here: inside `src/**` shader sources built from template literals, backticks are
// not used for emphasis. Use plain names or single quotes in those comments.
import { test } from 'node:test'
import { createRequire } from 'node:module'
const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** Shader-source modules: the ones that build GLSL inside template literals. */
const SHADER_MODULES = [
  'src/lighting/deferredLightingShader143.js',
  'src/lighting/DeferredLighting143.js',
  'src/channels/materialShader143.js',
  'src/shadows/shaderAdapter143.js',
]

test('shader modules do not contain backticks inside their GLSL', () => {
  for (const relative of SHADER_MODULES) {
    const source = readFileSync(join(root, relative), 'utf8')
    // Count backticks: template literals legitimately use them as delimiters, so an ODD count is the
    // signature of a stray emphasis backtick (or an unterminated literal). Even counts are checked
    // further by parsing the module, which is what the import below does.
    const count = (source.match(/`/g) || []).length
    assert.equal(count % 2, 0, `${relative}: odd backtick count (${count}) suggests a stray backtick inside a template literal`)
  }
})

test('every shader module can be imported and produces balanced GLSL', async () => {
  const lighting = await import('../../src/lighting/deferredLightingShader143.js')
  for (const options of [{}, { diffuse: true }, { specular: true }, { diffuse: true, specular: true }]) {
    const glsl = lighting.deferredLightingShaderSource(C, options).sources.join('\n')
    assert.equal((glsl.match(/\{/g) || []).length, (glsl.match(/\}/g) || []).length, `braces must balance for ${JSON.stringify(options)}`)
    // A truncated template loses the tail of the shader; the output write is the last statement.
    assert.match(glsl, /out_FragColor\s*=\s*vec4\(color,\s*1\.0\);\s*\}\s*$/, `shader must end cleanly for ${JSON.stringify(options)}`)
  }
})

test('the material and shadow adapters are importable', async () => {
  // Importing is the real check: a stray backtick makes the module throw on parse, which no amount of
  // source inspection would catch as reliably.
  const material = await import('../../src/channels/materialShader143.js')
  const shadow = await import('../../src/shadows/shaderAdapter143.js')
  assert.equal(typeof material.materialSources, 'function')
  assert.equal(typeof shadow.receiverSource, 'function')
})

test('all source files under src/ parse as ES modules', async () => {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.js')) files.push(full)
    }
  }
  walk(join(root, 'src'))
  assert.ok(files.length > 40, `expected to find the source tree, found ${files.length} files`)
  const failures = []
  for (const file of files) {
    try {
      await import(file)
    } catch (error) {
      // Node cannot import browser-only modules that reference `document` at load time; those are
      // reported as reference errors rather than syntax errors, and only syntax errors are our concern.
      if (error instanceof SyntaxError) failures.push(`${file}: ${error.message}`)
    }
  }
  assert.deepEqual(failures, [], `syntax errors: ${failures.join(' | ')}`)
})
