import { SharedGlbTextureCache } from './shared-glb-textures.js'

// Direct Model loading for the campus dataset. The manifest keeps geographic
// placement outside the renderer; GLB node transforms remain untouched.
export function normalizeCampusGlbMaterials(gltf, dielectricMaterials = []) {
  let changed = 0
  for (const index of dielectricMaterials) {
    const pbr = gltf.materials?.[index]?.pbrMetallicRoughness
    if (pbr && (pbr.metallicFactor === undefined || pbr.metallicFactor === 1) && !pbr.metallicRoughnessTexture) {
      // These legacy FBX exports omit metalness on architectural diffuse
      // materials; glTF's default of 1 otherwise turns them into black metal.
      pbr.metallicFactor = 0
      changed++
    }
  }
  return changed
}

export function campusGlbMatrix(C, manifest) {
  const { longitude, latitude, height = 0 } = manifest.origin
  const enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(longitude, latitude, height))
  // ENU +Z is up: clockwise heading rotates local north toward local east.
  const rotation = C.Matrix3.fromRotationZ(-C.Math.toRadians(manifest.headingDegrees || 3))
  return C.Matrix4.multiplyByMatrix3(enu, rotation, enu)
}

function ready(model, scene) {
  if (model.ready) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const removers = []
    const finish = error => {
      clearTimeout(timer)
      removers.forEach(remove => remove())
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('GLB initialization timed out')), 90000)
    removers.push(model.readyEvent.addEventListener(() => finish()))
    removers.push(model.errorEvent.addEventListener(error => finish(error)))
    scene.requestRender()
  })
}

// The manifest lists a primary root plus fallbacks: by default nginx 8083's
// `/DongdaModel_PBR/` proxy, then the local static directory, then the dev-server route.
// Probe the candidates once so a host that can serve none of them fails with one
// actionable message instead of seventy per-file 404s.
export async function assertCampusGlbBase(urls) {
  for (const url of urls) {
    let response
    try {
      response = await fetch(url, { method: 'HEAD' })
    } catch {
      continue // Unreachable host: try the next candidate.
    }
    if (response.ok) return url
  }
  throw new Error(
    `GLB 根路径不可用，已尝试：${urls.join('、')}。` +
    '默认走 nginx 8083 的 /DongdaModel_PBR/ 代理，不可达时回退 /assets/campus-glb-release；' +
    '也可用 ?glbAssets=<可访问目录> 指定其他地址。')
}

export async function loadCampusGlbs(C, viewer, manifest, baseUrl, models, onProgress, sharedTextureCache) {
  let next = 0, failed = false
  const modelMatrix = campusGlbMatrix(C, manifest)
  const sharedTextures = sharedTextureCache ?? new SharedGlbTextureCache(C)
  const worker = async () => {
    while (!failed && next < manifest.models.length) {
      const asset = manifest.models[next++]
      try {
        const url = `${baseUrl.replace(/\/$/, '')}/${asset.file}`
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        const glb = new Uint8Array(await response.arrayBuffer())
        const imageHashes = await sharedTextures.hashEmbeddedImages(glb)
        const model = await C.Model.fromGltfAsync({
          gltf: glb, basePath: url,
          modelMatrix: C.Matrix4.clone(modelMatrix), scene: viewer.scene,
          shadows: C.ShadowMode.ENABLED, asynchronous: true,
          gltfCallback: gltf => {
            sharedTextures.annotate(gltf, imageHashes)
            normalizeCampusGlbMaterials(gltf, asset.dielectricMaterials)
          },
          incrementallyLoadTextures: false, releaseGltfJson: true
        })
        if (viewer.isDestroyed()) { model.destroy(); return }
        model.name = asset.name
        model.id = { name: asset.name, file: asset.file }
        viewer.scene.primitives.add(model)
        models.push(model)
        await ready(model, viewer.scene)
        onProgress(models.filter(m => m.ready).length, manifest.models.length)
      } catch (error) {
        failed = true
        throw new Error(`${asset.file}: ${error.message}`)
      }
    }
  }
  try {
    await Promise.all(Array.from({length: Math.min(3, manifest.models.length)}, worker))
    return sharedTextures
  } catch (error) {
    sharedTextures.destroy()
    throw error
  }
}
