#!/usr/bin/env node
// Render the noise atlas through the shader's own fetch path and dump it as an image.
//
// The sky showed a dotted/checkerboard pattern, which points at the noise lookup rather than at
// the march. This renders raw texelFetch output so the atlas layout and the shader's addressing
// can be compared directly instead of reasoned about.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const page = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
const out = {}
try {
  const { default: createNoiseAtlas } = await import('/src/environment/noiseAtlas.js')
  const Cesium = window.Cesium
  const canvas = document.getElementById('c')
  const gl = canvas.getContext('webgl2')
  const atlas = createNoiseAtlas(Cesium, { _gl: gl, defaultTexture: null })
  // Upload the atlas exactly as the pipeline does.
  atlas._bind?.()
  out.size = [atlas.width, atlas.height]

  const vs = '#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}'
  const fs2 = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'uniform sampler2D noiseTexture;',
    'out vec4 out_FragColor;',
    // Same addressing as volumetricClouds143.ccrNoiseVoxel, but driven by the fragment coordinate
    // so the whole atlas can be inspected at once.
    'float fetchAtlas(int x, int y) {',
    '  ivec2 tile = ivec2(0, 0) * 66;',
    '  return texelFetch(noiseTexture, tile + ivec2(x, y) + 1, 0).r;',
    '}',
    'void main() {',
    '  ivec2 c = ivec2(gl_FragCoord.xy);',
    '  float v = fetchAtlas(c.x % 64, c.y % 64);',
    '  out_FragColor = vec4(v, v, v, 1.0);',
    '}'
  ].join('\\n')
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs2))
  gl.linkProgram(program)
  out.linked = !!gl.getProgramParameter(program, gl.LINK_STATUS)
  out.log = gl.getProgramInfoLog(program) || ''
  if (out.linked) {
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    // Bind the atlas to unit 0 as Cesium would.
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, atlas._texture || atlas.handle || atlas._glTexture)
    gl.uniform1i(gl.getUniformLocation(program, 'noiseTexture'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish()
    out.drew = true
  }
  window.__result = out
} catch (error) {
  window.__result = { failed: error.message, stack: String(error.stack).split('\\n').slice(0,3) }
}
</script>
<script src="/node_modules/cesium/Build/Cesium/Cesium.js"></script>
</body></html>`

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: error.message }))
    return
  }
  const port = 8961
  const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'rendering-performance')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(__dirname, '..', '..', 'examples', 'noise-atlas-check.html')
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  let written = false
  try {
    fs.writeFileSync(file, page)
    written = true
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
    try {
      const browserPage = await browser.newPage({ viewport: { width: 512, height: 512 } })
      const errors = []
      browserPage.on('pageerror', error => errors.push(error.message.slice(0, 200)))
      await browserPage.goto(`http://127.0.0.1:${port}/examples/noise-atlas-check.html`, { waitUntil: 'load' })
      await browserPage.waitForFunction(() => window.__result, null, { timeout: 30000 })
      const result = await browserPage.evaluate(() => window.__result)
      console.log(JSON.stringify(result, null, 2))
      await browserPage.screenshot({ path: path.join(outDir, 'noise-atlas.png') })
      if (errors.length) console.log('errors:', JSON.stringify(errors.slice(0, 3)))
    } finally { await browser.close() }
  } finally {
    if (written) fs.unlinkSync(file)
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
