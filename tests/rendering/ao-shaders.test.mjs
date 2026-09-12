import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { aoShader, bilateralShader, resolveShader } from '../../src/ao/aoShaders143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const shaders = { aoShader, bilateralShader, resolveShader }

test('all AO passes combine with the actual Cesium GLSL3 shader source and explicit depth reconstruction', () => {
  for (const [name, shader] of Object.entries(shaders)) {
    const combined = new C.ShaderSource({ sources: [shader] }).createCombinedFragmentShader({ webgl2: true })
    assert.match(combined, /^#version 300 es/, name)
    assert.equal((combined.match(/out vec4 out_FragColor;/g) || []).length, 1, name)
    for (const uniform of ['highp sampler2D u_depth', 'highp sampler2D u_material', 'highp sampler2D u_flags', 'highp sampler2D u_hiz', 'highp sampler2D u_transparency', 'mat4 u_inverseProjection', 'float u_radius', 'float u_strength', 'float u_bias']) {
      assert.ok(combined.includes(`uniform ${uniform};`), `${name}: ${uniform}`)
    }
    assert.match(combined, /vec4 projected = u_inverseProjection \* vec4\(uv \* 2\.0 - 1\.0, 0\.0, 1\.0\)/)
    assert.match(combined, /ray \* \(texelFetch\(u_depth, pixel, 0\)\.r \/ -ray.z\)/)
    assert.doesNotMatch(combined, /czm_(?:readDepth|windowToEyeCoordinates|reverseLogDepth)/)
  }
})

test('known supported surfaces require positive finite eye depth and usable normals', () => {
  for (const shader of Object.values(shaders)) {
    assert.match(shader, /!aoFinite\(depth\) \|\| depth <= 0\.0/)
    assert.match(shader, /\(flags & 3\) == 3 && \(flags & \(16 \| 32 \| 64\)\) == 0/)
    assert.match(shader, /!isnan\(value\) && !isinf\(value\)/)
    assert.match(shader, /normal\.xy = \(1\.0 - abs\(normal\.yx\)\) \* direction/)
  }
  assert.match(aoShader, /range\.a > 0\.0 \|\| aoTransparentCell\(samplePixel\) \|\| sampleDepth < 0\.0 \|\| !aoFinite\(sampleDepth\)\) return/)
  assert.match(aoShader, /centerRange\.a > 0\.0 \|\| aoTransparentCell\(pixel\)\) return/)
  assert.ok(aoShader.indexOf('range.a > 0.0') < aoShader.indexOf('range.b <= 0.0'), 'unknown classification precedes HiZ rejection')
})

test('AO uses the closest depth tangents and a fixed world-space 8 by 4 sampling kernel', () => {
  assert.match(aoShader, /abs\(forward\.z\) <= abs\(backward\.z\)/)
  assert.match(aoShader, /normal = cross\(horizontal, vertical\)/)
  assert.match(aoShader, /dot\(normal, -position\) < 0\.0\) normal = -normal/)
  assert.match(aoShader, /if \(!aoGeometricNormal\(pixel, position, normal\)\) return/)
  assert.match(aoShader, /directionIndex < 8/)
  assert.match(aoShader, /radialIndex <= 4/)
  assert.match(aoShader, /ivec2\(round\(direction \* pixelRadius/)
  assert.match(aoShader, /1\.0, 64\.0\)/)
  assert.match(aoShader, /distance >= radius\) continue/)
  assert.match(aoShader, /max\(dot\(normal, delta \/ distance\) - bias, 0\.0\) \/ \(1\.0 - bias\)/)
  assert.match(aoShader, /contribution \* \(1\.0 - distance \/ radius\)/)
  assert.match(aoShader, /1\.0 - u_strength \* occlusion \/ 32\.0/)
  assert.doesNotMatch(aoShader, /czm_frameNumber|random|history|texture\(u_material/)
})

