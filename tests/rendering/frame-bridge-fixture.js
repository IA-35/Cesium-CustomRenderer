// B01 frame-bridge fixture.
//
// Builds the smallest scene that can answer the B01 questions:
//   1. Where in the frame does the opaque colour become final, and can the bridge name that point
//      with a view/frame/generation attached?
//   2. Does replacing the opaque colour leave depth, picking and ID picking intact?
//   3. Does a translucent surface still composite on top of the *replaced* colour, with the exact
//      0.5/0.5 mix the plan predicts?
//   4. Which execution modes cannot be covered, and is that recorded rather than guessed?
//
// The scene is deliberately geometric, not asset-driven: a large opaque "wall" fills the frame, two
// small opaque cubes sit in front of it at different depths (so picking still has to discriminate),
// and one alpha=0.5 glass plane floats in front of everything.



export const FRAME_BRIDGE_FIXTURE_VERSION = 1

/** Linear-HDR replacement colours. Chosen well above 1.0 so a linear upload is unambiguous. */
export const REPLACEMENT_OPAQUE = [2, 0.5, 0.25, 1]
export const BACKGROUND_OPAQUE = [0.1, 0.2, 0.3, 1]

const DEG = Math.PI / 180

/**
 * Wait for rendered frames; rejects on render error so a shader failure cannot look like a timeout.
 */
