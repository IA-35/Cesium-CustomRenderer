import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { EXTMeshFeatures, EXTStructuralMetadata, KHRDracoMeshCompression, ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco from 'draco3dgltf'
import { MeshoptDecoder } from 'meshoptimizer'
import { createRequire } from 'node:module'
import { buildOverview } from './overview.mjs'
const {Matrix4,Cartesian3,Axis}=createRequire(import.meta.url)('cesium')

function editJSON(bytes,edit){
  const length=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+length));edit(json)
  const text=Buffer.from(JSON.stringify(json)),padding=Buffer.alloc((4-text.length%4)%4,32),tail=bytes.subarray(20+length),header=Buffer.from(bytes.subarray(0,20))
  header.writeUInt32LE(20+text.length+padding.length+tail.length,8);header.writeUInt32LE(text.length+padding.length,12)
  return Buffer.concat([header,text,padding,tail])
}

function worldVertices(doc,tileTransform){
  const vertices=[]
  doc.getRoot().listScenes()[0].traverse(node=>{
    if(!node.getMesh())return
    const matrix=Matrix4.multiply(tileTransform,Matrix4.multiply(Axis.Y_UP_TO_Z_UP,Matrix4.fromArray(node.getWorldMatrix()),new Matrix4()),new Matrix4())
    for(const p of node.getMesh().listPrimitives()){
      const a=p.getAttribute('POSITION')
      for(const index of p.getIndices().getArray()){
        const point=Matrix4.multiplyByPoint(matrix,Cartesian3.fromArray(a.getElement(index,[])),new Cartesian3())
        vertices.push([point.x,point.y,point.z].map(n=>Math.round(n*10000)/10000).join(','))
      }
    }
  })
  return vertices.sort()
}

async function fixture(dir, name, malformedDraco = false) {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene()
  const meta = doc.createExtension(EXTStructuralMetadata).setRequired(true)
  const klass = meta.createClass().setProperty('name', meta.createClassProperty().setType('STRING'))
  const table = meta.createPropertyTable().setClass('building').setCount(1)
  const bytes = new TextEncoder().encode(name)
  table.setProperty('name', meta.createPropertyTableProperty().setValues(bytes)
    .setStringOffsetType('UINT32').setStringOffsets(new Uint8Array(new Uint32Array([0, bytes.length]).buffer)))
  doc.getRoot().setExtension('EXT_structural_metadata', meta.createStructuralMetadata()
    .setSchema(meta.createSchema().setId('test').setClass('building', klass)).addPropertyTable(table))
  const ext = doc.createExtension(EXTMeshFeatures).setRequired(true)
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial().setBaseColorFactor([.3,.5,.7,1]))
    .setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint16Array([0,1,2])))
    .setAttribute('POSITION',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])))
    .setAttribute('_FEATURE_ID_0',doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint8Array([0,0,0])))
  prim.setExtension('EXT_mesh_features',ext.createFeatures().addFeatureID(ext.createFeatureID().setAttribute(0).setFeatureCount(1).setPropertyTable(table)))
  scene.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)))
  const file=path.join(dir,name+'.glb')
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS)
  if(malformedDraco){
    doc.createExtension(KHRDracoMeshCompression).setRequired(true)
    io.registerDependencies({'draco3d.encoder':await draco.createEncoderModule()})
    const bytes=Buffer.from(await io.writeBinary(doc))
    await fs.writeFile(file,editJSON(bytes,json=>{
      const p=json.meshes[0].primitives[0]
      json.accessors[p.indices].bufferView=p.extensions.KHR_draco_mesh_compression.bufferView
      json.accessors[p.indices].byteOffset=1
      json.accessors[p.indices].count=10000
    }))
  } else await io.write(file,doc)
  return file
}

