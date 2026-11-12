import getEzTreeRuntime from '../../vendor/cesium-ez-tree/runtime.js'
import { grassVariationAt, resolveGrassVariation } from './grassVariation.js'
import { sampleGrassGroundGrid } from './grassGroundSampler.js'
import { pickGrassSpecies, resolveGrassSpecies } from './grassSpecies.js'

const fetchJson = async url => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Grass resource request failed (${response.status}): ${url}`)
  return response.json()
}

const SCHEMA_VERSION = 1
const GRASS_VARIANTS = Object.freeze([
  { id: 'grass-10', file: 'grass-10.glb', scale: 1.0734813213348389 },
  { id: 'grass-17', file: 'grass-17.glb', scale: 1 },
])

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// Lightweight grass shading (see EzTreeVegetationFS): x = blend of blade normals
// toward the ground normal, y = root brightness, z = yellowing of tips,
// w = back-light transmission through thin tips.
const DEFAULT_LIGHTWEIGHT_SHADING = Object.freeze([0.6, 0.42, 0.45, 0.35])
const LEGACY_SHADING = Object.freeze([0, 1, 0, 0])
// Species meshes carry real curvature and midrib-folded normals; bending them
// hard toward the ground normal would flatten that shading again.
const SPECIES_SHADING = Object.freeze([0.3, 0.5, 0.4, 0.4])

// Generates procedural grass instances inside surveyed polygons.
//
// This is a business adapter, like FixedTreeCollection. Sampling, instance
// packing, GPU commands, culling, LOD and resource streaming stay in the pinned
// cesium-ez-tree runtime; this class only supplies the polygons in local ENU
// metres and the density budget.
//
// Grass instances reference the runtime's bundled `assets/models/grass.glb`, so
// that asset must be served from the runtime's assetBaseUrl.
export class GrassCollection {
  constructor(options) {
    if (!options?.Cesium || !options?.viewer?.scene || !options.polygonsUrl) {
      throw new Error('GrassCollection requires Cesium, viewer and polygonsUrl')
    }
    this.C = options.Cesium
    this.viewer = options.viewer
    this.scene = options.viewer.scene
    this.polygonsUrl = new URL(options.polygonsUrl, typeof document !== 'undefined' ? document.baseURI : undefined).href
    this.fetchJson = options.fetchJson || fetchJson
    this.profile = options.profile === 'lightweight' ? 'lightweight' : 'legacy'
    const lightweight = this.profile === 'lightweight'
    this.cellSize = options.cellSize ?? 64
    // Lightweight cards support dense close coverage; retain legacy asset budgets.
    this.density = options.density ?? (lightweight ? 4 : 0.045)
    this.maxInstances = options.maxInstances ?? (lightweight ? 650000 : 10000)
    this.scale = options.scale ?? (lightweight ? 0.24 : 1)
    this.patchScale = options.patchScale ?? 55
    // Lightweight assets: 'species' (blade patches + weeds, default) or 'cards'
    // (the original three-card grass.glb, kept as a cheaper fallback).
    this.assetMode = lightweight && options.assetMode !== 'cards' ? 'species' : 'cards'
    const speciesMode = this.assetMode === 'species' && lightweight
    // Upstream semantics: 1.0 is uniform coverage, lower values leave bare areas
    // between ~patchScale-sized patches. A mown lawn should be uniform.
    this.patchiness = options.patchiness ?? (lightweight ? 1 : 0.75)
    this.seed = options.seed ?? 20260908
    this.color = options.color || [0.42, 0.62, 0.27]
    this.height = options.height ?? 3
    this.objectsToExclude = options.objectsToExclude || []
    this.visible = options.show !== false
    // Realism controls apply to the lightweight profile only; legacy keeps its atlas look.
    this.variation = resolveGrassVariation(options.variation)
    this.species = speciesMode ? resolveGrassSpecies(options.species, options.variation) : null
    // Species meshes are authored in metres; sizeScale scales every species uniformly.
    this.sizeScale = Number.isFinite(options.sizeScale) ? Math.max(0.05, options.sizeScale) : 1
    // Wind displacement scales with instance height: metre-scaled species need less.
    this.windStrength = options.windStrength ?? (speciesMode ? 0.05 : 0.18)
    this.groundSampleSpacing = options.groundSampleSpacing ?? 10
    this.maxGroundSamples = options.maxGroundSamples ?? 4000
    this.receiveShadows = options.receiveShadows ?? lightweight
    this.shading = options.shading || (speciesMode ? SPECIES_SHADING : lightweight ? DEFAULT_LIGHTWEIGHT_SHADING : LEGACY_SHADING)
    this.maximumDistance = options.maximumDistance ?? (lightweight ? 220 : 900)
    this.lodNearDistance = options.lodNearDistance ?? (lightweight ? 60 : 250)
    this.minimumLodRatio = options.minimumLodRatio ?? (lightweight ? 0.06 : 0.1)

    this.destroyed = false
    this.state = 'loading'
    this.error = null
    this._polygons = 0
    this._areaHectares = 0
    this._instances = 0
    this._variantCounts = Object.create(null)
    this._groundClamped = false
    this._groundFallbacks = 0
    this._groundSamples = 0
    this._gridSampledPolygons = 0
    this._groundSampleMs = 0
    this.primitive = null
    this._runtime = options.ezTreeRuntime || getEzTreeRuntime(this.C)
    this.readyPromise = this._load()
  }

  async _load() {
    try {
      const data = await this.fetchJson(this.polygonsUrl)
      if (this.destroyed) throw new Error('Grass collection destroyed while loading')
      if (data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.polygons)) {
        throw new Error('Invalid grass polygon asset')
      }
      const origin = data.coordinateSystem?.origin
      if (!Number.isFinite(origin?.longitude) || !Number.isFinite(origin?.latitude)) {
        throw new Error('Grass polygons require a finite WGS84 origin')
      }

      const C = this.C
      const worldOrigin = C.Cartesian3.fromDegrees(origin.longitude, origin.latitude, 0)
      this._modelMatrix = C.Transforms.eastNorthUpToFixedFrame(worldOrigin)
      this._inverseModelMatrix = C.Matrix4.inverseTransformation(this._modelMatrix, new C.Matrix4())

      // The runtime sampler accepts one outline per call and the surveyed data is
      // a set of disjoint patches, so each patch is sampled on its own and the
      // results are concatenated. Everything is in local ENU metres around the
      // origin the polygons were authored against.
      const sampled = await this._samplePerPolygon(data.polygons)
      this._polygons = data.polygons.length
      this._areaHectares = data.summary?.areaHectares ?? 0
      if (this.destroyed) throw new Error('Grass collection destroyed while loading')

      const grass = this._buildInstances(sampled)
      this._instances = grass.length
      if (grass.length === 0) {
        this.state = 'ready'
        this.scene.requestRender()
        return this
      }

      this._runtime.configureEzTree({
        useWorkers: false,
        assetBaseUrl: new URL('./eztree/', this.polygonsUrl).href,
      })
      const grassAssets = this._grassAssets()
      this.primitive = new this._runtime.EzTreePrimitive({
        modelMatrix: this._modelMatrix,
        instances: grass,
        grassAssets,
        show: this.visible,
        lodCellSize: this.cellSize,
        cullingTileSize: 320,
        maximumGrassDistance: this.maximumDistance,
        grassLodNearDistance: this.lodNearDistance,
        grassMinimumLodRatio: this.minimumLodRatio,
        windStrength: this.windStrength,
        windFrequency: 0.9,
        castShadows: false,
        // Receive-only: blades never enter the light pass, so the shadow-map cost
        // is unchanged; only the receiver lookup is added for grass fragments.
        grassReceiveShadows: this.receiveShadows,
        grassShading: { x: this.shading[0], y: this.shading[1], z: this.shading[2], w: this.shading[3] },
        workerPacking: false,
        maximumCommandBuildsPerFrame: 8,
        maximumUploadBytesPerFrame: 512 * 1024,
        statisticsUpdateInterval: 30,
      })
      this.scene.primitives.add(this.primitive)
      await this._waitForAssets()
      if (this.destroyed) throw new Error('Grass collection destroyed while loading')
      this.state = 'ready'
      this.scene.requestRender()
      return this
    } catch (error) {
      if (!this.destroyed) {
        this.state = 'error'
        this.error = error.message
        this._releasePrimitive()
      }
      throw error
    }
  }

  // Samples every polygon separately, because the runtime accepts a single
  // outline per call and the surveyed data is a set of disjoint patches.
  // Asking for one outline at a time also keeps the runtime's own
  // point-in-polygon rejection working per patch instead of across the whole set.
  async _samplePerPolygon(polygons) {
    const collected = []
    const totalArea = polygons.reduce((sum, polygon) => sum + Math.max(0, polygon.area || 0), 0)
    const budget = Math.max(0, Math.min(Math.floor(this.maxInstances), Math.round(this.density * totalArea)))
    if (!budget || !totalArea) return collected
    // Largest-remainder allocation keeps small patches deterministic without
    // manufacturing extra instances beyond the scene-wide budget.
    const shares = polygons.map((polygon, index) => {
      const exact = budget * Math.max(0, polygon.area || 0) / totalArea
      return {index, count: Math.floor(exact), fraction: exact - Math.floor(exact)}
    })
    const remainder = budget - shares.reduce((sum, share) => sum + share.count, 0)
    const ranked = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    for (let i = 0; i < remainder; i++) ranked[i].count++
    for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex++) {
      const polygon = polygons[polygonIndex]
      if (this.destroyed) break
      const count = shares[polygonIndex].count
      if (!count) continue
      const instances = this._runtime.createEzTreeVegetationInstances({
        modelMatrix: this._modelMatrix,
        polygon: {
          positions: polygon.outer.map(point => [...point]),
          holes: (polygon.holes || []).map(hole => hole.map(point => [...point])),
        },
        seed: this.seed + (polygon.id || 0),
        // Trees, flowers and rocks are separate concerns for this dataset; the
        // runtime still walks their loops, so keep the counts at zero.
        treeCount: 0,
        flowerCount: 0,
        rockCount: 0,
        grassCount: count,
        grassScale: this.scale,
        grassPatchScale: this.patchScale,
        grassPatchiness: this.patchiness,
      })
      const grass = instances.filter(instance => instance.kind === 'grass')
      if (this.profile === 'lightweight') await this._placeOnGround(grass)
      for (const instance of grass) collected.push(instance)
      // The upstream sampler is synchronous. Yield between small polygon groups
      // so camera, loading UI and cancellation remain responsive.
      if (polygonIndex % 12 === 11) await new Promise(resolve => setTimeout(resolve, 0))
    }
    return collected
  }

  // Grid-samples the polygon ground; falls back to one sample per polygon when the
  // scene cannot sample, the budget is spent or every grid sample missed.
  async _placeOnGround(grass) {
    if (!grass.length) return
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const started = now()
    const budget = this.maxGroundSamples - this._groundSamples
    if (this.scene.sampleHeightSupported && this.groundSampleSpacing > 0 && budget > 0) {
      const result = await sampleGrassGroundGrid({
        C: this.C, scene: this.scene, instances: grass,
        modelMatrix: this._modelMatrix, inverseModelMatrix: this._inverseModelMatrix,
        spacing: this.groundSampleSpacing, sampleBudget: budget,
        objectsToExclude: this.objectsToExclude, isCancelled: () => this.destroyed,
      })
      this._groundSamples += result.samples
      this._groundSampleMs += now() - started
      if (!result.fallback) {
        this._gridSampledPolygons++
        return
      }
    }
    let groundHeight = this.height
    if (this.scene.sampleHeightSupported) {
      const C = this.C
      const world = C.Matrix4.multiplyByPoint(this._modelMatrix, grass[0].translation, new C.Cartesian3())
      const position = C.Cartographic.fromCartesian(world)
      const sampledHeight = this.scene.sampleHeight(position, this.objectsToExclude)
      if (Number.isFinite(sampledHeight)) {
        position.height = sampledHeight + 0.02
        C.Cartographic.toCartesian(position, C.Ellipsoid.WGS84, world)
        groundHeight = C.Matrix4.multiplyByPoint(this._inverseModelMatrix, world, new C.Cartesian3()).z
        this._groundSamples++
      } else this._groundFallbacks++
    } else this._groundFallbacks++
    for (const instance of grass) instance.translation.z = groundHeight
  }

  _grassAssets() {
    if (this.species) {
      // Only species that actually received clumps are loaded.
      const used = new Set(Object.keys(this._variantCounts))
      return this.species.filter(item => used.has(item.assetId))
        .map(item => ({ id: item.assetId, url: item.url, scale: 1, alphaFromColor: false }))
    }
    const variants = this.profile === 'lightweight'
      ? [{ id: 'grass-light', file: 'eztree/models/grass.glb', scale: 1 }]
      : GRASS_VARIANTS
    return variants.map(variant => ({
      id: variant.id,
      url: new URL(variant.file, this.polygonsUrl).href,
      scale: variant.scale,
      alphaFromColor: this.profile !== 'lightweight',
    }))
  }

  _buildInstances(sampled) {
    const C = this.C
    // Quantize root height with XY after per-polygon ground sampling.
    return sampled.map((instance, index) => {
      const id = `grass-${index}`
      if (this.species) return this._buildSpeciesInstance(instance, index, id)
      const variant = this.profile === 'lightweight'
        ? { id: 'grass-light', scale: 1 } : GRASS_VARIANTS[fnv1a(id) & 1]
      const translation = instance.translation
      this._variantCounts[variant.id] = (this._variantCounts[variant.id] || 0) + 1
      if (this.profile === 'lightweight') return this._buildLightweightInstance(instance, index, id, variant)
      return {
        kind: 'grass',
        id,
        asset: variant.id,
        translation: new C.Cartesian3(translation.x, translation.y, this.height),
        scale: new C.Cartesian3(instance.scale.x * variant.scale, instance.scale.y * variant.scale, instance.scale.z * variant.scale),
        rotation: instance.rotation,
        windPhase: instance.windPhase,
        // Legacy atlases already contain their own colour.
        color: C.Color.WHITE ? C.Color.clone(C.Color.WHITE) : new C.Color(1, 1, 1, 1),
      }
    })
  }

  // The six-triangle lightweight asset is a grayscale mask tinted in linear space.
  // Colour and size vary by patch noise and per-clump jitter (see grassVariation.js).
  _buildLightweightInstance(instance, index, id, variant) {
    const C = this.C
    const translation = instance.translation
    const { color, heightScale, widthScale } = grassVariationAt(translation.x, translation.y, index, this.seed, this.variation)
    const width = variant.scale * 0.13 * widthScale
    return {
      kind: 'grass',
      id,
      asset: variant.id,
      translation: new C.Cartesian3(translation.x, translation.y, translation.z),
      scale: new C.Cartesian3(instance.scale.x * width, instance.scale.y * width, instance.scale.z * variant.scale * 0.10 * heightScale),
      rotation: instance.rotation,
      windPhase: instance.windPhase,
      color: new C.Color(color[0], color[1], color[2], 1),
    }
  }

  // Blade-patch/weed species. The upstream sampler's scale is only used as a
  // relative jitter (~0.9-1.1); absolute size comes from the metre-scaled mesh.
  _buildSpeciesInstance(instance, index, id) {
    const C = this.C
    const translation = instance.translation
    const species = pickGrassSpecies(this.species, translation.x, translation.y, index, this.seed)
    this._variantCounts[species.assetId] = (this._variantCounts[species.assetId] || 0) + 1
    const { color, heightScale, widthScale } = grassVariationAt(translation.x, translation.y, index, this.seed, species.variation)
    const nominal = Math.max(1e-6, this.scale)
    const widthJitter = instance.scale.x / (nominal * 5.5)
    const heightJitter = instance.scale.z / (nominal * 5)
    const size = this.sizeScale * species.size
    const width = size * widthScale * widthJitter
    return {
      kind: 'grass',
      id,
      asset: species.assetId,
      translation: new C.Cartesian3(translation.x, translation.y, translation.z),
      scale: new C.Cartesian3(width, width, size * heightScale * heightJitter),
      rotation: instance.rotation,
      windPhase: instance.windPhase,
      color: new C.Color(color[0], color[1], color[2], 1),
    }
  }

  _waitForAssets() {
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); remove(); this._cancelReady = null; error ? reject(error) : resolve() }
      const remove = this.scene.postRender.addEventListener(() => {
        const resources = this.primitive?._resources
        const failed = resources?.gltfAssetRecords.find(asset => asset.record.error)?.record
        if (failed) { finish(failed.error); return }
        if (resources?.gltfRecordsBuilt && resources.pendingTextureCount === 0) finish()
      })
      const timer = setTimeout(() => finish(new Error('cesium-ez-tree grass asset loading timed out')), 90000)
      this._cancelReady = () => finish(new Error('Grass collection destroyed while loading'))
      this.scene.requestRender()
    })
  }

  setVisible(value) {
    if (this.destroyed) return
    this.visible = value === true
    if (this.primitive) this.primitive.show = this.visible
    this.scene.requestRender()
  }

  setMaximumDistance(value) {
    if (this.destroyed || !Number.isFinite(value)) return
    if (this.primitive) this.primitive.maximumGrassDistance = Math.max(1, value)
    this.scene.requestRender()
  }

  getDiagnostics() {
    const p = this.primitive
    const resources = p?._resources
    const submitted = this.visible ? (p?._submittedRecords || []) : []
    const batches = new Map()
    for (const record of submitted) {
      const key = record.lodGroup?.key || `cell:${record.cellX}:${record.cellY}`
      batches.set(key, (batches.get(key) || 0) + record.command.instanceCount)
    }
    let textureBytes = 0
    for (const asset of resources?.gltfAssetRecords || []) {
      for (const image of asset.record.imageRecords) textureBytes += image.texture?.sizeInBytes || 0
    }
    return {
      backend: 'cesium-ez-tree',
      source: 'grass',
      profile: this.profile,
      assetMode: this.assetMode,
      state: this.state,
      visible: this.visible,
      polygons: this._polygons,
      areaHectares: Number(this._areaHectares.toFixed(4)),
      density: this.density,
      heightMode: this.profile === 'lightweight' ? (this._gridSampledPolygons ? 'grid-sampled' : 'polygon-sampled') : 'fixed',
      groundSamples: this._groundSamples,
      gridSampledPolygons: this._gridSampledPolygons,
      groundSampleMs: Math.round(this._groundSampleMs),
      groundSampleSpacing: this.groundSampleSpacing,
      receiveShadows: this.receiveShadows,
      lod: { maximumDistance: this.maximumDistance, nearDistance: this.lodNearDistance, minimumRatio: this.minimumLodRatio },
      height: this.height,
      instances: this._instances,
      grassAssets: this.primitive?.grassAssets?.length || 0,
      sharedColorTextures: resources?.sharedImageRecords?.filter(record => record.texture).length || 0,
      variantCounts: { ...this._variantCounts },
      primitiveCount: p ? 1 : 0,
      batches: resources?.records.length || 0,
      visibleBatches: batches.size,
      submittedDraws: submitted.length,
      submittedInstances: [...batches.values()].reduce((sum, count) => sum + count, 0),
      submittedTriangles: submitted.reduce((sum, record) => sum + record.command.count * record.command.instanceCount / 3, 0),
      geometryResources: resources?.meshResources.length || 0,
      bufferBytes: (resources?.meshGpuMemoryBytes || 0) + (resources?.instanceGpuMemoryBytes || 0),
      textureBytes,
      shadowCastingDraws: (resources?.records || []).filter(record => record.command?.castShadows).length,
      shadowReceivingDraws: (resources?.records || []).filter(record => record.command?.receiveShadows).length,
      groundClamped: false,
      groundFallbacks: this._groundFallbacks,
      error: this.error,
    }
  }

  _releasePrimitive() {
    if (this.primitive) {
      this.scene.primitives.remove(this.primitive)
      this.primitive = null
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.state = 'destroyed'
    this._cancelReady?.()
    this._releasePrimitive()
    this.scene.requestRender()
  }
}

export const createGrassCollection = options => new GrassCollection(options)
export default GrassCollection
