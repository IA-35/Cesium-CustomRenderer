import { validateFixedTreePoints, stableTreeVariation } from './fixedTreeData.js'
import getEzTreeRuntime from '../../vendor/cesium-ez-tree/runtime.js'

const fetchJson = async url => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Tree resource request failed (${response.status}): ${url}`)
  return response.json()
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
    if (!this.clampToGround) return result.points
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


  async _load() {
    try {
      const manifest = await this.fetchJson(this.manifestUrl)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.prototypes)) throw new Error('Invalid vegetation manifest')
      const assets = manifest.prototypes.map(p => {
        if ((this.source==='glb' && !p.url) || !Number.isFinite(p.height) || p.height <= 0) throw new Error(`Invalid tree prototype: ${p.id}`)
        return {id:p.id, height:p.height, url:p.url ? new URL(p.url,this.manifestUrl).href : undefined}
      })
      const data = await this.fetchJson(new URL(manifest.points,this.manifestUrl).href)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      if (manifest.pointCount !== data.objects?.length) throw new Error('Vegetation pointCount mismatch')
      this._points = await this._placePoints(data,manifest.typeMap)
      if (this.destroyed) throw new Error('Tree collection destroyed while loading')
      this._prototypeCount = assets.length
      const byId = new Map(assets.map(p=>[p.id,p]))
      const presets = {}
      for (const [index, asset] of assets.entries()) {
        const preset = this._runtime.EzTreePrimitive.loadPreset('Pine Medium')
        preset.seed = [13977, 24831, 38617][index % 3]
        preset.branch.children[0] = [38, 44, 30][index % 3]
        preset.branch.sections[0] = 9; preset.branch.sections[1] = 4
        preset.branch.segments[0] = 7; preset.branch.segments[1] = 4
        preset.leaves.count = 14
        // Keep canopy coverage while reducing tessellation and leaf-card count.
        preset.leaves.size = 2.8
        preset.leaves.tint = [0x467a35, 0x3b702f, 0x578743][index % 3]
        presets[asset.id] = preset
      }
      const instances = this._points.map(p=>{
        const asset = byId.get(p.prototypeId)
        if (!asset) throw new Error(`Unknown tree asset: ${p.prototypeId}`)
        const variation = stableTreeVariation(p.id)
        return {id:p.id,kind:this.source === 'glb' ? 'externalTree' : 'tree',asset:p.prototypeId,preset:p.prototypeId,
          translation:new this.C.Cartesian3(p.east,p.north,p.up),
          scale:variation.scale * (this.source === 'glb' ? 1 : asset.height / 50),heading:variation.heading,radius:asset.height}
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
