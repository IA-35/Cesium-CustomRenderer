import { startTransparencyFixture, planeGlb } from './deferred-transparency-fixture.js'

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0 }
const clone = matrix => Cesium.Matrix4.clone(matrix, new Cesium.Matrix4())

export async function startR186Fixture(f) {
  await startTransparencyFixture(f, { layers: [], height: 150 })
  const C = Cesium, s = f.viewer.scene
  f.frame = C.Transforms.eastNorthUpToFixedFrame(f.origin)
  f.geometry = []
  f.place = (x, y, z, sx, sy, angle = 0) => {
    const rotation = C.Matrix3.fromRotationZ(angle)
    const local = C.Matrix4.fromRotationTranslation(rotation, new C.Cartesian3(x, y, z))
    C.Matrix4.multiplyByScale(local, new C.Cartesian3(sx, sy, 1), local)
    return C.Matrix4.multiply(f.frame, local, new C.Matrix4())
  }
  f.addPlane = async (id, x, y, z, sx, sy, color, extra = {}) => {
    const model = await C.Model.fromGltfAsync({ url: planeGlb(C, { baseColor: [...color, 1], metallic: 0, roughness: .8, ...extra }),
      modelMatrix: f.place(x, y, z, sx, sy), id, upAxis: C.Axis.Z, forwardAxis: C.Axis.X })
    s.primitives.add(model); f.geometry.push(model); return model
  }
  // Actual geometry: window mullions and narrow railings, crossing both raster axes.
  for (let x = -24; x <= 24; x += 4) await f.addPlane(`mullion-${x}`, x, 0, 2, .13, 25, [.04, .05, .06])
  for (let y = -24; y <= 24; y += 4) await f.addPlane(`crossbar-${y}`, 0, y, 2.1, 25, .12, [.04, .05, .06])
  for (let x = -23; x <= 23; x += 2) await f.addPlane(`railing-${x}`, x, -35, 3, .09, 6, [.85, .88, .9])
  f.moving = await f.addPlane('moving-rigid-glb', 0, 0, 12, 5.5, 5.5, [.85, .12, .045])
  f.moving.show = false
  f.mask = await f.addPlane('mask-hole', -15, 15, 16, 5, 5, [.05, .75, .1], { mask: true })
  f.mask.show = false
  f.unsupported = await f.addPlane('unsupported-unlit', 15, 15, 17, 5, 5, [.1, .2, .8], { unlit: true })
  f.unsupported.customShader = new C.CustomShader({ fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.diffuse = vec3(0.1, 0.2, 0.8); }' })
  f.unsupported.show = false
  f.viewer.camera.twistLeft(.173)
  await new Promise(resolve => { const off = s.postRender.addEventListener(() => { if (f.geometry.every(model => model.ready)) { off(); resolve() } }) })
  f.viewer.useDefaultRenderLoop = false
  f.viewer.camera.frustum.far = 1000
  f.camera = { position: C.Cartesian3.clone(s.camera.positionWC), direction: C.Cartesian3.clone(s.camera.directionWC), up: C.Cartesian3.clone(s.camera.upWC) }
  f.restoreCamera = () => s.camera.setView({ destination: f.camera.position, orientation: { direction: f.camera.direction, up: f.camera.up } })
  f.step = () => { f.viewer.render(); if (f.errors.length) throw new Error(f.errors.join('\n') + '; TAA=' + JSON.stringify(f.pipeline.getTaaDiagnostics())) }
  f.steps = async n => { for (let i = 0; i < n; i++) { f.step(); if (i % 16 === 15) await new Promise(requestAnimationFrame) } }
  f.read = texture => {
    const context = s.context, gl = context._gl
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), cached = context._currentFramebuffer
    let framebuffer
    try {
      if (texture) framebuffer = new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
      if (texture && (texture.pixelDatatype === C.PixelDatatype.FLOAT || texture.pixelDatatype === C.PixelDatatype.HALF_FLOAT)) {
        const pixels = new Float32Array(texture.width * texture.height * 4)
        framebuffer._bind(); gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.FLOAT, pixels)
        return pixels
      }
      return context.readPixels({ framebuffer, width: texture?.width || s.drawingBufferWidth, height: texture?.height || s.drawingBufferHeight })
    } finally { framebuffer?.destroy(); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); context._currentFramebuffer = cached }
  }
  f.image = pixels => {
    const canvas = document.createElement('canvas'); canvas.width = s.drawingBufferWidth; canvas.height = s.drawingBufferHeight
    const context = canvas.getContext('2d'), data = context.createImageData(canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y++) data.data.set(pixels.subarray(y * canvas.width * 4, (y + 1) * canvas.width * 4), (canvas.height - y - 1) * canvas.width * 4)
    context.putImageData(data, 0, 0); return canvas.toDataURL('image/png')
  }
  f.configure = async samples => {
    f.pipeline.setAntiAliasing('fxaa'); f.step(); f.pipeline.setTaa({ enabled: true, jitterSamples: samples })
    if (!f.pipeline.taa?.jitter) f.step()
    if (!f.pipeline.taa?.jitter) throw new Error('TAA jitter unavailable: ' + JSON.stringify(f.pipeline.getTaaDiagnostics()))
    f.pipeline.taa.jitter.samples = samples
    f.pipeline.taa.jitter.reset()
    await f.steps(128)
    const diagnostics = f.pipeline.getTaaDiagnostics()
    if (diagnostics.jitter?.samples !== samples) throw new Error('Requested jitter phase count was not applied: ' + JSON.stringify(diagnostics))
  }
  const gl = s.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info')
  f.gpu = { vendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), version: gl.getParameter(gl.VERSION) }
  return f.gpu
}

