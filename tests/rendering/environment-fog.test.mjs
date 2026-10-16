import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { heightFogGLSL, heightFogOpticalDepthReference } from '../../src/environment/heightFog143.js'
import { resolveEnvironmentState } from '../../src/environment/environmentState.js'
import { createEnvironmentStages } from '../../src/environment/environmentStages.js'
import * as fog from '../../src/environment/environmentFog143.js'

const profile = { density0: 0.000025, baseHeight: 20, scaleHeight: 180,
  originHeight: 100, upDotRay: 0, distance: 4000 }
const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`)
}

test('long ground and orbital fog rays use spherical altitude instead of extrapolating underground',()=>{
  assert.equal(typeof fog.sphericalEnvironmentFogOpticalDepth,'function')
  const radius=6371000,height=12000,angle=4*Math.PI/180
  const origin=[0,0,radius+height],direction=[Math.cos(angle),0,-Math.sin(angle)]
  const b=origin[2]*direction[2],c=height*(2*radius+height)
  const distance=-b-Math.sqrt(b*b-c)
  const old=fog.environmentFogOpticalDepth({...profile,originHeight:height,upDotRay:direction[2],distance})
  close(old,80)
  const tau=fog.sphericalEnvironmentFogOpticalDepth({...profile,radius,origin,direction,distance})
  assert.ok(tau>0&&tau<0.5,`spherical atmosphere became opaque: ${tau}`)
  // Independent Simpson integration of true radial height; no planar adapter.
  const steps=65536,dt=distance/steps
  let sum=0
  for(let i=0;i<=steps;i++){
    const t=i*dt,h=Math.hypot(...origin.map((v,k)=>v+direction[k]*t))-radius
    const density=profile.density0*Math.exp(-(h-profile.baseHeight)/profile.scaleHeight)
    sum+=density*(i===0||i===steps?1:i%2?4:2)
  }
  const reference=sum*dt/3
  assert.ok(Math.abs(tau-reference)/reference<0.01,`${tau} differs from radial reference ${reference}`)
  const orbit=8000000
  for(const angle of [0,10,20]){
    const a=angle*Math.PI/180,origin=[0,0,radius+orbit],direction=[Math.sin(a),0,-Math.cos(a)]
    const b=origin[2]*direction[2],c=orbit*(2*radius+orbit),distance=-b-Math.sqrt(b*b-c)
    const tau=fog.sphericalEnvironmentFogOpticalDepth({...profile,radius,origin,direction,distance})
    assert.ok(tau>=0&&tau<0.05,`orbital ground color is erased at ${angle} degrees: ${tau}`)
  }
})

test('spherical fog preserves negative geodetic altitude rather than clamping it to sea level',()=>{
  const radius=6371000,height=-400,distance=1000
  const parameters={...profile,radius,origin:[0,0,radius+height],direction:[1,0,0],distance}
  const tau=fog.sphericalEnvironmentFogOpticalDepth(parameters)
  const seaLevel=fog.sphericalEnvironmentFogOpticalDepth({...parameters,origin:[0,0,radius]})
  assert.ok(tau>seaLevel*9)
  assert.ok(Math.abs(tau-0.257769)/0.257769<0.001)
  assert.ok(Math.abs(Math.exp(-tau)-0.77277372)<0.001)
})

test('finite environment fog reuses the height-fog integral', () => {
  assert.equal(typeof fog.environmentFogOpticalDepth, 'function')
  for (const [originHeight, upDotRay, distance] of [
    [100, 0, 4000], [100, 1e-9, 8000], [10, 0.7, 8000],
    [2000, -0.2, 8000], [-300, 0.1, 4000], [200, -0.001, 8000]
  ]) {
    const parameters = { ...profile, originHeight, upDotRay, distance }
    const reference = heightFogOpticalDepthReference({ ...parameters,
      originZ: originHeight, directionZ: upDotRay, end: distance, steps: 32768 })
    close(fog.environmentFogOpticalDepth(parameters), Math.min(reference, 80))
  }
})

test('fog density, base height, falloff and distance affect finite surfaces', () => {
  assert.equal(typeof fog.environmentFogOpticalDepth, 'function')
  const tau = parameters => fog.environmentFogOpticalDepth({ ...profile, ...parameters })
  const base = tau({})
  close(tau({ density0: profile.density0 * 2 }), base * 2)
  close(tau({ distance: profile.distance * 2 }), base * 2)
  close(tau({ baseHeight: profile.baseHeight + profile.scaleHeight }), base * Math.E)
  assert.ok(tau({ scaleHeight: 360 }) > base)
  assert.ok(tau({ originHeight: 300 }) < base)
  const clear = resolveEnvironmentState({ environmentPreset: 'clear' })
  const morning = resolveEnvironmentState({ environmentPreset: 'morning' })
  const depth = state => tau({ density0: state.fogDensity, scaleHeight: state.fogScaleHeight,
    baseHeight: state.fogBaseHeight, originHeight: 20, distance: 1000 })
  assert.ok(depth(morning) > depth(clear), 'preset density must reach the actual transport')
  assert.ok(depth(clear) < 0.03, 'clear default must remain a thin regional surface fog')
})

test('disabled, zero-density, zero-distance and infinite-sky fog are identities', () => {
  assert.equal(typeof fog.environmentFogTransport, 'function')
  for (const parameters of [
    { fog: false, volumetricFog: false }, { density0: 0 }, { distance: 0 },
    { distance: -1 }, { distance: Infinity }, { distance: NaN }, { distance: 20000000 }
  ]) {
    assert.deepEqual(fog.environmentFogTransport({ ...profile,
      sourceRadiance: [0.3, 0.43, 0.65], ...parameters }), { scattering: [0, 0, 0], transmittance: 1 })
  }
})

test('extreme downward and below-sea-level paths have bounded finite transport', () => {
  assert.equal(typeof fog.environmentFogTransport, 'function')
  for (const parameters of [
    { originHeight: -1000, scaleHeight: 10, upDotRay: -1, distance: 19999999 },
    { originHeight: 100000, scaleHeight: 10, upDotRay: -1, distance: 19999999 },
    { originHeight: 100000, scaleHeight: 10, upDotRay: 0, distance: 19999999 }
  ]) {
    const value = fog.environmentFogTransport({ ...profile, ...parameters, sourceRadiance: [0.3, 0.43, 0.65] })
    assert.ok(Number.isFinite(value.transmittance) && value.transmittance >= Math.exp(-80) && value.transmittance <= 1)
    assert.ok(value.scattering.every(channel => Number.isFinite(channel) && channel >= 0))
  }
})

test('only volumetric fog enables the optional atlas density modulation', () => {
  assert.equal(typeof fog.environmentFogTransport, 'function')
  const transport = parameters => fog.environmentFogTransport({ ...profile,
    sourceRadiance: [0.3, 0.43, 0.65], fogNoise: 0.45, ...parameters })
  assert.deepEqual(transport({ noiseSample: 0 }), transport({ noiseSample: 1 }))
  assert.ok(transport({ fog: false, volumetricFog: true, noiseSample: 1 }).transmittance <
    transport({ fog: false, volumetricFog: true, noiseSample: 0 }).transmittance)
  assert.deepEqual(transport({ volumetricFog: true, noiseSample: 0.5 }), transport({}))
})

test('ordered fog segments compose to the full finite ray', () => {
  assert.equal(typeof fog.environmentFogTransport, 'function')
  const parameters = { ...profile, originHeight: 300, upDotRay: -0.025,
    sourceRadiance: [0.3, 0.43, 0.65] }
  const full = fog.environmentFogTransport(parameters)
  const near = fog.environmentFogTransport({ ...parameters, distance: 1500 })
  const far = fog.environmentFogTransport({ ...parameters,
    originHeight: parameters.originHeight + parameters.upDotRay * 1500, distance: 2500 })
  close(near.transmittance * far.transmittance, full.transmittance)
  for (let channel = 0; channel < 3; channel++) {
    close(near.scattering[channel] + near.transmittance * far.scattering[channel], full.scattering[channel])
    close(full.scattering[channel], parameters.sourceRadiance[channel] * (1 - full.transmittance))
  }
})

test('GLSL contract preserves analytic reuse, both flags and sky-depth identity', () => {
  assert.equal(typeof fog.environmentFogGLSL, 'string')
  assert.ok(fog.environmentFogGLSL.includes(heightFogGLSL))
  assert.match(fog.environmentFogGLSL, /uniform vec4 fogParams;/)
  assert.match(fog.environmentFogGLSL, /uniform float fogBaseHeight;/)
  assert.match(fog.environmentFogGLSL, /float ccrHeightFogOpticalDepth\(/)
  assert.match(fog.environmentFogGLSL, /vec4 ccrEnvironmentFogTransport\(/)
  assert.match(fog.environmentFogGLSL, /effectFlags\.x > 0\.5 \|\| effectFlags\.w > 0\.5/)
  assert.match(fog.environmentFogGLSL, /distance < 20000000\.0/)
  assert.match(fog.environmentFogGLSL, /vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/)
  assert.doesNotMatch(fog.environmentFogGLSL, /sunRadiance|exposure|texture\(/)
})

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const createStages = (overrides = {}) => {
  class Stage { constructor(options) { Object.assign(this, options) } }
  class Composite { constructor(options) { Object.assign(this, options) } }
  const bindings = Object.fromEntries(['eyeToLocal', 'atmosphereOrigin', 'cloudNoiseOrigin', 'originalHdr',
    'sunDirectionLocal', 'atmosphereSunRadiance', 'atmosphereMieParameters', 'sunRadiance', 'skyRadiance',
    'cloudParams', 'cloudWind', 'noiseTexture', 'atmosphereParams', 'effectFlags'].map(name => [name, () => null]))
  return createEnvironmentStages({ ...C, PostProcessStage: Stage, PostProcessStageComposite: Composite },
    { ...bindings, ...overrides })
}

test('environment binds live fog callbacks and supplies zero-density defaults to older callers', () => {
  let state = resolveEnvironmentState({ fogBaseHeight: -980, fogHeightFalloff: 80 })
  const fogParams = () => new C.Cartesian4(state.fogDensity, state.fogScaleHeight, state.fogNoise, 5)
  const fogBaseHeight = () => state.fogBaseHeight
  const stages = createStages({ fogParams, fogBaseHeight })
  for (const stage of [stages.raymarchStage, stages.transmissionStage, stages.resolveStage, stages.occlusionStage]) {
    assert.equal(stage.uniforms.fogParams, fogParams)
    assert.equal(stage.uniforms.fogBaseHeight, fogBaseHeight)
    assert.equal(stage.uniforms.fogParams().y, 80)
    assert.equal(stage.uniforms.fogBaseHeight(), -980)
  }
  state = resolveEnvironmentState({ environmentPreset: 'morning', fogBaseHeight: 400, fogHeightFalloff: 800 })
  assert.equal(stages.raymarchStage.uniforms.fogParams().x, state.fogDensity)
  assert.equal(stages.raymarchStage.uniforms.fogParams().y, 800)
  assert.equal(stages.raymarchStage.uniforms.fogBaseHeight(), 400)
  const defaults = createStages()
  assert.equal(defaults.raymarchStage.uniforms.fogParams().x, 0)
  assert.equal(defaults.raymarchStage.uniforms.fogBaseHeight(), 0)
})

test('scene fog is gated before synthetic ground clipping and composes across the cloud layer', () => {
  const stages = createStages()
  const shader = stages.raymarchStage.fragmentShader
  const body = shader.slice(shader.lastIndexOf('void main()'))
  assert.match(body, /float distance = sceneDistance\(uv\);\s*bool finiteSurface = distance < DEPTH_LIMIT;/)
  assert.ok(body.indexOf('bool finiteSurface') < body.indexOf('ccrAtmosphereIntersect'),
    'the synthetic ground sphere must not make a sky-only ray count as a finite scene surface')
  assert.match(body, /bool atmosphereEnabled = effectFlags\.z > 0\.5;/)
  assert.match(body, /bool fogEnabled\s*=\s*finiteSurface\s*&&\s*\(effectFlags\.x\s*>\s*0\.5\s*\|\|\s*effectFlags\.w\s*>\s*0\.5\)/)
  assert.match(body, /ccrSceneMedium\(origin \+ direction \* cloudDistance,\s*direction, max\(distance - cloudDistance, 0\.0\), sceneColor,atmosphereEnabled,fogEnabled,noiseSample,transmittance\)/)
  assert.match(body, /color = clouds\.rgb \+ clouds\.a \* background;/)
  assert.match(body, /ccrSceneMedium\(origin,direction,cloudDistance,color,atmosphereEnabled,fogEnabled,noiseSample,transmittance\)/)
  assert.match(body, /ccrSceneMedium\(origin,direction,distance,sceneColor,atmosphereEnabled,fogEnabled,noiseSample,transmittance\)/)
  assert.match(shader, /ccrSphericalFogTransport\(origin,direction,atmosphereParams\.x,distance,source,noiseSample\)/)
  const transmission = stages.transmissionStage.fragmentShader
  assert.match(transmission, /bool finiteSurface=sceneDistance\(uv\)<DEPTH_LIMIT;/)
  assert.match(transmission, /transmission\*=ccrSegmentFog\(atmosphereOrigin,direction,cloudDistance,noiseSample\)\.a\s*\*ccrSegmentFog\(atmosphereOrigin\+direction\*cloudDistance,direction,max\(distance-cloudDistance,0\.0\),noiseSample\)\.a/)
})
