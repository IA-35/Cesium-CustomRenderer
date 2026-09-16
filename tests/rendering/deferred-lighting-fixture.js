// B02 fixture: a controlled PBR scene where a native Cesium render and a CCR deferred render can be
// compared pixel-for-pixel.
//
// The reference must not come from the shader under test (the plan is explicit about this). So the
// native reference is produced by Cesium's own pipeline with CCR's deferred pass disabled, reading
// the same camera, clock and geometry.
//
// Geometry is generated, never loaded: no campus asset, no external imagery, matching the generic
// renderer scope in docs/RENDERER_SCOPE.md.

import { createFrameBridge } from '/src/pipeline/FrameBridge143.js'

export const DEFERRED_FIXTURE_VERSION = 1

/** Material cases; each isolates one PBR parameter axis. */
export const MATERIAL_CASES = [
  { id: 'white-dielectric', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.6 },
  { id: 'grey-dielectric', baseColor: [0.18, 0.18, 0.18, 1], metallic: 0, roughness: 0.6 },
  { id: 'red-glossy', baseColor: [0.8, 0.1, 0.1, 1], metallic: 0, roughness: 0.15 },
  { id: 'green-rough', baseColor: [0.1, 0.7, 0.2, 1], metallic: 0, roughness: 0.95 },
  { id: 'metal-gold', baseColor: [1.0, 0.77, 0.34, 1], metallic: 1, roughness: 0.3 },
  { id: 'metal-mid', baseColor: [0.9, 0.9, 0.9, 1], metallic: 0.5, roughness: 0.4 },
  { id: 'emissive', baseColor: [0.2, 0.2, 0.2, 1], metallic: 0, roughness: 0.8, emissive: [4, 1, 0.5] },
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

/**
 * A neutral 9-coefficient SH environment (sky above, dimmer ground below).
 *
 * Only L0 and the L1 "up" band are populated: that is enough for a stable, non-zero irradiance that
 * depends on the surface normal, which is what makes the indirect term measurable. The values are
 * small and neutral so the term stays a *test input* rather than something that could mask a direct
 * lighting error.
 */
function neutralSphericalHarmonics(C) {
  const coefficients = []
  for (let i = 0; i < 9; i++) coefficients.push(new C.Cartesian3(0, 0, 0))
  // L0: average irradiance.
  coefficients[0] = new C.Cartesian3(0.35, 0.4, 0.5)
  // L1 band: a mild sky/ground gradient along +Z (up in the SH basis Cesium uses for the probe).
  coefficients[2] = new C.Cartesian3(0.06, 0.07, 0.09)
  return coefficients
}

/**
 * Quaternion that rotates the local +Z axis onto `direction`.
 *
 * Used to aim each test tile at the sun. Written out rather than pulled from a helper because the
 * shortest-arc rotation is three lines and the fixture should not depend on more engine surface than
 * it needs.
 */
function quaternionFromZTo(C, direction) {
  const from = new C.Cartesian3(0, 0, 1)
  const to = C.Cartesian3.normalize(direction, new C.Cartesian3())
  const dot = C.Cartesian3.dot(from, to)
  if (dot > 0.999999) return new C.Quaternion(0, 0, 0, 1)
  if (dot < -0.999999) return new C.Quaternion(1, 0, 0, 0)
  const axis = C.Cartesian3.cross(from, to, new C.Cartesian3())
  C.Cartesian3.normalize(axis, axis)
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
  return C.Quaternion.fromAxisAngle(axis, angle, new C.Quaternion())
}

/**
 * A unit plane as a data-URI glTF, with the given PBR material.
 *
 * Hand-built rather than via Cesium's geometry classes: this fixture needs a *known* normal
 * direction and a *known* UV-free surface, and generating the buffers directly keeps the reference
 * independent of any Cesium geometry-orientation convention.
 */
export function planeGlb(C, material) {
  const positions = new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,-1,0, 1,1,0, -1,1,0])
  const normals = new Float32Array(Array.from({length:6},()=>[0,0,material.backFacing?-1:1]).flat())
  const arrays = [positions,normals,new Uint16Array(material.backFacing?[0,2,1,3,5,4]:[0,1,2,3,4,5]),
    new Float32Array([0,0,1,0,1,1,0,0,1,1,0,1])]
  const accessors = [
    {bufferView:0,componentType:5126,count:6,type:'VEC3',min:[-1,-1,0],max:[1,1,0]},
    {bufferView:1,componentType:5126,count:6,type:'VEC3'},
    {bufferView:2,componentType:5123,count:6,type:'SCALAR'},
    {bufferView:3,componentType:5126,count:6,type:'VEC2'},
  ]
  const add = (array,type,count,componentType=5126) => {
    const bufferView=arrays.length;arrays.push(array)
    accessors.push({bufferView,componentType,count,type});return accessors.length-1
  }
  const attributes={POSITION:0,NORMAL:1,TEXCOORD_0:3},node={mesh:0,name:'surface'}
  const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[node],accessors,
    materials:[{pbrMetallicRoughness:{baseColorFactor:material.baseColor,metallicFactor:material.metallic,roughnessFactor:material.roughness},
      emissiveFactor:material.emissive||[0,0,0],doubleSided:!!material.backFacing}],
    meshes:[{primitives:[{attributes,indices:2,material:0}]}]}
  const mat=gltf.materials[0]
  if(material.normalMap||material.mask){
    const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4
    const context=canvas.getContext('2d'),image=context.createImageData(4,4)
    for(let i=0;i<16;i++)image.data.set(material.normalMap?[150,128,250,255]:[255,255,255,i%4===0?0:255],i*4)
    context.putImageData(image,0,0)
    gltf.images=[{uri:canvas.toDataURL()}];gltf.samplers=[{magFilter:9728,minFilter:9728}];gltf.textures=[{source:0,sampler:0}]
    if(material.normalMap)mat.normalTexture={index:0}
    else{mat.pbrMetallicRoughness.baseColorTexture={index:0};mat.alphaMode='MASK';mat.alphaCutoff=.5}
  }
  if(material.instanced){
    gltf.extensionsUsed=['EXT_mesh_gpu_instancing'];gltf.extensionsRequired=['EXT_mesh_gpu_instancing']
    node.extensions={EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:add(new Float32Array([-1.25,0,0,1.25,0,0]),'VEC3',2)}}}
  }
  if(material.skinned){
    attributes.JOINTS_0=add(new Uint8Array(24),'VEC4',6,5121)
    const weights=new Float32Array(24);for(let i=0;i<6;i++)weights[i*4]=1
    attributes.WEIGHTS_0=add(weights,'VEC4',6)
    const inverse=add(new Float32Array(Array.from(C.Matrix4.IDENTITY)),'MAT4',1)
    node.skin=0;gltf.nodes.push({name:'joint'});gltf.scenes[0].nodes.push(1)
    gltf.skins=[{joints:[1],inverseBindMatrices:inverse,skeleton:1}]
  }
  if(material.features){
    attributes._FEATURE_ID_0=add(new Uint16Array(6),'SCALAR',6,5123)
    const height=add(new Float32Array([10]),'SCALAR',1)
    gltf.extensionsUsed=['EXT_mesh_features','EXT_structural_metadata']
    gltf.meshes[0].primitives[0].extensions={EXT_mesh_features:{featureIds:[{featureCount:1,attribute:0,propertyTable:0}]}}
    gltf.extensions={EXT_structural_metadata:{schema:{classes:{building:{properties:{height:{type:'SCALAR',componentType:'FLOAT32'}}}}},
      propertyTables:[{class:'building',count:1,properties:{height:{values:accessors[height].bufferView}}}]}}
  }
  if(material.unlit){gltf.extensionsUsed=['KHR_materials_unlit'];mat.extensions={KHR_materials_unlit:{}}}
  if(material.clearcoat){gltf.extensionsUsed=['KHR_materials_clearcoat'];mat.extensions={KHR_materials_clearcoat:{clearcoatFactor:.8,clearcoatRoughnessFactor:.1}}}
  gltf.buffers=arrays.map(array=>{
    let binary='';for(const b of new Uint8Array(array.buffer))binary+=String.fromCharCode(b)
    return {uri:'data:application/octet-stream;base64,'+btoa(binary),byteLength:array.byteLength}
  })
  gltf.bufferViews=arrays.map((array,buffer)=>({buffer,byteLength:array.byteLength}))
  return 'data:model/gltf+json,'+encodeURIComponent(JSON.stringify(gltf))
}