export async function captureR186Series(f, name, count = 128, motion = 'static') {
  const s = f.viewer.scene, width = s.drawingBufferWidth, height = s.drawingBufferHeight, size = width * height
  const sum = new Float64Array(size), square = new Float64Array(size), first = new Float32Array(size)
  const temporal = [], images = [], luma = new Float32Array(size)
  // Fixed ROIs retain geometry silhouettes, mullions, railings and the disoccluded background.
  const rois = [{ name: 'windows', x: 170, y: 125, w: 300, h: 190 }, { name: 'railings', x: 170, y: 65, w: 300, h: 65 }, { name: 'moving-background', x: 250, y: 170, w: 140, h: 100 }]
  const C = Cesium, profileScale = [width / s.canvas.clientWidth, height / s.canvas.clientHeight]
  const projectLinePoint = (x, y, z) => {
    const world = C.Matrix4.multiplyByPoint(f.frame, new C.Cartesian3(x, y, z), new C.Cartesian3())
    const window = C.SceneTransforms.worldToWindowCoordinates(s, world)
    return window && [window.x * profileScale[0], height - window.y * profileScale[1]]
  }
  const sampleLuma = (x, y) => {
    x -= .5; y -= .5
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    return (luma[iy * width + ix] * (1 - fx) + luma[iy * width + ix + 1] * fx) * (1 - fy)
      + (luma[(iy + 1) * width + ix] * (1 - fx) + luma[(iy + 1) * width + ix + 1] * fx) * fy
  }
  const lastPixels = new Uint8Array(width * height * 4)
  let acquisitionCenter = null
  for (let frame = 0; frame < count; frame++) {
    if (motion === 'pan') s.camera.moveRight(.018)
    if (motion === 'rotate') s.camera.twistLeft(.00015)
    if (motion === 'object') { f.moving.show = frame < 80; f.moving.modelMatrix = f.place(-18 + frame * .35, 0, 12, 5.5, 5.5) }
    f.step()
    const pixels = f.read(); lastPixels.set(pixels)
    for (let i = 0; i < size; i++) { const j = i * 4; const value = .2126 * pixels[j] + .7152 * pixels[j + 1] + .0722 * pixels[j + 2]; luma[i] = value; sum[i] += value; square[i] += value * value; if (frame === 0) first[i] = value }
    const diag = f.pipeline.getTaaDiagnostics()
    if (motion === 'object' && frame === 79) {
      const world = C.Matrix4.getTranslation(f.moving.modelMatrix, new C.Cartesian3())
      const window = C.SceneTransforms.worldToWindowCoordinates(s, world)
      acquisitionCenter = window && [Math.floor(window.x * profileScale[0]), Math.floor(height - window.y * profileScale[1])]
    }
    let acquisitionProbe
    if (motion === 'object' && [79, 80, 81, 87, 95, 111].includes(frame)) {
      // Keep the last covered 5x5 pixels fixed: revealed history should age 1..32,
      // while the separate displayed texture must retain scene alpha (opaque here).
      const taa = f.pipeline.taa, metadata = taa?.frames?.[1 - taa.active]?.resolve.outputTexture, display = taa?.output
      acquisitionProbe = { available: !!(acquisitionCenter && metadata && display), centerPx: acquisitionCenter, expectedAgeAfterReveal: frame >= 80 ? Math.min(32, frame - 79) : null }
      if (acquisitionProbe.available) {
        const alpha = texture => {
          const values = f.read(texture), samples = []
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const x = Math.max(0, Math.min(texture.width - 1, acquisitionCenter[0] + dx)), y = Math.max(0, Math.min(texture.height - 1, acquisitionCenter[1] + dy))
            samples.push(values[(y * texture.width + x) * 4 + 3])
          }
          return { min: Math.min(...samples), max: Math.max(...samples), center: samples[12] }
        }
        acquisitionProbe.metadata = alpha(metadata); acquisitionProbe.displayAlpha = alpha(display)
        acquisitionProbe.metadata.centerAge = acquisitionProbe.metadata.center
        acquisitionProbe.separateDisplayTexture = metadata !== display
      }
    }
    const roiValues = rois.map(roi => {
      const values = []
      for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) values.push(luma[y * width + x])
      return { name: roi.name, mean: values.reduce((a, b) => a + b, 0) / values.length, contrast: percentile(values, .95) - percentile(values, .05) }
    })
    const lineProfiles = [-16, -4, 8, 20].flatMap(x => {
      const center = projectLinePoint(x, 10.3, 2), across = projectLinePoint(x + 1, 10.3, 2)
      if (!center || !across || center[0] < 4 || center[0] > width - 4 || center[1] < 4 || center[1] > height - 4) return []
      const span = Math.hypot(across[0] - center[0], across[1] - center[1]), normal = across.map((value, i) => (value - center[i]) / span)
      const profile = Array.from({ length: 25 }, (_, i) => sampleLuma(center[0] + normal[0] * (i - 12) * .25, center[1] + normal[1] * (i - 12) * .25))
      const background = (profile[0] + profile[24]) * .5, contrast = Math.max(0, background - Math.min(...profile))
      const darkArea = profile.reduce((sum, value, i) => sum + Math.max(0, background - value) * (i === 0 || i === 24 ? .5 : 1), 0) * .25
      return [{ x, centerPx: center, normal, nominalWidthPx: span * .26, profile, background, contrast, equivalentWidthPx: contrast > 0 ? darkArea / contrast : null }]
    })
    temporal.push({ frame, phase: diag.jitter?.index % (diag.jitter?.samples || 8), jitter: diag.jitter?.pixel, resets: diag.stats?.resets, historyValid: diag.historyValid, valid: diag.valid, motion: diag.motion, rois: roiValues, lineProfiles, acquisitionProbe })
    if (frame < 32 || [63, 79, 80, 95, 127].includes(frame)) images.push({ frame, png: f.image(pixels) })
    if (frame % 16 === 15) await new Promise(requestAnimationFrame)
  }
  const metrics = rois.map(roi => {
    const std = [], edges = [], flat = []
    for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) {
      const i = y * width + x, value = Math.sqrt(Math.max(0, square[i] / count - (sum[i] / count) ** 2))
      std.push(value)
      let edge = false
      for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(first[i] - first[(y + dy) * width + x + dx]) > 8) { edge = true; break }
      ;(edge ? edges : flat).push(value)
    }
    const describe = values => ({ pixels: values.length, meanStd: values.reduce((a, b) => a + b, 0) / (values.length || 1), p95Std: percentile(values, .95), maxStd: Math.max(...values) })
    return { ...roi, all: describe(std), edge: describe(edges), flat: describe(flat), contrast: temporal.map(item => item.rois.find(value => value.name === roi.name).contrast) }
  })
  const lineMetrics = [-16, -4, 8, 20].map(x => {
    const profiles = temporal.flatMap(item => item.lineProfiles.filter(profile => profile.x === x))
    const describe = key => {
      const values = profiles.map(profile => profile[key]).filter(Number.isFinite), n = values.length
      const mean = n ? values.reduce((a, b) => a + b, 0) / n : null
      return { samples: n, mean, p05: n ? percentile(values, .05) : null, p95: n ? percentile(values, .95) : null, std: n ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n) : null }
    }
    return { x, contrast: describe('contrast'), equivalentWidthPx: describe('equivalentWidthPx') }
  })
  return { name, count, width, height, metrics, lineMetrics, lineProfileSampling: { stepPx: .25, radiusPx: 3, windowToDrawingBufferScale: profileScale, coordinates: 'drawing-buffer pixel centres, bottom-left origin; geometry-reprojected normal' }, temporal, images, diagnostics: f.pipeline.getTaaDiagnostics() }
}

