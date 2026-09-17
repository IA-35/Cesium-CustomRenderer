import ShadowCache from '../shadows/ShadowCache.js'

export default class OccluderCache143 {
  constructor(C,scene){Object.assign(this,{C,scene,values:new ShadowCache(),resources:new Map(),resourceRevision:0,revision:0,signature:null})}
  track(resource,geometry=false){
    if(!resource||typeof resource!=='object')return
    if(this.resources.has(resource)){const r=this.resources.get(resource);r.frame=this.scene.frameState.frameNumber;r.geometry||=geometry;return}
    const record={active:true,hooks:[],frame:this.scene.frameState.frameNumber},cache=this
    for(const key of ['copyFrom','copyFromArrayView','copyFromFramebuffer']){
      const previous=resource[key];if(typeof previous!=='function')continue
      const hook=function(...args){if(record.active){cache.resourceRevision++;if(record.geometry)cache.geometryDirty=true}return previous.apply(this,args)}
      const hadOwn=Object.hasOwn(resource,key);resource[key]=hook;record.hooks.push({key,previous,hook,hadOwn})
    }
    record.geometry=geometry;if(record.hooks.length)this.resources.set(resource,record)
  }
  update(commands){
    const C=this.C,groups=new Map(),records=[],gl=this.scene.context._gl
    // geometryDirty is a one-shot latch: it flags this frame (and bumps the
    // revision) so the query is re-run after a vertex/index upload, then resets
    // so a static model that finished streaming does not stay "unsafe" forever.
    let unsafe=!!this.geometryDirty,saved,linked=false
    this.geometryDirty=false
    try{
      for(const command of commands){
        if(![C.Pass.OPAQUE,C.Pass.CESIUM_3D_TILE].includes(command.pass)||!(command.owner instanceof C.Model))continue
        const program=command.shaderProgram,defines=[...(program?.vertexShaderSource.defines||[]),...(program?.fragmentShaderSource.defines||[])]
        if(defines.some(d=>/SKINNING|MORPH|CUSTOM_VERTEX|CUSTOM_FRAGMENT|CUSTOM_SHADER_REPLACE/.test(d))||command.owner.activeAnimations?.length){unsafe=true;continue}
        if(defines.some(d=>/CLIPPING|SILHOUETTE|OUTLINE|EDGE_VISIBILITY|POINT_CLOUD/.test(d))){unsafe=true;continue}
        if(defines.includes('ALPHA_MODE_BLEND'))continue
        if(!command.boundingVolume?.center||!Number.isFinite(command.boundingVolume.radius)||!command.renderState.depthTest.enabled||!command.renderState.depthMask)continue
        // `allUniforms` lazily links the program, which can move the current
        // program. Snapshot it only when a link will actually happen this pass.
        if(!linked&&!program._program){saved=gl.getParameter(gl.CURRENT_PROGRAM);linked=true}
        void program.allUniforms
        const uniforms=[]
        for(const uniform of program._manualUniforms||[]){
          if(/^(campus_|ccr_|model_ibl|model_specularEnvironment|model_sphericalHarmonic)/.test(uniform.name))continue
          const value=command.uniformMap[uniform.name]();this.track(value);uniforms.push([uniform.name,this.values.value(value)])
        }
        for(const attribute of command.vertexArray._attributes||[])this.track(attribute.vertexBuffer,true)
        this.track(command.vertexArray.indexBuffer,true)
        let group=groups.get(command.owner)
        if(!group){group={owner:command.owner,commands:[],spheres:[]};groups.set(command.owner,group)}
        group.commands.push(command);group.spheres.push(command.boundingVolume)
        records.push([this.values.identity(command.owner),this.values.identity(command.vertexArray),program.id,command.renderState.id,command.count,command.offset,command.instanceCount,command.primitiveType,command.pass,
          this.values.value(command.modelMatrix),this.values.value(command.boundingVolume.center),command.boundingVolume.radius,uniforms])
      }
    }catch(error){unsafe=true;this.reason=error.message}
    finally{if(linked)gl.useProgram(saved)}
    records.sort((a,b)=>a[0]-b[0]||a[1]-b[1])
    const signature=JSON.stringify([this.resourceRevision,records,unsafe?this.scene.frameState.frameNumber:0])
    const changed=signature!==this.signature
    if(changed){this.signature=signature;this.revision++}
    for(const [resource,record]of this.resources)if(resource.isDestroyed?.()||record.frame<this.scene.frameState.frameNumber-120){this.untrack(resource,record);this.resources.delete(resource)}
    for(const group of groups.values())group.sphere=C.BoundingSphere.fromBoundingSpheres(group.spheres)
    return {groups:[...groups.values()],changed,revision:this.revision,unsafe}
  }
  destroy(){
    for(const [resource,record]of this.resources)this.untrack(resource,record)
    this.resources.clear()
  }
  untrack(resource,record){record.active=false;for(const h of record.hooks)if(resource[h.key]===h.hook){if(h.hadOwn)resource[h.key]=h.previous;else delete resource[h.key]}}
}
