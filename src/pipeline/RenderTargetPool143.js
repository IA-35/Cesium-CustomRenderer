const pools=new WeakMap()
export function getRenderTargetPool(C,context){
  let pool=pools.get(context)
  if(!pool||pool.destroyed){pool=new RenderTargetPool143(C,context);pools.set(context,pool)}
  return pool
}
export function peekRenderTargetPool(context){return pools.get(context)}

// Only CCR-owned, single-sample targets are allocated here. Borrowed inputs are
// read reservations, never entries in the destruction list.
export default class RenderTargetPool143 {
  constructor(C,context){
    Object.assign(this,{C,context,entries:[],owners:new Set(),readers:new Map(),generation:1,nextId:1,
      allocated:0,reused:0,crossReused:0,peakBytes:0,destroyed:false})
    this.onLost=()=>this.invalidate();context._gl?.canvas?.addEventListener('webglcontextlost',this.onLost)
  }
  attach(owner){if(this.destroyed)throw new Error('Target pool destroyed');this.owners.add(owner)}
  detach(owner){this.releaseOwner(owner);this.owners.delete(owner);if(!this.owners.size)this.invalidate()}
  resize(width,height){const size=width+':'+height;if(this.size&&this.size!==size)this.invalidate();this.size=size}
  acquire(owner,spec){
    if(this.destroyed)throw new Error('Target pool destroyed')
    if(spec.context&&spec.context!==this.context)throw new Error('Target pool context mismatch')
    if(!Number.isInteger(spec.width)||spec.width<1||!Number.isInteger(spec.height)||spec.height<1|| (spec.samples??1)!==1)throw new Error('Invalid single-sample target descriptor')
    const descriptor={width:spec.width,height:spec.height,pixelFormat:spec.pixelFormat,pixelDatatype:spec.pixelDatatype,samples:1,depth:!!spec.depth}
    const key=JSON.stringify(descriptor),kind=owner.kind||owner.label||owner
    let entry=this.entries.find(e=>e.key===key&&!e.lease&&!e.retired&&!this.readers.has(e.texture))
    if(entry){this.reused++;if(entry.kind!==kind)this.crossReused++}
    else{
      const C=this.C;let texture,framebuffer
      try{
        texture=new C.Texture({context:this.context,width:spec.width,height:spec.height,pixelFormat:spec.pixelFormat,pixelDatatype:spec.pixelDatatype,
          sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST})})
        framebuffer=new C.Framebuffer({context:this.context,...(spec.depth?{depthTexture:texture}:{colorTextures:[texture]}),destroyAttachments:false})
        if(framebuffer.status!==this.context._gl.FRAMEBUFFER_COMPLETE)throw new Error('Pooled framebuffer incomplete')
      }catch(error){if(framebuffer&&!framebuffer.isDestroyed())framebuffer.destroy();if(texture&&!texture.isDestroyed())texture.destroy();throw error}
      entry={id:this.nextId++,key,texture,framebuffer,descriptor,version:0,bytes:texture.sizeInBytes};this.entries.push(entry);this.allocated++
    }
    entry.kind=kind;entry.version++
    const version=entry.version,pool=this
    const valid=()=>!pool.destroyed&&!entry.retired&&entry.lease===lease&&entry.version===version
    const requireValid=()=>{if(!valid())throw new Error('Target lease expired')}
    const lease={owner,id:entry.id,generation:this.generation,descriptor,
      get valid(){return valid()},get texture(){requireValid();return entry.texture},get framebuffer(){requireValid();return entry.framebuffer},
      release(){if(valid())entry.lease=null}}
    entry.lease=lease
    this.peakBytes=Math.max(this.peakBytes,this.entries.reduce((n,e)=>n+e.bytes,0))
    return lease
  }
  reserve(textures){
    const unique=[...new Set(textures.filter(Boolean))]
    for(const texture of unique)this.readers.set(texture,(this.readers.get(texture)||0)+1)
    let released=false
    return ()=>{if(released)return;released=true;for(const texture of unique){const n=this.readers.get(texture)-1;if(n)this.readers.set(texture,n);else this.readers.delete(texture)}this.collect()}
  }
  assertWritable(lease,inputs){if(inputs.includes(lease.texture))throw new Error('Pooled target texture feedback')}
  releaseTexture(texture){const entry=this.entries.find(e=>e.texture===texture);entry?.lease?.release()}
  releaseOwner(owner){for(const entry of this.entries)if(entry.lease?.owner===owner)entry.lease.release()}
  invalidate(){this.generation++;for(const entry of this.entries){entry.retired=true;entry.lease=null}this.collect()}
  collect(){
    this.entries=this.entries.filter(entry=>{
      if(!entry.retired||this.readers.has(entry.texture))return true
      if(!entry.framebuffer.isDestroyed())entry.framebuffer.destroy()
      if(!entry.texture.isDestroyed())entry.texture.destroy()
      return false
    })
  }
  getDiagnostics(){return {generation:this.generation,allocated:this.allocated,reused:this.reused,crossReused:this.crossReused,
    live:this.entries.filter(e=>e.lease).length,targets:this.entries.length,currentBytes:this.entries.reduce((n,e)=>n+e.bytes,0),peakBytes:this.peakBytes,
    entries:this.entries.map(e=>({id:e.id,kind:e.kind,...e.descriptor,bytes:e.bytes,live:!!e.lease,retired:!!e.retired}))}}
  destroy(){if(this.destroyed)return;this.invalidate();this.destroyed=true;this.owners.clear();this.context._gl?.canvas?.removeEventListener('webglcontextlost',this.onLost)}
}