// Compare both resolves against the same live inputs and history, before depth is overwritten.
export async function compareR186Resolve(f, referenceShader, currentOnly = false, timed = false) {
  const C = Cesium, taa = f.pipeline.taa, stage = taa.frames[0].resolve
  let activeStage = stage
  const uniforms = Object.fromEntries(Object.keys(stage._uniformMap)
    .filter(name => name.startsWith('u_') && !name.endsWith('Dimensions'))
    .map(name => [name, () => activeStage._uniformMap[name]()]))
  const currentOutput = shader => shader.replace('vec4 currentColor = taaCurrent(uv);',
    'vec4 currentColor = taaCurrent(uv); out_FragColor = currentColor; return;')
  const reference = new C.PostProcessStage({ name: 'taa_performance_reference', fragmentShader: currentOnly ? currentOutput(referenceShader) : referenceShader, uniforms,
    pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampleMode: C.PostProcessStageSampleMode.LINEAR })
  const collection = taa._collection('taa_performance_reference', reference), restores = []
  const probe = currentOnly && new C.PostProcessStage({ name: 'taa_performance_current', fragmentShader: currentOutput(stage.fragmentShader), uniforms,
    pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampleMode: C.PostProcessStageSampleMode.LINEAR })
  const probeCollection = probe && taa._collection('taa_performance_current', probe)
  const result = { component: currentOnly ? 'current' : 'resolve', frames: 0, values: 0, maxError: 0, maxErrorRGBA: [0,0,0,0], meanError: 0 }
  const gl = f.viewer.scene.context._gl, ext = timed && gl.getExtension('EXT_disjoint_timer_query_webgl2'), pending = []
  if (timed && !ext) throw new Error('GPU timer unavailable for paired resolve comparison')
  if (timed) result.queries = []
  const measure = (label, fn) => {
    if (!timed || result.frames < 32) return fn()
    const query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    try { return fn() } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, label, frame: result.frames }) }
  }
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) if (gl.getQueryParameter(pending[i].query, gl.QUERY_RESULT_AVAILABLE)) {
      const item = pending.splice(i, 1)[0]
      result.queries.push({ label: item.label, frame: item.frame, milliseconds: gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6,
        disjoint: !!gl.getParameter(ext.GPU_DISJOINT_EXT) }); gl.deleteQuery(item.query)
    }
  }
  for (const frame of taa.frames) {
    const execute = frame.collection.execute
    frame.collection.execute = function (context, color, depth, id) {
      const value = measure('optimized', () => execute.call(this, context, color, depth, id))
      activeStage = frame.resolve
      collection.update(context, f.viewer.scene.frameState.useLogDepth, false); collection.clear(context)
      if (collection.ready) {
        measure('reference', () => collection.execute(context, taa.alphaSource || color, depth, id))
        if (timed) { result.frames++; return value }
        if (probeCollection) {
          probeCollection.update(context, f.viewer.scene.frameState.useLogDepth, false); probeCollection.clear(context)
          if (!probeCollection.ready) return value
          probeCollection.execute(context, color, depth, id)
        }
        const actual = f.read(probe ? probe.outputTexture : frame.resolve.outputTexture), expected = f.read(reference.outputTexture)
        for (let i = 0; i < actual.length; i++) {
          const error = Math.abs(actual[i] - expected[i])
          if (!Number.isFinite(error)) throw new Error('Non-finite resolve comparison')
          result.maxError = Math.max(result.maxError, error); result.meanError += error
          result.maxErrorRGBA[i % 4] = Math.max(result.maxErrorRGBA[i % 4], error)
        }
        result.values += actual.length; result.frames++
      }
      return value
    }
    restores.push(() => { frame.collection.execute = execute })
  }
  const matrix = !timed && C.Matrix4.clone(f.moving.modelMatrix), show = !timed && f.moving.show
  try {
    for (let frame = 0; frame < (timed ? 332 : 32); frame++) {
      if (!timed) {
        if (frame >= 8 && frame < 16) f.viewer.camera.moveRight(.17)
        f.moving.show = frame >= 16 && frame < 24
        if (f.moving.show) f.moving.modelMatrix = f.place(frame - 20, 0, 12, 5.5, 5.5)
      }
      f.step()
      if (timed) poll()
      await new Promise(requestAnimationFrame)
    }
    if (timed) {
      for (let i = 0; pending.length && i < 120; i++) { await new Promise(requestAnimationFrame); poll() }
      if (pending.length || result.queries.length < 580 || result.queries.some(q => q.disjoint)) throw new Error('Incomplete paired GPU samples')
      return result
    }
    result.meanError /= result.values
    // Current reconstruction should agree to float precision. Full resolves also
    // report cancellation in variance; judge their displayed images separately.
    if (result.frames < 24 || (currentOnly && result.maxError > 1e-6) || result.maxErrorRGBA[3] > 1e-5)
      throw new Error('Resolve parity failed: ' + JSON.stringify(result))
    return result
  } finally {
    restores.forEach(restore => restore()); collection.destroy(); if (probeCollection) probeCollection.destroy()
    for (const item of pending) gl.deleteQuery(item.query)
    if (!timed) {
      f.moving.modelMatrix = matrix; f.moving.show = show; f.restoreCamera(); taa.resetHistory()
      await f.steps(128)
    }
  }
}

