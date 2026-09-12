import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as adapter from '../../src/channels/reflectionShader143.js'
import { receiverSource } from '../../src/shadows/shaderAdapter143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const required = ['HDR', 'LIGHTING_PBR', 'HAS_NORMALS', 'SPECULAR_IBL', 'USE_IBL_LIGHTING']
function program(defines = required) {
  return {
    vertexShaderSource: new C.ShaderSource({ defines: ['HAS_SKINNING', 'HAS_INSTANCING', 'LOG_DEPTH'], sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines, sources: [C._shadersMaterialStageFS, C._shadersImageBasedLightingStageFS, C._shadersLightingStageFS, C._shadersModelFS] })
  }
}
function adapt(input) {
  assert.equal(typeof adapter.reflectionSources, 'function', 'reflection input adapter is implemented')
  return adapter.reflectionSources(C, input)
}

test('captures native specular contribution and BRDF response while running original lighting', () => {
  const result = adapt(program([...required, 'USE_SPECULAR', 'DIFFUSE_IBL', 'CUSTOM_SPECULAR_IBL']))
  const source = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /vec3 specularContribution = radiance \* FssEss \* model_iblFactor.y;\s+campus_reflectionSpecular = specularContribution;\s+campus_reflectionWeight = FssEss \* model_iblFactor.y;/)
  assert.match(source, /campus_reflectionRoughness = roughness;/)
  assert.match(source, /lightingStage\(material, attributes\);/)
  assert.match(source, /vec3 FssEss = specularWeight \* \(singleScatterFresnel \* brdfLut.x \+ brdfLut.y\);/)
  assert.match(source, /return diffuseContribution \+ specularContribution;/)
  assert.match(source, /out_FragColor = vec4\(campus_reflectionSpecular, 1\.0\);/)
  assert.match(source, /campus_reflectionResponse = vec4\(campus_reflectionWeight, campus_reflectionRoughness\);/)
  assert.match(source, /if \(campus_reflectionValid < 0\.5\)/)
  for (const location of [0, 1]) assert.equal((source.match(new RegExp(`layout\\(location = ${location}\\) out vec4`, 'g')) || []).length, 1)
  assert.doesNotMatch(source, /layout\(location = 2\)/)
})

test('clones only fragment source and preserves picking uniforms and log-depth wrappers', () => {
  const input = program([...required, 'LOG_DEPTH'])
  input.fragmentShaderSource.sources = ['uniform vec4 czm_pickColor;\n' + input.fragmentShaderSource.sources.slice(0, -1).join('\n') + C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main'), 'void main() { czm_log_depth_main(); czm_writeLogDepth(); }']
  input.fragmentShaderSource.includeBuiltIns = false
  const original = JSON.stringify(input)
  const result = adapt(input)
  assert.equal(result.vertexShaderSource, input.vertexShaderSource)
  assert.notEqual(result.fragmentShaderSource, input.fragmentShaderSource)
  assert.equal(JSON.stringify(input), original)
  assert.equal(result.fragmentShaderSource.includeBuiltIns, false)
  assert.ok(result.fragmentShaderSource.defines.includes('LOG_DEPTH'))
  assert.ok(result.fragmentShaderSource.defines.includes('CESIUM_REDIRECTED_COLOR_OUTPUT'))
  assert.match(result.fragmentShaderSource.sources.join('\n'), /czm_log_depth_main\(\); czm_writeLogDepth\(\);/)
})

test('retains material evaluation, MASK, polygon clipping and line visibility before outputs', () => {
  const source = adapt(program([...required, 'ALPHA_MODE_MASK', 'ENABLE_CLIPPING_POLYGONS', 'HAS_LINE_PATTERN'])).fragmentShaderSource.sources.join('\n')
  for (const marker of ['materialStage(material, attributes, selectedFeature);', 'if (alpha < u_alphaCutoff)', 'modelClippingPolygonsStage();', 'lineStyleStage();', 'if (mod(maskTest, 2.0) < 1.0)']) assert.ok(source.includes(marker), marker)
  assert.ok(source.indexOf('modelClippingPolygonsStage();') < source.indexOf('out_FragColor = vec4(campus_reflectionSpecular'))
})

test('native atmosphere attenuates both captured terms through the exact fog function', () => {
  const input = program([...required, 'HAS_ATMOSPHERE'])
  assert.equal(adapt(input), null, 'unknown atmosphere implementation must not be assumed linear')
  input.fragmentShaderSource.sources.unshift(C._shadersAtmosphereStageFS)
  const source = adapt(input).fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /vec3 withFog = czm_fog\(distanceToCamera, color.rgb, fogColor, czm_fogVisualDensityScalar\);/)
  for (const term of ['Specular', 'Weight']) assert.ok(source.includes(`campus_reflection${term} = czm_fog(distanceToCamera, campus_reflection${term}, vec3(0.0), czm_fogVisualDensityScalar);`))
  assert.match(source, /if \(u_isInFog\)/)
  assert.match(source, /atmosphereStage\(color, attributes\);/)
})

