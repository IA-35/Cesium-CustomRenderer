import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import getRuntime from '../../vendor/cesium-ez-tree/runtime.js'
import { receiverSource, casterSources } from '../../src/shadows/shaderAdapter143.js'
import VS from '../../vendor/cesium-ez-tree/src/EzTree/Shaders/EzTreeInstancedVS.js'
import FS from '../../vendor/cesium-ez-tree/src/EzTree/Shaders/EzTreeVegetationFS.js'

const C=createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
test('upstream 20-byte attributes round-trip surveyed ENU coordinates within quantization error',()=>{
  const runtime=getRuntime(C)
  const positions=[new C.Cartesian3(-360,125,2),new C.Cartesian3(615,635,2.3),new C.Cartesian3(100,-274,1.9)]
  const packed=runtime.createEzTreeInstanceAttributes(positions.map((translation,i)=>({translation,scale:1,heading:i,color:C.Color.WHITE})))
  assert.equal(packed.byteLength,positions.length*20)
  const words=new Uint16Array(packed.values.buffer)
  positions.forEach((p,i)=>['x','y','z'].forEach((axis,j)=>{
    const restored=packed.translationMinimum[axis]+words[i*10+j]/65535*packed.translationDecodeScale[axis]
    assert.ok(Math.abs(restored-p[axis])<0.02)
  }))
  assert.equal(getRuntime(C),runtime)
})

test('upstream primitive handles non-shadow native updateForPass calls safely',()=>{
  const p=new (getRuntime(C).EzTreePrimitive)({instances:[],castShadows:true})
  assert.doesNotThrow(()=>p.updateForPass({},{}))
  p.destroy();assert.equal(p.isDestroyed(),true)
})

test('explicit grass assets partition every instance once and normalize alpha cutout',()=>{
  const runtime=getRuntime(C)
  const assets=[{id:'grass-10',url:'/grass-10.glb'},{id:'grass-17',url:'/grass-17.glb'}]
  const instances=[
    {kind:'grass',asset:'grass-10',id:'a'},
    {kind:'grass',asset:'grass-17',id:'b'},
    {kind:'grass',asset:'grass-10',id:'c'},
  ]
  const groups=runtime.groupGrassAssets(instances,assets)
  assert.equal(groups.size,2)
  assert.deepEqual(groups.get('grass-10').instances.map(item=>item.id),['a','c'])
  assert.deepEqual(groups.get('grass-17').instances.map(item=>item.id),['b'])
  assert.equal(groups.get('grass-10').alphaCutoff,0.35)
  assert.equal(groups.get('grass-17').alphaCutoff,0.35)
  assert.throws(()=>runtime.groupGrassAssets([{kind:'grass',asset:'missing'}],assets),/Unknown grass asset/)
})

test('byte-identical material images share one canonical record without trusting hash collisions',()=>{
  const runtime=getRuntime(C)
  const make=values=>{
    const image={bytes:new Uint8Array(values),mimeType:'image/webp',texture:undefined}
    return {imageRecords:[image],primitiveRecords:[{material:{imageRecord:image}}]}
  }
  const records=[make([1,2,3,4]),make([1,2,3,4]),make([4,3,2,1])]
  const result=runtime.canonicalizeImageRecords(records,()=> 'forced-collision')
  assert.equal(result.unique.length,2)
  assert.equal(records[1].primitiveRecords[0].material.imageRecord,records[0].primitiveRecords[0].material.imageRecord)
  assert.notEqual(records[2].primitiveRecords[0].material.imageRecord,records[0].primitiveRecords[0].material.imageRecord)
  assert.equal(result.sharedCount,1)
})

test('shared image texture is destroyed exactly once across both asset records',()=>{
  const runtime=getRuntime(C)
  const make=values=>{
    const image={bytes:new Uint8Array(values),mimeType:'image/webp',texture:undefined}
    return {imageRecords:[image],primitiveRecords:[{material:{imageRecord:image}}]}
  }
  const records=[make([1,2,3]),make([1,2,3])]
  runtime.canonicalizeImageRecords(records)
  let destroys=0
  records[0].imageRecords[0].texture={destroy(){destroys++;return undefined}}
  runtime.destroyEzTreeGltfAssetRecord(records[0])
  runtime.destroyEzTreeGltfAssetRecord(records[1])
  assert.equal(destroys,1)
})

test('ez-tree receiver retains ambient color and depth variant retains cutout alpha without lighting',()=>{
  const shader=new C.ShaderSource({sources:[FS]})
  const receiver=receiverSource(C,shader,false,true)
  assert.ok(receiver)
  assert.match(receiver.sources.join('\n'),/ccr_ezTreeVisibility = campus_shadowVisibility\(v_positionEC, normalEC\)/)
  assert.match(receiver.sources.join('\n'),/vec3\(0\.38\) \+ czm_lightColor/)
  const caster=casterSources(C,{vertexShaderSource:new C.ShaderSource({sources:[VS]}),fragmentShaderSource:shader})
  assert.ok(caster.fragmentShaderSource.defines.includes('SHADOW_MAP'))
  const fs=caster.fragmentShaderSource.sources.join('\n')
  assert.ok(fs.indexOf('mask < u_alphaCutoff')<fs.indexOf('#ifdef SHADOW_MAP'))
  assert.match(fs,/#ifdef SHADOW_MAP\s+out_FragColor = vec4\(1\.0\);\s+return;/)
})