export function attachR186MotionProbe(f) {
  const motion = f.pipeline.taa?.motion
  if (!motion) return { available: false, reason: 'Baseline has no object-motion pass' }
  f.disposeResolveProbe?.()
  const C = Cesium, taa = f.pipeline.taa, originalStage = taa.frames[0].resolve
  const anchor = 'vec2 offsetUV = velocityNDC * 0.5;'
  if (!originalStage.fragmentShader.includes(anchor)) throw new Error('Resolve velocity probe anchor changed')
  const shader = originalStage.fragmentShader
    .replace('if (u_hasMotionTexture) {', 'bool ccrProbeAccepted = false; if (u_hasMotionTexture) {')
    .replace('if (visibleMotion) {', 'ccrProbeAccepted = visibleMotion; if (visibleMotion) {')
    .replace(anchor, 'out_FragColor = vec4(velocityNDC, ccrProbeAccepted ? 1.0 : 0.0, closestEyeDepth); return; ' + anchor)
  // Cesium's public uniform descriptors do not retain callback values after update.
  // Reuse the live callback map, excluding the stage's built-in input textures.
  const uniforms = Object.fromEntries(Object.entries(originalStage._uniformMap).filter(([name]) => name.startsWith('u_') && !name.endsWith('Dimensions')))
  const probe = new C.PostProcessStage({ name: 'r186_effective_velocity_' + Date.now(), fragmentShader: shader, uniforms,
    pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampleMode: C.PostProcessStageSampleMode.LINEAR })
  const collection = taa._collection('r186_probe', probe), restores = []
  for (const frame of taa.frames) {
    const execute = frame.collection.execute
    frame.collection.execute = function (context, color, depth, id) {
      const result = execute.call(this, context, color, depth, id)
      collection.update(context, f.viewer.scene.frameState.useLogDepth, false); collection.clear(context)
      if (collection.ready) {
        try { collection.execute(context, color, depth, id) }
        catch (error) { throw new Error('Resolve diagnostic failed: ' + error.message + '; undefined uniforms=' + Object.entries(probe._uniformMap || {}).filter(([name, value]) => { try { return value() === undefined } catch { return true } }).map(([name]) => name).join(',')) }
        f.resolveProbePixels = f.read(probe.outputTexture)
      }
      return result
    }
    restores.push(() => { frame.collection.execute = execute })
  }
  f.disposeResolveProbe = () => { restores.forEach(restore => restore()); collection.destroy(); f.disposeResolveProbe = undefined }
  const execute = motion.executor.execute
  f.motionDraws = []
  motion.executor.execute = function (item, context, passState, overrides, submit) {
    const u = overrides.uniformMap
    f.motionDraws.push({ frame: f.viewer.scene.frameState.frameNumber, owner: item.owner, currentModelView: clone(u.ccr_currentModelView()), previousModelView: clone(u.ccr_previousModelView()), currentProjection: clone(u.ccr_currentProjection()), previousProjection: clone(u.ccr_previousProjection()), previousValid: u.ccr_previousValid() })
    return execute.call(this, item, context, passState, overrides, submit)
  }
  return { available: true, resolveProbe: 'Exact production shader through visibleMotion and velocityNDC; extra RGBA32F diagnostic output before accumulation only' }
}

