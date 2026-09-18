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
  const ezTreeRuntime = {configureEzTree(){}, EzTreePrimitive: class {static loadPreset(){return {branch:{children:{},sections:{},segments:{}},leaves:{}}}constructor(options){Object.assign(this,options);this._instances=options.instances;this._externalLodGroups=new Map();this._resources={pendingTextureCount:0,gltfRecordsBuilt:true,cachedCommandCount:1,gltfAssetRecords:[],barkTextureRecords:new Map(),meshResources:[],records:[]};models.push(this)}destroy(){this.dead=true}}}
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


async function load(h, resources, manifestUrl) {
  const collection=createFixedTreeCollection({Cesium:h.Cesium,viewer:h.viewer,manifestUrl,
    ezTreeRuntime:h.ezTreeRuntime,clampToGround:false,fetchJson:async url=>structuredClone(resources.get(url))})
  await new Promise(resolve=>setTimeout(resolve,0))
  h.listeners.slice().forEach(f=>f())
  await collection.readyPromise
  return collection
}
test('uses one upstream primitive for all fixed points with ENU transforms', async()=>{
  const {manifestUrl,resources}=fixture(),h=harness(),t=await load(h,resources,manifestUrl)
  assert.equal(h.models.length,1)
  assert.equal(h.models[0]._instances.length,2)
  assert.equal(h.models[0]._instances[1].translation.x,20)
  assert.equal(h.models[0].treeAssets.length,0)
  assert.equal(h.models[0]._instances[0].kind,'tree')
  assert.equal(h.models[0].treeBranchMinimumLodRatio,1)
  assert.equal(h.models[0].treeLeafMinimumLodRatio,1)
  assert.equal(t.getDiagnostics().backend,'cesium-ez-tree')
  assert.equal(t.getDiagnostics().modelCount,0)
  assert.equal(h.listeners.length,0)
  t.destroy()
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
