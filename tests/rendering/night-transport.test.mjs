import test from 'node:test'
import assert from 'node:assert/strict'
import {createEnvironmentStages} from '../../src/environment/environmentStages.js'
import {cloudGLSL} from '../../src/environment/volumetricClouds143.js'
import {createRequire} from 'node:module'
const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

test('cloud lunar source has independent extinction and is separate from the solar daylight source',()=>{
  const shader=cloudGLSL('balanced')
  assert.match(shader,/ccrCloudLightOpticalDepth\(position, moonDirectionAtmo\)/)
  assert.match(shader,/moonRadiance \* ccrCloudLightTransmittance\(position, moonDirectionAtmo\)/)
  assert.match(shader,/lighting \+= nightSkyRadiance/)
})

test('environment stages bind zero night energy for existing integrations and include night transport',()=>{
  const vector=()=>C.Cartesian3.UNIT_Z
  const uniforms=Object.fromEntries(['eyeToLocal','atmosphereOrigin','cloudNoiseOrigin','effectFlags','originalHdr',
    'sunDirectionLocal','atmosphereSunRadiance','atmosphereMieParameters','sunRadiance','skyRadiance','cloudParams',
    'windOffset','noiseTexture','atmosphereParams','sourceSize'].map(name=>[name,vector]))
  const stages=createEnvironmentStages(C,uniforms)
  try {
    assert.deepEqual(stages.cloudStage.uniforms.moonRadiance(),C.Cartesian3.ZERO)
    assert.deepEqual(stages.cloudStage.uniforms.nightSkyRadiance(),C.Cartesian3.ZERO)
    assert.match(stages.raymarchStage.fragmentShader,/ccrNightAtmosphere\(/)
    assert.match(stages.raymarchStage.fragmentShader,/source\+=nightSkyRadiance/)
  }finally{stages.composite.destroy();stages.cloudComposite.destroy();stages.occlusionStage.destroy()}
})
