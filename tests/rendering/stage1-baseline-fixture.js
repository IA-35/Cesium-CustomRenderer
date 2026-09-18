// B00 baseline fixture.
//
// Purpose: lock a reproducible picture of the *current* rendering result so every later
// batch can be compared against it. It deliberately does not enable any deferred/experimental
// feature: this is the reference the plan calls "现有增强基线".
//
// Rules enforced here (see docs/STAGE1_COMPLETION_PLAN.md B00):
//   * The camera, the clock, the cloud animation time and the viewport are frozen, so two runs
//     of the same configuration must produce the same picture.
//   * Every capture reports the *real* drawing buffer (`canvas.width/height`) rather than the CSS
//     viewport, because headless Chrome may clamp the backbuffer.
//   * Missing assets, failed tile loads and shader errors are recorded as failures, never
//     silently skipped. `?imagery=none` only suppresses the external imagery request; it may not
//     be used to turn a campus-basemap failure into a pass.

/** Fixed UTC timestamp for replay; each geographic input keeps its own solar orientation. */
export const BASELINE_TIME = '2026-06-21T04:00:00Z'

/** Cloud animation time frozen alongside the clock so the shell noise does not drift. */
export const BASELINE_CLOUD_TIME = 0

const DEG = Math.PI / 180

/** Camera shots relative to the supplied test origin.
 * Historical IDs are retained for golden compatibility; they do not imply an asset type.
 */
export const BASELINE_SHOTS = [
  { id: 'near', kind: 'fixed', title: '固定近景', pitch: -0.25, range: 220, description: 'close building detail, shading and shadows' },
  { id: 'panorama', kind: 'fixed', title: '全景', pitch: -0.35, range: 1800, description: 'scene overview, shadows and fog' },
  { id: 'tree-road', kind: 'fixed', title: '低角度近景', pitch: -0.12, range: 420, description: 'low-angle geometric detail' },
  { id: 'glass-water', kind: 'fixed', title: '表面斜视', pitch: -0.18, range: 260, description: 'oblique surface view; material coverage uses dedicated fixtures' },
  { id: 'horizon', kind: 'fixed', title: '地平线', pitch: 0.02, range: 1500, description: 'ground/sky blend, atmosphere, fog' },
  { id: 'high-altitude', kind: 'fixed', title: '高空', pitch: -1.45, range: 26000, description: 'fixed 12-50 km cloud fade from above' },
  { id: 'orbit', kind: 'orbit', title: '连续绕行轨迹', pitch: -0.3, range: 900, samples: 8, description: 'continuous orbit used to catch temporal instability' },
]

/** Deterministic viewport list. The 1st entry is the frozen comparison size. */
export const BASELINE_VIEWPORTS = [
  { width: 1280, height: 720, role: 'reference' },
  { width: 801, height: 603, role: 'resize-odd' },
]

/**
 * Frames to render after each camera change before the picture is considered settled.
 *
 * This is not a fudge factor: the classification run in `docs/verification/stage1-B00/` shows every
 * shot is already bit-identical after 60 frames, while a 20-frame settle still caught the cloud
 * fade and the near view mid-convergence. The baseline therefore waits past convergence so that the
 * reference hash describes the settled picture rather than a transient one.
 */
export const BASELINE_SETTLE_FRAMES = 60

/** Frames per orbit sample; smaller than a settle wait because an orbit measures change over time. */
export const BASELINE_ORBIT_FRAMES = 60

/**
 * Wait for `count` further rendered frames. Rejects (instead of hanging) when the scene raised a
 * render error, which is how a missing campus asset becomes a visible baseline failure.
 */
