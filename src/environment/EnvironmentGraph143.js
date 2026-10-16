import {installPooledStageCache} from '../pipeline/PooledStageCache143.js'

const stageKeys = {
  'cloud.march':'cloudStage', 'cloud.depth':'cloudDepthStage',
  'atmosphere.raymarch':'raymarchStage', 'atmosphere.transmission':'transmissionStage',
  'environment.composite':'resolveStage', 'environment.medium':'occlusionStage'
}
const lutKeys=['atmosphere.transmittanceLut','atmosphere.multiscatterLut','atmosphere.skyViewLut']
const historyKeys=['cloud.history.colorA','cloud.history.depthA','cloud.history.colorB','cloud.history.depthB']

// Joins the host's existing Graph. Cesium still owns shader compilation and the
// native collection execution; each Graph callback submits the actual stage.
export default class EnvironmentGraph143 {
  constructor(C,scene) {
    Object.assign(this,{C,scene,resources:new Map(),collections:[],hooks:[],pending:new Map(),results:new Map(),providers:{},stages:{}})
  }

  configure({stages=this.stages,...providers}={}) { this.stages=stages;this.setProviders(providers);return this }
  setProviders(providers={}) { Object.assign(this.providers,providers);return this }
  _provider(name) { const value=this.providers[name];return typeof value==='function'?value():value }

  installCollection(collection,entries) {
    if(this.destroyed||this.collections.some(record=>record.collection===collection))return null
    const stages=entries.map(entry=>entry.stage)
    // Function uniforms cannot be inferred by the generic cache. Retain local
    // outputs there; the explicit cross-collection Graph ledger owns releases.
    const cache=installPooledStageCache(this.C,this.scene,collection,stages,'environment',stages.map(stage=>stage.name))
    if(!cache)return null
    const record={collection,entries,cache};this.collections.push(record)
    for(const {key,stage}of entries) {
      const previous=stage.execute,adapter=this
      const hook=function(...args){return adapter.run(key,()=>previous.apply(this,args))}
      stage.execute=hook;this.hooks.push({stage,previous,hook})
      const property=stageKeys[key];if(property)this.stages[property]=stage
    }
    if(this.graph&&!this.graph.activeFrame)this._connectCache(record)
    return cache
  }

  declareGraph(graph) {
    this.offLifecycle?.();this.graph=graph;this.resources.clear()
    const external=name=>{const resource=graph.importResource(name,{keepAlive:true});this.resources.set(name,resource);return resource}
    for(const name of ['environment.input','environment.depth','cloud.temporal',...lutKeys,...historyKeys])external(name)
    for(let index=0;index<2;index++)for(const key of ['transmittance','multipleScattering','skyView'])external(`atmosphere.lut.${index}.${key}`)
    for(const [key,property]of Object.entries(stageKeys)) {
      const stage=this.stages[property],scale=stage?.textureScale??(key==='environment.composite'?1:0.5)
      this.resources.set(key,graph.createResource(key,{
        width:Math.max(1,Math.ceil(this.scene.drawingBufferWidth*scale)),height:Math.max(1,Math.ceil(this.scene.drawingBufferHeight*scale)),
        scale,format:String(stage?.pixelFormat??this.C.PixelFormat?.RGBA??6408),datatype:String(stage?.pixelDatatype??this.C.PixelDatatype?.FLOAT??5126),
        keepAlive:key==='environment.composite'||key==='environment.medium'
      }))
    }
    const base=['environment.input','environment.depth'],cloud=['cloud.march','cloud.depth','cloud.temporal']
    const passes=[
      [lutKeys[0],[]],[lutKeys[1],[lutKeys[0]]],[lutKeys[2],lutKeys.slice(0,2)],
      ['cloud.march',[...base,...lutKeys]],['cloud.depth',[...base,'cloud.march']],
      ['cloud.temporal',['cloud.march','cloud.depth',...historyKeys]],
      ['atmosphere.raymarch',[...base,...cloud,...lutKeys]],
      ['atmosphere.transmission',[...base,...cloud,...lutKeys]],
      ['environment.composite',[...base,'atmosphere.raymarch','atmosphere.transmission']],
      ['environment.medium',[...base,...cloud,...lutKeys]]
    ]
    for(const [name,reads]of passes)graph.addPass(name,builder=>{
      for(const key of reads)builder.read(this.resources.get(key))
      builder.write(this.resources.get(name));builder.sideEffect()
      if(name==='cloud.temporal')for(const key of historyKeys)builder.write(this.resources.get(key))
    },()=>this.pending.get(name)?.(),{phase:'environment'})
    this.offLifecycle=graph.registerPassLifecycle(lutKeys[0],{
      begin:()=>{this.pending.clear();this.results.clear();this._bindPersistent()},
      end:()=>{this.pending.clear();for(const {cache}of this.collections){cache.end();cache.releaseFrame()}}
    })
    for(const record of this.collections)this._connectCache(record)
    return this.resources
  }