export async function sampleR186Motion(f, name, frames = 32) {
  const C = Cesium, s = f.viewer.scene, motion = f.pipeline.taa?.motion
  if (!motion) return { name, available: false }
  f.moving.show = true; f.mask.show = name === 'mask'; f.unsupported.show = name === 'unsupported' || name === 'occlusion'
  f.mask.modelMatrix = f.place(0, 0, 20, 7, 7)
  f.unsupported.modelMatrix = f.place(0, 0, 21, 7, 7)
  f.restoreCamera(); f.moving.modelMatrix = f.place(0, 0, 12, 5.5, 5.5); await f.steps(4)
  const samples = [], summaries = []
  let previousKnownView = clone(s.camera.viewMatrix), previousKnownModel = clone(f.moving.modelMatrix)
  const difference = (a, b) => Math.max(...Array.from({ length: 16 }, (_, i) => Math.abs(a[i] - b[i])))
  for (let frame = 0; frame < frames; frame++) {
    f.motionDraws.length = 0
    if (name === 'camera-static') { f.moving.show = false; s.camera.moveRight(.04) }
    else {
      const x = name === 'translation' || name === 'combined' || name === 'occlusion' || name === 'mask' || name === 'unsupported' ? frame * .07 : 0
      const z = name === 'depth-z' ? 12 + frame * .08 : 12
      const angle = name === 'rotation' ? frame * .004 : 0
      f.moving.modelMatrix = f.place(x, 0, z, 5.5, 5.5, angle)
      if (name === 'combined') s.camera.moveRight(.025)
      if (name === 'start-stop' && frame > 12) f.moving.modelMatrix = f.place(.84, 0, 12, 5.5, 5.5)
      if (name === 'start-stop' && frame <= 12) f.moving.modelMatrix = f.place(frame * .07, 0, 12, 5.5, 5.5)
      if (name === 'appearance') f.moving.show = frame >= 8 && frame < 24
    }
    const knownView = clone(s.camera.viewMatrix), knownModel = clone(f.moving.modelMatrix)
    const expectedCurrentMatrix = C.Matrix4.multiply(knownView, knownModel, new C.Matrix4())
    const expectedPreviousMatrix = C.Matrix4.multiply(previousKnownView, previousKnownModel, new C.Matrix4())
    f.step()
    previousKnownView = knownView; previousKnownModel = knownModel
    const diag = motion.getDiagnostics(), summary = { frame, phase: f.pipeline.taa.jitter.index % f.pipeline.taa.jitter.samples, ...diag }
    summaries.push(summary)
    const record = f.motionDraws.find(draw => draw.owner === f.moving), texture = motion.textureForResolve
    if (!record || !texture) continue
    // Independent history check: known test animation matrices and camera matrices,
    // in addition to comparing shader arithmetic with the submitted uniforms.
    summary.currentTransformError = difference(record.currentModelView, expectedCurrentMatrix)
    summary.previousTransformError = difference(record.previousModelView, record.previousValid ? expectedPreviousMatrix : expectedCurrentMatrix)
    const pixels = f.read(texture)
    // Pixel-centre ray intersects the exact current rigid plane; this avoids treating a
    // nearby raster fragment as the CPU point and accidentally accepting depth errors.
    const inverseMv = C.Matrix4.inverse(record.currentModelView, new C.Matrix4())
    const rasterProjection = C.Matrix4.inverse(f.pipeline.taa.previousInverseRasterProjection, new C.Matrix4())
    const inverseRaster = C.Matrix4.inverse(rasterProjection, new C.Matrix4())
    for (const local of [[-.9, -.4], [.1, .3], [.55, -.15]]) {
      const eye = C.Matrix4.multiplyByVector(record.currentModelView, new C.Cartesian4(local[0], local[1], 0, 1), new C.Cartesian4())
      const clip = C.Matrix4.multiplyByVector(rasterProjection, eye, new C.Cartesian4())
      const x = Math.floor((clip.x / clip.w * .5 + .5) * texture.width), y = Math.floor((clip.y / clip.w * .5 + .5) * texture.height)
      const rayEye = C.Matrix4.multiplyByVector(inverseRaster, new C.Cartesian4((x + .5) / texture.width * 2 - 1, (y + .5) / texture.height * 2 - 1, 0, 1), new C.Cartesian4())
      const origin = C.Matrix4.multiplyByVector(inverseMv, new C.Cartesian4(0, 0, 0, 1), new C.Cartesian4())
      const direction = C.Matrix4.multiplyByVector(inverseMv, new C.Cartesian4(rayEye.x, rayEye.y, rayEye.z, 0), new C.Cartesian4())
      const t = -origin.z / direction.z, point = new C.Cartesian4(origin.x + direction.x * t, origin.y + direction.y * t, 0, 1)
      const currentEye = C.Matrix4.multiplyByVector(record.currentModelView, point, new C.Cartesian4()), previousEye = C.Matrix4.multiplyByVector(record.previousModelView, point, new C.Cartesian4())
      const currentClip = C.Matrix4.multiplyByVector(record.currentProjection, currentEye, new C.Cartesian4()), previousClip = C.Matrix4.multiplyByVector(record.previousProjection, previousEye, new C.Cartesian4())
      const expected = [currentClip.x / currentClip.w - previousClip.x / previousClip.w, currentClip.y / currentClip.w - previousClip.y / previousClip.w, -currentEye.z, record.previousValid ? -previousEye.z : -1]
      let visibility = 'visible-moving-surface'
      let expectedEffectiveVelocity = expected.slice(0, 2), expectedAccepted = true
      if (name === 'unsupported' || name === 'occlusion' || name === 'mask') {
        const foreground = name === 'mask' ? f.mask : f.unsupported
        const inverse = C.Matrix4.inverse(C.Matrix4.multiply(s.camera.viewMatrix, foreground.modelMatrix, new C.Matrix4()), new C.Matrix4())
        const a = C.Matrix4.multiplyByVector(inverse, new C.Cartesian4(0, 0, 0, 1), new C.Cartesian4())
        let covered = false
        // The current reconstruction reads four raster samples per axis; include
        // that same footprint in the independent visibility/velocity oracle.
        const jitter = f.pipeline.taa.jitter.pixel
        for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) {
          const ray = C.Matrix4.multiplyByVector(inverseRaster, new C.Cartesian4((x + Math.floor(jitter.x) + dx + .5) / texture.width * 2 - 1, (y + Math.floor(jitter.y) + dy + .5) / texture.height * 2 - 1, 0, 1), new C.Cartesian4())
          const b = C.Matrix4.multiplyByVector(inverse, new C.Cartesian4(ray.x, ray.y, ray.z, 0), new C.Cartesian4())
          const ix = a.x - b.x * a.z / b.z, iy = a.y - b.y * a.z / b.z
          covered ||= Math.abs(ix) < 1 && Math.abs(iy) < 1 && (name !== 'mask' || (ix + 1) * .5 >= .25)
        }
        if (covered) { expectedEffectiveVelocity = [0, 0]; expectedAccepted = false; visibility = 'static-foreground-blocks-background-motion' }
        else if (name === 'mask') visibility = 'mask-hole-reveals-background-motion'
      }
      const measured = Array.from(pixels.subarray((y * texture.width + x) * 4, (y * texture.width + x) * 4 + 4))
      const effective = f.resolveProbePixels && Array.from(f.resolveProbePixels.subarray((y * texture.width + x) * 4, (y * texture.width + x) * 4 + 4))
      samples.push({ frame, phase: f.pipeline.taa.jitter.index % f.pipeline.taa.jitter.samples, pixel: [x, y], point: [point.x, point.y], visibility, expected, measured,
        rawExpectedMatchesVisibleSurface: expectedAccepted, absoluteError: expectedAccepted ? measured.map((value, i) => Math.abs(value - expected[i])) : null,
        resolve: { expectedEffectiveVelocity, expectedAccepted, measured: effective, error: effective?.slice(0, 2).map((value, i) => Math.abs(value - expectedEffectiveVelocity[i])), acceptedMatches: effective && (effective[2] > .5) === expectedAccepted } })
    }
    if (frame % 8 === 7) await new Promise(requestAnimationFrame)
  }
  f.moving.show = false; f.mask.show = false; f.unsupported.show = false
  return { name, available: true, summaries, samples,
    maxError: [0, 1, 2, 3].map(i => Math.max(0, ...samples.filter(sample => sample.absoluteError).map(sample => sample.absoluteError[i]))),
    resolveMaxError: [0, 1].map(i => Math.max(0, ...samples.filter(sample => sample.resolve.error).map(sample => sample.resolve.error[i]))),
    resolveMismatch: samples.filter(sample => sample.resolve.acceptedMatches === false).length }
}