/**
 * Places one large plane per material case in a grid, all facing the camera, all lit identically.
 * A grid rather than overlapping geometry: every sample point then maps to exactly one case, so a
 * pixel-comparison failure names the material that caused it.
 */
export async function startDeferredFixture(fixture, options = {}) {
  if (fixture.started) return fixture
  const C = Cesium
  const { viewer } = fixture
  fixture.errors = fixture.errors || []
  const scene = viewer.scene
  scene.skyBox.show = false
  scene.skyAtmosphere.show = false
  scene.sun.show = false
  scene.moon.show = false
  scene.backgroundColor = new C.Color(0.025, 0.04, 0.06, 1)

  const iso = options.time || '2026-06-21T04:00:00Z'
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso)
  viewer.clock.shouldAnimate = false
  scene.postUpdate.addEventListener(() => { viewer.clock.currentTime = C.JulianDate.fromIso8601(iso) })

  const origin = C.Cartesian3.fromDegrees(options.longitude ?? 123.42, options.latitude ?? 41.77, 0)
  const frame = C.Transforms.eastNorthUpToFixedFrame(origin)
  fixture.origin = origin
  fixture.models = []

  // Each tile is 40m wide on a 4x2 grid, 2m apart, standing vertically and facing the camera.
  //
  // The transform order matters and was wrong once: the plane spans [-1,1], so it must be scaled to
  // tile size *first* and translated *second*. Translating before scaling multiplies the offset by
  // the scale and throws most tiles off-screen.
  const COLUMNS = options.columns || 4
  const TILE = 40
  const cases = options.cases || MATERIAL_CASES

  // Orient every tile to face the sun, so the direct term is non-trivial and therefore testable.
  //
  // This is a *test setup* decision, not a renderer rule. At the fixture's date and latitude the sun
  // is almost overhead in local ENU (measured: [-0.048, -0.314, 0.948]), so axis-aligned planes
  // receive almost no direct light and every tile renders black. Rotating the tiles to face the light
  // makes NdotL large and stable, and because the rotation is derived from the sun rather than
  // hard-coded it stays correct if the fixture's time or place changes.
  // Controlled directional sunlight, transformed from this fixture's local frame.
  const sunLocalENU = options.sunLocalENU || new C.Cartesian3(-0.0477, -0.3137, 0.9483)
  const sunWorld = C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(frame, sunLocalENU, new C.Cartesian3()), new C.Cartesian3())
  scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(sunWorld, new C.Cartesian3()), intensity: 1 })
  const tileRotation = C.Matrix4.fromRotationTranslation(
    C.Matrix3.fromQuaternion(quaternionFromZTo(C, options.normalLocal || sunLocalENU), new C.Matrix3()),
    C.Cartesian3.ZERO,
    new C.Matrix4(),
  )

  for (const [index, material] of cases.entries()) {
    const column = index % COLUMNS
    const row = Math.floor(index / COLUMNS)
    const east = (column - (COLUMNS - 1) / 2) * (TILE + 2) * (options.spacing || 1)
    const north = ((Math.ceil(cases.length / COLUMNS) - 1) / 2 - row) * (TILE + 2) * (options.spacing || 1)
    // local: scale the unit plane to tile size, tilt it toward the sun, then place it in the grid.
    const scaled = C.Matrix4.multiplyByScale(C.Matrix4.IDENTITY, new C.Cartesian3(TILE / 2, TILE / 2, 1), new C.Matrix4())
    const rotated = C.Matrix4.multiply(tileRotation, scaled, new C.Matrix4())
    const localOffset = C.Matrix4.fromTranslation(new C.Cartesian3(east, north, 0), new C.Matrix4())
    const inFrame = C.Matrix4.multiply(localOffset, rotated, new C.Matrix4())
    const modelMatrix = C.Matrix4.multiply(frame, inFrame, new C.Matrix4())
    const model = await C.Model.fromGltfAsync({ url: planeGlb(C, material), modelMatrix, id: material.id, upAxis: C.Axis.Z, forwardAxis: C.Axis.X })
    scene.primitives.add(model)
    fixture.models.push({ id: material.id, model, east, north, sampleLocal: material.instanced ? new C.Cartesian3(-1.25,0,0) : C.Cartesian3.ZERO })
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
    for (const { model } of fixture.models) model.imageBasedLighting.sphericalHarmonicCoefficients = options.sphericalHarmonics
  }
  await waitFrames(scene, 6, fixture.errors)

  // Look down at the tile grid from above, from the direction opposite the sun so the lit faces are
  // visible. The camera is fixed so the sun angle -- and therefore the expected shading -- is the same
  // for every tile and across runs.
  const height = options.height ?? 240
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(options.longitude ?? 123.42, options.latitude ?? 41.77, height),
    orientation: {
      heading: 0,
      // Tilt toward the tiles: the sun is up and slightly north, so looking straight down keeps every
      // tile's sun-facing side in view.
      pitch: -Math.PI / 2,
      roll: 0,
    },
  })
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)

  await waitFrames(scene, 30, fixture.errors)
  fixture.started = true
  return fixture
}

