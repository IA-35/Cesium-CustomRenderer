import { validateFixedTreePoints, stableTreeVariation } from './fixedTreeData.js'
import { resolveTreePreset, seedPool, fnv1a } from './treePresets.js'
import getEzTreeRuntime from '../../vendor/cesium-ez-tree/runtime.js'

const fetchJson = async url => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Tree resource request failed (${response.status}): ${url}`)
  return response.json()
}

// Crown density. `Pine Medium` ships 82 first-level children and 30 leaf cards at size 1.435; the
// previous build cut these to 38/44/30 branches and 14 oversized cards, which is what made the
// stand read as sparse sticks. Children and leaf count are restored to the upstream density while
// the per-branch ring counts above stay reduced.
const CROWN_BRANCH_CHILDREN = 82
const CROWN_LEAF_COUNT = 30
const CROWN_LEAF_SIZE = 1.435

// Per-variant jitter. Distinct seeds already change the topology, but two seeds can still land on
// similar silhouettes; nudging the branch and leaf parameters apart by a hash of (prototype,
// variant) guarantees the derived trees are visibly different.
function applyVariantJitter(preset, prototypeId, variant) {
  if (variant === 0) return
  const mix = (salt, min, max) => {
    const value = (fnv1a(`${prototypeId}:${variant}:${salt}`) / 0xffffffff)
    return min + value * (max - min)
  }
  // Every field is guarded: a preset (or a test double) may omit a level entirely.
  if (preset.branch) {
    if (Number.isFinite(preset.branch.length?.[1])) {
      preset.branch.length[1] *= mix('len', 0.82, 1.18)
    }
    if (Number.isFinite(preset.branch.angle?.[1])) {
      preset.branch.angle[1] *= mix('angle', 0.88, 1.12)
    }
    if (Number.isFinite(preset.branch.gnarliness?.[0])) {
      preset.branch.gnarliness[0] = mix('gnarl', 0.02, 0.12)
    }
  }
  if (preset.leaves) {
    if (Number.isFinite(preset.leaves.count)) {
      preset.leaves.count = Math.round(preset.leaves.count * mix('leaf', 0.85, 1.15))
    }
    if (Number.isFinite(preset.leaves.size)) {
      preset.leaves.size *= mix('size', 0.9, 1.1)
    }
  }
}

// Variant choice by point id. Neighbouring points hash to different variants rather than cycling
// in sequence, so a row of trees does not repeat on a fixed period.
function pickVariant(pointId, count) {
  return count > 1 ? fnv1a(`variant:${pointId}`) % count : 0
}

// Species-specific shape. Length/start control where the second level begins and how far it
// reaches; crownScale and heightScale come from the species table.
function applySpeciesShape(preset, asset, resolved) {
  const branch = preset.branch, leaves = preset.leaves
  if (!branch) return
  switch (resolved.form) {
    // Columnar conifer: short, high-set second level so the silhouette stays narrow and tall.
    case 'columnar':
      branch.length[1] = 13
      branch.start[1] = 0.08
      branch.children[0] = 68
      if (leaves) leaves.count = 26
      break
    // Spreading conifer: long second level reaching down the trunk for a wide crown.
    case 'spreading':
      branch.length[1] = 29
      branch.start[1] = 0.22
      if (leaves) leaves.count = 30
      break
    // Broadleaf: shorter trunk, second level starting low, rounder crown via the deciduous preset.
    case 'rounded':
      branch.length[0] = 30
      branch.length[1] = 17
      branch.start[1] = 0.18
      branch.children[0] = 60
      if (leaves) leaves.count = 28
      break
    default:
      break
  }
}

// Business adapter only. Geometry, textures, packed attributes, GPU commands,
// culling and resource scheduling are owned by the pinned cesium-ez-tree runtime.
export class FixedTreeCollection {
  constructor(options) {
    if (!options?.Cesium || !options?.viewer?.scene || !options.manifestUrl) throw new Error('FixedTreeCollection requires Cesium, viewer and manifestUrl')
    this.C = options.Cesium
    this.viewer = options.viewer
    this.scene = options.viewer.scene
    this.manifestUrl = new URL(options.manifestUrl, typeof document !== 'undefined' ? document.baseURI : undefined).href
    this.fetchJson = options.fetchJson || fetchJson
    this.cellSize = options.cellSize ?? 80
    this.source = options.source === 'glb' ? 'glb' : 'procedural'
    this.scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1
    this.heightOffset = options.heightOffset ?? 0
    this.clampToGround = options.clampToGround !== false
    this.objectsToExclude = options.objectsToExclude || []
    this.visible = options.show !== false
    this.destroyed = false
    this.state = 'loading'
    this.error = null
    this._points = []
    this._prototypeCount = 0
    this._groundClamped = false
    this._groundFallbacks = 0
    this.primitive = null
    this._runtime = options.ezTreeRuntime || getEzTreeRuntime(this.C)
    this.readyPromise = this._load()
  }
  async _placePoints(data, typeMap) {
    const C = this.C
    const result = validateFixedTreePoints(data, typeMap)
    const origin = C.Cartesian3.fromDegrees(result.origin.longitude, result.origin.latitude, 0)
    this._modelMatrix = C.Transforms.eastNorthUpToFixedFrame(origin)
    if (!this.clampToGround) {
      result.points.forEach(point => { point.up = this.heightOffset })
      return result.points
    }
    if (typeof this.scene.clampToHeightMostDetailed !== 'function') throw new Error('Scene ground clamping is not supported')
    const source = result.points.map(point => C.Cartesian3.fromDegrees(point.geographicPosition[0], point.geographicPosition[1], 0))
    let clamped
    try { clamped = await this.scene.clampToHeightMostDetailed(source, this.objectsToExclude) } catch { clamped = null }
    if (this.destroyed) throw new Error('FixedTreeCollection was destroyed during ground clamping')
    if (!Array.isArray(clamped) || clamped.length !== result.points.length) {
      this._groundFallbacks = result.points.length
      throw new Error('Tree ground clamping failed; no zero-height fallback is rendered')
    }
    const inverse = C.Matrix4.inverseTransformation(this._modelMatrix, new C.Matrix4())
    const local = new C.Cartesian3()
    this._groundFallbacks = 0
    result.points.forEach((point, index) => {
      if (!clamped[index]) { this._groundFallbacks++; return }
      C.Matrix4.multiplyByPoint(inverse, clamped[index], local)
      point.east = local.x; point.north = local.y; point.up = local.z + this.heightOffset
    })
    if (this._groundFallbacks) throw new Error(`${this._groundFallbacks} tree positions have no ground height`)
    this._groundClamped = true
    return result.points
  }


  // Presets the pinned runtime actually bundles. `loadPreset` silently returns default options
  // for an unknown name, so a typo or a generator-repository-only preset would render as a
  // shapeless default tree instead of failing. Resolving against this list turns that into a
  // deliberate substitution recorded in `_presetReport`.
  _bundledPresets() {
    if (!this._bundledPresetCache) {
      const candidates = ['Pine Medium', 'Oak Medium', 'Aspen Medium', 'Ash Medium']
      this._bundledPresetCache = candidates.filter(name => {
        const probe = this._runtime.EzTreePrimitive.loadPreset(name)
        // A bundled preset carries a real branch table; the default fallback does not.
        return !!(probe && probe.branch && Number.isFinite(probe.branch.children?.[0]))
      })
    }
    return this._bundledPresetCache
  }

  /** Number of named variants derived for one prototype (recorded during preset construction). */
  _variantCount(prototypeId) {
    if (!this._variantCounts) this._variantCounts = new Map()
    return this._variantCounts.get(prototypeId) ?? 0
  }

  async _load() {
    try {
      const manifest = await this.fetchJson(this.manifestUrl)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.prototypes)) throw new Error('Invalid vegetation manifest')
      const assets = manifest.prototypes.map(p => {
        if ((this.source==='glb' && !p.url) || !Number.isFinite(p.height) || p.height <= 0) throw new Error(`Invalid tree prototype: ${p.id}`)
        // Carry the authored species/form/preset through: they drive the procedural shape choice
        // and were previously dropped here, which forced every prototype onto one preset.
        return {id:p.id, height:p.height, url:p.url ? new URL(p.url,this.manifestUrl).href : undefined,
          species:p.species, form:p.form, generatorPreset:p.generatorPreset}
      })
      const data = await this.fetchJson(new URL(manifest.points,this.manifestUrl).href)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      if (manifest.pointCount !== data.objects?.length) throw new Error('Vegetation pointCount mismatch')
      this._points = await this._placePoints(data,manifest.typeMap)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      this._prototypeCount = assets.length
      const byId = new Map(assets.map(p=>[p.id,p]))
      // The runtime groups instances by `instance.preset` *name* and looks the configuration up in
      // `treePresets` (EzTreePrimitive.js:1133, 1644-1645). A single name per prototype therefore
      // yields a single topology for every point; deriving several named variants per prototype is
      // what actually removes the repetition, because the seed only enters the generator once per
      // group.
      const presets = {}
      this._presetReport = []
      this._variantCounts = new Map()
      for (const [index, asset] of assets.entries()) {
        const resolved = resolveTreePreset(asset, this._bundledPresets())
        const seeds = seedPool(asset.id)
        this._variantCounts.set(asset.id, seeds.length)
        for (let variant = 0; variant < seeds.length; variant++) {
          const name = variant === 0 ? asset.id : `${asset.id}~${variant}`
          const preset = this._runtime.EzTreePrimitive.loadPreset(resolved.preset)
          preset.seed = seeds[variant]
          // Shape overrides are applied only to the tables the preset actually carries. A test
          // double or an unknown preset name may omit them, and loadPreset returns default options
          // rather than failing for a name it does not bundle.
          if (preset.branch) {
            preset.branch.children[0] = CROWN_BRANCH_CHILDREN
            // Tessellation stays reduced: the crown silhouette is what the stand reads at
            // distance, and the per-branch ring counts cost triangles without changing it.
            preset.branch.sections[0] = 9; preset.branch.sections[1] = 4
            preset.branch.segments[0] = 7; preset.branch.segments[1] = 4
          }
          // Crown density is restored to the upstream values. The previous build halved the leaf
          // count and doubled the leaf size to hold coverage, which produced sparse oversized cards
          // rather than foliage.
          if (preset.leaves) {
            preset.leaves.count = CROWN_LEAF_COUNT
            preset.leaves.size = preset.leaves.size || CROWN_LEAF_SIZE
          }
          // Per-variant jitter keeps the derived trees from reading as scaled copies of each other.
          applyVariantJitter(preset, asset.id, variant)
          if (this.source === 'procedural') {
            if (preset.branch) preset.branch.length[0] = 48
            applySpeciesShape(preset, asset, resolved)
          }
          presets[name] = preset
        }
        this._presetReport.push({ id: asset.id, species: asset.species || null,
          preset: resolved.preset, authored: resolved.usedAuthoredPreset,
          form: resolved.form, approximate: resolved.approximate, variants: seeds.length })
      }
      const instances = this._points.map(p=>{
        const asset = byId.get(p.prototypeId)
        if (!asset) throw new Error(`Unknown tree asset: ${p.prototypeId}`)
        const variation = stableTreeVariation(p.id)
        const baseScale = this.scale * (this.source === 'glb' ? 1 : asset.height / 50)
        // Pick one of the prototype's named variants by this point's own id, so neighbouring trees
        // differ instead of cycling three literals.
        const variant = pickVariant(p.id, this._variantCount(asset.id))
        const presetName = variant === 0 ? p.prototypeId : `${p.prototypeId}~${variant}`
        return {id:p.id,kind:this.source === 'glb' ? 'externalTree' : 'tree',asset:p.prototypeId,preset:presetName,
          translation:new this.C.Cartesian3(p.east,p.north,p.up),
          scale:new this.C.Cartesian3(baseScale * variation.crownScale,baseScale * variation.crownScale,baseScale * variation.heightScale),
          heading:variation.heading,radius:asset.height * this.scale}
      })
      this._runtime.configureEzTree({useWorkers:false,assetBaseUrl:new URL('./eztree/',this.manifestUrl).href})
      this.primitive = new this._runtime.EzTreePrimitive({
        modelMatrix:this._modelMatrix,instances,treeAssets:this.source === 'glb' ? assets : [],treePresets:presets,show:this.visible,
        maximumTreeBranchDistance:Infinity,maximumTreeLeafDistance:Infinity,
        treeBranchMinimumLodRatio:1,treeLeafMinimumLodRatio:1,
        lodCellSize:this.cellSize,cullingTileSize:320,windStrength:0,windFrequency:0,
        castShadows:true,workerPacking:false,maximumCommandBuildsPerFrame:8,
        maximumUploadBytesPerFrame:512*1024,statisticsUpdateInterval:30
      })
      this.scene.primitives.add(this.primitive)
      await this._waitForAssets()
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      this.state = 'ready'
      this.scene.requestRender()
      return this
    } catch (error) {
      if (!this.destroyed) { this.state='error'; this.error=error.message; this._releasePrimitive() }
      throw error
    }
  }

  _waitForAssets() {
    return new Promise((resolve,reject)=>{
      const finish = error => { clearTimeout(timer); remove(); this._cancelReady=null; error ? reject(error) : resolve() }
      const remove = this.scene.postRender.addEventListener(()=>{
        const resources=this.primitive?._resources
        const failed=resources?.gltfAssetRecords.find(a=>a.record.error)?.record || [...(resources?.barkTextureRecords.values()||[])].find(a=>a.error)
        if(failed){finish(failed.error);return}
        if(resources?.gltfRecordsBuilt && resources.pendingTextureCount===0) finish()
      })
      const timer=setTimeout(()=>finish(new Error('cesium-ez-tree asset loading timed out')),90000)
      this._cancelReady=()=>finish(new Error('Tree collection destroyed while loading'))
      this.scene.requestRender()
    })
  }

  setVisible(value) {
    if(this.destroyed)return
    this.visible=value===true
    if(this.primitive)this.primitive.show=this.visible
    this.scene.requestRender()
  }

  getDiagnostics() {
    const p=this.primitive,resources=p?._resources,groups=[...(p?._externalLodGroups.values()||[])],lodBatches=[0,0,0,0]
    for(const g of groups)lodBatches[g.currentLod]++
    const submitted=this.visible?(p?._submittedRecords||[]):[]
    const drawnGroups=new Map(submitted.filter(r=>r.cutoutType>0 || r.lodGroup).map(r=>[r.lodGroup?.key||`${r.cellX}:${r.cellY}:${resources.meshResources.indexOf(r.meshResource)}`,r.instanceCount]))
    const totalBatches = this.source === 'glb' ? groups.length : (resources?.records.length||0)/2
    if(this.source==='procedural')lodBatches[0]=totalBatches
    let textureBytes=0
    for(const asset of resources?.gltfAssetRecords||[])for(const image of asset.record.imageRecords)textureBytes+=image.texture?.sizeInBytes||0
    for(const record of resources?.barkTextureRecords?.values()||[])textureBytes+=record.texture?.sizeInBytes||0
    return {backend:'cesium-ez-tree',source:this.source,state:this.state,visible:this.visible,instances:this._points.length,
      prototypes:this._prototypeCount,batches:totalBatches,primitiveCount:p?1:0,modelCount:0,
      visibleBatches:drawnGroups.size,lodBatches,submittedDraws:submitted.length,
      submittedInstances:[...drawnGroups.values()].reduce((n,count)=>n+count,0),
      submittedTriangles:submitted.reduce((n,r)=>n+r.command.count*r.command.instanceCount/3,0),
      geometryResources:resources?.meshResources.length||0,
      bufferBytes:(resources?.meshGpuMemoryBytes||0)+(resources?.instanceGpuMemoryBytes||0),textureBytes,
      groundClamped:this._groundClamped,groundFallbacks:this._groundFallbacks,error:this.error}
  }

  _releasePrimitive() {
    if(this.primitive){this.scene.primitives.remove(this.primitive);this.primitive=null}
  }

  destroy() {
    if(this.destroyed)return
    this.destroyed=true;this.state='destroyed'
    this._cancelReady?.();this._releasePrimitive();this.scene.requestRender()
  }
}
export const createFixedTreeCollection = options => new FixedTreeCollection(options)
export default FixedTreeCollection
