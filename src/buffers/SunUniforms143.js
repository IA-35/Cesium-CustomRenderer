import UniformBuffer143,{uniformBuffersSupported,withUniformBlocks} from './UniformBuffer143.js'
const owners=new WeakMap()
export const sunBlockGLSL=`
#ifdef CCR_SUN_UBO
layout(std140) uniform CCRSunFrame {
  vec4 ccrLightEye;
  vec4 ccrLightRadiance;
  vec4 ccrLightWorld;
};
#define CCR_LIGHT_DIRECTION_EC ccrLightEye.xyz
#define CCR_LIGHT_COLOR_HDR ccrLightRadiance.xyz
#else
#define CCR_LIGHT_DIRECTION_EC czm_lightDirectionEC
#define CCR_LIGHT_COLOR_HDR czm_lightColorHdr
#endif
`
export function acquireSunUniforms(C,scene){
  if(!uniformBuffersSupported(scene.context))return null
  let owner=owners.get(scene)
  if(!owner){
    const context=scene.context,dispatcher=context._ccrDrawDispatcher,previous=context.draw,token={active:true}
    owner={references:0,token,previous,data:new Float32Array(12),buffer:new UniformBuffer143(context._gl,48),programs:new WeakMap(),revision:0}
    owner.update=()=>{
      const us=context.uniformState
      // 每次带 UBO 的 draw 都会调用：直接写入，不分配临时数组。
      const data=owner.data,write=(offset,value)=>{data[offset]=value.x;data[offset+1]=value.y;data[offset+2]=value.z;data[offset+3]=0}
      write(0,us.lightDirectionEC);write(4,us.lightColorHdr);write(8,us.lightDirectionWC)
      const bytes=owner.buffer.update(owner.data);if(bytes)owner.revision++;return bytes
    }
    owner.hook=function(command,passState,...args){
      const program=args[0]||command.shaderProgram
      if(!token.active||!program?.fragmentShaderSource?.defines?.includes('CCR_SUN_UBO'))return previous.call(this,command,passState,...args)
      let active=owner.programs.get(program)
      if(active===undefined){void program.allUniforms;const index=context._gl.getUniformBlockIndex(program._program,'CCRSunFrame');active=index!==0xffffffff;owner.programs.set(program,active)}
      if(!active)return previous.call(this,command,passState,...args)
      owner.update()
      if(owner.scopedPrograms?.has(program))return previous.call(this,command,passState,...args)
      return withUniformBlocks(context._gl,[program],[{name:'CCRSunFrame',buffer:owner.buffer}],()=>previous.call(this,command,passState,...args))
    }
         if(dispatcher){
       owner.dispatcherDispose=dispatcher.addHandler(event=>{
         const command=event.command,program=event.overrides[0]||command?.shaderProgram
         if(!token.active||!program)return 'continue'
         // 每个 program 只判定一次（含 defines 扫描），之后每次 draw 只查 WeakMap。
         let active=owner.programs.get(program)
         if(active===undefined){
           active=!!program.fragmentShaderSource?.defines?.includes('CCR_SUN_UBO')
           if(active){void program.allUniforms;active=context._gl.getUniformBlockIndex(program._program,'CCRSunFrame')!==0xffffffff}
           owner.programs.set(program,active)
         }
         if(!active)return 'continue'
         owner.update()
         if(!owner.scopedPrograms?.has(program))event.aroundDraw(invoke=>withUniformBlocks(context._gl,[program],[{name:'CCRSunFrame',buffer:owner.buffer}],invoke))
         return 'continue'
       },{name:'sun-uniforms'})
     }else context.draw=owner.hook
     owners.set(scene,owner)
  }
  owner.references++;let released=false
  return {buffer:owner.buffer,update:()=>{if(released)throw new Error('Sun uniform lease released');return owner.update()},
    withPrograms(programs,callback){
      if(released)throw new Error('Sun uniform lease released')
      const previous=owner.scopedPrograms
      return withUniformBlocks(scene.context._gl,programs,[{name:'CCRSunFrame',buffer:owner.buffer}],()=>{
        owner.scopedPrograms=new Set(programs)
        try{return callback()}finally{owner.scopedPrograms=previous}
      })
    },
    getDiagnostics:()=>({...owner.buffer.getDiagnostics(),references:owner.references,viewRevision:owner.revision,released}),
    release(){if(released)return;released=true;if(--owner.references)return;owner.token.active=false;if(owner.dispatcherDispose)owner.dispatcherDispose();if(scene.context?.draw===owner.hook)scene.context.draw=owner.previous;owner.buffer.destroy();owners.delete(scene)}}
}