export function waitFrames(scene, count, errors, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let remaining = count
    const timer = setTimeout(() => {
      off()
      reject(new Error(`frame timeout after ${count} frames; render errors: ${(errors || []).join(' | ') || 'none'}`))
    }, timeoutMs)
    const off = scene.postRender.addEventListener(() => {
      if (--remaining !== 0) return
      off()
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Minimal unlit box model so the fixture does not depend on any campus asset. */
function boxGlb(C, color) {
  const geometry = C.BoxGeometry.createGeometry(C.BoxGeometry.fromDimensions({
    dimensions: new C.Cartesian3(1, 1, 1),
    vertexFormat: C.VertexFormat.POSITION_AND_NORMAL,
  }))
  const arrays = [
    new Float32Array(geometry.attributes.position.values),
    new Float32Array(geometry.attributes.normal.values),
    new Uint16Array(geometry.indices),
  ]
  const buffers = arrays.map(array => {
    const bytes = new Uint8Array(array.buffer)
    let text = ''
    for (const value of bytes) text += String.fromCharCode(value)
    return { uri: 'data:application/octet-stream;base64,' + btoa(text), byteLength: bytes.length }
  })
  return 'data:model/gltf+json,' + encodeURIComponent(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], buffers,
    bufferViews: arrays.map((array, index) => ({ buffer: index, byteLength: array.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: arrays[0].length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: arrays[1].length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: arrays[2].length, type: 'SCALAR' },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color, roughnessFactor: 0.9, metallicFactor: 0 }, emissiveFactor: [0, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  }))
}

/**
 * Build the scene. `options.orderIndependentTranslucency` is the switch the plan asks us to test
 * both ways: with OIT the bridge has a per-frustum boundary; without it, it does not.
 */
export async function startFrameBridgeFixture(fixture, options = {}) {
  if (fixture.started) return fixture
  const C = Cesium
  const { viewer } = fixture
  fixture.errors = fixture.errors || []
  const scene = viewer.scene
  const merged = { ...(fixture.options || {}), ...options }
  fixture.effectiveOptions = merged

  // A stable sun and clock: two runs must not differ because the sun moved.
  viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T02:00:00Z')
  viewer.clock.shouldAnimate = false
  scene.postUpdate.addEventListener(() => { viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T02:00:00Z') })

  const origin = C.Cartesian3.fromDegrees(123.42, 41.77, 0)
  const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
  const place = (position, scale) => {
    const matrix = C.Matrix4.multiply(frame, C.Matrix4.fromTranslation(new C.Cartesian3(...position)), new C.Matrix4())
    return C.Matrix4.multiplyByScale(matrix, new C.Cartesian3(...scale), matrix)
  }

  fixture.origin = origin
  fixture.models = []

  // Back wall: fills the frame, sits behind everything, and is what the replacement test recolours.
  const wall = await C.Model.fromGltfAsync({ id: 'wall', url: boxGlb(C, [0.35, 0.55, 0.45, 1]), modelMatrix: place([0, 400, -20], [600, 4, 260]) })
  // Two foreground opaque cubes: they must keep occluding the wall after a replacement.
  const nearCube = await C.Model.fromGltfAsync({ id: 'near-cube', url: boxGlb(C, [0.8, 0.3, 0.6, 1]), modelMatrix: place([-60, 60, 6], [24, 24, 24]) })
  const farCube = await C.Model.fromGltfAsync({ id: 'far-cube', url: boxGlb(C, [0.3, 0.4, 0.9, 1]), modelMatrix: place([60, 120, 6], [40, 40, 40]) })
  fixture.models.push(wall, nearCube, farCube)
  for (const model of fixture.models) scene.primitives.add(model)

  // Glass plane in front of everything: translucent, alpha 0.5. `glass: false` leaves it out, which
  // is how the harness checks that the bridge works on a frame with no translucent content at all.
  if (merged.glass !== false) {
    fixture.glass = scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        id: 'glass',
        geometry: new C.Geometry({
          attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3,
            values: new Float64Array([-110,0,-75, 110,0,-75, 110,0,75, -110,0,75]) }) },
          indices: new Uint16Array([0,1,2,0,2,3]), primitiveType: C.PrimitiveType.TRIANGLES,
          boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, 134),
        }),
        modelMatrix: place([0, 10, 40], [1, 1, 1]),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(new C.Color(0.2, 0.5, 1.0, 0.5)) },
      }),
      appearance: glassAppearance(C, 0.5),
      asynchronous: false,
    }))
  }

  fixture.setGlassAlpha = alpha => { fixture.glass.appearance = glassAppearance(C, alpha) }
  fixture.glassPoint = C.Matrix4.multiplyByPoint(frame, new C.Cartesian3(0,10,40), new C.Cartesian3())
  fixture.wall = wall
  fixture.nearCube = nearCube
  fixture.farCube = farCube

  const pipeline = fixture.CCR.createVisualPipeline({
    Cesium: C,
    viewer,
    options: {
      environment: false,
      clouds: false,
      shadows: false,
      shadowMode: 'native',
      antialiasing: 'fxaa',
      fog: false,
      screenSpaceAoEnabled: false,
      screenSpaceReflectionEnabled: false,
      hdrBloomEnabled: false,
    },
  })
  pipeline.setCampusOrigin(origin)
  // Setting `viewer.scene.msaaSamples` before the pipeline exists is overwritten by its own AA
  // configuration (measured in B01), so the requested sample count is applied through the pipeline.
  if (merged.msaaSamples > 1) pipeline.setAntiAliasing({ mode: 'msaa', msaaSamples: merged.msaaSamples })
  fixture.pipeline = pipeline

  viewer.camera.lookAt(origin, new C.HeadingPitchRange(0, -0.25, 320))
  const position = C.Cartesian3.clone(viewer.camera.positionWC, new C.Cartesian3())
  const direction = C.Cartesian3.clone(viewer.camera.directionWC, new C.Cartesian3())
  const up = C.Cartesian3.clone(viewer.camera.upWC, new C.Cartesian3())
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
  viewer.camera.setView({ destination: position, orientation: { direction, up } })

  await waitFrames(scene, 30, fixture.errors)
  fixture.started = true
  return fixture
}

/**
 * Sample the presented default framebuffer at a pixel. Requires `preserveDrawingBuffer: true`.
 * Coordinates are in CSS pixels measured from the top-left, matching what the test reads.
 */
