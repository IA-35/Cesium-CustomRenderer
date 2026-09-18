import {cubeUrl} from './stage1-scene.js'
import {waitFrames} from './ssr-surfaces-fixture.js'

// Command-heavy geometry, without private assets or remote services. The campus
// check separately covers real Tiles, textures and asset traversal.
export async function loadPerformanceScene(f) {
  const C=Cesium,s=f.viewer.scene
  f.origin=C.Cartesian3.fromDegrees(116.39,39.9)
  const frame=C.Transforms.eastNorthUpToFixedFrame(f.origin),url=cubeUrl(C)
  f.models=[]
  for(let x=-7;x<=7;x++)for(let y=-7;y<=7;y++) {
    const height=12+((x*x+y*y)%7)*7
    const matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(x*40,y*40,height/2)),new C.Matrix4())
    C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(20,20,height),matrix)
    const model=await C.Model.fromGltfAsync({url,modelMatrix:matrix,id:`building-${x}-${y}`})
    s.primitives.add(model);f.models.push(model)
  }
  f.performanceOwners=new Set(f.models)
  applyPerformanceTrack(f,'orbit',0)
  for(let i=0;i<120&&!f.models.every(m=>m.ready);i++)await waitFrames(s,1,f.errors)
  if(!f.models.every(m=>m.ready))throw new Error('Performance models did not become ready')
  await waitFrames(s,10,f.errors)
  return readPerformanceLoad(f)
}

export function applyPerformanceTrack(f,track,t) {
  const C=Cesium
  const heading=track==='orbit'?t:0
  const pitch=track==='pitch'?-.75+.2*Math.sin(t):-.65
  const range=track==='altitude'?1250+250*Math.sin(t):1250
  f.viewer.camera.lookAt(f.origin,new C.HeadingPitchRange(heading,pitch,range))
  f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
}

export function readPerformanceLoad(f) {
  const C=Cesium,s=f.viewer.scene,commands=new Set()
  for(const bin of s._view.frustumCommandsList)for(const pass of [C.Pass.OPAQUE,C.Pass.CESIUM_3D_TILE])
    for(let i=0;i<(bin.indices[pass]||0);i++) {
      const command=bin.commands[pass][i]
      if(f.performanceOwners.has(command.owner))commands.add(command)
    }
  return {models:f.models.length,draws:commands.size,
    triangles:[...commands].reduce((n,c)=>n+(c.count||0)*(c.instanceCount||1)/3,0),
    primitives:s.primitives.length,scope:'visible model commands in main-view frustum bins, deduplicated'}
}
