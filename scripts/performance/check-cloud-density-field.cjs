#!/usr/bin/env node
// Production density-field GPU diagnosis; no image, frame-time or performance acceptance.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const q = f => sorted.length ? sorted[Math.floor((sorted.length - 1) * f)] : null
  return { count: sorted.length, min: q(0), p10: q(.1), p50: q(.5), p90: q(.9), max: q(1),
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null }
}

// Pearson correlation over overlapping pairs, separately in both horizontal axes.
// The first sampled shift at or below .5 is reported without subpixel interpolation.
function autocorrelation(values, size, span) {
  const correlate = (shift, axis) => {
    let n = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0
    for (let y = 0; y < size - (axis === 1 ? shift : 0); y++) {
      for (let x = 0; x < size - (axis === 0 ? shift : 0); x++) {
        const u = values[y * size + x], v = values[(y + (axis === 1 ? shift : 0)) * size + x + (axis === 0 ? shift : 0)]
        n++; a += u; b += v; aa += u * u; bb += v * v; ab += u * v
      }
    }
    const denominator = Math.sqrt(Math.max(aa - a * a / n, 0) * Math.max(bb - b * b / n, 0))
    return denominator > 1e-15 ? (ab - a * b / n) / denominator : null
  }
  const curve = Array.from({ length: size / 2 + 1 }, (_, shift) => {
    const x = correlate(shift, 0), y = correlate(shift, 1)
    return { shiftPixels: shift, distanceMetres: shift * span / size, x, y,
      mean: x === null || y === null ? null : (x + y) / 2 }
  })
  const half = key => curve.find(row => row[key] !== null && row[key] <= .5)?.distanceMetres ?? null
  return { method: 'Overlap Pearson correlation; first discrete shift <= 0.5; no wrapping',
    pixelSpacingMetres: span / size, halfCorrelationMetres: { x: half('x'), y: half('y'), mean: half('mean') }, curve }
}

function summarize(pixels, size, span, maximumTau, tolerance) {
  const tau = [], top = [], meanDensity = [], T = [], opacity = []
  let invalidPixels = 0, occupied = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const t = Math.exp(-pixels[i])
    if (!pixels.slice(i, i + 4).every(Number.isFinite) || pixels[i] < 0 || pixels[i] > maximumTau + tolerance || pixels[i + 2] < 0 || pixels[i + 3] !== 1 || t < 0 || t > 1) invalidPixels++
    tau.push(pixels[i]); meanDensity.push(pixels[i + 2]); T.push(t); opacity.push(1 - t)
    if (pixels[i + 1] > 0) top.push(pixels[i + 1])
    if (t < .95) occupied++
  }
  return { invalidPixels, tau: distribution(tau), transmittance: distribution(T), opacity: distribution(opacity),
    topAltitude: distribution(top), topAltitudeSpreadP90P10: top.length ? distribution(top).p90 - distribution(top).p10 : null,
    meanDensity: distribution(meanDensity), occupancy: { definition: 'T < 0.95', pixels: occupied, fraction: occupied / tau.length },
    opacityAutocorrelation: autocorrelation(opacity, size, span) }
}