export function readCanvasPixel(viewer, x, y) {
  const context = viewer.scene.context
  const gl = context._gl
  return context.readPixels({
    x: Math.round(x * (gl.drawingBufferWidth / viewer.canvas.clientWidth || 1)),
    y: Math.round(gl.drawingBufferHeight - 1 - y * (gl.drawingBufferHeight / viewer.canvas.clientHeight || 1)),
    width: 1,
    height: 1,
  })
}

/**
 * Resolve `(x, y)` into an ECEF world position through the depth buffer, or `null` when the pixel
 * has no surface (sky/background). Uses the same path as `scene.pickPosition`.
 */
export function pickPositionAt(viewer, x, y) {
  return viewer.scene.pickPosition(new Cesium.Cartesian2(x, y))
}

/**
 * Attach a bridge and return an evidence-carrying handle.
 *
 * The recorded phase log is the B01 deliverable that matters most: it is the proof of *where* the
 * bridge actually sat in the frame, produced by the engine rather than asserted by us.
 *
 * `options.replacement`, when given, registers a hook-driven replacement. That is the shape the
 * later batches use, and the only one that survives: a one-shot `uploadOpaqueColor` called from
 * outside the frame is overwritten by the next frame's own opaque pass (measured in B01), while a
 * replacement written at `opaqueReadHook` is consumed by the same frame's translucent composite.
 */
export function attachBridge(fixture, options = {}) {
  const bridge = fixture.CCR.createFrameBridge({ Cesium, scene: fixture.viewer.scene, ...options })
  const log = []
  fixture.bridgeLog = log
  const record = (phase, limit) => context => {
    if (log.length >= limit) return
    log.push({
      phase,
      frameNumber: context.frameNumber,
      frameGeneration: context.frameGeneration,
      generation: context.generation,
      callIndex: context.callIndex,
      sceneId: context.sceneId,
      viewId: context.viewId,
      drawingBuffer: context.drawingBuffer,
    })
  }
  const limit = options.logLimit || 64
  const disposers = [
    bridge.on('opaqueFrame', record('opaqueFrame', limit), { label: 'log-opaque' }),
    bridge.on('opaqueReadHook', record('opaqueReadHook', limit), { label: 'log-read' }),
    bridge.on('translucent', record('translucent', limit), { label: 'log-translucent' }),
    bridge.on('resolve', record('resolve', limit), { label: 'log-resolve' }),
  ]
  let replacementDispose
  if (options.replacement) {
    const phase = options.replacementPhase || 'translucent'
    replacementDispose = bridge.on(phase, () => {
      fixture.lastReplacement = bridge.uploadOpaqueColor(options.replacement)
    }, { label: 'replace-opaque' })
    disposers.push(replacementDispose)
  }
  bridge.install()
  fixture.bridge = bridge
  fixture.disposeBridge = () => { for (const dispose of disposers) dispose(); bridge.destroy() }
  return bridge
}

/** Human-readable per-frame phase sequence, e.g. `o r | t | r` for one OIT frame. */
export function summarizeLog(log) {
  const letters = { opaqueFrame: 'o', opaqueReadHook: 'r', translucent: 't', resolve: 'R' }
  const frames = []
  let current = { frameGeneration: null, order: [] }
  for (const entry of log) {
    if (entry.frameGeneration !== current.frameGeneration) {
      if (current.order.length) frames.push(current)
      current = { frameGeneration: entry.frameGeneration, order: [] }
    }
    current.order.push(letters[entry.phase] || '?')
  }
  if (current.order.length) frames.push(current)
  return frames.map(frame => frame.order.join(''))
}

function glassAppearance(C, alpha) {
  return new C.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false,
    fragmentShaderSource: `void main() { out_FragColor = vec4(0.2, 0.5, 0.8, ${Number(alpha).toFixed(8)}); }`,
    renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: false } },
  })
}
