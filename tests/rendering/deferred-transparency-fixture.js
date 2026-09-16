// B03 fixture: transparent composition over a CCR-lit opaque background.
//
// Why this is a separate fixture from B02's: B02 samples a *grid* of tiles, one screen position per
// material. B03 must sample **stacked layers at one screen position** -- glass in front of glass in
// front of an opaque surface -- because that is where composition order, alpha degradation and the
// linear blend are actually observable. A grid cannot express "what is behind this pixel".
//
// Every reference value is analytic: the opaque background is read with all translucent objects
// hidden, so the expected blended result is computed from measured inputs rather than from the
// implementation under test.
//
// Geometry is generated, never loaded (docs/RENDERER_SCOPE.md): no campus asset, no external imagery.

export const DEFERRED_TRANSPARENCY_FIXTURE_VERSION = 1

/** The opaque backing surface. Deliberately mid-grey so a blend error is easy to see in either direction. */
export const BACKDROP = { baseColor: [0.55, 0.58, 0.62, 1], metallic: 0, roughness: 0.7 }

/**
 * Translucent layers, listed front-to-back in *layer index* order (1 = closest to the camera).
 *
 * `alpha` is the glTF baseColorFactor alpha, and `alphaMode: BLEND` is what makes it translucent at
 * all -- see `planeGlb`. `distance` is metres toward the camera from the backdrop.
 */
export const GLASS_LAYERS = [
  { id: 'front', alpha: 0.5, baseColor: [0.90, 0.25, 0.20, 0.5], distance: 30, roughness: 0.15, metallic: 0 },
  { id: 'back', alpha: 0.5, baseColor: [0.20, 0.45, 0.90, 0.5], distance: 15, roughness: 0.15, metallic: 0 },
]

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

/** Shortest-arc quaternion rotating +Z onto `direction`. Local helper, not engine API. */
function quaternionFromZTo(C, direction) {
  const from = new C.Cartesian3(0, 0, 1)
  const to = C.Cartesian3.normalize(direction, new C.Cartesian3())
  const dot = C.Cartesian3.dot(from, to)
  if (dot > 0.999999) return new C.Quaternion(0, 0, 0, 1)
  if (dot < -0.999999) return new C.Quaternion(1, 0, 0, 0)
  const axis = C.Cartesian3.normalize(C.Cartesian3.cross(from, to, new C.Cartesian3()), new C.Cartesian3())
  return C.Quaternion.fromAxisAngle(axis, Math.acos(Math.max(-1, Math.min(1, dot))), new C.Quaternion())
}

/**
 * A unit plane as a data-URI glTF with the given PBR material.
 *
 * `material.blend` sets `alphaMode: 'BLEND'`. This matters more than it looks: glTF defaults to
 * OPAQUE, and an OPAQUE material ignores baseColorFactor alpha entirely. Omitting it makes a "glass"
 * pane an opaque plane that additionally gets captured by the deferred opaque pass -- a B03
 * reconnaissance run measured exactly that and reported three opaque tiles as a blend result.
 */
export function planeGlb(C, material) {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0])
  const normals = new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat())
  const arrays = [positions, normals, new Uint16Array([0, 1, 2, 3, 4, 5]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])]
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'surface' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 6, type: 'VEC2' },
    ],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: material.baseColor,
        metallicFactor: material.metallic,
        roughnessFactor: material.roughness,
      },
      emissiveFactor: material.emissive || [0, 0, 0],
      doubleSided: false,
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 3 }, indices: 2, material: 0 }] }],
  }
  if (material.blend) gltf.materials[0].alphaMode = 'BLEND'
  if (material.mask) {
    const canvas = document.createElement('canvas')
    canvas.width = 4; canvas.height = 4
    const context = canvas.getContext('2d'), image = context.createImageData(4, 4)
    for (let i = 0; i < 16; i++) image.data.set([255, 255, 255, i % 4 === 0 ? 0 : 255], i * 4)
    context.putImageData(image, 0, 0)
    gltf.images = [{ uri: canvas.toDataURL() }]
    gltf.samplers = [{ magFilter: 9728, minFilter: 9728 }]
    gltf.textures = [{ source: 0, sampler: 0 }]
    gltf.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }
    gltf.materials[0].alphaMode = 'MASK'
    gltf.materials[0].alphaCutoff = 0.5
  }
  if (material.unlit) {
    gltf.extensionsUsed = ['KHR_materials_unlit']
    gltf.materials[0].extensions = { KHR_materials_unlit: {} }
  }
  gltf.buffers = arrays.map(array => {
    let binary = ''
    for (const b of new Uint8Array(array.buffer)) binary += String.fromCharCode(b)
    return { uri: 'data:application/octet-stream;base64,' + btoa(binary), byteLength: array.byteLength }
  })
  gltf.bufferViews = arrays.map((array, buffer) => ({ buffer, byteLength: array.byteLength }))
  return 'data:model/gltf+json,' + encodeURIComponent(JSON.stringify(gltf))
}