export async function checkR186Ui(f) {
  const C = Cesium, scene = f.viewer.scene, previousSamples = f.pipeline.getOptions().taaJitterSamples
  const labels = scene.primitives.add(new C.LabelCollection()), billboards = scene.primitives.add(new C.BillboardCollection())
  const position = C.Matrix4.multiplyByPoint(f.frame, new C.Cartesian3(0, 0, 20), new C.Cartesian3())
  const icon = document.createElement('canvas'); icon.width = icon.height = 20
  const context = icon.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 20, 20)
  // Constant sky isolates glyph coverage: antialiased text over changing HDR
  // geometry legitimately changes a thresholded composite edge pixel.
  labels.add({ position, text: 'TRAA UI', font: '24px sans-serif', style: C.LabelStyle.FILL, fillColor: C.Color.YELLOW, pixelOffset: new C.Cartesian2(-180, -140), disableDepthTestDistance: Infinity })
  const id = 'r186-ui-billboard', billboard = billboards.add({ position, image: icon, width: 20, height: 20, pixelOffset: new C.Cartesian2(180, -140), disableDepthTestDistance: Infinity, id })
  const counts = { label: [], billboard: [] }, diffs = { label: [], billboard: [] }; let base
  try {
    f.restoreCamera(); await f.configure(32)
    for (let frame = 0; frame < 32; frame++) {
      await f.steps(1)
      const pixels = f.read(), mask = new Uint8Array(pixels.length / 4)
      for (let i = 0; i < mask.length; i++) {
        const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2]
        mask[i] = r > 180 && g > 180 && b < 70 ? 1 : r > 180 && g < 70 && b < 70 ? 2 : 0
      }
      base ||= mask
      for (const [key, bit] of [['label', 1], ['billboard', 2]]) {
        let count = 0, diff = 0
        for (let i = 0; i < mask.length; i++) { if (mask[i] & bit) count++; if ((mask[i] & bit) !== (base[i] & bit)) diff++ }
        counts[key].push(count); diffs[key].push(diff)
      }
    }
    const taa = f.pipeline.getTaaDiagnostics(), overlay = taa.overlay, pick = scene.pick(billboard.computeScreenSpacePosition(scene))?.id === id
    if (!taa.valid || !overlay?.active || !overlay.drawn || !pick || Object.values(counts).some(values => values.some(value => value === 0)) || Object.values(diffs).some(values => values.some(value => value !== 0))) throw new Error('Native UI acceptance failed: ' + JSON.stringify({ counts, diffs, pick, overlay }))
    return { counts, diffs, pick, overlay, taa: { valid: taa.valid, jitterSamples: taa.jitter?.samples } }
  } finally { scene.primitives.remove(labels); scene.primitives.remove(billboards); f.pipeline.setTaa({ enabled: true, jitterSamples: previousSamples }); await f.steps(2) }
}

