#!/usr/bin/env node
// Compile-check the new atmosphere and cloud GLSL inside a real WebGL2 context.
//
// The Node-level tests can only inspect the shader strings. A GLSL syntax error, a missing
// uniform declaration or an illegal loop bound only shows up when a driver compiles it, so this
// script builds a standalone page that links both shaders and reports the driver's log.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const reference = fs.readFileSync(path.join(__dirname, '../../src/environment/reference/shadertoy_wlBXWK.glsl'), 'utf8').replace(/\r\n/g, '\n')
const referenceFunction = reference.slice(reference.indexOf('vec3 calculate_scattering('), reference.indexOf('/*\nA ray-sphere intersect'))

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>CCR shader compile check</title></head>
<body><canvas id="c" width="64" height="64"></canvas>
<script type="module">
const out = []
try {
  const { atmosphereGLSL } = await import('/src/environment/atmosphereScattering143.js')
  const { cloudGLSL, cloudDistanceFadeGLSL } = await import('/src/environment/volumetricClouds143.js')
  const { cloudShadowGLSL } = await import('/src/environment/cloudShadow143.js')
  const { transmittanceCodecGLSL, createEnvironmentStages } = await import('/src/environment/environmentStages.js')
  const { default: noiseData } = await import('/src/environment/cloudNoiseData.js')
  const { default: createColorGrading } = await import('/src/stages/colorGrading.js')
  const { cloudTemporalResolveShader } = await import('/src/environment/CloudTemporal143.js')
  const gl = document.getElementById('c').getContext('webgl2')
  if (!gl) { window.__result = { ok: false, reason: 'no webgl2' } }
  else {
    // A preamble that mirrors the host contract: the cloud module relies on the atmosphere
    // module's helpers and on the host-provided radiance functions.
    // The shader modules declare their own uniforms (atmosphereParams, cloudParams, cloudWind,
    // noiseTexture, sunDirectionAtmo, skyRadiance, sunRadiance). Only the host-side inputs that
    // environmentStages.js supplies are declared here, plus the radiance accessor functions the
    // cloud module calls into.
    const preamble = [
      '#version 300 es',
      'precision highp float;',
      'precision highp int;',
      'precision highp sampler2D;',
      'out vec4 out_FragColor;',
      'uniform mat4 enuToEcef;',
      'uniform mat4 eyeToLocal;',
      'uniform sampler2D originalHdr;',
      'uniform vec2 sourceSize;',
      'uniform vec2 effectSize;',
      'uniform bool surfaceDepthAvailable;',
      'uniform sampler2D surfaceDepthTexture;',
      'uniform sampler2D depthTexture;',
      'uniform bool shellEmptyScene;'
    ].join('\\n')
    const bodyFor = tier => [
      atmosphereGLSL(tier),
      ${JSON.stringify(referenceFunction)},
      // environmentStages.js injects these between the scattering and cloud modules.
      'vec3 ccrSkyRadiance() { return vec3(0.4, 0.5, 0.7); }',
      'vec3 ccrSunRadiance() { return vec3(1.0, 0.95, 0.85); }',
      cloudGLSL(tier),
      transmittanceCodecGLSL,
      'uniform vec3 probeOrigin; uniform vec3 probeDirection; uniform vec3 probeColor;',
      'uniform float probeDistance; uniform int probeMode; uniform int referenceSteps;',
      'void main() {',
      '  vec3 transmittance = vec3(1.0);',
      '  if (probeMode == 0) out_FragColor = ccrClouds(probeOrigin, probeDirection, probeDistance);',
      '  else if (probeMode == 1) out_FragColor = vec4(ccrAtmosphere(probeOrigin, probeDirection, probeDistance, probeColor, transmittance), 1.0);',
      '  else if (probeMode == 3) out_FragColor = vec4(ccrAtmosphereScene(probeOrigin, probeDirection, probeDistance, probeColor, transmittance), 1.0);',
      '  else if (probeMode == 4) out_FragColor = vec4(ccrCloudNoise3D(probeOrigin), 1.0);',
      '  else if (probeMode == 5) out_FragColor = vec4(vec3(ccrCloudDensity(probeOrigin)), 1.0);',
      '  else if (probeMode == 6) out_FragColor = vec4(ccrUnpackTransmittance(ccrPackTransmittance(probeColor)), ccrPackTransmittance(probeColor));',
      '  else if (probeMode == 7) { vec3 ignored = ccrAtmosphereScene(probeOrigin, probeDirection, probeDistance, probeColor, transmittance); out_FragColor = vec4(transmittance, 1.0); }',
      '  else if (probeMode == 8) out_FragColor = vec4(vec3(ccrCloudDistanceFade(probeDistance, CLOUD_MAX_DISTANCE)), 1.0);',
      '  else out_FragColor = vec4(calculate_scattering(probeOrigin, probeDirection, probeDistance, probeColor, sunDirectionAtmo, vec3(40.0), vec3(0.0), atmosphereParams.x, atmosphereParams.y, CCR_RAYLEIGH_BETA, CCR_MIE_BETA, CCR_ABSORPTION_BETA, vec3(0.0), ATMOS_MIE_G, ATMOS_RAYLEIGH_SCALE, ATMOS_MIE_SCALE, ATMOS_OZONE_CENTER, ATMOS_OZONE_FALLOFF, referenceSteps > 0 ? referenceSteps : ATMOS_OUTER_STEPS, ATMOS_LIGHT_STEPS), 1.0);',
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
    const vertex = compile(gl.VERTEX_SHADER, '#version 300 es\\nout vec2 v_textureCoordinates; void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v_textureCoordinates = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }')
    const body = bodyFor('balanced')
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
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('RGBA32F readback unavailable')
    const target = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, target)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete test framebuffer')
    const noise = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, noise)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 528, 528, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(528 * 528).fill(255))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.viewport(0, 0, 1, 1)
    const measurements = []
    for (const tier of ['performance', 'balanced', 'high']) {
      const f = compile(gl.FRAGMENT_SHADER, preamble + '\\n' + bodyFor(tier))
      const p = gl.createProgram()
      gl.attachShader(p, vertex.shader); gl.attachShader(p, f.shader); gl.linkProgram(p)
      if (!f.ok || !gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(tier + ': ' + f.log + gl.getProgramInfoLog(p))
      gl.useProgram(p)
      const u3 = (name, values) => gl.uniform3fv(gl.getUniformLocation(p, name), values)
      const u4 = (name, values) => gl.uniform4fv(gl.getUniformLocation(p, name), values)
      const u1 = (name, value) => gl.uniform1f(gl.getUniformLocation(p, name), value)
      const mie = (scale,g) => gl.uniform2f(gl.getUniformLocation(p,'atmosphereMieParameters'),scale,g)
      const mode = value => gl.uniform1i(gl.getUniformLocation(p, 'probeMode'), value)
      u4('atmosphereParams', [6371000, 6471000, 1 / 1200, 1 / 8000])
      u3('sunDirectionAtmo', [0, 0, 1]); u3('cloudWind', [0, 0, 0]); u3('cloudNoiseOrigin', [0, 0, 100])
      u3('probeColor', [0.2, 0.4, 0.6]); u3('probeDirection', [0, 0, 1])
      const render = (height, distance, probeMode = 0) => {
        u3('probeOrigin', [0, 0, 6371000 + height]); u3('atmosphereOrigin', [0, 0, 6371000 + height])
        u1('probeDistance', distance); mode(probeMode)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        const pixel = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel)
        if (gl.getError() !== gl.NO_ERROR || !pixel.every(Number.isFinite)) throw new Error('Invalid GPU output')
        return Array.from(pixel)
      }
      const close = (a, b, tolerance, label) => {
        if (a.some((v, i) => Math.abs(v - b[i]) > tolerance)) throw new Error(tier + ' ' + label + ': ' + JSON.stringify({a,b}))
      }
      const maxCloudDistance={performance:30000,balanced:40000,high:50000}[tier]
      const viewFade=[0.69,0.7,0.85,0.99,1,1.01].map(f=>render(100,maxCloudDistance*f,8)[0])
      close(viewFade.slice(0,3),[1,1,0.5],1e-5,'cloud view range fade')
      if(viewFade[3]>0.004||viewFade[4]!==0||viewFade[5]!==0)throw new Error(tier+': cloud optical density does not fade out at its view limit')
      u4('cloudParams', [0, 1600, 2800, 0.03])
      close(render(100, 40000), [0, 0, 0, 1], 1e-6, 'cloud disabled')
      u4('cloudParams', [1, 1600, 2800, 0.03])
      close(render(100, 1000), [0, 0, 0, 1], 1e-6, 'cloud hidden by geometry')
      const dense = render(100, 40000)
      const phase = g => (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g, 1.5))
      const phaseBound = [1, 0.5, 0.25].reduce((sum, weight) => sum + weight * (0.8 * phase(0.65 * weight) + 0.2 * phase(-0.2 * weight)), 0)
      const lighting = [0.4, 0.5, 0.7].map((v, i) => v * 0.8 + [1, 0.95, 0.85][i] * phaseBound)
      if (dense[3] >= 0.99) throw new Error(tier + ' missed dense slab')
      if (dense.slice(0, 3).some((value, i) => value < 0 || value > lighting[i] * (1 - dense[3]) + 1e-4)) throw new Error(tier + ': cloud energy exceeds its source')
      mie(0.65,0.9);u3('atmosphereSunRadiance',[9,9,9])
      const sunlitDense=render(100,40000)
      if(sunlitDense[0]<=dense[0]+1e-4)throw new Error(tier+': cloud direct lighting is inactive')
      const solarPhaseBound=Array.from({length:8},(_,i)=>2**(-i)).reduce((sum,w)=>sum+w*(0.5*phase(0.7*w)+0.5*phase(-0.2*w)),0)
      const solarBound=[0.4,0.5,0.7].map(v=>9*solarPhaseBound+v*0.25+0.3*(Math.PI*v+9)/(4*Math.PI*Math.PI))
      if(sunlitDense.slice(0,3).some((v,i)=>v<0||v>solarBound[i]*(1-sunlitDense[3])+1e-4))throw new Error(tier+': cloud solar source exceeds its transport bound')
      u3('sunDirectionAtmo',[0,0,-1])
      close(render(100,40000),dense,1e-5,'night blocks cloud direct sunlight')
      u3('sunDirectionAtmo',[0,0,1])
      close(render(100, 0, 1), [0.2, 0.4, 0.6, 1], 1e-6, 'zero-length atmosphere identity')
      close(render(200000, 40000, 1), [0.2, 0.4, 0.6, 1], 1e-6, 'atmosphere miss identity')
      const port = render(100, 20000000, 1), oracle = render(100, 20000000, 2)
      close(port, oracle, 0.003, 'vendored reference parity')
      u3('sunDirectionAtmo', [0, 0, -1]); u3('probeColor', [0, 0, 0])
      close(render(100, 20000000, 1), [0, 0, 0, 1], 1e-6, 'planet blocks sunlight at night')
      mie(0.65,0.9); u3('atmosphereSunRadiance',[9,9,9])
      u3('sunDirectionAtmo', [Math.sqrt(1-0.02*0.02),0,0.02]); u3('probeDirection',[0,0,1])
      const elevatedDawn = render(12000,20000000,3)
      if(elevatedDawn.slice(0,3).reduce((a,b)=>a+b,0)<0.0001) throw new Error(tier+': a sun ray missing Earth was falsely occluded at dawn')
      u3('probeDirection', [0, 1, 0]); u3('sunDirectionAtmo', [0, 0.6, 0.8])
      const horizon = render(300, 20000000, 1)
      mie(1,0.7)
      u3('atmosphereSunRadiance', [40,40,40])
      const horizonScene = render(300, 20000000, 3)
      gl.uniform1i(gl.getUniformLocation(p, 'referenceSteps'), 256)
      const horizonReference = render(300, 20000000, 2)
      mie(1,0.9)
      const narrowMie=render(300,20000000,3)
      if(narrowMie[0]>=horizonScene[0]-0.01)throw new Error('Native Mie anisotropy did not narrow the off-sun halo')
      const fullAerosolTransmission=render(300,1000,7)
      mie(0,0.9)
      const noAerosolTransmission=render(300,1000,7)
      if(noAerosolTransmission[0]<=fullAerosolTransmission[0]+0.001)throw new Error('Weather Mie density does not affect runtime extinction')
      mie(1,0.7)
      if (horizonScene[2] / horizonScene[0] <= horizon[2] / horizon[0]) throw new Error(tier + ': horizon sampling did not improve spectral balance')
      const transmission = render(300, 20000000, 7)
      const sceneSun = [20,20,20]
      u3('atmosphereSunRadiance', sceneSun)
      const horizonCalibrated = render(300, 20000000, 3)
      close(horizonCalibrated, horizonScene.map((v,i)=>i<3?v*sceneSun[i]/40:v), 1e-5, 'scene irradiance calibration')
      close(render(300, 20000000, 7), transmission, 1e-6, 'lighting does not change extinction')
      // The finite-geometry path must also scale only in-scattering, not surface albedo.
      u3('probeColor',[0.2,0.4,0.6]); u3('atmosphereSunRadiance',[0,0,0])
      const surfaceTransmission=render(300,1000,7)
      close(render(300,1000,3),surfaceTransmission.map((v,i)=>i<3?v*[0.2,0.4,0.6][i]:v),1e-6,'zero sun preserves attenuated surface')
      u3('probeColor',[0,0,0])
      close(render(300,20000000,3),[0,0,0,1],1e-6,'zero sun has no solar scattering')
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 528, 528, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseData)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      const mod = n => ((n % 64) + 64) % 64
      const voxel = (point, channel) => {
        const [x,y,z] = point.map(mod)
        return noiseData[((Math.floor(z / 8) * 66 + y + 1) * 528 + (z % 8) * 66 + x + 1) * 4 + channel] / 255
      }
      const referenceNoise = point => {
        const base = point.map(Math.floor), f = point.map((v,i) => v-base[i]).map(v => v*v*(3-2*v))
        return [0,1,2].map(channel => {
          let result = 0
          for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)
            result += voxel([base[0]+x,base[1]+y,base[2]+z],channel) * (x?f[0]:1-f[0]) * (y?f[1]:1-f[1]) * (z?f[2]:1-f[2])
          return result
        })
      }
      let maxNoiseError = 0
      for (const point of [[0,0,0], [63.9,63.8,63.7], [-0.2,-1.5,-64.2], [14.3,7.9,28.4]]) {
        u3('probeOrigin', point); mode(4); gl.drawArrays(gl.TRIANGLES,0,3)
        const actual = new Float32Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,actual)
        const expected = referenceNoise(point)
        close(Array.from(actual).slice(0,3), expected, 2 / 255, 'atlas interpolation/seams')
        maxNoiseError = Math.max(maxNoiseError, ...expected.map((v,i) => Math.abs(v-actual[i])))
      }
      measurements.push({tier, viewFade, dense, sunlitDense, port, oracle, horizon, horizonScene, horizonCalibrated, horizonReference, elevatedDawn, maxNoiseError})
      u4('cloudParams', [0, 1600, 2800, 0.03])
      close(render(2000, 40000, 5), [0,0,0,1], 1e-6, 'zero coverage also disables light-path density')
      for (const value of [[1,1,1], [0,0,0], [0.1,0.01,0.001], [0.97,0.4,0.00001]]) {
        u3('probeColor',value)
        const decoded = render(100, 40000, 6)
        if (decoded.slice(0,3).some((v,i) => Math.abs(v-value[i]) > Math.max(1e-7, value[i]*0.033))) throw new Error('Float32 RGB transmission codec error')
      }
      // Restore the homogeneous cloud field for the next tier's integration checks.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 528, 528, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(528 * 528).fill(255))
      gl.deleteProgram(p); gl.deleteShader(f.shader)
    }
    // Exercise the actual resolve shader across a dark/bright albedo boundary.
    // A shared low-res medium must attenuate each full-res texel independently.
    class Stage { constructor(options) { Object.assign(this, options) } }
    const bindings = Object.fromEntries(['eyeToLocal','atmosphereOrigin','cloudNoiseOrigin','effectFlags',
      'originalHdr','sunDirectionLocal','atmosphereSunRadiance','atmosphereMieParameters','sunRadiance','skyRadiance','cloudParams','cloudWind','noiseTexture','atmosphereParams']
      .map(name => [name, () => null]))
    const stages = createEnvironmentStages({ PostProcessStage:Stage,PostProcessStageComposite:Stage,
      Color:class {},Cartesian2:class {},PixelFormat:{RGBA:1},PixelDatatype:{FLOAT:1},PostProcessStageSampleMode:{NEAREST:1} }, bindings)
    const resolve = compile(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float; precision highp int; out vec4 out_FragColor;\\n'
      + 'const vec4 czm_viewport = vec4(0.0,0.0,2.0,1.0); vec4 czm_windowToEyeCoordinates(vec2 xy,float z){return vec4(xy,z,1.0);} float czm_unpackDepth(vec4 v){return v.r;}\\n'
      + stages.resolveStage.fragmentShader)
    const rp = gl.createProgram(); gl.attachShader(rp,vertex.shader); gl.attachShader(rp,resolve.shader); gl.linkProgram(rp)
    if (!resolve.ok || !gl.getProgramParameter(rp,gl.LINK_STATUS)) throw new Error('Resolve compile: '+resolve.log+gl.getProgramInfoLog(rp))
    gl.useProgram(rp)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,target)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,2,1,0,gl.RGBA,gl.FLOAT,null)
    const upload = (unit,width,values) => {
      gl.activeTexture(gl.TEXTURE0+unit); const texture=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture)
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,1,0,gl.RGBA,gl.FLOAT,new Float32Array(values))
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
    }
    const transmission=[0.1,0.2,0.3]
    const bytes=transmission.map(v=>Math.round(-Math.log(v)*254/16)), packed=bytes[0]*65536+bytes[1]*256+bytes[2]
    upload(0,2,[0.01,0.01,0.01,1, 2,2,2,1]); upload(1,1,[0.2,0.3,0.4,packed])
    upload(2,1,[...transmission,1])
    gl.uniform1i(gl.getUniformLocation(rp,'originalHdr'),0); gl.uniform1i(gl.getUniformLocation(rp,'environmentColor'),1)
    gl.uniform1i(gl.getUniformLocation(rp,'environmentTransmission'),2)
    gl.uniform1i(gl.getUniformLocation(rp,'shellEmptyScene'),1); gl.uniform2f(gl.getUniformLocation(rp,'effectSize'),1,1)
    gl.viewport(0,0,2,1); gl.drawArrays(gl.TRIANGLES,0,3)
    const albedoBoundary = new Float32Array(8); gl.readPixels(0,0,2,1,gl.RGBA,gl.FLOAT,albedoBoundary)
    for(let pixel=0;pixel<2;pixel++)for(let c=0;c<3;c++) {
      const expected=[0.2,0.3,0.4][c]+[0.01,2][pixel]*transmission[c]
      if(Math.abs(albedoBoundary[pixel*4+c]-expected)>1e-5) throw new Error('Resolve leaked scene albedo into cloud radiance')
    }
    const shadowBoundarySource='#version 300 es\\nprecision highp float;out vec4 out_FragColor; const vec3 sunDirectionAtmo=vec3(0.0,0.0,1.0);float ccrCloudSunVisibility(vec3 p){return 0.0;}\\n'
      +cloudDistanceFadeGLSL
      +cloudShadowGLSL()
      +'void main(){float d=39000.0+floor(gl_FragCoord.x)*1000.0;out_FragColor=vec4(ccrCloudSurfaceTransmission(vec3(0.0),vec3(0.0,0.0,1.0),d,50000.0,true,vec3(8.0),vec3(2.0)),1.0);}'
    const sf=compile(gl.FRAGMENT_SHADER,shadowBoundarySource),sp=gl.createProgram()
    gl.attachShader(sp,vertex.shader);gl.attachShader(sp,sf.shader);gl.linkProgram(sp)
    if(!sf.ok||!gl.getProgramParameter(sp,gl.LINK_STATUS))throw new Error('Shadow range compile: '+sf.log+gl.getProgramInfoLog(sp))
    gl.useProgram(sp);gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,target)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,12,1,0,gl.RGBA,gl.FLOAT,null)
    gl.viewport(0,0,12,1);gl.drawArrays(gl.TRIANGLES,0,3)
    const shadowBoundary=new Float32Array(12*4);gl.readPixels(0,0,12,1,gl.RGBA,gl.FLOAT,shadowBoundary)
    if(shadowBoundary[10*4]<0.98||shadowBoundary[11*4]<0.9999)throw new Error('Cloud shadow has a hard 50 km cutoff: '+JSON.stringify(Array.from(shadowBoundary).filter((_,i)=>i%4===0)))
    // A roof silhouette next to far background must not derive its normal from
    // the other surface. Exercise the production resolve's normal reconstruction.
    const normalSource=stages.resolveStage.fragmentShader.replace(
      'out_FragColor = vec4(radiance + surface * transmittance, original.a);',
      'out_FragColor = vec4(normal * 0.5 + 0.5, 1.0);')
    const nf=compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float; precision highp int; out vec4 out_FragColor;\\n'
      +'const vec4 czm_viewport=vec4(0.0,0.0,8.0,8.0); vec4 czm_windowToEyeCoordinates(vec2 xy,float z){float d=z<0.5?100.0:1000.0;return vec4(vec3((xy/8.0*2.0-1.0)*0.1,-1.0)*d,1.0);} float czm_unpackDepth(vec4 v){return v.r;}\\n'+normalSource)
    const np=gl.createProgram();gl.attachShader(np,vertex.shader);gl.attachShader(np,nf.shader);gl.linkProgram(np)
    if(!nf.ok||!gl.getProgramParameter(np,gl.LINK_STATUS))throw new Error('Normal regression compile: '+nf.log+gl.getProgramInfoLog(np))
    gl.useProgram(np)
    const roofDepth=[]
    for(let y=0;y<8;y++)for(let x=0;x<8;x++)roofDepth.push(x>=1&&x<=5&&y>=1&&y<=5?0.2:0.8,0,0,1)
    gl.activeTexture(gl.TEXTURE3);const roofTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,roofTexture)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,8,8,0,gl.RGBA,gl.FLOAT,new Float32Array(roofDepth))
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
    gl.uniform1i(gl.getUniformLocation(np,'depthTexture'),3)
    gl.uniform2f(gl.getUniformLocation(np,'sourceSize'),8,8)
    gl.uniformMatrix4fv(gl.getUniformLocation(np,'eyeToLocal'),false,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
    gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,target)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,8,8,0,gl.RGBA,gl.FLOAT,null)
    gl.viewport(0,0,8,8);gl.drawArrays(gl.TRIANGLES,0,3)
    const roofNormals=new Float32Array(8*8*4);gl.readPixels(0,0,8,8,gl.RGBA,gl.FLOAT,roofNormals)
    let minRoofNormal=1
    for(let y=1;y<=5;y++)for(let x=1;x<=5;x++)minRoofNormal=Math.min(minRoofNormal,roofNormals[(y*8+x)*4+2]*2-1)
    if(minRoofNormal<0.99)throw new Error('Cloud shadow normal crosses roof silhouette: '+minRoofNormal)
    // Exercise the production cloud temporal shader: accepted history is clipped,
    // while a cloud-depth disagreement must return this frame exactly.
    const tf=compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float; precision highp int; out vec4 out_FragColor;\\n'+cloudTemporalResolveShader)
    const tp=gl.createProgram();gl.attachShader(tp,vertex.shader);gl.attachShader(tp,tf.shader);gl.linkProgram(tp)
    if(!tf.ok||!gl.getProgramParameter(tp,gl.LINK_STATUS))throw new Error('Cloud temporal compile: '+tf.log+gl.getProgramInfoLog(tp))
    gl.useProgram(tp)
    const current=[0.2,0.5,0.8].flatMap(v=>[v,v,v,0.4])
    upload(0,3,current);upload(1,3,[6000,0.4,0,1,6000,0.4,0,1,6000,0.4,0,1])
    upload(2,3,new Array(3).fill([10,10,10,0.5]).flat())
    upload(3,3,[6000,0.4,0,1,6000,0.4,0,1,6000,0.4,0,1])
    for(const [i,name]of ['u_currentColor','u_currentDepth','u_historyColor','u_historyDepth'].entries())gl.uniform1i(gl.getUniformLocation(tp,name),i)
    gl.uniformMatrix4fv(gl.getUniformLocation(tp,'u_inverseViewProjectionRelative'),false,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-1,1])
    gl.uniformMatrix4fv(gl.getUniformLocation(tp,'u_previousViewProjectionRelative'),false,[1,0,0,0,0,1,0,0,0,0,1,-1,0,0,0,0])
    gl.uniform3f(gl.getUniformLocation(tp,'u_previousCameraOffset'),0,0,0)
    gl.uniform1f(gl.getUniformLocation(tp,'u_currentWeight'),0.25)
    gl.uniform1i(gl.getUniformLocation(tp,'u_historyValid'),1)
    gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,target)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,3,1,0,gl.RGBA,gl.FLOAT,null)
    gl.viewport(0,0,3,1);gl.drawArrays(gl.TRIANGLES,0,3)
    const temporalAccepted=new Float32Array(4);gl.readPixels(1,0,1,1,gl.RGBA,gl.FLOAT,temporalAccepted)
    if(temporalAccepted[0]<=0.5||temporalAccepted[0]>=0.75||temporalAccepted[3]<0.399||temporalAccepted[3]>0.401)throw new Error('Cloud variance clipping failed: '+JSON.stringify(Array.from(temporalAccepted)))
    upload(2,3,new Array(3).fill([10,10,10,0.7]).flat())
    gl.drawArrays(gl.TRIANGLES,0,3)
    const temporalTRejected=new Float32Array(4);gl.readPixels(1,0,1,1,gl.RGBA,gl.FLOAT,temporalTRejected)
    if(temporalTRejected.some((v,i)=>Math.abs(v-[0.5,0.5,0.5,0.4][i])>1e-6))throw new Error('Color-alpha T disagreement did not reject history')
    upload(2,3,new Array(3).fill([10,10,10,0.5]).flat())
    upload(3,3,[100,0.9,0,1,100,0.9,0,1,100,0.9,0,1])
    gl.drawArrays(gl.TRIANGLES,0,3)
    const temporalRejected=new Float32Array(4);gl.readPixels(1,0,1,1,gl.RGBA,gl.FLOAT,temporalRejected)
    if(temporalRejected.some((v,i)=>Math.abs(v-[0.5,0.5,0.5,0.4][i])>1e-6))throw new Error('Cloud disocclusion did not reject history')
    // Exercise the shipped display grading shader, not a JS copy of its formula.
    const gradingStage=createColorGrading({PostProcessStage:Stage},()=>({}))
    const gf=compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float; out vec4 out_FragColor;\\n'+gradingStage.fragmentShader)
    const gp=gl.createProgram(); gl.attachShader(gp,vertex.shader); gl.attachShader(gp,gf.shader); gl.linkProgram(gp)
    if(!gf.ok||!gl.getProgramParameter(gp,gl.LINK_STATUS))throw new Error('Grading compile: '+gf.log+gl.getProgramInfoLog(gp))
    gl.useProgram(gp)
    const ramp=[0,0.1,0.25,0.5,0.8,0.9,0.95,1]
    upload(0,ramp.length,ramp.flatMap(v=>[v,v,v,0.37]))
    gl.uniform1i(gl.getUniformLocation(gp,'colorTexture'),0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,target)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,ramp.length,1,0,gl.RGBA,gl.FLOAT,null)
    gl.viewport(0,0,ramp.length,1)
    const grade=(contrast,brightness,active=true)=>{
      gl.uniform4f(gl.getUniformLocation(gp,'grading'),contrast,brightness,1.05,0)
      gl.uniform1i(gl.getUniformLocation(gp,'gradingActive'),active?1:0)
      gl.drawArrays(gl.TRIANGLES,0,3)
      const result=new Float32Array(ramp.length*4);gl.readPixels(0,0,ramp.length,1,gl.RGBA,gl.FLOAT,result)
      const gradingError=gl.getError()
      if(gradingError!==gl.NO_ERROR||!result.every(Number.isFinite))throw new Error('Invalid grading pixels: '+JSON.stringify({contrast,brightness,gradingError,pixels:Array.from(result)}))
      if(result.some((v,i)=>i%4===3&&Math.abs(v-0.37)>1e-6))throw new Error('Grading changed alpha')
      return Array.from(result).filter((v,i)=>i%4===0)
    }
    const gradedRamp=grade(1.1,1.08)
    if(gradedRamp[5]>=0.98||gradedRamp[6]>=1)throw new Error('Display grading clips tone-mapped highlights: '+JSON.stringify(gradedRamp))
    if(gradedRamp.some((v,i)=>v<0||v>1||(i&&v<=gradedRamp[i-1])))throw new Error('Grading ramp lost range/ordering')
    if(grade(1,1).some((v,i)=>Math.abs(v-ramp[i])>1e-6))throw new Error('Neutral grading is not identity')
    if(grade(3,3,false).some((v,i)=>Math.abs(v-ramp[i])>1e-6))throw new Error('Disabled grading is not identity')
    if(grade(1,0).some(v=>Math.abs(v)>1e-6))throw new Error('Zero brightness is not black')
    if(grade(0,1).some(v=>Math.abs(v-0.5)>1e-6))throw new Error('Zero contrast is not flat')
    for(const brightness of [1e-8,0.01,3]) {
      const values=grade(3,brightness)
      if(values.some(v=>v<0||v>1)||Math.abs(values.at(-1)-1)>1e-6)throw new Error('Brightness range lost white endpoint')
    }
    window.__result = { ok: vertex.ok && fragment.ok && linked,
      vertexLog: vertex.log, fragmentLog: fragment.log, linked, linkLog, length: body.length, measurements, albedoBoundary:Array.from(albedoBoundary),
      temporalAccepted:Array.from(temporalAccepted),temporalRejected:Array.from(temporalRejected),temporalTRejected:Array.from(temporalTRejected),
      minRoofNormal,shadowBoundary:Array.from(shadowBoundary).filter((_,i)=>i%4===0),gradedRamp }
  }
} catch (error) {
  window.__result = { ok: false, reason: error.message, stack: String(error.stack).split('\\n').slice(0, 4) }
}
</script></body></html>`

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: `browser unavailable: ${error.message}` }))
    process.exitCode = 1
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
      fs.writeFileSync(path.join(__dirname, '../../docs/verification/rendering-performance/p0-shader-check.json'), JSON.stringify(result, null, 2))
      if (!result.ok || errors.length) process.exitCode = 1
    } finally { await browser.close() }
  } finally {
    if (written) fs.unlinkSync(file)
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
