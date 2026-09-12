import { reflectionInstrumentation } from '../channels/reflectionShader143.js'
import { reflectionCommon, traceFunctions } from './ssrShaders143.js'

const unsafeDefines = ['METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT', 'CESIUM_REDIRECTED_COLOR_OUTPUT', 'LOG_DEPTH_WRITE']
const inputUniforms = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(u_depth|u_material|u_flags|u_transparency|u_specular|u_response|u_inverseProjection|u_strength|u_projection|u_distance|u_thickness|u_near|u_maxLevel|u_hiz[0-4]|u_sourceColor)\b/

function modelStage(C, sources) {
  if (typeof C._shadersModelFS !== 'string') return null
  const matches = []
  for (const stage of [C._shadersModelFS.trim(), C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main').trim()]) {
    for (const [index, source] of sources.entries()) {
      const first = source.indexOf(stage)
      if (first < 0) continue
      if (source.indexOf(stage, first + stage.length) >= 0) return null
      matches.push({ index, stage })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function transparentVisibility(eyeDepth) {
  return `
    ivec2 campus_transparentPixel = ivec2(gl_FragCoord.xy);
    if (any(lessThan(campus_transparentPixel, ivec2(0))) || any(greaterThanEqual(campus_transparentPixel, textureSize(u_depth, 0)))) discard;
    float campus_transparentEyeDepth = ${eyeDepth};
    float campus_transparentOpaqueDepth = texelFetch(u_depth, campus_transparentPixel, 0).r;
    if (!(campus_transparentEyeDepth > 0.0) || isinf(campus_transparentEyeDepth) || campus_transparentNative.a <= 0.0) discard;
    if (campus_transparentOpaqueDepth < 0.0 || (campus_transparentOpaqueDepth > 0.0 &&
        (campus_transparentStrictDepth ? campus_transparentEyeDepth >= campus_transparentOpaqueDepth : campus_transparentEyeDepth > campus_transparentOpaqueDepth))) discard;`
}

// Replay the original TRANSLUCENT command, not its native OIT-derived shader.
// CPU owns blend/depth state and adds the trace inputs alongside original uniforms.
export function transparentReflectionSources(C, program, { mode } = {}) {
  const vs = program && program.vertexShaderSource
  const fs = program && program.fragmentShaderSource
  if (!vs || !fs || !Array.isArray(fs.sources) || fs.pickColorQualifier || !['oit', 'sorted'].includes(mode)) return null
  const defines = new Set([...(vs.defines || []), ...(fs.defines || [])].map(value => value.trim().split(/\s+/)[0]))
  if (unsafeDefines.some(define => defines.has(define))) return null
  if (fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main|czm_out_FragColor)\b/.test(source) ||
    /layout\s*\(\s*location\s*=\s*[1-9]/.test(source) || inputUniforms.test(source))) return null
  const model = modelStage(C, fs.sources)
  const capture = model ? reflectionInstrumentation(C, program, { allowBlend: true }) : { supported: false }
  const fragmentShaderSource = capture.supported ? capture.fragmentShaderSource : fs.clone()
  fragmentShaderSource.sources.unshift('uniform bool campus_transparentStrictDepth;')
  fragmentShaderSource.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')

  if (model) {
    const delta = capture.supported ? `
    vec3 campus_transparentDelta = vec3(0.0);
    if (campus_reflectionValid > 0.5 && u_strength > 0.0) {
        vec4 campus_transparentHit = traceReflection(campus_transparentPixel, attributes.positionEC, material.normalEC, campus_reflectionRoughness);
        if (campus_transparentHit.z > 0.0) {
            ivec2 campus_transparentHitPixel = clamp(ivec2(campus_transparentHit.xy * vec2(textureSize(u_sourceColor, 0))), ivec2(0), textureSize(u_sourceColor, 0) - 1);
            vec4 campus_transparentSource = texelFetch(u_sourceColor, campus_transparentHitPixel, 0);
            if (campus_transparentSource.a > 0.5) {
                campus_transparentDelta = clamp(campus_transparentHit.z * u_strength, 0.0, 1.0) * (campus_transparentSource.rgb * campus_reflectionWeight - campus_reflectionSpecular);
            }
        }
    }
    ${mode === 'oit'
      ? 'out_FragColor = vec4(campus_transparentDelta * campus_transparentNative.a * czm_alphaWeight(campus_transparentNative.a), 0.0);'
      : 'out_FragColor = vec4(campus_transparentDelta, campus_transparentNative.a);'}`
      : mode === 'oit' ? '\n    out_FragColor = vec4(0.0);' : '\n    out_FragColor = vec4(vec3(0.0), campus_transparentNative.a);'
    const replacement = `out_FragColor = color;
    vec4 campus_transparentNative = out_FragColor;${transparentVisibility('-attributes.positionEC.z')}${delta}`
    // Capture prepends globals, so find the original stage again by content.
    fragmentShaderSource.sources = fragmentShaderSource.sources.map(source => source.replace(model.stage, model.stage.replace('out_FragColor = color;', replacement)))
    if (capture.supported) {
      fragmentShaderSource.defines.push('REFLECTION_TRANSPARENT_RECEIVER')
      fragmentShaderSource.sources.unshift(reflectionCommon.replace('in vec2 v_textureCoordinates;', '') + '\nuniform highp sampler2D u_sourceColor;\n' + traceFunctions)
    } else fragmentShaderSource.sources.unshift('uniform highp sampler2D u_depth;')
  } else {
    // Known log-depth writers publish gl_FragDepth; the two-argument Cesium
    // helper decodes that value, unlike the linear gl_FragCoord overload.
    const writesDepth = fs.sources.some(source => /\bgl_FragDepth\s*=/.test(source) ||
      (defines.has('LOG_DEPTH') && /\bczm_writeLogDepth\s*\(/.test(source)))
    const position = writesDepth ? 'czm_windowToEyeCoordinates(gl_FragCoord.xy, gl_FragDepth)' : 'czm_windowToEyeCoordinates(gl_FragCoord)'
    fragmentShaderSource.sources = fs.sources.map(source => C.ShaderSource.replaceMain(source, 'campus_transparentOriginalMain'))
    fragmentShaderSource.sources.unshift('uniform bool campus_transparentStrictDepth;')
    fragmentShaderSource.sources.unshift('uniform highp sampler2D u_depth;')
    fragmentShaderSource.sources.push(`
void main() {
    campus_transparentOriginalMain();
    vec4 campus_transparentNative = out_FragColor;
    vec4 campus_transparentPositionEC = ${position};${transparentVisibility('-campus_transparentPositionEC.z / campus_transparentPositionEC.w')}
    ${mode === 'oit' ? 'out_FragColor = vec4(0.0);' : 'out_FragColor = vec4(vec3(0.0), campus_transparentNative.a);'}
}`)
  }
  return { vertexShaderSource: vs, fragmentShaderSource }
}