export async function checkR186Lifecycle(f) {
  const diagnostics = () => f.pipeline.getTaaDiagnostics(), states = []
  const record = name => states.push({ name, ...diagnostics() })
  f.pipeline.setAntiAliasing('fxaa'); await f.steps(4); record('disabled')
  f.pipeline.setAntiAliasing('taa'); await f.steps(40); record('reenabled')
  f.pipeline.setEnabled(false); await f.steps(4); record('pipeline-paused')
  f.pipeline.setEnabled(true); await f.steps(40); record('pipeline-resumed')
  const scene = f.viewer.scene, near = scene.camera.frustum.near, far = scene.camera.frustum.far
  const distant = await f.addPlane('multi-frustum-target', 0, 0, -1000000, 60000, 60000, [.2, .2, .2])
  const depthRatio = scene.logarithmicDepthFarToNearRatio
  scene.logarithmicDepthFarToNearRatio = 1000
  scene.camera.frustum.near = .01; scene.camera.frustum.far = 1e9
  for (let i = 0; i < 40; i++) { f.step(); await new Promise(requestAnimationFrame) }
  record('multi-frustum-fallback')
  const fallback = states.at(-1); fallback.actualFrustums = scene._view.frustumCommandsList.length
  fallback.exercised = fallback.actualFrustums > 1
  scene.primitives.remove(distant)
  scene.logarithmicDepthFarToNearRatio = depthRatio
  scene.camera.frustum.near = near; scene.camera.frustum.far = far; await f.steps(40); record('frustum-restored')
  return states
}

export function readR186Samplers(f) {
  const gl = f.viewer.scene.context._gl, bound = gl.getParameter(gl.TEXTURE_BINDING_2D)
  const read = texture => {
    if (!texture || texture.isDestroyed()) return null
    gl.bindTexture(gl.TEXTURE_2D, texture._texture)
    return { min: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER), mag: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER) }
  }
  try { return { historyColor: read(f.pipeline.taa.historyColor), historyDepth: read(f.pipeline.taa.historyDepth), motion: read(f.pipeline.taa.motion?.textureForResolve), expected: { linear: gl.LINEAR, nearest: gl.NEAREST } } }
  finally { gl.bindTexture(gl.TEXTURE_2D, bound) }
}

