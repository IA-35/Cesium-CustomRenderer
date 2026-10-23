import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixedTreeCollection } from '../../src/instances/FixedTreeCollection.js'

function fixture() {
  const manifestUrl = 'https://example.test/vegetation/manifest.json'
  const manifest = {
    schemaVersion: 1, points: 'points.json', pointCount: 2,
    typeMap: { 松柏: 'pine' }, prototypes: [{ id: 'pine', height: 8, url:'pine/tree.glb', lods: [0, 1, 2, 3].map(level => ({ level, url: `pine/lod${level}.gltf` })) }]
  }
  const points = {
    coordinateSystem: { origin: { longitude: 123, latitude: 41 }, geographicPositionOrder: ['longitude', 'latitude'] },
    summary: { objectCount: 2 },
    objects: [
      { type: '松柏', object: 'a', relativePosition: [0, 0], geographicPosition: [123, 41] },
      { type: '松柏', object: 'b', relativePosition: [20, 0], geographicPosition: [123.001, 41] }
    ]
  }
  const prototype = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [1] }], nodes: [{ mesh: 0 }, { children: [0] }],
    buffers: [{ uri: 'model.bin', byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }]
  }
  const resources = new Map([[manifestUrl, manifest], ['https://example.test/vegetation/points.json', points]])
  for (let lod = 0; lod < 4; lod++) resources.set(`https://example.test/vegetation/pine/lod${lod}.gltf`, prototype)
  return { manifestUrl, resources }
}

function harness() {
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
    static fromDegrees(longitude, latitude, height = 0) { return new Cartesian3(longitude, latitude, height) }
    static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }
  }
  class Matrix4 {
    static inverseTransformation(value) { return value }
    static multiplyByPoint(_matrix, point, result) { Object.assign(result, point); return result }
  }
  const models = []; const removed = []; const listeners = []; let requests = 0
  const ezTreeRuntime = {configureEzTree(){}, EzTreePrimitive: class {static loadPreset(){return {branch:{children:{},length:{},start:{},sections:{},segments:{}},leaves:{}}}constructor(options){Object.assign(this,options);this._instances=options.instances;this._externalLodGroups=new Map();this._resources={pendingTextureCount:0,gltfRecordsBuilt:true,cachedCommandCount:1,gltfAssetRecords:[],barkTextureRecords:new Map(),meshResources:[],records:[]};models.push(this)}destroy(){this.dead=true}}}
  const Cesium = {
    Cartesian3, Matrix4, ShadowMode: { ENABLED: 3 },
    Transforms: { eastNorthUpToFixedFrame(origin) { return { origin } } },
    Model: { async fromGltfAsync(options) { const model = { ...options, show: true, destroyed: false, destroy() { this.destroyed = true } }; models.push(model); return model } }
  }
  const scene = {
    camera: { positionWC: new Cartesian3(0, 0, 100), frustum: { fovy: Math.PI / 3 } }, drawingBufferHeight: 1080,
    primitives: { add(model) { return model }, remove(model) { removed.push(model); model.destroy(); return true } },
    postRender: { addEventListener(listener) { listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) } } },
    requestRender() { requests++ }
  }
  return { ezTreeRuntime, Cesium, viewer: { scene }, scene, models, removed, listeners, requests: () => requests }
}


async function load(h, resources, manifestUrl, options = {}) {
  const collection=createFixedTreeCollection({Cesium:h.Cesium,viewer:h.viewer,manifestUrl,
    ezTreeRuntime:h.ezTreeRuntime,clampToGround:false,fetchJson:async url=>structuredClone(resources.get(url)),...options})
  await new Promise(resolve=>setTimeout(resolve,0))
  h.listeners.slice().forEach(f=>f())
  await collection.readyPromise
  return collection
}
test('uses the configured fixed height without sampling the scene', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness()
  h.scene.clampToHeightMostDetailed=async()=>{throw new Error('must not sample scene height')}
  const t=await load(h,resources,manifestUrl,{heightOffset:2})
  assert.deepEqual(h.models[0]._instances.map(instance=>instance.translation.z),[2,2])
  assert.equal(t.getDiagnostics().groundClamped,false)
  t.destroy()
})

test('scales fixed GLB trees and their culling radius', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness(),baselineHarness=harness()
  const baseline=await load(baselineHarness,resources,manifestUrl,{source:'glb'})
  const t=await load(h,resources,manifestUrl,{source:'glb',scale:1.6})
  const instance=h.models[0]._instances[0]
  assert.equal(instance.kind,'externalTree')
  assert.equal(h.models[0].castShadows,false)
  assert.equal(instance.scale.x / baselineHarness.models[0]._instances[0].scale.x,1.6)
  assert.equal(instance.radius,12.8)
  baseline.destroy()
  t.destroy()
})