/**
 * Build the transparent stack: one opaque backdrop plus `GLASS_LAYERS` in front of it, all
 * co-planar and pointing at the fixed camera so their screen projections coincide exactly.
 *
 * The camera looks straight down the local +Z (up) axis at a rectangle centred on `origin`, and every
 * pane shares the same model matrix except for a translation along that axis. Coincident projections
 * are what allow "the pixel behind the glass" to be a meaningful reference.
 */
export async function startTransparencyFixture(fixture, options = {}) {
  if (fixture.started) return fixture
  const C = Cesium
  const { viewer } = fixture
  fixture.errors = fixture.errors || []
  const scene = viewer.scene

  // Deterministic, self-contained environment: no sky, no imagery, no atmosphere, fixed clock.
  scene.skyBox.show = false
  scene.skyAtmosphere.show = false
  scene.sun.show = false
  scene.moon.show = false
  scene.backgroundColor = new C.Color(0.02, 0.03, 0.05, 1)

  const iso = options.time || '2026-06-21T04:00:00Z'
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso)
  viewer.clock.shouldAnimate = false
  scene.postUpdate.addEventListener(() => { viewer.clock.currentTime = C.JulianDate.fromIso8601(iso) })

  const origin = C.Cartesian3.fromDegrees(options.longitude ?? 123.42, options.latitude ?? 41.77, 0)
  const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
  fixture.origin = origin

  // A controlled directional sun rather than the time-driven default, so the lighting input is a
  // fixed test parameter instead of something that shifts with the clock or the ephemeris.
  const sunLocalENU = options.sunLocalENU || new C.Cartesian3(0, -0.4, 0.9165)
  const sunWorld = C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame, sunLocalENU, new C.Cartesian3()), new C.Cartesian3())
  scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(sunWorld, new C.Cartesian3()), intensity: 1 })

  const SIZE = options.size ?? 60
  const place = (localZ) => {
    const local = C.Matrix4.fromTranslation(new C.Cartesian3(0, 0, localZ), new C.Matrix4())
    const scaled = C.Matrix4.multiplyByScale(C.Matrix4.IDENTITY, new C.Cartesian3(SIZE / 2, SIZE / 2, 1), new C.Matrix4())
    return C.Matrix4.multiply(frame, C.Matrix4.multiply(local, scaled, new C.Matrix4()), new C.Matrix4())
  }

  fixture.layers = []
  // Backdrop first: it is the opaque surface every translucent layer is composited over.
  const backdrop = await C.Model.fromGltfAsync({
    url: planeGlb(C, { ...BACKDROP, ...(options.backdrop || {}) }),
    modelMatrix: place(0), id: 'backdrop', upAxis: C.Axis.Z, forwardAxis: C.Axis.X,
  })
  scene.primitives.add(backdrop)
  fixture.backdrop = backdrop
  fixture.layers.push({ id: 'backdrop', alpha: 1, model: backdrop })

  for (const layer of options.layers || GLASS_LAYERS) {
    const model = await C.Model.fromGltfAsync({
      url: planeGlb(C, {
        baseColor: layer.baseColor, metallic: layer.metallic, roughness: layer.roughness,
        // alpha < 1 must be translucent; alpha === 1 stays OPAQUE so the alpha=1 degradation path is
        // exercised by the engine's own material classification rather than by a forced flag.
        blend: layer.alpha < 1,
      }),
      modelMatrix: place(layer.distance), id: layer.id, upAxis: C.Axis.Z, forwardAxis: C.Axis.X,
    })
    scene.primitives.add(model)
    fixture.layers.push({ ...layer, model })
  }

  fixture.pipeline = fixture.CCR.createVisualPipeline({
    Cesium: C, viewer,
    options: {
      environment: false, clouds: false, shadows: false, fog: false,
      antialiasing: 'off', screenSpaceAoEnabled: false, screenSpaceReflectionEnabled: false,
      hdrBloomEnabled: false, materialChannelsEnabled: false, albedoEnabled: false,
    },
  })
  fixture.pipeline.setCampusOrigin(origin)

  if (options.sphericalHarmonics) {
    for (const { model } of fixture.layers) {
      if (model.imageBasedLighting) model.imageBasedLighting.sphericalHarmonicCoefficients = options.sphericalHarmonics
    }
  }

  // Look straight down at the stack from a fixed height: with the panes co-planar and perpendicular to
  // the view, every pane projects onto the same screen rectangle.
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(options.longitude ?? 123.42, options.latitude ?? 41.77, options.height ?? 150),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  })
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)

  await waitFrames(scene, 40, fixture.errors)
  fixture.started = true
  return fixture
}