export function waitFrames(scene, count, errors, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let remaining = count
    const timer = setTimeout(() => {
      off()
      reject(new Error(`Frame timeout after ${count} frames; render errors: ${(errors || []).join(' | ') || 'none'}`))
    }, timeoutMs)
    const off = scene.postRender.addEventListener(() => {
      if (--remaining !== 0) return
      off()
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Pause every clock that would otherwise make two runs differ. */
export function freezeTime(viewer, iso = BASELINE_TIME) {
  const clock = viewer.clock
  clock.currentTime = Cesium.JulianDate.fromIso8601(iso)
  clock.shouldAnimate = false
  if (viewer.__baselineFreezeOff) viewer.__baselineFreezeOff()
  viewer.__baselineFreezeOff = viewer.scene.postUpdate.addEventListener(() => {
    clock.currentTime = Cesium.JulianDate.fromIso8601(iso)
  })
}

/** Apply a camera shot using the explicitly supplied world origin. */
export function applyShot(viewer, shot, origin) {
  if (!origin) throw new Error('The baseline fixture must supply its own origin')
  holdView(viewer, origin, 0, shot.pitch, shot.range)
}

/** Put the camera at an absolute ECEF view and pin it, so later frames cannot drift. */
export function holdView(viewer, origin, heading, pitch, range) {
  const camera = viewer.camera
  camera.lookAt(origin, new Cesium.HeadingPitchRange(heading, pitch, range))
  const position = Cesium.Cartesian3.clone(camera.positionWC, new Cesium.Cartesian3())
  const direction = Cesium.Cartesian3.clone(camera.directionWC, new Cesium.Cartesian3())
  const up = Cesium.Cartesian3.clone(camera.upWC, new Cesium.Cartesian3())
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
  camera.setView({ destination: position, orientation: { direction, up } })
  return { position, direction, up }
}

/** Cartesian3 -> plain array; the scratch instance is reused because these run per frame. */
const scratchVector = { x: 0, y: 0, z: 0 }
function vector(cartesian) {
  if (!cartesian) return null
  scratchVector.x = cartesian.x
  scratchVector.y = cartesian.y
  scratchVector.z = cartesian.z
  return [scratchVector.x, scratchVector.y, scratchVector.z]
}

/** Sample `count` positions along a full orbit, so frame N is comparable across runs. */
export function orbitSamples(viewer, shot, origin, count = shot.samples || 8) {
  if (!origin) throw new Error('orbitSamples needs an origin')
  return Array.from({ length: count }, (_, index) => {
    const heading = (index / count) * Math.PI * 2
    holdView(viewer, origin, heading, shot.pitch, shot.range)
    return {
      heading,
      position: vector(viewer.camera.positionWC),
      direction: vector(viewer.camera.directionWC),
      up: vector(viewer.camera.upWC),
    }
  })
}

/** Camera/clock/viewport snapshot used to prove that two captures used identical inputs. */
export function cameraSnapshot(viewer) {
  const { camera, canvas } = viewer
  return {
    position: vector(camera.positionWC),
    direction: vector(camera.directionWC),
    up: vector(camera.upWC),
    frustum: { near: camera.frustum.near, far: camera.frustum.far, fov: camera.frustum.fov, aspectRatio: camera.frustum.aspectRatio },
    time: Cesium.JulianDate.toIso8601(viewer.clock.currentTime),
    drawingBuffer: [canvas.width, canvas.height],
  }
}

/**
 * Per-channel statistics of a `readPixels` result.
 *
 * `sampleStride` sub-samples the buffer: a full 1280x720 RGBA readback is ~3.7 MB of pixels, and
 * serializing that many numbers across the Playwright boundary costs more than the render itself.
 * The stride is fixed and deterministic, so two frozen runs still compare exactly.
 */
export function imageStats(data, sampleStride = 4) {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  let finite = true
  const step = 4 * sampleStride
  for (let i = 0; i < data.length; i += step) {
    for (let channel = 0; channel < 4; channel++) {
      const value = data[i + channel]
      if (!Number.isFinite(value)) { finite = false; continue }
      if (value < min) min = value
      if (value > max) max = value
      sum += value
      count++
    }
  }
  return { min, max, mean: sum / count, finite, samples: count, stride: sampleStride, pixels: data.length / 4 }
}

/**
 * Read back the default framebuffer exactly as presented. `preserveDrawingBuffer: true` is required
 * on the viewer; this asserts it rather than silently returning a blank image.
 */
export function readDrawingBuffer(viewer, sampleStride = 4) {
  const context = viewer.scene.context
  const gl = context._gl
  const width = gl.drawingBufferWidth
  const height = gl.drawingBufferHeight
  const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  const data = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous)
  return { width, height, data, stats: imageStats(data, sampleStride) }
}

/**
 * Count differing bytes between two RGBA readbacks and return a compact description of where they
 * are. B00 uses this to classify residual frame-to-frame noise instead of guessing at its cause.
 */
export function diffBytes(a, b, threshold = 1) {
  const channels = ['r', 'g', 'b', 'a']
  const differing = { r: 0, g: 0, b: 0, a: 0 }
  const maxDelta = { r: 0, g: 0, b: 0, a: 0 }
  let pixels = 0
  let worst = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 4) {
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(a[i + channel] - b[i + channel])
      if (delta >= threshold) {
        differing[channels[channel]]++
        changed = true
        if (delta > maxDelta[channels[channel]]) maxDelta[channels[channel]] = delta
      }
      if (delta > worst) worst = delta
    }
    if (changed) pixels++
  }
  return {
    comparedBytes: length,
    differing,
    maxDelta,
    differingPixels: pixels,
    differingPixelRatio: pixels / (length / 4),
    worstDelta: worst,
    identical: worst < threshold,
  }
}