/** Sample a pixel from the presented default framebuffer (requires preserveDrawingBuffer). */
export function readPixel(viewer, x, y) {
  const context = viewer.scene.context
  const gl = context._gl
  return Array.from(context.readPixels({
    x: Math.round(x), y: Math.round(gl.drawingBufferHeight - 1 - y), width: 1, height: 1,
  }))
}

/**
 * Read the material G-buffer by *sampling it through a shader*.
 *
 * This is not a stylistic choice. `gl.readPixels` against the material MRT framebuffer returns the
 * **default framebuffer** contents in this configuration: all four attachments read back as the
 * identical presented-screen bytes, with GL_INVALID_OPERATION set (measured in B02). Reading through
 * a 1x1 viewport-quad command is how CCR's existing AO/SSR/Bloom fixtures read texture data, and it
 * is the only approach here that returns real values.
 *
 * `readPixel` on the *presented* framebuffer remains correct and is what the native-vs-deferred
 * comparison uses.
 */
export function probeMaterialTextures(C, scene, textures, samples) {
  const probeUV = new C.Cartesian2(0.5, 0.5)
  const results = {}
  const readOne = (uv, expression) => {
    const target = new C.Texture({
      context: scene.context, width: 1, height: 1,
      pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT,
    })
    const framebuffer = new C.Framebuffer({ context: scene.context, colorTextures: [target], destroyAttachments: false })
    const previous = [probeUV.x, probeUV.y]
    probeUV.x = uv[0]
    probeUV.y = uv[1]
    const command = scene.context.createViewportQuadCommand(
      // `out_FragColor` is already declared by the viewport-quad preamble; redeclaring it is a compile
      // error, which is how that was discovered.
      new C.ShaderSource({
        sources: [`uniform sampler2D u_normalRoughMetal;
uniform sampler2D u_emissiveFlags;
uniform sampler2D u_eyeDepth;
uniform sampler2D u_albedoOcclusion;
uniform vec2 u_uv;
void main() { out_FragColor = ${expression}; }`],
      }),
      {
        framebuffer,
        renderState: C.RenderState.fromCache({
          viewport: new C.BoundingRectangle(0, 0, 1, 1), depthTest: { enabled: false }, depthMask: false,
        }),
        uniformMap: {
          u_normalRoughMetal: () => textures.normalRoughMetal,
          u_emissiveFlags: () => textures.emissiveFlags,
          u_eyeDepth: () => textures.eyeDepth,
          u_albedoOcclusion: () => textures.albedoOcclusion,
          u_uv: () => probeUV,
        },
      },
    )
    let pixels
    try {
      command.execute(scene.context)
      pixels = Array.from(scene.context.readPixels({ framebuffer, width: 1, height: 1 }))
    } finally {
      probeUV.x = previous[0]
      probeUV.y = previous[1]
      command.shaderProgram.destroy()
      framebuffer.destroy()
      target.destroy()
    }
    return pixels
  }

  for (const sample of samples) {
    results[sample.id] = {
      uv: sample.uv,
      eyeDepth: readOne(sample.uv, 'vec4(texture(u_eyeDepth, u_uv).r, 0.0, 0.0, 1.0)')[0],
      flags: readOne(sample.uv, 'vec4(texture(u_emissiveFlags, u_uv).a, 0.0, 0.0, 1.0)')[0],
      albedo: readOne(sample.uv, 'texture(u_albedoOcclusion, u_uv)').slice(0, 3),
      normalRoughMetal: readOne(sample.uv, 'texture(u_normalRoughMetal, u_uv)').slice(0, 4),
    }
  }
  return results
}