async function main() {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const directory = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8973'], { stdio: 'ignore' })
  let browser
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.once('exit', code => reject(new Error(`Density probe server exited: ${code}`)))
      setTimeout(resolve, 1500)
    })
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    const url = 'http://127.0.0.1:8973/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets'
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.pipeline?.environmentRenderer?.noise, null, { timeout: 120000 })
    const result = await page.evaluate(async () => {
      const C = window.Cesium, { viewer, pipeline } = campus, context = viewer.scene.context, gl = context._gl
      const { atmosphereGLSL } = await import('/src/environment/atmosphereScattering143.js')
      const { cloudGLSL } = await import('/src/environment/volumetricClouds143.js')
      const { resolveEnvironmentState } = await import('/src/environment/environmentState.js')
      viewer.useDefaultRenderLoop = false
      const state = resolveEnvironmentState()
      const size = 128, span = 24000, layers = 48, base = state.cloudBase, top = state.cloudTop, radius = 6371000
      const coverage = state.cloudCoverage, densityScale = state.cloudExtinction
      let fieldDensityScale = densityScale
      const candidate = cloudGLSL('balanced')
      const replaceOnce = (source, pattern, replacement) => {
        const matches = source.match(new RegExp(pattern.source, 'g')) || []
        if (matches.length !== 1) throw new Error(`Ambiguous baseline reconstruction: ${pattern}, matches ${matches.length}`)
        return source.replace(pattern, replacement)
      }
      let baseline = replaceOnce(candidate, /const vec3 CCR_CLOUD_SHAPE_PERIOD = vec3\([^;]+;/, 'const vec3 CCR_CLOUD_SHAPE_PERIOD = vec3(8000.0);')
      baseline = replaceOnce(baseline, /const vec3 CCR_CLOUD_DETAIL_PERIOD = vec3\([^;]+;/, 'const vec3 CCR_CLOUD_DETAIL_PERIOD = vec3(2000.0);')
      baseline = replaceOnce(baseline, /float weatherHeight=cloudModel==1\?t:t\*t;/, 'float weatherHeight=t;')
      baseline = replaceOnce(baseline, /if\(cloudModel!=1\) shape=1\.0-\(1\.0-shape\)\*1\.25;/, '')
      baseline = replaceOnce(baseline, /return ccrCloudHeightScale\(cloudModel==1\?t:t\*t\);/, 'return ccrCloudHeightScale(t);')
      const texture = new C.Texture({ context, width: size, height: size, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
      const framebuffer = new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
      const renderState = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, size, size), depthTest: { enabled: false }, depthMask: false })
      const uniforms = {
        atmosphereParams: () => new C.Cartesian4(radius, 6471000, 1 / 1200, 1 / 8000),
        atmosphereOrigin: () => new C.Cartesian3(0, 0, radius + 2200),
        cloudNoiseOrigin: () => new C.Cartesian3(0, 0, 2200),
        cloudParams: () => new C.Cartesian4(coverage, base, top, fieldDensityScale), cloudModel: () => 0,
        cloudWeatherOffset: () => C.Cartesian3.ZERO, cloudShapeOffset: () => C.Cartesian3.ZERO,
        cloudDetailOffset: () => C.Cartesian3.ZERO, noiseTexture: () => pipeline.environmentRenderer.noise
      }
      const fields = [], images = []
      try {
        for (const [name, source, extinction] of [['baseline', baseline, .03], ['shape-only', candidate, .03], ['candidate', candidate, densityScale]]) {
          fieldDensityScale = extinction
          const shader = 'precision highp float;precision highp sampler2D;\n'
            + atmosphereGLSL('balanced', { lut: false }) + 'vec3 ccrSkyRadiance(){return vec3(0.0);}\n' + source
            + `void main(){vec2 xy=(gl_FragCoord.xy/${size}.0-0.5)*${span}.0;float tau=0.0;float highest=0.0;float sum=0.0;`
            + `for(int i=0;i<${layers};i++){float h=${base}.0+(float(i)+0.5)*${(top - base) / layers}.0;`
            + `vec3 p=vec3(xy,sqrt((${radius}.0+h)*(${radius}.0+h)-dot(xy,xy)));`
            + `float sigma=ccrCloudDensity(p);tau+=sigma*${(top - base) / layers}.0;sum+=sigma;if(sigma>0.0003)highest=h;}`
            + `out_FragColor=vec4(tau,highest,sum/${layers}.0,1.0);}`
          const command = context.createViewportQuadCommand(shader, { framebuffer, renderState, uniformMap: uniforms })
          const pixels = new Float32Array(size * size * 4)
          try {
            command.execute(context)
            const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer._framebuffer)
            try {
              if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete float density framebuffer')
              gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, pixels)
            } finally {
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
            }
            const error = gl.getError()
            if (error) throw new Error(`Density-field GL error: ${error}`)
          } finally { command.shaderProgram?.destroy() }
          fields.push({ name, densityScale: extinction, pixels: Array.from(pixels), source })
          // Diagnostic false colour: left opacity (black-white), right cloud top (blue-red).
          const canvas = document.createElement('canvas'); canvas.width = size * 2; canvas.height = size
          const ctx = canvas.getContext('2d'), image = ctx.createImageData(size * 2, size)
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const p = ((size - 1 - y) * size + x) * 4, t = pixels[p + 1] > 0 ? (pixels[p + 1] - base) / (top - base) : 0
            const a = 255 * (1 - Math.exp(-pixels[p])), i = (y * size * 2 + x) * 4, j = i + size * 4
            image.data.set([a, a, a, 255], i)
            image.data.set(pixels[p + 1] > 0 ? [255 * t, 255 * (1 - Math.abs(2 * t - 1)), 255 * (1 - t), 255] : [0, 0, 0, 255], j)
          }
          ctx.putImageData(image, 0, 0); images.push({ name, dataUrl: canvas.toDataURL('image/png') })
        }
      } finally { framebuffer.destroy(); texture.destroy(); C.RenderState.removeFromCache(renderState) }
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      return { size, span, layers, base, top, radius, coverage, densityScale, fields, images,
        renderer: gl.getParameter(gl.RENDERER), unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        noise: { width: pipeline.environmentRenderer.noise.width, height: pipeline.environmentRenderer.noise.height }, url: location.href }
    })
    const tauTolerance = 1e-4
    const cases = result.fields.map(({ name, densityScale, pixels, source }) => {
      const maximumTau = densityScale * (result.top - result.base)
      return { name, densityScale, maximumTau, tauTolerance,
        densityScaleSource: name === 'candidate' ? 'resolveEnvironmentState().cloudExtinction' : 'Explicit former extinction 0.03 for diagnostic comparison',
        cloudSourceSha256: crypto.createHash('sha256').update(source).digest('hex'), ...summarize(pixels, result.size, result.span, maximumTau, tauTolerance) }
    })
    const [baseline, shapeOnly, candidate] = cases
    const compare = (before, after) => {
      const beforeLength = before.opacityAutocorrelation.halfCorrelationMetres.mean
      const afterLength = after.opacityAutocorrelation.halfCorrelationMetres.mean
      return { before: before.name, after: after.name,
        halfCorrelationRatio: beforeLength && afterLength ? afterLength / beforeLength : null,
        topAltitudeSpreadRatio: before.topAltitudeSpreadP90P10 ? after.topAltitudeSpreadP90P10 / before.topAltitudeSpreadP90P10 : null,
        largerCorrelationLength: beforeLength !== null && afterLength !== null ? afterLength > beforeLength : null,
        greaterTopAltitudeVariation: after.topAltitudeSpreadP90P10 > before.topAltitudeSpreadP90P10 }
    }
    const report = {
      scope: 'Real GPU production ccrCloudDensity field integration; structural diagnosis only, not rendered appearance or performance acceptance',
      createdAt: new Date().toISOString(), url: result.url, renderer: result.renderer, unmaskedRenderer: result.unmaskedRenderer, noiseTexture: result.noise,
      correction: 'The earlier densityScale=1 diagnostic run omitted production extinction, so its tau, opacity, occupancy, correlation and density-threshold top statistics must not be cited. The subsequent corrected 0.03 shape-only report is archived as cloud-density-field-shape-only.json; current final extinction is read from production state.',
      sampling: { size: [result.size, result.size], spanMetres: result.span, layers: result.layers, heightMetres: [result.base, result.top],
        verticalRule: 'Midpoints; ccrCloudDensity returns media density times per-case extinction; tau=sum(sigma*dh)', cloudModel: 0, coverage: result.coverage, productionDensityScale: result.densityScale,
        stateSource: 'resolveEnvironmentState() defaults for coverage, layer and final candidate extinction; per-case extinction and bounds recorded in cases',
        physicalUpperBound: 'Clamped media density <= 1; sigma <= case extinction; tau <= case extinction * layer thickness',
        radiusMetres: result.radius, atmosphereOrigin: [0, 0, result.radius + 2200], cloudNoiseOrigin: [0, 0, 2200], offsets: [0, 0, 0],
        position: '(x,y,sqrt((R+h)^2-x^2-y^2))', output: ['tau', 'highest height with sigma > 0.0003; 0 for none', 'mean sigma', '1'],
        topAltitudePopulation: 'Columns with at least one sample above sigma threshold; quantization 25 m' },
      baseline: 'Explicit diagnostic algorithm variant reconstructed from current source: shape period 8 km, detail 2 km, linear weather height, shapeAmount 1, linear unused profile helper. Same weather field, noise texture and sampling; not an old bundle or screenshot.',
      shapeOnly: 'Current production algorithm with explicit former extinction 0.03, isolating shape changes from the final extinction change.',
      images: result.images.map(({ name }) => ({ file: `cloud-density-field-${name}.png`, panels: ['opacity black-white', 'highest density threshold altitude blue-red; black empty'] })),
      cases, comparison: compare(baseline, candidate), shapeOnlyComparison: compare(baseline, shapeOnly),
      summary: { validFields: cases.every(row => row.invalidPixels === 0), expectedTrendIsDiagnosticOnly: true }
    }
    if (!report.summary.validFields) throw new Error('Invalid or nonphysical cloud density-field pixels')
    fs.mkdirSync(directory, { recursive: true })
    for (const { name, dataUrl } of result.images) fs.writeFileSync(path.join(directory, `cloud-density-field-${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
    const output = path.join(directory, 'cloud-density-field.json')
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ output, ...report.summary, comparison: report.comparison,
      shapeOnlyComparison: report.shapeOnlyComparison,
      cases: cases.map(row => ({ name: row.name, densityScale: row.densityScale, maximumTau: row.maximumTau,
        topAltitude: row.topAltitude, topAltitudeSpreadP90P10: row.topAltitudeSpreadP90P10,
        tau: row.tau, occupancy: row.occupancy, halfCorrelationMetres: row.opacityAutocorrelation.halfCorrelationMetres })) }, null, 2))
  } finally { await browser?.close(); server.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
