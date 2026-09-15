const requiredDefines = ['HDR', 'LIGHTING_PBR', 'HAS_NORMALS', 'SPECULAR_IBL', 'USE_IBL_LIGHTING']
const excludedDefines = [
  'USE_CLEARCOAT', 'USE_ANISOTROPY', 'HAS_CUSTOM_FRAGMENT_SHADER', 'HAS_CUSTOM_VERTEX_SHADER',
  'CUSTOM_SHADER_REPLACE_MATERIAL', 'LIGHTING_UNLIT', 'ALPHA_MODE_BLEND', 'HAS_CLASSIFICATION',
  'HAS_MODEL_COLOR', 'HAS_PRIMITIVE_OUTLINE', 'HAS_CLIPPING_PLANES',
  'HAS_EDGE_VISIBILITY', 'HAS_EDGE_VISIBILITY_MRT', 'HAS_SILHOUETTE', 'HAS_POINT_CLOUD_COLOR_STYLE',
  'METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT', 'CESIUM_REDIRECTED_COLOR_OUTPUT'
]

export const reflectionCaptureDeclarations = `
vec3 campus_reflectionSpecular = vec3(0.0);
vec3 campus_reflectionWeight = vec3(0.0);
float campus_reflectionRoughness = 0.0;
float campus_reflectionValid = 0.0;
`

const output = `
    if (campus_reflectionValid < 0.5) {
        out_FragColor = vec4(0.0);
        campus_reflectionResponse = vec4(0.0);
    } else {
        out_FragColor = vec4(campus_reflectionSpecular, 1.0);
        campus_reflectionResponse = vec4(campus_reflectionWeight, campus_reflectionRoughness);
    }`

function uniqueStage(sources, variants) {
  const matches = []
  for (const [index, source] of sources.entries()) {
    for (const stage of variants) {
      const offset = source.indexOf(stage)
      if (offset < 0) continue
      if (source.indexOf(stage, offset + stage.length) >= 0) return null
      matches.push({ index, stage })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

// Replay with the original uniformMap, camera/frustum and automatic uniforms.
// Leaves native ModelFS/MaterialStageFS and color output intact for composition
// with the material MRT adapter. Unsupported callers can add the zero globals.
export function reflectionInstrumentation(C, program, { allowBlend = false } = {}) {
  const vs = program && program.vertexShaderSource
  const fs = program && program.fragmentShaderSource
  const unsupported = { fragmentShaderSource: fs, supported: false }
  if (!vs || !fs || !Array.isArray(fs.sources) || fs.pickColorQualifier) return unsupported
  if (typeof C._shadersModelFS !== 'string' || typeof C._shadersImageBasedLightingStageFS !== 'string') return unsupported
  const defines = new Set((fs.defines || []).map(define => define.trim().split(/\s+/)[0]))
  const allDefines = new Set([...defines, ...(vs.defines || []).map(define => define.trim().split(/\s+/)[0])])
  if (allDefines.has('USE_CPU_STYLING') && !allDefines.has('HAS_SELECTED_FEATURE_ID')) return unsupported
  if (requiredDefines.some(define => !defines.has(define)) || excludedDefines.some(define =>
    allDefines.has(define) && !(allowBlend && define === 'ALPHA_MODE_BLEND'))) return unsupported
  if (fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main)\b/.test(source))) return unsupported
  // The known receiver replaces native color with grayscale when its live W > 1.5.
  const shadowReceiver = fs.sources.some(source => /^\s*uniform\s+vec4\s+campus_shadowParams\s*;/m.test(source))
  if (!shadowReceiver && fs.sources.some(source => /\bcampus_shadowParams\b/.test(source))) return unsupported

  const model = uniqueStage(fs.sources, [C._shadersModelFS.trim(), C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main').trim()])
  const ibl = uniqueStage(fs.sources, [C._shadersImageBasedLightingStageFS.trim()])
  if (!model || !ibl) return unsupported
  const styling = allDefines.has('HAS_SELECTED_FEATURE_ID')
    ? uniqueStage(fs.sources, [C._shadersCPUStylingStageFS.trim()]) : null
  if (allDefines.has('HAS_SELECTED_FEATURE_ID') && !styling) return unsupported
  let atmosphere
  if (defines.has('HAS_ATMOSPHERE')) {
    if (typeof C._shadersAtmosphereStageFS !== 'string') return unsupported
    atmosphere = uniqueStage(fs.sources, [C._shadersAtmosphereStageFS.trim()])
    if (!atmosphere) return unsupported
  }

  const specularMarker = 'vec3 specularContribution = radiance * FssEss * model_iblFactor.y;'
  const capture = `${specularMarker}
        campus_reflectionSpecular = specularContribution;
        campus_reflectionWeight = FssEss * model_iblFactor.y;
        campus_reflectionRoughness = roughness;
        campus_reflectionValid = dot(normalEC, normalEC) > 1.0e-12
            ${shadowReceiver ? '&& campus_shadowParams.w <= 1.5' : ''}
            && !any(isnan(normalEC)) && !any(isinf(normalEC))
            && !any(isnan(specularContribution)) && !any(isinf(specularContribution))
            && !any(isnan(campus_reflectionWeight)) && !any(isinf(campus_reflectionWeight))
            && roughness >= 0.0 && roughness <= 1.0 ? 1.0 : 0.0;`
  const fogMarker = 'vec3 withFog = czm_fog(distanceToCamera, color.rgb, fogColor, czm_fogVisualDensityScalar);'
  const fogCapture = `${fogMarker}
    // HDR fog is linear; black removes the additive atmospheric radiance.
    campus_reflectionSpecular = czm_fog(distanceToCamera, campus_reflectionSpecular, vec3(0.0), czm_fogVisualDensityScalar);
    campus_reflectionWeight = czm_fog(distanceToCamera, campus_reflectionWeight, vec3(0.0), czm_fogVisualDensityScalar);`
  const fragmentShaderSource = fs.clone()
  fragmentShaderSource.sources = fs.sources.map((source, index) => {
    if (styling && index === styling.index) {
      source = source.replace('vec4 featureColor = feature.color;',
        'vec4 featureColor = feature.color;\n    if (!all(equal(feature.color, vec4(1.0)))) campus_reflectionValid = 0.0;')
    }
    if (index === ibl.index) source = source.replace(ibl.stage, ibl.stage.replace(specularMarker, capture))
    if (atmosphere && index === atmosphere.index) source = source.replace(atmosphere.stage, atmosphere.stage.replace(fogMarker, fogCapture))
    return source
  })
  fragmentShaderSource.sources.unshift(reflectionCaptureDeclarations)
  return { fragmentShaderSource, supported: true }
}

// Standalone two-attachment wrapper for validation and independent replay.
// Attachment 0 is the existing HDR cube-map term; attachment 1 is the response
// to multiply SSR radiance by, with perceptual roughness in A.
export function reflectionSources(C, program) {
  const { fragmentShaderSource, supported } = reflectionInstrumentation(C, program)
  if (!supported) return null
  const model = uniqueStage(fragmentShaderSource.sources, [C._shadersModelFS.trim(), C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main').trim()])
  fragmentShaderSource.sources[model.index] = fragmentShaderSource.sources[model.index].replace(model.stage, model.stage.replace('out_FragColor = color;', output))
  fragmentShaderSource.sources.unshift('layout(location = 1) out vec4 campus_reflectionResponse;')
  fragmentShaderSource.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  return { vertexShaderSource: program.vertexShaderSource, fragmentShaderSource }
}