/** Cheap content hash of a readback or of a serializable record; no dependency on Node crypto. */
export function hashBytes(bytes) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + bytes[i] * (i % 251 + 1)) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

/**
 * Run the full baseline and return everything the acceptance script needs to persist.
 * `options.configurations` lets a caller pin the frozen effect set; the default is the current
 * enhanced baseline with nothing experimental enabled.
 */
export async function runBaseline(fixture, options = {}) {
  const { viewer } = fixture
  const scene = viewer.scene
  const errors = fixture.errors || []
  const checks = {}
  const measurements = {}
  const check = (name, value) => {
    checks[name] = !!value
    if (!value) throw new Error(`${name}: ${JSON.stringify({ measurements, errors })}`)
  }

  // The synthetic fixture only builds the scene (and therefore the pipeline) on demand; the campus
  // page builds it while loading. Either way the baseline never creates a *different* pipeline.
  if (!fixture.pipeline) {
    const { startStage1Scene } = await import('/tests/rendering/stage1-scene.js')
    await startStage1Scene(fixture)
  }
  const pipeline = fixture.pipeline

  freezeTime(viewer)
  const origin = fixture.origin || pipeline.campusOrigin
  if (!origin) throw new Error('The baseline fixture must supply its own origin')

  // Shadow texel stabilization has history: start from the same camera before creating it.
  // Do not change the production shadow algorithm or disable it to get deterministic pictures.
  pipeline.setEnabled(false)
  applyShot(viewer, BASELINE_SHOTS[0], origin)
  if (pipeline.customShadow) { pipeline.customShadow.destroy(); pipeline.customShadow = null }
  pipeline.setEnabled(true)

  const configurations = options.configurations || baselineConfigurations()

  measurements.captures = []
  measurements.configurations = []
  const settleFrames = options.settleFrames ?? BASELINE_SETTLE_FRAMES
  const orbitFrames = options.orbitFrames ?? BASELINE_ORBIT_FRAMES

  for (const configuration of configurations) {
    pipeline.setOptions(configuration.options)
    if (configuration.screenSpaceAO) pipeline.setScreenSpaceAO(configuration.screenSpaceAO)
    if (configuration.reflections) pipeline.setScreenSpaceReflections(configuration.reflections)
    if (configuration.bloom) pipeline.setHdrBloom(configuration.bloom)
    if (configuration.antialiasing) pipeline.setAntiAliasing(configuration.antialiasing)
    await waitFrames(scene, 30, errors)

    const record = { id: configuration.id, title: configuration.title, settleFrames, orbitFrames, shots: [], runtime: runtimeInfo(viewer, pipeline) }
    measurements.configurations.push({ id: configuration.id, title: configuration.title, settleFrames, orbitFrames, runtime: record.runtime })

    for (const shot of BASELINE_SHOTS) {
      if (shot.kind === 'orbit') {
        const frames = []
        for (let index = 0; index < (shot.samples || 8); index++) {
          const heading = (index / (shot.samples || 8)) * Math.PI * 2
          holdView(viewer, origin, heading, shot.pitch, shot.range)
          await waitFrames(scene, orbitFrames, errors)
          await waitBaselineReady(fixture, options.requireImagery)
          const readback = readDrawingBuffer(viewer)
          frames.push({
            index,
            heading,
            camera: cameraSnapshot(viewer),
            drawingBuffer: [readback.width, readback.height],
            stats: readback.stats,
            hash: hashBytes(readback.data),
          })
        }
        const first = frames[0]
        const last = frames[frames.length - 1]
        check(`orbitSampled:${configuration.id}`, frames.length === (shot.samples || 8))
        check(`orbitEndpointsDiffer:${configuration.id}`, first.hash !== last.hash)
        record.shots.push({ id: shot.id, kind: shot.kind, title: shot.title, samples: shot.samples || 8, frames })
        measurements.captures.push({
          configuration: configuration.id, shot: shot.id, kind: shot.kind,
          hash: last.hash, stats: last.stats,
          frames: frames.map(frame => ({ index: frame.index, heading: frame.heading, hash: frame.hash, stats: frame.stats, camera: frame.camera })),
        })
        continue
      }

      applyShot(viewer, shot, origin)
      await waitFrames(scene, settleFrames, errors)
      await waitBaselineReady(fixture, options.requireImagery)
      const before = cameraSnapshot(viewer)
      const readback = readDrawingBuffer(viewer)
      const frozen = cameraSnapshot(viewer)
      measurements.materialInventory = measurements.materialInventory || []
      measurements.materialInventory.push({ configuration: configuration.id, shot: shot.id, ...visibleMaterialInventory(scene) })
      check(`cameraFrozen:${configuration.id}:${shot.id}`, JSON.stringify(before) === JSON.stringify(frozen))
      check(`nonBlank:${configuration.id}:${shot.id}`, hasColorVariation(readback.data))
      record.shots.push({
        id: shot.id,
        kind: shot.kind,
        title: shot.title,
        description: shot.description,
        camera: before,
        drawingBuffer: [readback.width, readback.height],
        stats: readback.stats,
        hash: hashBytes(readback.data),
        shadow: pipeline.customShadow ? { coverage: pipeline.customShadow.stats.coverage,
          levels: pipeline.customShadow.levels?.map(level=>({extent:level.light.camera.frustum.width,anchor:level.light.anchor,
            right:level.light.previousRight,direction:level.light.previousDirection,matrix:Array.from(level.light.viewProjection)})) } : null,
        environmentFrame: pipeline.environmentRenderer?.frameData ? Array.from(pipeline.environmentRenderer.frameData) : null,
      })
      measurements.captures.push({ configuration: configuration.id, shot: shot.id, kind: shot.kind, camera: before, hash: record.shots[record.shots.length - 1].hash, stats: readback.stats })
    }
  }

  check('noRenderErrors', errors.length === 0)
  return { checks, measurements }
}

