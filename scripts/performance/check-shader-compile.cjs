#!/usr/bin/env node
// Compile-check the new atmosphere and cloud GLSL inside a real WebGL2 context.
//
// The Node-level tests can only inspect the shader strings. A GLSL syntax error, a missing
// uniform declaration or an illegal loop bound only shows up when a driver compiles it, so this
// script builds a standalone page that links both shaders and reports the driver's log.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>CCR shader compile check</title></head>
<body><canvas id="c" width="64" height="64"></canvas>
<script type="module">
const out = []
try {
  const { atmosphereGLSL } = await import('/src/environment/atmosphereScattering143.js')
  const { cloudGLSL } = await import('/src/environment/volumetricClouds143.js')
  const gl = document.getElementById('c').getContext('webgl2')
  if (!gl) { window.__result = { ok: false, reason: 'no webgl2' } }
  else {
    // A preamble that mirrors the host contract: the cloud module relies on the atmosphere
    // module's helpers and on the host-provided radiance functions.
    const preamble = [
      '#version 300 es',
      'precision highp float;',
      'precision highp int;',
      'precision highp sampler2D;',
      'out vec4 out_FragColor;',
      'vec3 ccrSkyRadiance() { return vec3(0.4, 0.5, 0.7); }',
      'vec3 ccrSunRadiance() { return vec3(1.0, 0.95, 0.85); }'
    ].join('\\n')
    const body = [
      atmosphereGLSL('balanced'),
      cloudGLSL('balanced'),
      'void main() {',
      '  vec3 transmittance = vec3(1.0);',
      '  vec3 origin = vec3(0.0, 0.0, 6371002.0);',
      '  vec3 direction = normalize(vec3(0.0, 0.0, 1.0));',
      '  vec3 atmosphere = ccrAtmosphere(origin, direction, transmittance);',
      '  vec4 clouds = ccrClouds(origin, direction, 40000.0);',
      '  out_FragColor = vec4(atmosphere + clouds.rgb, clouds.a * transmittance.b);',
      '}'
    ].join('\\n')

    const compile = (type, source) => {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS)
      const log = gl.getShaderInfoLog(shader) || ''
      return { shader, ok, log }
    }
    const vertex = compile(gl.VERTEX_SHADER, '#version 300 es\\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }')
    const fragment = compile(gl.FRAGMENT_SHADER, preamble + '\\n' + body)
    let linked = false, linkLog = ''
    if (vertex.ok && fragment.ok) {
      const program = gl.createProgram()
      gl.attachShader(program, vertex.shader)
      gl.attachShader(program, fragment.shader)
      gl.linkProgram(program)
      linked = !!gl.getProgramParameter(program, gl.LINK_STATUS)
      linkLog = gl.getProgramInfoLog(program) || ''
    }
    const uniforms = []
    const program = gl.getParameter(gl.CURRENT_PROGRAM)
    window.__result = { ok: vertex.ok && fragment.ok && linked,
      vertexLog: vertex.log, fragmentLog: fragment.log, linked, linkLog, length: body.length }
  }
} catch (error) {
  window.__result = { ok: false, reason: error.message, stack: String(error.stack).split('\\n').slice(0, 4) }
}
</script></body></html>`

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: `browser unavailable: ${error.message}` }))
    return
  }
  const file = path.join(__dirname, '..', '..', 'examples', 'shader-compile-check.html')
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', '8903'], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  let written = false
  try {
    fs.writeFileSync(file, page)
    written = true
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    try {
      const browserPage = await browser.newPage()
      const errors = []
      browserPage.on('pageerror', error => errors.push(error.message))
      await browserPage.goto('http://127.0.0.1:8903/examples/shader-compile-check.html', { waitUntil: 'load' })
      await browserPage.waitForFunction(() => window.__result, null, { timeout: 30000 })
      const result = await browserPage.evaluate(() => window.__result)
      result.pageErrors = errors
      console.log(JSON.stringify(result, null, 2))
    } finally { await browser.close() }
  } finally {
    if (written) fs.unlinkSync(file)
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
