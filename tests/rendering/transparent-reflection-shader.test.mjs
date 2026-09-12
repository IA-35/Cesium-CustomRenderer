import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as adapter from '../../src/reflections/transparentReflectionShader143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const defines = ['HDR', 'LIGHTING_PBR', 'HAS_NORMALS', 'SPECULAR_IBL', 'USE_IBL_LIGHTING', 'ALPHA_MODE_BLEND']
function program(extra = []) {
  return {
    vertexShaderSource: new C.ShaderSource({ defines: ['HAS_SKINNING', 'HAS_INSTANCING'], sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines: [...defines, ...extra], sources: [C._shadersMaterialStageFS, C._shadersImageBasedLightingStageFS, C._shadersLightingStageFS, C._shadersModelFS] })
  }
}
function adapt(input, mode = 'sorted') {
  assert.equal(typeof adapter.transparentReflectionSources, 'function', 'transparent reflection adapter must exist')
  return adapter.transparentReflectionSources(C, input, { mode })
}
const combined = value => value.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })

test('sorted transparent PBR captures native specular and emits an unpremultiplied delta with original alpha', () => {
  const source = combined(adapt(program()))
  assert.match(source, /campus_reflectionSpecular = specularContribution;/)
  assert.match(source, /campus_reflectionWeight = FssEss \* model_iblFactor.y;/)
  assert.match(source, /lightingStage\(material, attributes\);/)
  assert.match(source, /out_FragColor = color;\s+vec4 campus_transparentNative = out_FragColor;/)
  assert.match(source, /traceReflection\(campus_transparentPixel, attributes.positionEC, material.normalEC, campus_reflectionRoughness\)/)
  assert.match(source, /campus_transparentDelta = clamp\(campus_transparentHit.z \* u_strength, 0\.0, 1\.0\) \* \(campus_transparentSource.rgb \* campus_reflectionWeight - campus_reflectionSpecular\);/)
  assert.match(source, /if \(campus_transparentSource.a > 0\.5\)/)
  assert.match(source, /out_FragColor = vec4\(campus_transparentDelta, campus_transparentNative.a\);/)
  assert.doesNotMatch(source, /in vec2 v_textureCoordinates;/)
  assert.match(source, /#define REFLECTION_TRANSPARENT_RECEIVER/)
  assert.equal((source.match(/layout\(location = 0\) out vec4 out_FragColor;/g) || []).length, 1)
})

test('OIT delta uses exactly the native Cesium alpha weight and does not contribute coverage', () => {
  const source = combined(adapt(program(), 'oit'))
  assert.match(source, /out_FragColor = vec4\(campus_transparentDelta \* campus_transparentNative.a \* czm_alphaWeight\(campus_transparentNative.a\), 0\.0\);/)
  assert.ok(source.includes(C._shadersalphaWeight.split('\n').find(line => line.trim().startsWith('return ')).trim()), 'actual Cesium alpha-weight formula is included')
})

test('manual opaque occlusion keeps unknown depth conservative and preserves native alpha/clipping/discards', () => {
  const source = combined(adapt(program(['ALPHA_MODE_MASK', 'ENABLE_CLIPPING_POLYGONS'])))
  assert.match(source, /float campus_transparentEyeDepth = -attributes.positionEC.z;/)
  assert.match(source, /campus_transparentOpaqueDepth < 0\.0/)
  assert.match(source, /campus_transparentStrictDepth \? campus_transparentEyeDepth >= campus_transparentOpaqueDepth : campus_transparentEyeDepth > campus_transparentOpaqueDepth/)
  assert.match(source, /if \(alpha < u_alphaCutoff\)/)
  assert.ok(source.indexOf('modelClippingPolygonsStage();') < source.indexOf('vec4 campus_transparentNative ='))
  assert.match(source, /campus_transparentNative.a <= 0\.0/)
})

test('preserves the vertex, log-depth wrappers, original fragment and uniform references', () => {
  const input = program(['LOG_DEPTH'])
  input.vertexShaderSource.defines.push('LOG_DEPTH')
  input.fragmentShaderSource.sources = input.fragmentShaderSource.sources.map(source => C.ShaderSource.replaceMain(source, 'czm_log_depth_main'))
  input.fragmentShaderSource.sources.push('void main() { czm_log_depth_main(); czm_writeLogDepth(); }')
  const uniformMap = { original: () => 1 }
  input.uniformMap = uniformMap
  const original = JSON.stringify(input)
  const result = adapt(input)
  assert.equal(result.vertexShaderSource, input.vertexShaderSource)
  assert.equal(input.uniformMap, uniformMap)
  assert.equal(JSON.stringify(input), original)
  assert.ok(result.fragmentShaderSource.defines.includes('LOG_DEPTH'))
  assert.match(combined(result), /czm_log_depth_main\(\); czm_writeLogDepth\(\);/)
})

test('visible unsupported model materials keep alpha attenuation in sorted mode and zero OIT delta', () => {
  for (const excluded of ['HAS_CUSTOM_FRAGMENT_SHADER', 'USE_CLEARCOAT', 'USE_ANISOTROPY', 'HAS_MODEL_COLOR']) {
    const input = program([excluded])
    const sorted = combined(adapt(input))
    assert.match(sorted, /out_FragColor = vec4\(vec3\(0\.0\), campus_transparentNative.a\);/)
    assert.match(sorted, /float campus_transparentEyeDepth = -attributes.positionEC.z;/)
    assert.doesNotMatch(sorted, /vec4 traceReflection\(/)
    assert.match(combined(adapt(input, 'oit')), /out_FragColor = vec4\(0\.0\);/)
  }
})

test('unknown ordinary transparent shaders execute their original alpha and discard before zero-delta fallback', () => {
  const input = { vertexShaderSource: new C.ShaderSource({ sources: ['void main(){gl_Position=vec4(1.0);}'] }),
    fragmentShaderSource: new C.ShaderSource({ sources: ['uniform vec4 tint; void main(){ if(tint.a < 0.1) discard; out_FragColor = tint; }'] }) }
  const source = combined(adapt(input))
  assert.match(source, /campus_transparentOriginalMain\(\);\s+vec4 campus_transparentNative = out_FragColor;/)
  assert.match(source, /if\(tint.a < 0\.1\) discard;/)
  assert.match(source, /czm_windowToEyeCoordinates\(gl_FragCoord\)/)
  assert.match(source, /out_FragColor = vec4\(vec3\(0\.0\), campus_transparentNative.a\);/)
  input.fragmentShaderSource.sources[0] += '\n#ifdef LOG_DEPTH\nvoid unusedLogDepthHelper(){czm_writeLogDepth();}\n#endif'
  assert.match(combined(adapt(input)), /vec4 campus_transparentPositionEC = czm_windowToEyeCoordinates\(gl_FragCoord\);/)
  input.fragmentShaderSource.defines.push('LOG_DEPTH')
  input.fragmentShaderSource.sources[0] = input.fragmentShaderSource.sources[0].replace('out_FragColor = tint;', 'out_FragColor = tint; czm_writeLogDepth();')
  assert.match(combined(adapt(input)), /czm_windowToEyeCoordinates\(gl_FragCoord.xy, gl_FragDepth\)/)
})

test('unsafe derived passes and conflicting attachment/uniform interfaces are rejected', () => {
  assert.equal(adapt({}), null)
  assert.equal(adapt(program(), 'invalid'), null)
  for (const extra of ['METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT', 'CESIUM_REDIRECTED_COLOR_OUTPUT', 'LOG_DEPTH_WRITE']) assert.equal(adapt(program([extra])), null, extra)
  const pick = program(); pick.fragmentShaderSource.pickColorQualifier = 'uniform'
  assert.equal(adapt(pick), null)
  for (const source of ['layout(location = 1) out vec4 extra;', 'uniform sampler2D u_depth;', 'void czm_translucent_main(){}']) {
    const conflict = program(); conflict.fragmentShaderSource.sources.unshift(source)
    assert.equal(adapt(conflict), null)
  }
})