test('requires HDR native PBR specular IBL and excludes unsupported material or color-changing paths', () => {
  for (const missing of required) assert.equal(adapt(program(required.filter(define => define !== missing))), null, missing)
  for (const excluded of ['USE_CLEARCOAT', 'USE_ANISOTROPY', 'HAS_CUSTOM_FRAGMENT_SHADER', 'HAS_CUSTOM_VERTEX_SHADER', 'CUSTOM_SHADER_REPLACE_MATERIAL', 'LIGHTING_UNLIT', 'ALPHA_MODE_BLEND', 'HAS_SELECTED_FEATURE_ID', 'USE_CPU_STYLING', 'HAS_MODEL_COLOR', 'HAS_PRIMITIVE_OUTLINE', 'HAS_CLIPPING_PLANES', 'HAS_EDGE_VISIBILITY', 'HAS_EDGE_VISIBILITY_MRT', 'HAS_SILHOUETTE', 'HAS_POINT_CLOUD_COLOR_STYLE', 'METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT', 'CESIUM_REDIRECTED_COLOR_OUTPUT']) assert.equal(adapt(program([...required, excluded])), null, excluded)
  const vertexCustom = program()
  vertexCustom.vertexShaderSource.defines.push('HAS_CUSTOM_VERTEX_SHADER')
  assert.equal(adapt(vertexCustom), null, 'Cesium custom vertex define is vertex-only')
})

test('unknown or derived picking sources remain unsupported without source mutation', () => {
  assert.equal(adapt({}), null)
  const input = program()
  input.fragmentShaderSource.pickColorQualifier = 'uniform'
  assert.equal(adapt(input), null)
  for (const target of [C._shadersModelFS, C._shadersImageBasedLightingStageFS]) {
    const unknown = program()
    unknown.fragmentShaderSource.sources = unknown.fragmentShaderSource.sources.filter(source => source !== target)
    assert.equal(adapt(unknown), null)
  }
  const picking = program()
  picking.fragmentShaderSource.sources = picking.fragmentShaderSource.sources.map(source => C.ShaderSource.replaceMain(source, 'czm_non_pick_main'))
  assert.equal(adapt(picking), null)
})