/**
 * Screen positions of each material tile plus a background point.
 *
 * Derived from the camera projection rather than hard-coded, so changing the camera in the fixture
 * does not silently sample the wrong tile.
 */
export function samplePoints(fixture) {
  const C = Cesium
  const viewer = fixture.viewer
  const scene = viewer.scene
  const width = scene.drawingBufferWidth
  const height = scene.drawingBufferHeight
  const points = []
  for (const entry of fixture.models) {
    // The tile centre in world space, then through the engine's own world->window transform.
    const world = C.Matrix4.multiplyByPoint(entry.model.modelMatrix, entry.sampleLocal || C.Cartesian3.ZERO, new C.Cartesian3())
    const window = C.SceneTransforms.worldToWindowCoordinates(scene, world)
    if (!window) continue
    points.push({ id: entry.id, x: Math.round(window.x), y: Math.round(window.y) })
  }
  points.push({ id: 'background-sky', x: Math.round(width * 0.5), y: 4 })
  return { width, height, points }
}

/**
 * Read every sample point twice: once with CCR deferred lighting active, once with it disabled
 * (the native reference). Everything else -- camera, clock, geometry -- is identical.
 */
export async function compareNativeVsDeferred(fixture, lighting = {}) {
  const scene = fixture.viewer.scene
  const errors = fixture.errors
  const { points, width, height } = samplePoints(fixture)

  // 1) Native reference: no CCR lighting, plain Cesium forward PBR.
  fixture.pipeline.setLighting({ mode: 'enhanced' })
  await waitFrames(scene, 40, errors)
  const native = {}
  for (const point of points) native[point.id] = readPixel(fixture.viewer, point.x, point.y)

  // 2) CCR deferred.
  fixture.pipeline.setLighting({ mode: 'deferred', ...lighting })
  await waitFrames(scene, 40, errors)
  const deferred = {}
  for (const point of points) deferred[point.id] = readPixel(fixture.viewer, point.x, point.y)

  const diagnostics = fixture.pipeline.getLightingDiagnostics()
  return { width, height, points, native, deferred, diagnostics }
}
