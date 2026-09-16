import { reflectionInstrumentation, reflectionCaptureDeclarations } from './reflectionShader143.js'

// Attachment 1 alpha stores integer flags directly in RGBA16F (not normalized).
export const MATERIAL_FLAGS = Object.freeze({
  SURFACE: 1,
  NORMAL_VALID: 2,
  METALLIC_ROUGHNESS_VALID: 4,
  EMISSIVE_VALID: 8,
  ALPHA_MASK: 16,
  UNLIT: 32,
  CUSTOM: 64,
  SPECULAR_GLOSSINESS: 128,
  ALBEDO_VALID: 256,
  STANDARD_PBR_VALID: 512
})

const declarations = `
precision highp float;
layout(location = 1) out vec4 campus_materialEmissiveFlags;
layout(location = 2) out float campus_materialDepth;
layout(location = 3) out float campus_transparentCoverage;
float campus_materialMetallic = 0.0;
bool campus_materialMetallicValid = false;
vec2 campus_materialOctNormal(vec3 normalEC) {
    float magnitude = abs(normalEC.x) + abs(normalEC.y) + abs(normalEC.z);
    vec3 n = magnitude > 0.0 ? normalEC / magnitude : vec3(0.0, 0.0, 1.0);
    vec2 direction = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    vec2 oct = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * direction;
    return oct * 0.5 + 0.5;
}
`