test('bilateral and joint resolve reject disjoint surfaces and unknown samples', () => {
  for (const shader of [bilateralShader, resolveShader]) {
    assert.match(shader, /uniform highp sampler2D u_visibility;/)
    assert.match(shader, /abs\(dot\(geometricNormal, delta\)\) > threshold\) return 0\.0/)
    assert.match(shader, /max\(0\.02, u_radius \* 0\.05\)/)
    assert.match(shader, /agreement < 0\.85\) return 0\.0/)
    assert.match(shader, /pow\(max\(agreement, 0\.0\), 16\.0\)/)
    assert.match(shader, /value\.g <= 0\.0\) continue/)
    assert.match(shader, /weightSum > 0\.0 \?.* : 1\.0/)
  }
  assert.match(bilateralShader, /uniform vec2 u_axis;/)
  assert.match(bilateralShader, /center\.g <= 0\.0 \|\| !aoReceiver\(pixel\)\) return/)
  assert.match(bilateralShader, /tap = -2; tap <= 2/)
  assert.match(bilateralShader, /tap == 0 \? 6\.0 : \(abs\(tap\) == 1 \? 4\.0 : 1\.0\)/)
  assert.match(bilateralShader, /vec4\(visibility, center\.g, 0\.0, 1\.0\)/)
  assert.match(resolveShader, /vec2 halfPosition = vec2\(pixel\) \* 0\.5/)
  assert.match(resolveShader, /vec2 fraction = fract\(halfPosition\)/)
  assert.match(resolveShader, /y < 2/)
  assert.match(resolveShader, /x < 2/)
  assert.doesNotMatch(resolveShader, /texture\(u_visibility/)
})

test('depth tangents outside the AO radius leave thin receivers unresolved instead of borrowing background AO', () => {
  for (const shader of Object.values(shaders)) {
    assert.match(shader, /float tangentLengthSquared = dot\(tangent, tangent\);/)
    assert.match(shader, /tangentLengthSquared > 1\.0e-12 && tangentLengthSquared <= u_radius \* u_radius/)
  }
  assert.match(resolveShader, /out_FragColor = source;/)
  assert.match(resolveShader, /if \(!aoGeometricNormal\(pixel, position, geometricNormal\)\) return;/)
})

test('transparent coverage excludes receivers and invalidates AO samples at the matching HiZ footprint', () => {
  for (const shader of Object.values(shaders)) {
    assert.match(shader, /texelFetch\(u_transparency, pixel, 0\)\.r > 0\.0\) return false;/)
    assert.match(shader, /ivec2 base = \(pixel \/ 2\) \* 2;/)
    assert.match(shader, /aoInside\(covered\) && texelFetch\(u_transparency, covered, 0\)\.r > 0\.0\) return true;/)
    assert.doesNotMatch(shader, /texture\(u_transparency/)
  }
  assert.match(aoShader, /centerRange\.a > 0\.0 \|\| aoTransparentCell\(pixel\)\) return;/)
  assert.match(aoShader, /range\.a > 0\.0 \|\| aoTransparentCell\(samplePixel\) \|\| sampleDepth < 0\.0/)
  assert.ok(resolveShader.indexOf('out_FragColor = source;') < resolveShader.indexOf('if (!aoReceiver(pixel)) return;'))
})

test('resolve preserves source alpha, emission and HDR values without tone or gamma operations', () => {
  assert.match(resolveShader, /uniform highp sampler2D colorTexture;/)
  assert.match(resolveShader, /out_FragColor = source;/)
  assert.match(resolveShader, /vec3 emission = min\(max\(texelFetch\(u_flags, pixel, 0\)\.rgb, vec3\(0\.0\)\), max\(source\.rgb, vec3\(0\.0\)\)\)/)
  assert.match(resolveShader, /vec4\(emission \+ \(source\.rgb - emission\) \* visibility, source\.a\)/)
  assert.doesNotMatch(resolveShader, /clamp\(source|gamma|tonemap|czm_aces|pow\(source/)
})