export async function useR186RootCameraDepthDomain(f, useRoot = true) {
  const taa = f.pipeline.taa, root = f.viewer.scene.camera.frustum
  const before = { x: taa.cameraNearFar.x, y: taa.cameraNearFar.y }, writes = []
  for (const frame of taa.frames) {
    const execute = frame.collection.execute
    frame.collection.execute = function (...args) {
      if (writes.length < 40) writes.push({ before: [taa.cameraNearFar.x, taa.cameraNearFar.y], after: useRoot ? [root.near, root.far] : [taa.cameraNearFar.x, taa.cameraNearFar.y] })
      if (useRoot) { taa.cameraNearFar.x = root.near; taa.cameraNearFar.y = root.far }
      return execute.apply(this, args)
    }
  }
  taa.resetHistory(); await f.steps(128)
  return { experiment: useRoot ? 'Only override u_cameraNearFar before resolve collection executes; no source/threshold/filter changes' : 'Control: same reset and additional 128 warmup, retain production draw near/far', before, root: [root.near, root.far], writes }
}

// No readPixels during this experiment. Queries rotate frame / AA / motion to
// avoid nested TIME_ELAPSED scopes; every auxiliary draw gets a query and sums by frame.
export async function measureR186Performance(f, count = 300, trials = 3) {
  const s = f.viewer.scene, gl = s.context._gl, ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  if (!ext) return { available: false, reason: 'EXT_disjoint_timer_query_webgl2 unavailable' }
  const pending = [], result = [], cpu = [], taa = f.pipeline.taa, motion = taa.motion
  let activeScope = null, frameIndex = 0
  const query = (scope, fn) => {
    const value = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, value)
    try { return fn() } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ value, scope, frame: frameIndex }) }
  }
  const execute = taa._execute
  taa._execute = function (...args) { return activeScope === 'aa' ? query('aa', () => execute.apply(this, args)) : execute.apply(this, args) }
  const motionExecute = motion?.executor.execute
  if (motion) motion.executor.execute = function (...args) { return activeScope === 'motion' ? query('motion-draw', () => motionExecute.apply(this, args)) : motionExecute.apply(this, args) }
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) if (gl.getQueryParameter(pending[i].value, gl.QUERY_RESULT_AVAILABLE)) {
      const item = pending.splice(i, 1)[0]; result.push({ frame: item.frame, scope: item.scope, milliseconds: gl.getQueryParameter(item.value, gl.QUERY_RESULT) / 1e6, disjoint: !!gl.getParameter(ext.GPU_DISJOINT_EXT) }); gl.deleteQuery(item.value)
    }
  }
  try {
    if (f.moving) f.moving.show = true; await f.steps(128)
    for (let trial = 0; trial < trials; trial++) for (let frame = 0; frame < count; frame++) {
      frameIndex = trial * count + frame; activeScope = ['frame', 'aa', 'motion'][frame % 3]
      if (f.beforeFrame) f.beforeFrame(frame)
      else f.moving.modelMatrix = f.place(Math.sin(frame * .02) * 8, 0, 12, 5.5, 5.5)
      const start = performance.now(); if (activeScope === 'frame') query('frame', () => f.step()); else f.step()
      cpu.push({ trial, frame, scope: activeScope, milliseconds: performance.now() - start, motionDraws: motion?.stats.draws || 0 }); poll()
      await new Promise(requestAnimationFrame)
    }
    activeScope = null
    for (let i = 0; pending.length && i < 120; i++) { await new Promise(requestAnimationFrame); poll() }
  } finally { taa._execute = execute; if (motion) motion.executor.execute = motionExecute; if (f.moving) f.moving.show = false; for (const item of pending) gl.deleteQuery(item.value) }
  const motionFrames = new Map(cpu.filter(item => item.scope === 'motion').map(item => [item.trial * count + item.frame,
    { frame: item.trial * count + item.frame, scope: 'motion', milliseconds: 0, draws: 0, disjoint: false }]))
  for (const value of result.filter(item => item.scope === 'motion-draw')) { const frame = motionFrames.get(value.frame) || { frame: value.frame, scope: 'motion', milliseconds: 0, draws: 0, disjoint: false }; frame.milliseconds += value.milliseconds; frame.draws++; frame.disjoint ||= value.disjoint; motionFrames.set(value.frame, frame) }
  const diagnostics = taa.getDiagnostics()
  const observedRhiTextures = [...new Set((taa.rhiHistory || []).flatMap(entry => [entry.color?.texture, entry.depth?.texture]).filter(Boolean))]
  const observedRhiBytes = observedRhiTextures.reduce((sum, texture) => sum + texture.sizeInBytes, 0)
  return { available: true, motionAvailable: !!motion, count, trials, cpu, queries: result, motionFrames: [...motionFrames.values()], unavailableQueries: pending.length,
    aaBytes: diagnostics.stageBytes === undefined ? diagnostics.bytes : diagnostics.stageBytes + diagnostics.rhiHistoryBytes,
    stageBytes: diagnostics.stageBytes ?? diagnostics.bytes, rhiHistoryBytes: diagnostics.rhiHistoryBytes ?? null,
    observedRhiBytes, observedRhiTextureCount: observedRhiTextures.length,
    motionBytes: motion?.getDiagnostics().bytes || 0, reportedTotalBytes: diagnostics.bytes,
    methodology: '300 frames per trial; frame/AA/motion scopes rotate; motion query sums all auxiliary draws per sampled frame including explicit zero-draw frame entries, excluding begin/clear cost; no pixel readback; legacy baseline diagnostics bytes omits RHI history' }
}
