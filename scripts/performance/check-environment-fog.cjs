#!/usr/bin/env node
// Standalone GLSL transport readback; does not load the SDK build or campus scene.
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')

async function main() {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
  const { environmentFogTransport } = await import(pathToFileURL(path.resolve(__dirname,
    '../../src/environment/environmentFog143.js')))
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8966'],
    { stdio: 'ignore', windowsHide: true })
  let browser
  try {
    const url = 'http://127.0.0.1:8966/src/environment/environmentFog143.js'
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await fetch(url)).ok) break } catch {}
      if (attempt === 39) throw new Error('Fog probe server did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage()
    await page.goto(url)
    const sourceRadiance = [0.3, 0.43, 0.65]
    const cases = []
    const add = (label, parameters) => cases.push({ label, sourceRadiance,
      fog: true, volumetricFog: false, fogNoise: 0.45, noiseSample: 0.5,
      density0: 0.000025, baseHeight: 20, scaleHeight: 180,
      originHeight: 100, upDotRay: 0, distance: 4000, ...parameters })
    for (const density0 of [0, 0.000025, 0.0002]) {
      for (const baseHeight of [20, 1000]) {
        for (const scaleHeight of [80, 800]) {
          for (const [originHeight, upDotRay, distance] of [[100, 0, 4000],
            [100, 1e-9, 8000], [10, 0.7, 8000], [2000, -0.2, 8000]]) {
            add(`profile-${cases.length}`, { density0, baseHeight, scaleHeight, originHeight, upDotRay, distance })
          }
        }
      }
    }
    for (const volumetricFog of [false, true]) {
      for (const noiseSample of [0, 0.5, 1]) add(`noise-${volumetricFog}-${noiseSample}`, { volumetricFog, noiseSample })
    }
    add('disabled', { fog: false })
    add('volumetric-only', { fog: false, volumetricFog: true })
    add('zero-distance', { distance: 0 })
    add('sky-depth-sentinel', { distance: 20000000 })
    // Stay more than one float32 ULP below the 20,000 km sky sentinel.
    add('below-sea-long-down', { originHeight: -1000, scaleHeight: 10, upDotRay: -1, distance: 19000000 })
    add('high-long-down', { originHeight: 100000, scaleHeight: 10, upDotRay: -1, distance: 19000000 })
    for(const height of [12000,8000000])for(const angle of height===12000?[4,10,45,90]:[0,10,20,25]){
      const radius=6371000,a=angle*Math.PI/180
      const origin=[0,0,radius+height],direction=height===12000?[Math.cos(a),0,-Math.sin(a)]:[Math.sin(a),0,-Math.cos(a)]
      const b=origin[2]*direction[2],c=height*(2*radius+height),distance=-b-Math.sqrt(b*b-c)
      add(`spherical-${height}-${angle}`,{origin,direction,radius,distance})
    }
    add('spherical-below-sea',{origin:[0,0,6371000-400],direction:[1,0,0],radius:6371000,distance:1000})
    const readback = await page.evaluate(async cases => {
      const { environmentFogGLSL } = await import('/src/environment/environmentFog143.js')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const gl = canvas.getContext('webgl2')
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('RGBA32F WebGL2 unavailable')
      const compile = (type, source) => {
        const shader = gl.createShader(type)
        gl.shaderSource(shader, source); gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
        return shader
      }
      const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`)
      const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec4 effectFlags;
uniform vec3 probeGeometry;
uniform vec3 probeSource;
uniform float probeNoise;
uniform float probeSplit;
uniform vec3 probeOrigin;
uniform vec3 probeDirection;
uniform float probeRadius;
out vec4 result;
${environmentFogGLSL}
void main() {
  if(probeRadius>0.0) {
    if(probeSplit>0.0) {
      vec4 a=ccrSphericalFogTransport(probeOrigin,probeDirection,probeRadius,probeSplit,probeSource,probeNoise);
      vec4 b=ccrSphericalFogTransport(probeOrigin+probeDirection*probeSplit,probeDirection,probeRadius,probeGeometry.z-probeSplit,probeSource,probeNoise);
      result=vec4(a.rgb+a.a*b.rgb,a.a*b.a);
    } else result=ccrSphericalFogTransport(probeOrigin,probeDirection,probeRadius,probeGeometry.z,probeSource,probeNoise);
    return;
  }
  if(probeSplit>0.0) {
    vec4 a=ccrEnvironmentFogTransport(probeGeometry.x,probeGeometry.y,probeSplit,probeSource,probeNoise);
    vec4 b=ccrEnvironmentFogTransport(probeGeometry.x+probeGeometry.y*probeSplit,probeGeometry.y,
      probeGeometry.z-probeSplit,probeSource,probeNoise);
    result=vec4(a.rgb+a.a*b.rgb,a.a*b.a);
  } else result=ccrEnvironmentFogTransport(probeGeometry.x,probeGeometry.y,probeGeometry.z,probeSource,probeNoise);
}`)
      const program = gl.createProgram()
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
      gl.useProgram(program)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null)
      const framebuffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer')
      gl.viewport(0, 0, 1, 1)
      const set1 = (name, value) => gl.uniform1f(gl.getUniformLocation(program, name), value)
      const samples = cases.map(parameters => {
        gl.uniform4f(gl.getUniformLocation(program, 'effectFlags'), parameters.fog ? 1 : 0, 0, 0, parameters.volumetricFog ? 1 : 0)
        gl.uniform4f(gl.getUniformLocation(program, 'fogParams'), parameters.density0, parameters.scaleHeight, parameters.fogNoise, 5)
        gl.uniform3f(gl.getUniformLocation(program, 'probeGeometry'), parameters.originHeight, parameters.upDotRay, parameters.distance)
        gl.uniform3fv(gl.getUniformLocation(program, 'probeSource'), parameters.sourceRadiance)
        gl.uniform3fv(gl.getUniformLocation(program,'probeOrigin'),parameters.origin||[0,0,0])
        gl.uniform3fv(gl.getUniformLocation(program,'probeDirection'),parameters.direction||[0,0,1])
        set1('probeRadius',parameters.radius||0)
        set1('fogBaseHeight', parameters.baseHeight); set1('probeNoise', parameters.noiseSample)
        const draw = split => {
          set1('probeSplit', split); gl.drawArrays(gl.TRIANGLES, 0, 3)
          const pixel = new Float32Array(4)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel)
          if (gl.getError() !== gl.NO_ERROR || !pixel.every(Number.isFinite)) throw new Error('Invalid GPU output: ' + parameters.label)
          return Array.from(pixel)
        }
        const full = draw(0)
        const split = parameters.distance > 0 && (parameters.distance < 10000 || parameters.origin) ? draw(parameters.distance * 0.375) : null
        return { parameters, full, split }
      })
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      return { samples, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }
    }, cases)
    let maximumError = 0, maximumSplitError = 0
    for (const { parameters, full, split } of readback.samples) {
      const expected = environmentFogTransport(parameters)
      const reference = [...expected.scattering, expected.transmittance]
      for (let channel = 0; channel < 4; channel++) {
        const error = Math.abs(full[channel] - reference[channel])
        maximumError = Math.max(maximumError, error)
        if (error > (parameters.origin?0.001:1e-4)) throw new Error(`${parameters.label} GPU/CPU mismatch: ${full} / ${reference}`)
        if (split) {
          const splitError = Math.abs(full[channel] - split[channel])
          maximumSplitError = Math.max(maximumSplitError, splitError)
          if (splitError > (parameters.origin?0.001:1e-4)) throw new Error(`${parameters.label} segment mismatch: ${full} / ${split}`)
        }
      }
    }
    const report = { ok: true, renderer: readback.renderer, cases: cases.length,
      maximumError, maximumSplitError, samples: readback.samples }
    fs.writeFileSync(path.resolve(__dirname, '../../docs/verification/rendering-performance/p1-fog-check.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2))
  } finally {
    await browser?.close()
    server.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
