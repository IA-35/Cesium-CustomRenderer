import {getRenderTargetPool} from './RenderTargetPool143.js'

// Adapter only for CCR's independent AO/Bloom collections. Cesium continues to
// compile shaders, bind uniforms and execute PostProcessStage commands.
export function installPooledStageCache(C,scene,collection,stages,kind,retained=[]){
  if(!collection._textureCache)return null // lightweight CPU test engines
  const previous=collection._textureCache,cache=new PooledStageCache143(C,scene,collection,stages,kind,retained)
  collection._textureCache=cache
  const assign=stage=>{
    if(!stage)return
    if(typeof stage.length==='number')for(let i=0;i<stage.length;i++)assign(stage.get(i))
    else stage._textureCache=cache
  }
  for(const stage of stages)assign(stage)
  for(const key of ['_fxaa','_ao','_bloom','_tonemapping'])assign(collection[key])
  previous.destroy()
  return cache
}

export default class PooledStageCache143 {
  constructor(C,scene,collection,stages,kind,retained){
    Object.assign(this,{C,scene,collection,stages,kind,owner:{kind},slots:[],nodes:[],nameToNode:new Map(),retained:new Set(retained),hooks:[],graph:null,graphResources:new Map(),nodeGraphResources:new Map()})
    this.pool=getRenderTargetPool(C,scene.context);this.pool.attach(this.owner)
    // First build the complete resource ledger, before allocating GPU targets.
    const names=new Set(stages.map(stage=>stage.name))
    this.nodes=stages.map((stage,index)=>({stage,index,name:stage.name,first:index,last:index,
      reads:Object.values(stage.uniforms||{}).filter(v=>typeof v==='string'&&names.has(v)),
      scale:stage.textureScale,pixelFormat:stage.pixelFormat,pixelDatatype:stage.pixelDatatype,samples:1}))
    for(const node of this.nodes)this.nameToNode.set(node.name,node)
    for(const node of this.nodes)for(const name of node.reads)this.nameToNode.get(name).last=Math.max(this.nameToNode.get(name).last,node.index)
    for(const node of this.nodes)if(this.retained.has(node.name)||node.index===stages.length-1)node.last=Infinity
    for(const node of this.nodes){
      const key=[node.scale,node.pixelFormat,node.pixelDatatype].join(':')
      let slot=this.slots.find(slot=>slot.key===key&&slot.last<node.first)
      if(!slot){slot={key,last:node.last,nodes:[]};this.slots.push(slot)}
      slot.last=node.last;slot.nodes.push(node);node.slot=slot
      const previous=node.stage.execute,cache=this
      const hook=function(...args){
        cache.pool.assertWritable(node.slot.lease,[args[1],...node.reads.map(name=>cache.getOutputTexture(name))].filter(Boolean))
        try{return previous.apply(this,args)}finally{cache.finishStage(node.index)}
      }
      node.stage.execute=hook;this.hooks.push({stage:node.stage,previous,hook})
    }
  }
  declareGraph(graph) {
    this.graph = graph
    this.graphResources.clear()
    this.nodeGraphResources.clear()
    this.inputGraphResource = graph.importResource(`${this.kind}.input`, { keepAlive: true })
    for (const slot of this.slots) {
      const node = slot.nodes[0]
      this.graphResources.set(slot, null)
    }
    for (const node of this.nodes) {
      const resource = graph.createResource(`${this.kind}.${node.name}`, {
        width: Math.ceil(this.scene.drawingBufferWidth * node.scale),
        height: Math.ceil(this.scene.drawingBufferHeight * node.scale),
        format: String(node.pixelFormat), datatype: String(node.pixelDatatype), scale: node.scale,
        keepAlive: this.retained.has(node.name) || node.index === this.nodes.length - 1
      })
      this.nodeGraphResources.set(node, resource)
      if (!this.graphResources.get(node.slot)) this.graphResources.set(node.slot, resource)
    }
    for (const node of this.nodes) {
      graph.addPass(`${this.kind}.${node.name}`, pass => {
        pass.read(this.inputGraphResource)
        for (const name of node.reads) {
          const dependency = this.nameToNode.get(name)
          if (dependency) pass.read(this.nodeGraphResources.get(dependency))
        }
        pass.write(this.nodeGraphResources.get(node))
        pass.sideEffect()
      }, null, { phase: this.kind })
    }
    return this.graphResources
  }

