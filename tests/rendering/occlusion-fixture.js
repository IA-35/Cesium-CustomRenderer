import {cubeUrl} from './stage1-scene.js'
import {waitFrames} from './deferred-lighting-fixture.js'
export async function startOcclusionFixture(f,{dense=false}={}){
 const C=Cesium,s=f.viewer.scene,origin=C.Cartesian3.fromDegrees(120,40),frame=C.Transforms.eastNorthUpToFixedFrame(origin)
 f.origin=origin;s.globe.show=false;s.skyBox.show=false;s.skyAtmosphere.show=false;s.sun.show=false;s.moon.show=false
 f.viewer.clock.shouldAnimate=false;f.viewer.clock.currentTime=C.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
 f.models=[]
 let denseUrl
 if(dense){
  const geometry=C.SphereGeometry.createGeometry(new C.SphereGeometry({radius:.5,stackPartitions:96,slicePartitions:96,vertexFormat:C.VertexFormat.POSITION_AND_NORMAL}))
  const arrays=[new Float32Array(geometry.attributes.position.values),new Float32Array(geometry.attributes.normal.values),geometry.indices]
  const gltf=JSON.parse(decodeURIComponent(cubeUrl(C,[.5,.6,.7,1]).split(',')[1]))
  gltf.buffers=arrays.map(a=>{let s='';for(const byte of new Uint8Array(a.buffer))s+=String.fromCharCode(byte);return{uri:'data:application/octet-stream;base64,'+btoa(s),byteLength:a.byteLength}})
  gltf.bufferViews=arrays.map((a,i)=>({buffer:i,byteLength:a.byteLength}));gltf.accessors[0].count=arrays[0].length/3;gltf.accessors[1].count=arrays[1].length/3;gltf.accessors[2].count=arrays[2].length;gltf.accessors[2].componentType=arrays[2] instanceof Uint32Array?5125:5123
  denseUrl='data:model/gltf+json,'+encodeURIComponent(JSON.stringify(gltf))
 }
 const add=async(pos,size,id)=>{const matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(...pos)),new C.Matrix4());C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(...size),matrix)
  const model=await C.Model.fromGltfAsync({url:dense&&id!=='wall'?denseUrl:cubeUrl(C,[.5,.6,.7,1]),modelMatrix:matrix,id});s.primitives.add(model);f.models.push(model);return model}
 f.wall=await add([0,-20,25],[95,4,55],'wall')
 for(let x=-4;x<=4;x++)for(let y=0;y<5;y++)await add([x*8,5+y*9,5],[5,5,10],'object-'+x+'-'+y)
 f.pipeline=f.CCR.createVisualPipeline({Cesium:C,viewer:f.viewer,options:{environment:false,clouds:false,shadows:false,antialiasing:'off',fog:false}})
 f.viewer.camera.lookAt(C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(0,15,12),new C.Cartesian3()),new C.HeadingPitchRange(0,-.12,150));f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
 await waitFrames(s,40,f.errors)
 for(const model of f.models)model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,0)
 await waitFrames(s,12,f.errors)
 return f
}