/**
 * Read a pixel of the **linear HDR** scene colour.
 *
 * The acceptance gate is stated in linear HDR, so the comparison must happen there: reading the
 * presented 8-bit sRGB image would let tonemapping compression hide a blend error.
 *
 * Which texture holds the HDR colour depends on the composition path, and reading the wrong one
 * silently returns black rather than failing:
 *   * with OIT, `resolveFramebuffers` composites into the **scene framebuffer**;
 *   * with sorted translucency the OIT composite does not run, and `resolveFramebuffers` feeds the
 *     post-process chain from the **globe-depth colour** framebuffer instead (`Scene.js`: it selects
 *     `globeFramebuffer` when `useGlobeDepthFramebuffer && !useOIT`).
 * The caller therefore picks the input the same way `resolveFramebuffers` does, instead of assuming
 * the scene framebuffer always has it. `presentedPixel` is available as an independent cross-check.
 */
export function hdrColorTexture(C, scene) {
  const environment = scene._environmentState || {}
  const globeDepth = scene._view && scene._view.globeDepth
  if (!environment.useOIT && environment.useGlobeDepthFramebuffer && globeDepth) {
    return globeDepth.colorFramebufferManager.getColorTexture(0)
  }
  return scene._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0)
}

export function readTexture(C,scene,colorTexture,x,y) {
  const context=scene.context,gl=context._gl
  const rd=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),dr=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),cached=context._currentFramebuffer,viewport=C.BoundingRectangle.clone(context.uniformState.viewport)
  const target=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
  const framebuffer=new C.Framebuffer({context,colorTextures:[target],destroyAttachments:false})
  const options={viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false,blending:{enabled:false}}
  const command=context.createViewportQuadCommand('uniform sampler2D src;uniform vec2 uv;void main(){out_FragColor=texture(src,uv);}',{
    framebuffer,renderState:C.RenderState.fromCache(options),uniformMap:{src:()=>colorTexture,uv:()=>new C.Cartesian2((x+.5)/colorTexture.width,(colorTexture.height-1-y+.5)/colorTexture.height)}})
  try {command.execute(context);return Array.from(context.readPixels({framebuffer,width:1,height:1}))}
  finally{command.shaderProgram.destroy();C.RenderState.removeFromCache(options);framebuffer.destroy();target.destroy();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,rd);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dr);context._currentFramebuffer=cached;context.uniformState.viewport=viewport}
}
export function readHdr(C,scene,x,y){return readTexture(C,scene,hdrColorTexture(C,scene),x,y).slice(0,3)}

/**
 * The presented (display-encoded) pixel. Used only as a cross-check that the HDR helper is reading
 * the texture the frame actually shows; never as the acceptance value.
 */
export function presentedPixel(scene, x, y) {
  const gl = scene.context._gl
  return Array.from(scene.context.readPixels({
    x: Math.round(x), y: Math.round(gl.drawingBufferHeight - 1 - y), width: 1, height: 1,
  })).slice(0, 3)
}

/** Centre of the stack in screen coordinates, derived from the camera rather than hard-coded. */
export function stackScreenPoint(fixture) {
  const C = Cesium
  const scene = fixture.viewer.scene
  const window = C.SceneTransforms.worldToWindowCoordinates(scene, fixture.origin)
  if (!window) throw new Error('the transparency stack is not on screen; check the camera')
  return { x: Math.round(window.x), y: Math.round(window.y) }
}

/**
 * Analytic alpha-compositing expectation, front-to-back over a background.
 *
 * `layers` is ordered front-to-back. This is the *definition* the acceptance gate compares against;
 * it is deliberately independent of any GLSL the renderer uses.
 */
export function expectedBlend(background, layers) {
  // Fold from the back: result = background, then for each layer front-to-back we need
  // out = layerColor*alpha + behind*(1-alpha). Because the fold runs back-to-front, iterate the
  // reversed list.
  let result = background.slice(0, 3)
  for (const layer of [...layers].reverse()) {
    const alpha = layer.alpha
    result = layer.color.slice(0, 3).map((value, index) => value * alpha + result[index] * (1 - alpha))
  }
  return result
}