  begin(input){
    this.unreserve?.();this.unreserve=this.pool.reserve([input])
    this.releaseFrame();this.prepared=false;this.input=input
    if (this.graph && this.inputGraphResource) this.graph.bindExternal(this.inputGraphResource, input)
  }
  end(){this.unreserve?.();this.unreserve=null;this.input=null}
  update(context){
    if(this.prepared)return
    if (!this.graph?.activeFrame || !this.graph.transientAllocator) this.pool.resize(this.scene.drawingBufferWidth,this.scene.drawingBufferHeight)
    try{
      for(const slot of this.slots){
        const node=slot.nodes[0],width=Math.ceil(this.scene.drawingBufferWidth*node.scale),height=Math.ceil(this.scene.drawingBufferHeight*node.scale)
        const resource=this.nodeGraphResources.get(node) || this.graphResources.get(slot)
        if(this.graph?.transientAllocator&&this.graph.activeFrame&&resource){
          slot.lease=this.graph.leaseOf(resource)
          if(!slot.lease)throw new Error(`PooledStageCache143 missing Graph lease for ${resource.name}`)
          slot.graphManaged=true
        }else{
          const existing = this.graph && resource && this.graph.activeFrame ? this.graph.leaseOf(resource) : undefined
          if (existing) {
            slot.lease=existing
            slot.graphManaged=true
          } else {
            slot.lease=this.pool.acquire(this.owner,{context,width,height,pixelFormat:node.pixelFormat,pixelDatatype:node.pixelDatatype,samples:1})
            slot.graphManaged=false
          }
        }
        slot.lastId=slot.lease.id
        slot.clear=new this.C.ClearCommand({framebuffer:slot.lease.framebuffer,color:node.stage.clearColor})
      }
      this.prepared=true
    }catch(error){this.releaseFrame();throw error}
  }
  clear(context){const cleared=new Set();for(const slot of this.slots){const id=slot.lease?.id;if(id!==undefined&&cleared.has(id))continue;if(id!==undefined)cleared.add(id);slot.clear?.execute(context)}}
  finishStage(index){
    const completedName=this.nodes[index]?.name
    for(const slot of this.slots) if(slot.last===index) {
      if(slot.graphManaged && this.graph?.activeFrame) { this.graph.completePass(`${this.kind}.${completedName}`); continue }
      slot.lease?.release()
    }
  }
  releaseFrame(){for(const slot of this.slots){if(!slot.graphManaged)slot.lease?.release();slot.lease=null;slot.graphManaged=false;slot.clear=null}this.prepared=false}
  updateDependencies(){} // this adapter's declared graph is immutable
  getFramebuffer(name){const lease=this.nameToNode.get(name)?.slot.lease;return lease?.valid?lease.framebuffer:undefined}
  getOutputTexture(name){return this.getFramebuffer(name)?.getColorTexture(0)}
  getStageByName(name){return this.collection.getStageByName(name)}
  getLedger(){return this.nodes.map(n=>({name:n.name,reads:n.reads,first:n.first,last:Number.isFinite(n.last)?n.last:'retained',
    format:n.pixelFormat,datatype:n.pixelDatatype,width:Math.ceil(this.scene.drawingBufferWidth*n.scale),height:Math.ceil(this.scene.drawingBufferHeight*n.scale),samples:1,
    history:false,retainedVisibility:this.retained.has(n.name),slot:this.slots.indexOf(n.slot)}))}
  getDiagnostics(){
    const ids=new Set(this.slots.map(s=>s.lastId)),entries=this.pool.entries.filter(e=>ids.has(e.id)&&!e.retired)
    const output=this.pool.entries.find(e=>e.id===this.nodes.at(-1)?.slot.lastId&&!e.retired)
    return {bytes:entries.reduce((n,e)=>n+e.bytes,0),liveBytes:entries.filter(e=>e.lease).reduce((n,e)=>n+e.bytes,0),
      output:output?{width:output.texture.width,height:output.texture.height,id:output.id}:null,
      scope:'resident targets last used by this producer; may be shared, use pool totals for allocation',ledger:this.getLedger()}
  }
  isDestroyed(){return !!this.destroyed}
  destroy(){
    if(this.destroyed)return
    this.end();this.releaseFrame()
    for(const {stage,previous,hook}of this.hooks)if(stage.execute===hook)stage.execute=previous
    this.hooks=[];this.pool.detach(this.owner);this.destroyed=true
  }
}
