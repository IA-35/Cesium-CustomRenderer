import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as adapter from '../../src/channels/materialShader143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const pbr = ['LIGHTING_PBR', 'USE_METALLIC_ROUGHNESS', 'HAS_NORMALS']
function program(defines = pbr) {
  return {
    vertexShaderSource: new C.ShaderSource({ defines: ['HAS_SKINNING', 'HAS_MORPH_TARGETS', 'HAS_INSTANCING', 'LOG_DEPTH'], sources: [C._shadersModelVS] }),
    fragmentShaderSource: new C.ShaderSource({ defines, sources: [C._shadersMaterialStageFS, C._shadersModelFS] })
  }
}
function adapt(input) {
  assert.equal(typeof adapter.materialSources, 'function', 'material MRT adapter must be implemented')
  return adapter.materialSources(C, input)
}

test('actual bundle material shader captures metallic and writes three material attachments plus opaque coverage reset', () => {
  const result = adapt(program())
  const source = result.fragmentShaderSource.sources.join('\n')
  assert.match(source, /float metalness = setMetallicRoughness\(material\);\s+campus_materialMetallic = metalness;\s+campus_materialMetallicValid = true;/)
  assert.match(source, /float campus_materialMetallic = 0\.0;/)
  assert.match(source, /bool campus_materialMetallicValid = false;/)
  assert.match(source, /out_FragColor = vec4\(campus_materialOctNormal\(material.normalEC\), clamp\(material.roughness, 0\.0, 1\.0\), clamp\(campus_materialMetallic, 0\.0, 1\.0\)\);/)
  assert.match(source, /layout\(location = 1\) out vec4 campus_materialEmissiveFlags;/)
  assert.match(source, /layout\(location = 2\) out float campus_materialDepth;/)
  assert.match(source, /layout\(location = 3\) out float campus_transparentCoverage;/)
  assert.match(source, /campus_transparentCoverage = 0\.0;/)
  assert.match(source, /campus_materialEmissiveFlags = vec4\(material.emissive, campus_materialFlags\);/)
  assert.match(source, /campus_materialDepth = -attributes.positionEC.z;/)
  assert.doesNotMatch(source, /lightingStage\(material, attributes\);/)
  assert.match(source, /material.baseColor = baseColorWithAlpha;/)
  assert.match(source, /float metalness = clamp\(metallicRoughness.b, 0\.0, 1\.0\);/)
  const combined = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(combined, /^#version 300 es/)
  assert.equal((combined.match(/layout\(location = 0\) out vec4 out_FragColor;/g) || []).length, 1)
  for (const location of [1, 2, 3]) assert.equal((combined.match(new RegExp(`layout\\(location = ${location}\\) out`, 'g')) || []).length, 1)
  assert.match(combined, /#define CESIUM_REDIRECTED_COLOR_OUTPUT/)
})

test('preserves source objects, vertex transforms, log-depth wrappers and unrelated outputs', () => {
  const input = program([...pbr, 'LOG_DEPTH', 'HDR'])
  input.fragmentShaderSource.sources = [
    'void untouchedHelper() { vec4 color = vec4(1.0); out_FragColor = color; }\n' + C._shadersMaterialStageFS + C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main'),
    'void main() { czm_log_depth_main(); czm_writeLogDepth(); }'
  ]
  input.fragmentShaderSource.includeBuiltIns = false
  const before = JSON.stringify(input)
  const result = adapt(input)
  assert.equal(result.vertexShaderSource, input.vertexShaderSource)
  assert.notEqual(result.fragmentShaderSource, input.fragmentShaderSource)
  assert.equal(result.fragmentShaderSource.includeBuiltIns, false)
  assert.equal(JSON.stringify(input), before)
  assert.ok(result.fragmentShaderSource.defines.includes('LOG_DEPTH'))
  assert.ok(result.fragmentShaderSource.defines.includes('HDR'))
  assert.ok(result.fragmentShaderSource.defines.includes('CESIUM_REDIRECTED_COLOR_OUTPUT'))
  const source = result.fragmentShaderSource.sources.join('\n')
  assert.match(source, /void main\(\) \{ czm_log_depth_main\(\); czm_writeLogDepth\(\); \}/)
  assert.match(source, /void untouchedHelper\(\) \{ vec4 color = vec4\(1\.0\); out_FragColor = color; \}/)
})

test('retains mask, styles, custom material, clipping and edge discards; excludes silhouette expansion', () => {
  const input = program([...pbr, 'ALPHA_MODE_MASK', 'HAS_CUSTOM_FRAGMENT_SHADER', 'HAS_EDGE_VISIBILITY_MRT', 'HAS_SILHOUETTE'])
  input.fragmentShaderSource.sources.unshift(C._shadersEdgeVisibilityStageFS)
  const source = adapt(input).fragmentShaderSource.sources.join('\n')
  for (const marker of ['if (alpha < u_alphaCutoff)', 'cpuStylingStage(material, selectedFeature);', 'modelColorStage(material);', 'customShaderStage(material, attributes, featureIds, metadata, metadataClass, metadataStatistics);', 'modelClippingPlanesStage(color);', 'modelClippingPolygonsStage();', 'lineStyleStage();', 'edgeVisibilityStage(color, featureIds);', 'if (v_shouldDiscard > 0.5)']) assert.ok(source.includes(marker), marker)
  assert.match(source, /#ifdef HAS_SILHOUETTE\s+if \(model_silhouettePass\) discard;\s+#endif/)
  assert.ok(source.indexOf('modelClippingPolygonsStage();') < source.indexOf('campus_materialDepth ='))
  assert.ok(source.indexOf('modelClippingPolygonsStage();') < source.indexOf('campus_transparentCoverage ='))
  assert.match(source, /#if defined\(HAS_EDGE_VISIBILITY_MRT\) && !defined\(CESIUM_REDIRECTED_COLOR_OUTPUT\)/)
})

test('flags distinguish measured PBR values, missing normals, unlit, specular glossiness and custom material', () => {
  assert.deepEqual(adapter.MATERIAL_FLAGS, { SURFACE: 1, NORMAL_VALID: 2, METALLIC_ROUGHNESS_VALID: 4, EMISSIVE_VALID: 8, ALPHA_MASK: 16, UNLIT: 32, CUSTOM: 64, SPECULAR_GLOSSINESS: 128, ALBEDO_VALID: 256, STANDARD_PBR_VALID: 512 })
  for (const [defines, expected, metallicValid] of [
    [pbr, 11, true],
    [['LIGHTING_PBR', 'USE_METALLIC_ROUGHNESS'], 9, true],
    [[...pbr, 'ALPHA_MODE_MASK'], 27, true],
    [['LIGHTING_UNLIT', 'HAS_NORMALS'], 43, false],
    [['LIGHTING_PBR', 'USE_SPECULAR_GLOSSINESS', 'HAS_NORMALS'], 139, false],
    [[...pbr, 'HAS_CUSTOM_FRAGMENT_SHADER'], 67, false],
    [[...pbr, 'CUSTOM_SHADER_REPLACE_MATERIAL'], 65, false]
  ]) {
    const source = adapt(program(defines)).fragmentShaderSource.sources.join('\n')
    assert.ok(source.includes(`float campus_materialFlags = ${expected}.0;`), defines.join(','))
    assert.equal(source.includes('if (campus_materialMetallicValid) campus_materialFlags += 4.0;'), metallicValid)
  }
})

test('unknown, modified, picking, shadow and translucent shader variants are unsupported', () => {
  assert.equal(adapt({}), null)
  for (const define of ['METADATA_PICKING_ENABLED', 'ALPHA_MODE_BLEND', 'SHADOW_MAP', 'OIT']) assert.equal(adapt(program([...pbr, define])), null, define)
  const picking = program()
  picking.fragmentShaderSource.pickColorQualifier = 'uniform'
  assert.equal(adapt(picking), null)
  for (const modelSource of ['void main() { out_FragColor = vec4(1.0); }', C._shadersModelFS.replace('lightingStage(material, attributes);', 'unknownLighting(material);'), C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_non_pick_main')]) {
    const input = program()
    input.fragmentShaderSource.sources[1] = modelSource
    assert.equal(adapt(input), null)
  }
  const missingMaterial = program()
  missingMaterial.fragmentShaderSource.sources.shift()
  assert.equal(adapt(missingMaterial), null)
})

test('ordinary model pick-color uniform does not make the draw a picking pass', () => {
  const input = program([...pbr, 'LOG_DEPTH'])
  input.fragmentShaderSource.sources = [
    'uniform vec4 czm_pickColor;\n' + C._shadersMaterialStageFS + C.ShaderSource.replaceMain(C._shadersModelFS, 'czm_log_depth_main'),
    'void main() { czm_log_depth_main(); czm_writeLogDepth(); }'
  ]
  const result = adapt(input)
  assert.ok(result, 'normal model shader with unused picking uniform must remain supported')
  assert.match(result.fragmentShaderSource.sources.join('\n'), /uniform vec4 czm_pickColor;/)
})

test('custom material modification checks the resulting normal before exposing its validity', () => {
  const input = program([...pbr, 'HAS_CUSTOM_FRAGMENT_SHADER'])
  input.fragmentShaderSource.sources.unshift(`
void customShaderStage(inout czm_modelMaterial material, ProcessedAttributes attributes,
    FeatureIds featureIds, Metadata metadata, MetadataClass metadataClass, MetadataStatistics metadataStatistics) {
    material.normalEC = vec3(0.0);
}`)
  const result = adapt(input)
  const combined = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(combined, /material.normalEC = vec3\(0\.0\);/)
  assert.match(combined, /if \(!\(dot\(material.normalEC, material.normalEC\) > 1\.0e-12\) \|\| any\(isinf\(material.normalEC\)\)\) campus_materialFlags -= 2\.0;/)
  assert.ok(combined.indexOf('customShaderStage(material, attributes, featureIds, metadata, metadataClass, metadataStatistics);') < combined.indexOf('campus_materialFlags -= 2.0;'))
  assert.ok(combined.indexOf('campus_materialFlags -= 2.0;') < combined.indexOf('campus_materialEmissiveFlags ='))
  const replacement = adapt(program([...pbr, 'HAS_CUSTOM_FRAGMENT_SHADER', 'CUSTOM_SHADER_REPLACE_MATERIAL']))
  const replacementSource = replacement.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(replacementSource, /float campus_materialFlags = 65\.0;/)
  assert.doesNotMatch(replacementSource, /campus_materialFlags -= 2\.0;/)
})

test('replacement material supports the actual omitted MaterialStageFS shape with conservative flags', () => {
  const input = program([...pbr, 'HAS_CUSTOM_FRAGMENT_SHADER', 'CUSTOM_SHADER_REPLACE_MATERIAL'])
  input.fragmentShaderSource.sources.shift()
  input.fragmentShaderSource.sources.unshift(`
void customShaderStage(inout czm_modelMaterial material, ProcessedAttributes attributes,
    FeatureIds featureIds, Metadata metadata, MetadataClass metadataClass, MetadataStatistics metadataStatistics) {
    material.diffuse = vec3(0.2);
    material.emissive = vec3(1.0, 0.0, 0.0);
}`)
  const original = JSON.stringify(input)
  const result = adapt(input)
  assert.ok(result, 'Cesium omits MaterialStageFS when custom shader replaces the material')
  const source = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /float campus_materialFlags = 65\.0;/)
  assert.match(source, /float campus_materialMetallic = 0\.0;/)
  assert.match(source, /material.emissive = vec3\(1\.0, 0\.0, 0\.0\);/)
  assert.match(source, /campus_materialEmissiveFlags = vec4\(material.emissive, campus_materialFlags\);/)
  assert.doesNotMatch(source, /campus_materialMetallic = metalness;/)
  assert.doesNotMatch(source, /campus_materialFlags [+-]=/)
  assert.equal(JSON.stringify(input), original)
})

test('optional reflection layout captures native lighting while preserving pre-lighting material outputs', () => {
  const input = program([...pbr, 'HDR', 'SPECULAR_IBL', 'USE_IBL_LIGHTING'])
  input.fragmentShaderSource.sources.splice(1, 0, C._shadersImageBasedLightingStageFS, C._shadersLightingStageFS)
  const before = JSON.stringify(input)
  const result = adapter.materialSources(C, input, true)
  const source = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /layout\(location = 4\) out vec4 campus_reflectionSpecularOutput;/)
  assert.match(source, /layout\(location = 5\) out vec4 campus_reflectionResponse;/)
  assert.match(source, /czm_modelMaterial campus_baseMaterial = material;\s+lightingStage\(material, attributes\);/)
  assert.match(source, /campus_materialOctNormal\(campus_baseMaterial.normalEC\)/)
  assert.match(source, /clamp\(campus_baseMaterial.roughness/)
  assert.match(source, /vec4\(campus_baseMaterial.emissive, campus_materialFlags\)/)
  assert.match(source, /campus_reflectionSpecular = specularContribution;/)
  assert.match(source, /campus_reflectionSpecularOutput = vec4\(campus_reflectionSpecular, 1\.0\);/)
  assert.match(source, /campus_reflectionResponse = vec4\(campus_reflectionWeight, campus_reflectionRoughness\);/)
  assert.match(source, /!any\(isnan\(campus_reflectionSpecular\)\)/)
  assert.match(source, /!any\(isinf\(campus_reflectionWeight\)\)/)
  assert.equal(JSON.stringify(input), before)
  assert.doesNotMatch(adapter.materialSources(C, input).fragmentShaderSource.sources.join('\n'), /layout\(location = [45]\)/)
})

test('unsupported reflection material retains base material channels and clears both optional outputs', () => {
  const result = adapter.materialSources(C, program([...pbr, 'HAS_CUSTOM_FRAGMENT_SHADER']), true)
  const source = result.fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /float campus_reflectionValid = 0\.0;/)
  assert.doesNotMatch(source, /lightingStage\(material, attributes\);/)
  assert.match(source, /campus_reflectionSpecularOutput = vec4\(0\.0\);/)
  assert.match(source, /campus_reflectionResponse = vec4\(0\.0\);/)
  assert.match(source, /campus_materialOctNormal\(material.normalEC\)/)
  assert.match(source, /campus_transparentCoverage = 0\.0;/)
})

test('opaque-color layout retains native lighting for reflected and unsupported custom/styled materials', () => {
  for (const extra of [[], ['HAS_CUSTOM_FRAGMENT_SHADER'], ['HAS_MODEL_COLOR', 'HAS_SELECTED_FEATURE_ID']]) {
    const input = program([...pbr, 'HDR', 'SPECULAR_IBL', 'USE_IBL_LIGHTING', ...extra])
    input.fragmentShaderSource.sources.splice(1, 0, C._shadersImageBasedLightingStageFS, C._shadersLightingStageFS)
    const before = JSON.stringify(input)
    const source = adapter.materialSources(C, input, true, true).fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
    assert.match(source, /layout\(location = 6\) out vec4 campus_opaqueColor;/)
    assert.match(source, /czm_modelMaterial campus_baseMaterial = material;\s+lightingStage\(material, attributes\);/)
    assert.match(source, /campus_opaqueColor = color;/)
    assert.match(source, /campus_materialOctNormal\(campus_baseMaterial.normalEC\)/)
    for (const stage of ['modelColorStage(material);', 'cpuStylingStage(material, selectedFeature);', 'atmosphereStage(color, attributes);', 'modelClippingPolygonsStage();']) {
      assert.ok(source.indexOf(stage) < source.indexOf('campus_opaqueColor = color;'))
    }
    assert.equal(JSON.stringify(input), before)
    assert.doesNotMatch(adapter.materialSources(C, input, true).fragmentShaderSource.sources.join('\n'), /campus_opaqueColor/)
  }
})

test('albedo captures finite pre-lighting base color and occlusion at each active layout location', () => {
  for (const [reflection, opaqueColor, location] of [[false, false, 4], [true, false, 6], [true, true, 7]]) {
    const input = program([...pbr, 'HDR', 'SPECULAR_IBL', 'USE_IBL_LIGHTING'])
    input.fragmentShaderSource.sources.splice(1, 0, C._shadersImageBasedLightingStageFS, C._shadersLightingStageFS)
    const before = JSON.stringify(input)
    const source = adapter.materialSources(C, input, reflection, opaqueColor, true).fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
    assert.match(source, new RegExp(`layout\\(location = ${location}\\) out vec4 campus_albedoOcclusion;`))
    assert.match(source, /czm_modelMaterial campus_baseMaterial = material;/)
    assert.match(source, /campus_albedoOcclusion = vec4\(campus_baseMaterial\.baseColor\.rgb, campus_baseMaterial\.occlusion\);/)
    assert.match(source, /campus_materialFlags \+= 256\.0;/)
    assert.match(source, /campus_materialFlags \+= 512\.0;/)
    assert.match(source, /65504\.0/)
    assert.doesNotMatch(source, /clamp\(campus_baseMaterial\.baseColor/)
    assert.equal(JSON.stringify(input), before)
  }
})

test('standard PBR validity excludes special material and post-material color paths while MASK remains eligible', () => {
  const special = ['USE_SPECULAR', 'USE_CLEARCOAT', 'USE_ANISOTROPY', 'HAS_CUSTOM_VERTEX_SHADER',
    'HAS_CUSTOM_FRAGMENT_SHADER', 'HAS_MODEL_COLOR', 'HAS_SELECTED_FEATURE_ID', 'HAS_PRIMITIVE_OUTLINE',
    'USE_CPU_STYLING', 'HAS_CLIPPING_PLANES', 'ENABLE_CLIPPING_POLYGONS', 'HAS_EDGE_VISIBILITY',
    'HAS_EDGE_VISIBILITY_MRT', 'HAS_SILHOUETTE', 'HAS_POINT_CLOUD_COLOR_STYLE']
  const standard = adapter.materialSources(C, program([...pbr, 'ALPHA_MODE_MASK']), false, false, true)
    .fragmentShaderSource.sources.join('\n')
  assert.match(standard, /campus_materialFlags \+= 512\.0;/)
  for (const define of special) {
    const source = adapter.materialSources(C, program([...pbr, define]), false, false, true).fragmentShaderSource.sources.join('\n')
    assert.doesNotMatch(source, /campus_materialFlags \+= 512\.0;/, define)
    if (define.startsWith('HAS_CUSTOM_')) {
      assert.doesNotMatch(source, /campus_materialFlags \+= 256\.0;/, define)
      assert.match(source, /campus_albedoOcclusion = vec4\(0\.0\);/, define)
    }
  }
})

test('albedo-disabled shaders preserve the exact legacy low-byte flags and output layout', () => {
  const source = adapter.materialSources(C, program()).fragmentShaderSource.createCombinedFragmentShader({ webgl2: true })
  assert.match(source, /float campus_materialFlags = 11\.0;/)
  assert.doesNotMatch(source, /campus_albedoOcclusion|\+= 256\.0|\+= 512\.0/)
})

test('vertex-only custom shader defines exclude both new validity flags without mutating source', () => {
  const input = program()
  input.vertexShaderSource.defines.push('HAS_CUSTOM_VERTEX_SHADER')
  const original = JSON.stringify(input)
  const source = adapter.materialSources(C, input, false, false, true).fragmentShaderSource.sources.join('\n')
  assert.doesNotMatch(source, /campus_materialFlags \+= (256|512)\.0;/)
  assert.match(source, /campus_albedoOcclusion = vec4\(0\.0\);/)
  assert.equal(JSON.stringify(input), original)
})
