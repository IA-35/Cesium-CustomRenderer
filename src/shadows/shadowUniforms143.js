// Shared contract for enhanced, deferred and transparent receivers. A legacy
// one-map input (including diagnostic fixtures) remains a valid single cascade.
export function shadowUniforms(C,scene,getShadow,fallbackTexture=()=>scene.context.defaultTexture){
  const inactive=new C.Cartesian4(0,0,1,0),splits=new C.Cartesian4(1,1,1,0)
  const level=i=>{const shadow=getShadow();return shadow?.cascades?.[i]||(i===0?shadow:null)}
  const uniforms={campus_shadowSplits:()=>getShadow()?.splits||splits,
    campus_shadowCascadeCount:()=>{const shadow=getShadow();return shadow?(shadow.cascades?.length||1):0}}
  for(let i=0;i<3;i++){
    const suffix=i?String(i):''
    uniforms['campus_shadowDepth'+suffix]=()=>level(i)?.texture||fallbackTexture()
    uniforms['campus_eyeToShadow'+suffix]=()=>level(i)?.matrix||C.Matrix4.IDENTITY
    uniforms['campus_shadowParams'+suffix]=()=>level(i)?.params||inactive
  }
  return uniforms
}