test('overview joins compatible floors and preserves transformed geometry and feature rows',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ccr-overview-'))
  try {
    const files=await Promise.all(['floor1','floor2'].map(n=>fixture(dir,n)))
    const originals=await Promise.all(files.map(f=>fs.readFile(f)))
    const input=path.join(dir,'tileset.json'),output=path.join(dir,'out')
    const secondTransform=[0,1,0,0,-1,0,0,0,0,0,1,0,10,3,5,1]
    await fs.writeFile(input,JSON.stringify({asset:{version:'1.1'},geometricError:10,root:{boundingVolume:{sphere:[0,0,0,100]},geometricError:10,refine:'REPLACE',children:[
      {boundingVolume:{sphere:[0,0,0,2]},geometricError:0,content:{uri:'floor1.glb'}},
      {transform:secondTransform,boundingVolume:{sphere:[0,0,0,2]},geometricError:0,content:{uri:'floor2.glb'}}]}}))
    const result=await buildOverview(input,output)
    assert.equal(result.before.primitives,2)
    assert.equal(result.after.primitives,1)
    assert.equal(result.after.triangles,2)
    assert.equal(result.features,2)
    const outputTiles=JSON.parse(await fs.readFile(path.join(output,'tileset.json'),'utf8'))
    assert.ok(outputTiles.geometricError>0,'Cesium root traversal must not terminate before visiting the content')
    const doc=await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path.join(output,'overview.glb'))
    const prim=doc.getRoot().listMeshes()[0].listPrimitives()[0]
    assert.deepEqual([...new Set(prim.getAttribute('_FEATURE_ID_0').getArray())],[0,1])
    const io=new NodeIO().registerExtensions(ALL_EXTENSIONS)
    const expected=[...worldVertices(await io.read(files[0]),Matrix4.IDENTITY),...worldVertices(await io.read(files[1]),Matrix4.fromArray(secondTransform))].sort()
    assert.deepEqual(worldVertices(doc,Matrix4.fromArray(outputTiles.root.transform)),expected,'world-space triangles survive both axis conversion and tile rotation')
    const table=doc.getRoot().getExtension('EXT_structural_metadata').listPropertyTables()[0]
    assert.equal(new TextDecoder().decode(table.getProperty('name').getValues()),'floor1floor2')
    assert.deepEqual(await Promise.all(files.map(f=>fs.readFile(f))),originals)
    const compact=path.join(dir,'compact')
    await buildOverview(input,compact,{compact:true})
    await MeshoptDecoder.ready
    const packed=await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}).read(path.join(compact,'overview.glb'))
    const packedPrim=packed.getRoot().listMeshes()[0].listPrimitives()[0]
    assert.equal(packedPrim.getAttribute('POSITION').getComponentSize(),2)
    assert.deepEqual([...new Set(packedPrim.getAttribute('_FEATURE_ID_0').getArray())],[0,1])
    assert.ok(packed.getRoot().listExtensionsRequired().some(e=>e.extensionName==='EXT_meshopt_compression'))
    const unsupported=await io.read(files[0]);unsupported.getRoot().listMaterials()[0].setAlphaMode('BLEND');await io.write(files[0],unsupported)
    await assert.rejects(buildOverview(input,path.join(dir,'blend')),/BLEND/)
    await assert.rejects(buildOverview(input,dir),/output/i)
    await assert.rejects(buildOverview(input,output),/exist/i)
  } finally { await fs.rm(dir,{recursive:true,force:true}) }
})

test('rejects unknown extensions before the glTF reader can silently omit them',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ccr-overview-unsupported-'))
  try{
    const file=await fixture(dir,'custom'),bytes=await fs.readFile(file),input=path.join(dir,'tileset.json')
    await fs.writeFile(file,editJSON(bytes,j=>{j.extensionsUsed.push('VENDOR_test');j.meshes[0].primitives[0].extensions.VENDOR_test={meaningful:1}}))
    await fs.writeFile(input,JSON.stringify({asset:{version:'1.1'},root:{boundingVolume:{sphere:[0,0,0,2]},geometricError:0,content:{uri:'custom.glb'}}}))
    await assert.rejects(buildOverview(input,path.join(dir,'out')),/Unsupported extension: VENDOR_test/)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('required Draco indices referencing the compressed blob are normalized in the copy only',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ccr-overview-draco-'))
  try{
    const file=await fixture(dir,'compressed',true),original=await fs.readFile(file),input=path.join(dir,'tileset.json')
    await fs.writeFile(input,JSON.stringify({asset:{version:'1.1'},geometricError:0,root:{boundingVolume:{sphere:[0,0,0,2]},geometricError:0,content:{uri:'compressed.glb'}}}))
    const result=await buildOverview(input,path.join(dir,'out'))
    assert.equal(result.after.triangles,1)
    assert.equal(result.sources[0].normalizedDracoIndices,1)
    assert.deepEqual(await fs.readFile(file),original)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})