function runtimeInfo(viewer, pipeline) {
  const context = viewer.scene.context
  const gl = context._gl
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    cesiumVersion: Cesium.VERSION,
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    glVersion: gl.getParameter(gl.VERSION),
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
    canvas: [viewer.canvas.width, viewer.canvas.height],
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    devicePixelRatio: globalThis.devicePixelRatio,
    diagnostics: safeDiagnostics(pipeline),
  }
}

function safeDiagnostics(pipeline) {
  try {
    return typeof pipeline.getRenderDiagnostics === 'function' ? pipeline.getRenderDiagnostics() : null
  } catch (error) {
    return { error: String(error && error.message) }
  }
}

export function baselineReadiness(host, requireImagery = false) {
  const scene = host.viewer.scene
  const errors = [...(host.errors || []), ...(host.baselineProviderErrors || [])]
  if (errors.length) return { ready: false, reason: 'render/provider error: ' + errors.join(' | '), fatal: true }
  if (globalThis.__baselineHttpFailure) return { ready: false, reason: 'required resource failed', fatal: true }
  if ([...(host.tiles || []), ...(host.contextTiles || [])].some(tile => !tile.tilesLoaded)) return { ready: false, reason: 'model tiles loading' }
  if (scene.globe?.tilesLoaded === false) return { ready: false, reason: 'globe/imagery tiles loading' }
  if (requireImagery) {
    const layers = scene.imageryLayers
    let visible = 0
    for (let i = 0; i < layers.length; i++) {
      const layer = layers.get(i)
      if (layer.show && layer.alpha > 0 && layer.imageryProvider && layer.ready !== false) visible++
    }
    if (!visible) return { ready: false, reason: 'required visible imagery layer missing', fatal: true }
  }
  return { ready: true, reason: null }
}
export async function waitBaselineReady(host, requireImagery = false, timeoutMs = 90000) {
  const scene = host.viewer.scene
  let stable = 0
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const status = baselineReadiness(host, requireImagery)
    if (status.fatal) throw new Error(status.reason)
    stable = status.ready ? stable + 1 : 0
    if (stable >= 8) return
    await waitFrames(scene, 1, host.errors || [], Math.min(timeoutMs, 30000))
  }
  throw new Error('scene readiness timeout: ' + baselineReadiness(host, requireImagery).reason)
}
export function baselineConfigurations() {
  const base = { options: { environment: true, clouds: true, cloudGeometry: 'shell',
    environmentAnimation: false, fog: true, shadows: false, shadowMode: 'native' },
    screenSpaceAO: { enabled: false }, reflections: { enabled: false },
    bloom: { enabled: false }, antialiasing: { mode: 'fxaa', msaaSamples: 1, spatialAaQuality: 'balanced' } }
  return [
    { ...structuredClone(base), id: 'isolated', title: '隔离诊断（无阴影）' },
    { ...structuredClone(base), id: 'ccr-default', title: 'CCR默认阴影与SMAA',
      options: { ...base.options, shadows: true, shadowMode: 'custom' },
      antialiasing: { mode: 'smaa', msaaSamples: 1, spatialAaQuality: 'balanced' } },
    { ...structuredClone(base), id: 'campus-quality', title: '效果组合（历史配置ID）',
      options: { ...base.options, shadows: true, shadowMode: 'custom' },
      screenSpaceAO: { enabled: true, algorithm: 'hbao' }, reflections: { enabled: true },
      bloom: { enabled: true }, antialiasing: { mode: 'smaa', msaaSamples: 4, spatialAaQuality: 'balanced' } },
  ]
}

