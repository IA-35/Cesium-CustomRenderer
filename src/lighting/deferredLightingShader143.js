import { pcf } from '../shadows/shaderAdapter143.js'
export const DEFERRED_DEBUG_MODES = Object.freeze({ OFF:0, DIRECT:1, INDIRECT:2, EMISSIVE:3, SHADOW:4, AO:5, MATERIAL:6, ALBEDO:7 })

// The material inputs are already linear; eyeDepth is metres, never window depth.
export function deferredLightingShaderSource(C, { diffuse=false, specular=false } = {}) {
  return new C.ShaderSource({
    defines: [...(diffuse?['DIFFUSE_IBL','CUSTOM_SPHERICAL_HARMONICS']:[]),
      ...(specular?['SPECULAR_IBL','CUSTOM_SPECULAR_IBL']:[])],
    sources: [`
precision highp float;
uniform sampler2D u_normalRoughMetal;
uniform sampler2D u_albedoOcclusion;
uniform sampler2D u_emissiveFlags;
uniform sampler2D u_eyeDepth;
uniform sampler2D u_aoVisibility;
uniform float u_group;
uniform vec4 u_terms;
uniform float u_aoStrength;
uniform float u_debugMode;
uniform vec2 model_iblFactor;
uniform mat3 model_iblReferenceFrameMatrix;
uniform vec3 model_sphericalHarmonicCoefficients[9];
uniform samplerCube model_specularEnvironmentMaps;
uniform float model_specularEnvironmentMapsMaximumLOD;
in vec2 v_textureCoordinates;
`, pcf, C._shadersImageBasedLightingStageFS, `
void main() {
  vec4 e=texture(u_emissiveFlags,v_textureCoordinates);
  float group=floor(e.a/1024.0);
  float flags=mod(e.a,1024.0);
  vec4 positionMetal=texture(u_eyeDepth,v_textureCoordinates);
  float depth=positionMetal.r;
  if(group!=u_group || depth<=0.0 || mod(floor(flags/512.0),2.0)<1.0)discard;
  vec4 nrm=texture(u_normalRoughMetal,v_textureCoordinates);
  vec4 albedo=texture(u_albedoOcclusion,v_textureCoordinates);
  // Native eye-space XY and metric Z preserve precision for very sharp GGX lobes.
  vec3 positionEC=vec3(positionMetal.yz,-depth);
  vec3 normalEC=nrm.xyz,viewDirection=-normalize(positionEC);
  czm_modelMaterial material;
  material.normalEC=normalEC;
  material.roughness=nrm.w;
  material.diffuse=albedo.rgb*(1.0-positionMetal.w);
  material.specular=mix(vec3(0.04),albedo.rgb,positionMetal.w);
  material.occlusion=albedo.a;
  material.emissive=e.rgb;
  float shadow=u_terms.w>0.5?campus_shadowVisibility(positionEC,normalEC):1.0;
  float ao=mix(1.0,texture(u_aoVisibility,v_textureCoordinates).r,u_aoStrength);
  vec3 direct=czm_lightColorHdr*czm_pbrLighting(viewDirection,normalEC,normalize(czm_lightDirectionEC),material)*shadow;
  vec3 indirect=vec3(0.0);
#if defined(DIFFUSE_IBL) || defined(SPECULAR_IBL)
  indirect=textureIBL(viewDirection,normalEC,material)*ao;
#endif
  vec3 color=direct*u_terms.x+indirect*u_terms.y+e.rgb*u_terms.z;
  if(u_debugMode==1.0)color=direct;
  else if(u_debugMode==2.0)color=indirect;
  else if(u_debugMode==3.0)color=e.rgb;
  else if(u_debugMode==4.0)color=vec3(shadow);
  else if(u_debugMode==5.0)color=vec3(ao);
  else if(u_debugMode==6.0)color=vec3(nrm.w,positionMetal.w,0.0);
  else if(u_debugMode==7.0)color=albedo.rgb;
  out_FragColor=vec4(color,1.0);
}
`],
  })
}