// Accept only the bundled ModelFS, including Cesium's known log-depth rename.
// ShaderBuilder can concatenate all stages into one source; replace the matched
// stage substring, never every occurrence of a color assignment in that source.
export function materialSources(C, program, reflection = false, opaqueColor = false, albedo = false, neutralFeatures = false) {
  reflection = reflection || opaqueColor
  const vs = program && program.vertexShaderSource
  let fs = program && program.fragmentShaderSource
  if (!vs || !fs || !Array.isArray(fs.sources) || fs.pickColorQualifier) return null
  const capture = reflection ? reflectionInstrumentation(C, program) : null
  if (capture && capture.supported) fs = capture.fragmentShaderSource
  if (typeof C._shadersModelFS !== 'string' || typeof C._shadersMaterialStageFS !== 'string') return null
  const defines = new Set((fs.defines || []).map(define => define.trim().split(/\s+/)[0]))
  const allDefines = new Set([...defines, ...(vs.defines || []).map(define => define.trim().split(/\s+/)[0])])
  if (['METADATA_PICKING_ENABLED', 'ALPHA_MODE_BLEND', 'SHADOW_MAP', 'OIT', 'CESIUM_REDIRECTED_COLOR_OUTPUT'].some(define => defines.has(define))) return null
  const modelVariants = [C._shadersModelFS.trim(), C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main').trim()]
  const matches = []
  for (const [index, source] of fs.sources.entries()) {
    for (const model of modelVariants) {
      if (source.includes(model)) matches.push({ index, model })
    }
  }
  if (matches.length !== 1) return null
  const materialStage = C._shadersMaterialStageFS.trim()
  const materialStageCount = fs.sources.filter(source => source.includes(materialStage)).length
  // Cesium omits this stage when the custom shader replaces the whole material.
  if (materialStageCount !== 1 && !(materialStageCount === 0 && defines.has('CUSTOM_SHADER_REPLACE_MATERIAL'))) return null
  // Picking and redirected derived wrappers must not overwrite the MRT result.
  // Ordinary model shaders also declare czm_pickColor; only wrappers imply picking.
  if (fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main)\b/.test(source))) return null

  const custom = defines.has('HAS_CUSTOM_FRAGMENT_SHADER') || defines.has('CUSTOM_SHADER_REPLACE_MATERIAL')
  const normalValid = defines.has('HAS_NORMALS') && !defines.has('CUSTOM_SHADER_REPLACE_MATERIAL')
  const metallicValid = defines.has('LIGHTING_PBR') && defines.has('USE_METALLIC_ROUGHNESS') && !defines.has('USE_SPECULAR_GLOSSINESS') && !custom
  const albedoValid = materialStageCount === 1 && !custom && !allDefines.has('HAS_CUSTOM_VERTEX_SHADER')
  const standardPbrInvalidDefines = ['USE_SPECULAR', 'USE_CLEARCOAT', 'USE_ANISOTROPY', 'USE_CUSTOM_LIGHT_COLOR',
    'HAS_MODEL_COLOR', 'HAS_SELECTED_FEATURE_ID', 'USE_CPU_STYLING', 'HAS_PRIMITIVE_OUTLINE', 'HAS_CLIPPING_PLANES',
    'ENABLE_CLIPPING_POLYGONS', 'HAS_EDGE_VISIBILITY', 'HAS_EDGE_VISIBILITY_MRT', 'HAS_SILHOUETTE', 'HAS_POINT_CLOUD_COLOR_STYLE']
  const standardPbrValid = albedoValid && normalValid && metallicValid &&
    !standardPbrInvalidDefines.some(define => defines.has(define) &&
      !(neutralFeatures && ['HAS_SELECTED_FEATURE_ID', 'USE_CPU_STYLING'].includes(define)))
  let flags = MATERIAL_FLAGS.SURFACE
  if (normalValid) flags |= MATERIAL_FLAGS.NORMAL_VALID
  if (!custom) flags |= MATERIAL_FLAGS.EMISSIVE_VALID
  if (defines.has('ALPHA_MODE_MASK')) flags |= MATERIAL_FLAGS.ALPHA_MASK
  if (!defines.has('LIGHTING_PBR')) flags |= MATERIAL_FLAGS.UNLIT
  if (custom) flags |= MATERIAL_FLAGS.CUSTOM
  if (defines.has('USE_SPECULAR_GLOSSINESS')) flags |= MATERIAL_FLAGS.SPECULAR_GLOSSINESS

  const nativeLighting = opaqueColor || (capture && capture.supported)
  const snapshotMaterial = nativeLighting || albedo
  const material = snapshotMaterial ? 'campus_baseMaterial' : 'material'
  const reflectionOutput = reflection ? `
    campus_reflectionSpecularOutput = vec4(0.0);
    campus_reflectionResponse = vec4(0.0);
    if (campus_reflectionValid > 0.5
        && !any(isnan(campus_reflectionSpecular)) && !any(isinf(campus_reflectionSpecular))
        && !any(isnan(campus_reflectionWeight)) && !any(isinf(campus_reflectionWeight))
        && campus_reflectionRoughness >= 0.0 && campus_reflectionRoughness <= 1.0) {
        campus_reflectionSpecularOutput = vec4(campus_reflectionSpecular, 1.0);
        campus_reflectionResponse = vec4(campus_reflectionWeight, campus_reflectionRoughness);
    }` : ''
  const albedoOutput = !albedo ? '' : albedoValid ? `
    campus_albedoOcclusion = vec4(0.0);
    bool campus_albedoValid = !any(isnan(campus_baseMaterial.baseColor.rgb))
        && !any(isinf(campus_baseMaterial.baseColor.rgb))
        && all(lessThanEqual(abs(campus_baseMaterial.baseColor.rgb), vec3(65504.0)))
        && !isnan(campus_baseMaterial.occlusion) && !isinf(campus_baseMaterial.occlusion)
        && campus_baseMaterial.occlusion >= 0.0 && campus_baseMaterial.occlusion <= 1.0;
    if (campus_albedoValid) {
        campus_albedoOcclusion = vec4(campus_baseMaterial.baseColor.rgb, campus_baseMaterial.occlusion);
        campus_materialFlags += 256.0;
        ${standardPbrValid ? `if (campus_materialMetallicValid
            && dot(campus_baseMaterial.normalEC, campus_baseMaterial.normalEC) > 1.0e-12
            && !any(isnan(campus_baseMaterial.normalEC)) && !any(isinf(campus_baseMaterial.normalEC))
            && !isnan(campus_materialMetallic) && !isinf(campus_materialMetallic)
            && !isnan(campus_baseMaterial.roughness) && !isinf(campus_baseMaterial.roughness)
            && campus_materialMetallic >= 0.0 && campus_materialMetallic <= 1.0
            && campus_baseMaterial.roughness >= 0.0 && campus_baseMaterial.roughness <= 1.0) campus_materialFlags += 512.0;` : ''}
    }` : '\n    campus_albedoOcclusion = vec4(0.0);'
  const output = `
    float campus_materialFlags = ${flags}.0;
    ${normalValid ? `if (!(dot(${material}.normalEC, ${material}.normalEC) > 1.0e-12) || any(isinf(${material}.normalEC))) campus_materialFlags -= 2.0;` : ''}
    ${metallicValid ? 'if (campus_materialMetallicValid) campus_materialFlags += 4.0;' : ''}
    ${albedoOutput}
    out_FragColor = vec4(campus_materialOctNormal(${material}.normalEC), clamp(${material}.roughness, 0.0, 1.0), clamp(campus_materialMetallic, 0.0, 1.0));
    campus_materialEmissiveFlags = vec4(${material}.emissive, campus_materialFlags);
    campus_materialDepth = -attributes.positionEC.z;
    campus_transparentCoverage = 0.0;${reflectionOutput}
    ${opaqueColor ? 'campus_opaqueColor = color;' : ''}`
  const { index, model } = matches[0]
  const patchedModel = model
    .replace('czm_modelMaterial material = defaultModelMaterial();', `#ifdef HAS_SILHOUETTE
    if (model_silhouettePass) discard;
    #endif
    czm_modelMaterial material = defaultModelMaterial();`)
    .replace('lightingStage(material, attributes);', `${snapshotMaterial ? 'czm_modelMaterial campus_baseMaterial = material;\n    ' : ''}${nativeLighting
      ? 'lightingStage(material, attributes);'
      : '/* Material channels retain alpha and visibility without lighting. */'}`)
    .replace('out_FragColor = color;', output)
  const metallicCall = 'float metalness = setMetallicRoughness(material);'
  const patchedMaterial = materialStage.replace(metallicCall, `${metallicCall}
        campus_materialMetallic = metalness;
        campus_materialMetallicValid = true;`)
  const fragmentShaderSource = fs.clone()
  fragmentShaderSource.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  fragmentShaderSource.sources = fs.sources.map((source, sourceIndex) => {
    if (sourceIndex === index) source = source.replace(model, patchedModel)
    return source.replace(materialStage, patchedMaterial)
  })
  fragmentShaderSource.sources.unshift(declarations)
  if (reflection) {
    fragmentShaderSource.sources.unshift('layout(location = 4) out vec4 campus_reflectionSpecularOutput;\nlayout(location = 5) out vec4 campus_reflectionResponse;')
    if (!capture.supported) fragmentShaderSource.sources.unshift(reflectionCaptureDeclarations)
  }
  if (opaqueColor) fragmentShaderSource.sources.unshift('layout(location = 6) out vec4 campus_opaqueColor;')
  if (albedo) {
    const location = 4 + (reflection ? 2 : 0) + (opaqueColor ? 1 : 0)
    fragmentShaderSource.sources.unshift(`layout(location = ${location}) out vec4 campus_albedoOcclusion;`)
  }
  return { vertexShaderSource: vs, fragmentShaderSource, standardPbrValid }
}
