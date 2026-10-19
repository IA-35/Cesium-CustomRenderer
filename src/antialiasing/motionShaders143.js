// Three r186 VelocityNode: current unjittered NDC minus previous unjittered NDC.
// Cesium adaptation only: retain the actual Model main/discard/log-depth in an
// auxiliary framebuffer. Rigid primitives use the same local vertex for both frames.
export function motionSources143(C, program) {
  const vs = program?.vertexShaderSource, fs = program?.fragmentShaderSource
  if (!vs?.sources || !fs?.sources || fs.pickColorQualifier) return null
  const defines = [...(vs.defines || []), ...(fs.defines || [])].map(value => value.trim().split(/\s+/)[0])
  if (defines.some(value => /^(HAS_SKINNING|HAS_MORPH_TARGETS|HAS_INSTANCING|USE_LEGACY_INSTANCING|USE_2D_POSITIONS|HAS_CUSTOM_VERTEX_SHADER|HAS_CUSTOM_FRAGMENT_SHADER|CUSTOM_SHADER_REPLACE_MATERIAL|HAS_VERTICAL_EXAGGERATION|HAS_SILHOUETTE|HAS_PRIMITIVE_OUTLINE|HAS_EDGE_VISIBILITY|HAS_EDGE_VISIBILITY_MRT|HAS_PLANAR_FILL_ID_PASS|ALPHA_MODE_BLEND|CESIUM_REDIRECTED_COLOR_OUTPUT|SHADOW_MAP|OIT|METADATA_PICKING_ENABLED)$/.test(value))) return null
  const variants = source => [source?.trim(), source && C.ShaderSource.replaceMain(source, 'czm_log_depth_main').trim()].filter(Boolean)
  const vertex = variants(C._shadersModelVS).find(value => vs.sources.some(source => source.includes(value)))
  if (!vertex || vs.sources.filter(source => source.includes(vertex)).length !== 1 ||
      fs.sources.filter(source => variants(C._shadersModelFS).some(value => source.includes(value))).length !== 1 ||
      fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main)\b/.test(source))) return null
  const anchor = 'vec4 positionClip = geometryStage(attributes, modelView, normal);'
  if (!vertex.includes(anchor)) return null
  const vertexShaderSource = vs.clone(), fragmentShaderSource = fs.clone()
  vertexShaderSource.sources = vs.sources.map(source => source.replace(vertex, vertex.replace(anchor, `${anchor}
    ccr_currentEye = ccr_currentModelView * vec4(attributes.positionMC, 1.0);
    ccr_previousEye = ccr_previousModelView * vec4(attributes.positionMC, 1.0);`)))
  vertexShaderSource.sources.unshift(`uniform mat4 ccr_currentModelView;
uniform mat4 ccr_previousModelView;
out vec4 ccr_currentEye;
out vec4 ccr_previousEye;`)
  fragmentShaderSource.sources = fs.sources.map(source => C.ShaderSource.replaceMain(source, 'ccr_motionBase'))
  fragmentShaderSource.sources.unshift(`in vec4 ccr_currentEye;
in vec4 ccr_previousEye;
uniform mat4 ccr_currentProjection;
uniform mat4 ccr_previousProjection;
uniform bool ccr_previousValid;`)
  fragmentShaderSource.sources.push(`void main() {
    ccr_motionBase();
    vec4 currentClip = ccr_currentProjection * ccr_currentEye;
    vec4 previousClip = ccr_previousProjection * ccr_previousEye;
    if (currentClip.w <= 0.0) discard;
    vec2 previousNdc = previousClip.w > 0.0 ? previousClip.xy / previousClip.w : currentClip.xy / currentClip.w;
    out_FragColor = vec4(currentClip.xy / currentClip.w - previousNdc, -ccr_currentEye.z,
        ccr_previousValid && previousClip.w > 0.0 ? -ccr_previousEye.z : -1.0);
}`)
  return { vertexShaderSource, fragmentShaderSource }
}