test('uses each point type to choose a distinct procedural tree form', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness()
  const manifest=resources.get(manifestUrl)
  manifest.pointCount=3
  manifest.typeMap={松柏:'cypress',松树:'pine',松树01:'pine-small'}
  manifest.prototypes=[
    {id:'pine',height:10.5,species:'松树',form:'spreading'},
    {id:'cypress',height:9.5,species:'松柏',form:'columnar'},
    {id:'pine-small',height:8.5,species:'松树01',form:'rounded'}
  ]
  const points=resources.get('https://example.test/vegetation/points.json')
  points.summary.objectCount=3
  points.objects=[
    {type:'松柏',object:'c',relativePosition:[0,0],geographicPosition:[123,41]},
    {type:'松树',object:'p',relativePosition:[20,0],geographicPosition:[123.001,41]},
    {type:'松树01',object:'s',relativePosition:[40,0],geographicPosition:[123.002,41]}
  ]
  const t=await load(h,resources,manifestUrl,{source:'procedural'})
  const primitive=h.models[0]
  // Each point still resolves to its own prototype; the name now carries a derived variant index
  // ("pine~2") because the runtime groups by preset *name*, so several named variants are needed
  // for a stand not to repeat one silhouette. The prototype prefix is what identifies the species.
  const presetOf = index => primitive._instances[index].preset
  assert.deepEqual(primitive._instances.map(instance=>instance.preset.split('~')[0]),
    ['cypress','pine','pine-small'])
  for (const name of ['cypress','pine','pine-small']) {
    assert.ok(primitive.treePresets[name], `${name} must have a base variant`)
    const derived = Object.keys(primitive.treePresets).filter(key=>key.startsWith(`${name}~`))
    assert.ok(derived.length >= 8, `${name} must derive several variants, got ${derived.length}`)
    // Derived variants must differ in topology, not merely repeat the base configuration.
    const seeds = new Set([name,...derived].map(key=>primitive.treePresets[key].seed))
    assert.equal(seeds.size, 1 + derived.length, `${name} variants must have distinct seeds`)
  }
  // Base variants carry the authored species form: columnar (松柏), spreading (松树) and rounded
  // (松树01). These are the shape values applySpeciesShape writes for each form.
  assert.equal(primitive.treePresets.cypress.branch.length[1],13)
  assert.equal(primitive.treePresets.pine.branch.length[1],29)
  assert.equal(primitive.treePresets['pine-small'].branch.length[1],17)
  t.destroy()
})
test('uses one upstream primitive for all fixed points with ENU transforms', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness(),t=await load(h,resources,manifestUrl)
  assert.equal(h.models.length,1)
  assert.equal(h.models[0]._instances.length,2)
  assert.equal(h.models[0]._instances[1].translation.x,20)
  assert.equal(h.models[0].treeAssets.length,0)
  assert.equal(h.models[0]._instances[0].kind,'tree')
  assert.equal(h.models[0].castShadows,false)
  assert.equal(h.models[0].maximumTreeBranchDistance,6000)
  assert.equal(h.models[0].maximumTreeLeafDistance,4000)
  assert.equal(h.models[0].treeBranchMinimumLodRatio,0.35)
  assert.equal(h.models[0].treeLeafMinimumLodRatio,0.2)
  assert.equal(t.getDiagnostics().backend,'cesium-ez-tree')
  assert.equal(t.getDiagnostics().modelCount,0)
  assert.equal(h.listeners.length,0)
  t.destroy()
})
test('forwards finite campus tree distances and density settings', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness()
  const t=await load(h,resources,manifestUrl,{source:'glb',maximumTreeLeafDistance:1500,maximumTreeBranchDistance:2000,
    treeLeafLodNearDistance:600,treeBranchLodNearDistance:800,treeLeafMinimumLodRatio:0.35,treeBranchMinimumLodRatio:0.5})
  const p=h.models[0]
  assert.equal(p.maximumTreeLeafDistance,1500)
  assert.equal(p.maximumTreeBranchDistance,2000)
  assert.equal(p.treeLeafLodNearDistance,600)
  assert.equal(p.treeBranchLodNearDistance,800)
  assert.equal(p.treeLeafMinimumLodRatio,0.35)
  assert.equal(p.treeBranchMinimumLodRatio,0.5)
  t.destroy()
})

test('cellSize controls the spatial batching grid and defaults to 80 metres', async()=>{
  const {manifestUrl,resources}=fixture()
  const def=harness(),wide=harness(),invalid=harness()
  const a=await load(def,resources,manifestUrl)
  const b=await load(wide,resources,manifestUrl,{cellSize:320})
  // Non-finite and non-positive values must fall back instead of silently collapsing the grid.
  const c=await load(invalid,resources,manifestUrl,{cellSize:0})
  // The runtime emits one draw command per (glTF primitive × cell), so this value is the batch
  // grid it splits the point cloud with — not a cosmetic culling hint.
  assert.equal(def.models[0].lodCellSize,80)
  assert.equal(wide.models[0].lodCellSize,320)
  assert.equal(invalid.models[0].lodCellSize,80)
  a.destroy();b.destroy();c.destroy()
})
test('show and destroy operate on the upstream primitive and detach readiness', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness(),t=await load(h,resources,manifestUrl)
  t.setVisible(false);assert.equal(h.models[0].show,false)
  t.setVisible(true);assert.equal(h.models[0].show,true)
  t.destroy();t.destroy();assert.equal(h.removed.length,1);assert.equal(h.models[0].dead,true)
})
test('destroy during loading rejects and cannot resurrect a primitive', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness();let release
  const t=createFixedTreeCollection({Cesium:h.Cesium,viewer:h.viewer,manifestUrl,ezTreeRuntime:h.ezTreeRuntime,
    fetchJson:()=>new Promise(resolve=>{release=resolve})})
  t.destroy();release(resources.get(manifestUrl))
  // destroy should be checked after every async boundary, before requesting points.
  await assert.rejects(t.readyPromise,/destroyed/i)
  assert.equal(h.models.length,0)
})
test('clamp failure reports an error instead of claiming ground placement', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness()
  h.scene.clampToHeightMostDetailed=async()=>[undefined,undefined]
  const t=createFixedTreeCollection({Cesium:h.Cesium,viewer:h.viewer,manifestUrl,ezTreeRuntime:h.ezTreeRuntime,
    fetchJson:async url=>structuredClone(resources.get(url))})
  await assert.rejects(t.readyPromise,/ground height/)
  assert.equal(t.getDiagnostics().state,'error');assert.equal(h.models.length,0)
})
