import {receiverSource,pcf} from '../shadows/shaderAdapter143.js'

export function forwardShader(C,source,family){
  const fs=source.fragmentShaderSource,defines=new Set(fs.defines||[])
  if(family==='model'){
    if(['HAS_CUSTOM_FRAGMENT_SHADER','HAS_CUSTOM_VERTEX_SHADER','CUSTOM_SHADER_REPLACE_MATERIAL','USE_CLEARCOAT','USE_ANISOTROPY','USE_SPECULAR','USE_CUSTOM_LIGHT_COLOR'].some(d=>defines.has(d)))return null
    const result=receiverSource(C,fs)
    if(result)result.sources=result.sources.map(s=>s.replace('directLighting * campus_shadowVisibility(position, normal);','directLighting * campus_shadowVisibility(position, normal) * ccr_forwardTerms.x;')
      .replace('vec3 color = directColor + material.emissive;','vec3 color = directColor + material.emissive * ccr_forwardTerms.z;'))
    return result
  }
  const result=fs.clone()
  if(family==='particle'){
    if(!C._shadersBillboardCollectionFS||!fs.sources.some(s=>s.includes(C._shadersBillboardCollectionFS.trim())))return null
    result.sources=result.sources.map(s=>s.replace('out_FragColor = color;','out_FragColor = vec4(color.rgb * ccr_forwardTerms.z, color.a);'))
    return result
  }
  if(family!=='water'||defines.has('FLAT'))return null
  const stages=[C._shadersAllMaterialAppearanceFS,C._shadersEllipsoidSurfaceAppearanceFS].filter(Boolean)
  if(!fs.sources.some(s=>stages.some(stage=>s.includes(stage.trim()))))return null
  result.defines.push('DIFFUSE_IBL','SPECULAR_IBL','CUSTOM_SPHERICAL_HARMONICS','CUSTOM_SPECULAR_IBL')
  result.sources.unshift(pcf,`
uniform bool ccr_forwardActive;
uniform vec2 model_iblFactor;
uniform mat3 model_iblReferenceFrameMatrix;
uniform vec3 model_sphericalHarmonicCoefficients[9];
uniform samplerCube model_specularEnvironmentMaps;
uniform float model_specularEnvironmentMapsMaximumLOD;
`,C._shadersImageBasedLightingStageFS,`
vec4 ccr_waterLighting(vec3 toEye,czm_material water,vec3 position) {
  if(!ccr_forwardActive)return czm_phong(toEye,water,czm_lightDirectionEC);
  czm_modelMaterial material;
  material.normalEC=normalize(water.normal);
  material.diffuse=water.diffuse;
  material.specular=vec3(0.02)*clamp(water.specular,0.0,1.0);
  material.roughness=clamp(sqrt(2.0/(water.shininess+2.0)),0.04,1.0);
  material.occlusion=1.0;
  vec3 direct=czm_lightColorHdr*czm_pbrLighting(toEye,material.normalEC,normalize(czm_lightDirectionEC),material);
  direct*=campus_shadowVisibility(position,material.normalEC)*ccr_forwardTerms.x;
  vec3 indirect=textureIBL(toEye,material.normalEC,material);
  return vec4(direct+indirect+water.emission*ccr_forwardTerms.z,water.alpha);
}`)
  result.sources=result.sources.map(s=>s.replace('out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);',
    'out_FragColor = ccr_waterLighting(normalize(positionToEyeEC), material, v_positionEC);'))
  return result
}