export function hasColorVariation(bytes) {
  for (let i = 4; i < bytes.length; i += 4) {
    if (bytes[i] !== bytes[0] || bytes[i + 1] !== bytes[1] || bytes[i + 2] !== bytes[2]) return true
  }
  return false
}

function visibleMaterialInventory(scene) {
  const models = new Set(), materials = new Set()
  for (const frustum of scene._view.frustumCommandsList) {
    for (let pass = 0; pass < frustum.commands.length; pass++) {
      for (let i = 0; i < (frustum.indices[pass] || 0); i++) {
        const model = frustum.commands[pass][i].owner
        if (model?._sceneGraph?.components) models.add(model)
      }
    }
  }
  for (const model of models) {
    for (const node of model._sceneGraph.components.nodes || []) {
      for (const primitive of node.primitives || []) if (primitive.material) materials.add(primitive.material)
    }
  }
  const alphaModes = {}, result = { scope: 'material components of visible model owners', models: models.size,
    materials: materials.size, texturedAlbedo: 0, unlit: 0, alphaModes }
  for (const material of materials) {
    const alpha = material.alphaMode || 'OPAQUE'
    alphaModes[alpha] = (alphaModes[alpha] || 0) + 1
    if (material.metallicRoughness?.baseColorTexture) result.texturedAlbedo++
    if (material.unlit) result.unlit++
  }
  return result
}