  _connectCache({cache,entries}) {
    cache.graph=this.graph;cache.inputGraphResource=this.resources.get('environment.input')
    cache.nodeGraphResources.clear();cache.graphResources.clear()
    for(let index=0;index<entries.length;index++) {
      const node=cache.nodes[index],resource=this.resources.get(entries[index].key)
      if(resource){cache.nodeGraphResources.set(node,resource);cache.graphResources.set(node.slot,resource)}
    }
  }

  bind(name,value) { const resource=this.resources.get(name);if(resource?.kind==='external')this.graph.bindExternal(resource,value);return value }
  _bindPersistent() {
    const temporal=this._provider('cloudTemporal'),targets=temporal?.targets||[]
    for(let index=0;index<2;index++)for(const key of ['color','depth'])this.bind(`cloud.history.${key}${index?'B':'A'}`,targets[index]?.[key])
    const lut=this._provider('atmosphereLut'),textures=lut?.getTextures?.()||{}
    this.bind(lutKeys[0],textures.transmittance)
    this.bind(lutKeys[1],textures.multipleScattering)
    this.bind(lutKeys[2],textures.skyView)
    for(let index=0;index<2;index++)for(const key of ['transmittance','multipleScattering','skyView'])this.bind(`atmosphere.lut.${index}.${key}`,lut?.targets?.[index]?.[key]?.texture)
  }
  bindFrame({color,depth,cloudOutput}={}) {
    this.bind('environment.input',color);this.bind('environment.depth',depth);this.bind('cloud.temporal',cloudOutput)
    this._bindPersistent()
  }
  beginFrame(bindings) { this.bindFrame(bindings);for(const {cache}of this.collections)cache.begin(bindings?.color) }
  endFrame() { this.pending.clear();for(const {cache}of this.collections)cache.end() }

  run(name,invoke) {
    if(this.destroyed||!this.graph?.activeFrame||!this.graph.passes.some(pass=>pass.name===name))return invoke()
    if(this.graph.activeFrame.executed.has(name))return this.results.get(name)
    this._bindPersistent()
    const lutName={ [lutKeys[0]]:'transmittance',[lutKeys[1]]:'multipleScattering',[lutKeys[2]]:'skyView' }[name]
    if(lutName)this.bind(name,this._provider('atmosphereLut')?.commands?.[lutName]?.framebuffer?.getColorTexture(0))
    this.pending.set(name,()=>{const result=invoke();this.results.set(name,result);return result})
    try {
      if(!this.graph.executePass(name))return invoke()
      if(name==='cloud.temporal'){this.bind(name,this.results.get(name));this._bindPersistent()}
      return this.results.get(name)
    } finally {this.pending.delete(name);this.graph.completePass(name)}
  }

  getDiagnostics() {return {registered:!!this.graph,transientActive:!!this.collections.length&&!!this.graph?.activeFrame&&!!this.graph.transientAllocator,
    collections:this.collections.length,passes:[...(this.graph?.activeFrame?.executed||[])].filter(name=>this.resources.has(name)),
    scope:'Shared Graph owns temporary targets; cloud history and atmosphere LUTs remain external'}}

  destroy() {
    if(this.destroyed)return
    this.endFrame();this.offLifecycle?.();this.offLifecycle=null
    for(const {stage,previous,hook}of this.hooks.reverse())if(stage.execute===hook)stage.execute=previous
    for(const {cache}of this.collections)cache.destroy()
    this.hooks=[];this.collections=[];this.resources.clear();this.graph=null;this.destroyed=true
  }
}
