import HdrBloom143 from '../../src/bloom/HdrBloom143.js'

export function runBloomChecks(C, viewer) {
  const scene = viewer.scene, context = scene.context, gl = context._gl
  const width = context.drawingBufferWidth, height = context.drawingBufferHeight
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const hdr = scene.highDynamicRange, nativeBloom = scene.postProcessStages.bloom.enabled
  const checks = {}, measurements = {}, options = { hdrBloomLevels: 4, hdrBloomThreshold: 1, hdrBloomStrength: .3, hdrBloomKnee: .5 }
  const bloom = new HdrBloom143(C, scene, () => options)
  const data = new Float32Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i+1] = data[i+2] = .2; data[i+3] = .37 }
  const source = new C.Texture({ context, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
    source: { width, height, arrayBufferView: data }, flipY: false })
  const run = () => {
    let output
    for (let i = 0; i < 4; i++) output = bloom._execute(context, source, context.defaultTexture)
    if (!bloom.getDiagnostics().valid) throw new Error(JSON.stringify(bloom.getDiagnostics()))
    const fbo = new C.Framebuffer({ context, colorTextures: [output], destroyAttachments: false })
    try { return context.readPixels({ framebuffer: fbo, width, height }) } finally { fbo.destroy() }
  }
  const check = (name, value) => { checks[name] = !!value; if (!value) throw new Error(`Bloom ${name}: ${JSON.stringify(measurements)}`) }
  try {
    scene.highDynamicRange = true; scene.postProcessStages.bloom.enabled = false
    bloom.setEnabled(true)
    let pixels = run()
    check('belowKneeNeutral', pixels.every((value, i) => Math.abs(value - (i % 4 === 3 ? .37 : .2)) < .0001))
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2)
    for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) {
      const i = (y * width + x) * 4; data[i] = data[i+1] = data[i+2] = 16
    }
    source.copyFrom({ source: { width, height, arrayBufferView: data } })
    pixels = run()
    measurements.center = pixels[(cy * width + cx) * 4]
    measurements.halo = pixels[(cy * width + cx + 7) * 4]
    check('hdrRetained', measurements.center > 16)
    check('brightSourceSpreads', measurements.halo > .201)
    check('alphaRetained', pixels.every((value, i) => i % 4 !== 3 || Math.abs(value - .37) < .0001))
    check('allFinite', pixels.every(Number.isFinite))
    options.hdrBloomStrength = 0
    check('zeroStrengthBorrowsInput', bloom._execute(context, source) === source)
    options.hdrBloomStrength = .3
    const old = bloom.collection; options.hdrBloomLevels = 3; bloom.setEnabled(true); run()
    check('levelsRebuildAndRelease', old.isDestroyed())
    bloom.setEnabled(false)
    check('disabledReleasesChain', !bloom.collection)
    return { checks, measurements }
  } finally {
    bloom.destroy(); source.destroy()
    scene.highDynamicRange = hdr; scene.postProcessStages.bloom.enabled = nativeBloom
    context.uniformState.viewport = viewport
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
  }
}