test('instrumentation exposes captures without MRT outputs or changes to native model/material stages', () => {
  assert.equal(typeof adapter.reflectionInstrumentation, 'function')
  const input = program([...required, 'HAS_ATMOSPHERE'])
  input.fragmentShaderSource.sources.unshift(C._shadersAtmosphereStageFS)
  const original = JSON.stringify(input)
  const result = adapter.reflectionInstrumentation(C, input)
  assert.equal(result.supported, true)
  const source = result.fragmentShaderSource.sources.join('\n')
  assert.ok(source.includes(C._shadersModelFS))
  assert.ok(source.includes(C._shadersMaterialStageFS))
  assert.match(source, /campus_reflectionSpecular = specularContribution;/)
  assert.match(source, /float campus_reflectionValid = 0\.0;/)
  assert.match(source, /roughness <= 1\.0 \? 1\.0 : 0\.0;/)
  assert.doesNotMatch(source, /layout\(location|campus_reflectionResponse/)
  assert.ok(!result.fragmentShaderSource.defines.includes('CESIUM_REDIRECTED_COLOR_OUTPUT'))
  assert.equal(JSON.stringify(input), original)
})

test('unsupported instrumentation returns the original source and standalone zero globals', () => {
  assert.equal(typeof adapter.reflectionInstrumentation, 'function')
  const input = program([...required, 'HAS_MODEL_COLOR'])
  const result = adapter.reflectionInstrumentation(C, input)
  assert.equal(result.supported, false)
  assert.equal(result.fragmentShaderSource, input.fragmentShaderSource)
  assert.match(adapter.reflectionCaptureDeclarations, /vec3 campus_reflectionSpecular = vec3\(0\.0\);/)
  assert.match(adapter.reflectionCaptureDeclarations, /vec3 campus_reflectionWeight = vec3\(0\.0\);/)
  assert.match(adapter.reflectionCaptureDeclarations, /float campus_reflectionValid = 0\.0;/)
  assert.doesNotMatch(adapter.reflectionCaptureDeclarations, /layout|out_FragColor/)
})

test('real shadow receiver preserves normal reflection and dynamically rejects grayscale debug mode', () => {
  const input = program()
  input.fragmentShaderSource = receiverSource(C, input.fragmentShaderSource)
  assert.ok(input.fragmentShaderSource)
  let mode = 1, reads = 0
  const uniformMap = { campus_shadowParams: () => { reads++; return new C.Cartesian4(.001, 1, 100, mode) } }
  input.uniformMap = uniformMap
  const original = JSON.stringify(input.fragmentShaderSource)
  const result = adapter.reflectionInstrumentation(C, input)
  assert.equal(result.supported, true)
  const source = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  const capture = source.slice(source.indexOf('campus_reflectionValid = dot('), source.indexOf('? 1.0 : 0.0;', source.indexOf('campus_reflectionValid = dot(')))
  assert.ok(capture.includes('&& campus_shadowParams.w <= 1.5'), 'capture validity must read the live receiver mode')
  assert.match(source, /if \(campus_shadowParams.w > 1\.5\) material.diffuse = vec3\(campus_shadowVisibility/)
  assert.equal((source.match(/uniform vec4 campus_shadowParams;/g) || []).length, 1)
  assert.equal(input.uniformMap, uniformMap)
  assert.equal(reads, 0, 'shader adaptation must not snapshot or evaluate uniforms')
  mode = 2
  assert.equal(adapter.reflectionInstrumentation(C, input).fragmentShaderSource.sources.join('\n'), result.fragmentShaderSource.sources.join('\n'))
  assert.equal(reads, 0)
  assert.equal(JSON.stringify(input.fragmentShaderSource), original)
})

test('unknown shadow parameter declarations are unsupported and ordinary models need no shadow uniform', () => {
  const ordinary = adapter.reflectionInstrumentation(C, program())
  assert.equal(ordinary.supported, true)
  assert.doesNotMatch(ordinary.fragmentShaderSource.sources.join('\n'), /campus_shadowParams/)
  const unknown = program()
  unknown.fragmentShaderSource.sources.unshift('uniform vec3 campus_shadowParams;')
  const result = adapter.reflectionInstrumentation(C, unknown)
  assert.equal(result.supported, false)
  assert.equal(result.fragmentShaderSource, unknown.fragmentShaderSource)
})

test('transparent replay explicitly opts into BLEND without weakening ordinary capture exclusions', () => {
  const input = program([...required, 'ALPHA_MODE_BLEND'])
  assert.equal(adapter.reflectionInstrumentation(C, input).supported, false)
  const result = adapter.reflectionInstrumentation(C, input, { allowBlend: true })
  assert.equal(result.supported, true)
  assert.ok(result.fragmentShaderSource.defines.includes('ALPHA_MODE_BLEND'))
  assert.ok(result.fragmentShaderSource.sources.join('\n').includes(C._shadersModelFS))
  for (const define of ['USE_CLEARCOAT', 'USE_ANISOTROPY', 'HAS_CUSTOM_FRAGMENT_SHADER', 'HAS_MODEL_COLOR']) {
    assert.equal(adapter.reflectionInstrumentation(C, program([...required, 'ALPHA_MODE_BLEND', define]), { allowBlend: true }).supported, false)
  }
})
