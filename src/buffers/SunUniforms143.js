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
    const context=scene.context,previous=context.draw,token={active:true}
    owner={references:0,token,previous,data:new Float32Array(12),buffer:new UniformBuffer143(context._gl,48),programs:new WeakMap(),revision:0}
    owner.update=()=>{
      const us=context.uniformState
      for(const [offset,value]of [[0,us.lightDirectionEC],[4,us.lightColorHdr],[8,us.lightDirectionWC]])owner.data.set([value.x,value.y,value.z,0],offset)
      const bytes=owner.buffer.update(owner.data);if(bytes)owner.revision++;return bytes
    }
    owner.hook=function(command,passState,...args){
      const program=args[0]||command.shaderProgram
      if(!token.active||!program?.fragmentShaderSource?.defines?.includes('CCR_SUN_UBO'))return previous.call(this,command,passState,...args)
      let active=owner.programs.get(program)
      if(active===undefined){void program.allUniforms;const index=context._gl.getUniformBlockIndex(program._program,'CCRSunFrame');active=index!==0xffffffff;owner.programs.set(program,active)}
      if(!active)return previous.call(this,command,passState,...args)
      owner.update()
      return withUniformBlocks(context._gl,[program],[{name:'CCRSunFrame',buffer:owner.buffer}],()=>previous.call(this,command,passState,...args))
    }
    context.draw=owner.hook;owners.set(scene,owner)
  }
  owner.references++;let released=false
  return {buffer:owner.buffer,update:()=>{if(released)throw new Error('Sun uniform lease released');return owner.update()},
    getDiagnostics:()=>({...owner.buffer.getDiagnostics(),references:owner.references,viewRevision:owner.revision,released}),
    release(){if(released)return;released=true;if(--owner.references)return;owner.token.active=false;if(scene.context?.draw===owner.hook)scene.context.draw=owner.previous;owner.buffer.destroy();owners.delete(scene)}}
}
