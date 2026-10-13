import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO, PropertyType, Logger } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshFeatures, EXTStructuralMetadata, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { mergeDocuments, dedup, flatten, join, unpartition, prune, quantize } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import draco from 'draco3dgltf'
const { Matrix4, Matrix3, Cartesian3, BoundingSphere, OrientedBoundingBox, Axis } = createRequire(import.meta.url)('cesium')

const multiply = (a,b) => Matrix4.multiply(a,b,new Matrix4())
const supported = new Set(['KHR_draco_mesh_compression','EXT_mesh_features','EXT_structural_metadata','KHR_texture_basisu','KHR_texture_transform','KHR_materials_unlit'])
const stat = doc => {
  const prims=doc.getRoot().listMeshes().flatMap(m=>m.listPrimitives())
  return {primitives:prims.length,triangles:prims.reduce((n,p)=>n+(p.getIndices()?.getCount()||p.getAttribute('POSITION').getCount())/3,0)}
}
const inside = (dir,file) => {const rel=path.relative(dir,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

// Copy-only experiment: one closed building overview. No automatic LOD switch,
// no replacement of the source tileset, and no assumptions about business names.
export async function buildOverview(input, output, {compact=false} = {}) {
  input=path.resolve(input);output=path.resolve(output)
  const sourceDir=await fs.realpath(path.dirname(input)),outputParent=await fs.realpath(path.dirname(output))
  if(inside(path.join(outputParent,path.basename(output)),sourceDir))throw new Error('Output must not contain the input directory')
  try {await fs.stat(output);throw new Error('Output already exists')} catch(e) {if(e.code!=='ENOENT')throw e}
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.decoder':await draco.createDecoderModule()})
  const doc=new Document().setLogger(new Logger(Logger.Verbosity.WARN)),scene=doc.createScene('Overview')
  doc.getRoot().setDefaultScene(scene)
  const rootJSON=JSON.parse(await fs.readFile(input,'utf8'))
  const bound=rootJSON.root?.boundingVolume
  if(!bound?.sphere&&!bound?.box)throw new Error('Overview requires a sphere or box root bound')
  const rootTransform=Matrix4.fromArray(rootJSON.root.transform||Matrix4.toArray(Matrix4.IDENTITY))
  const localSphere=bound.sphere?new BoundingSphere(Cartesian3.fromArray(bound.sphere),bound.sphere[3]):BoundingSphere.fromOrientedBoundingBox(new OrientedBoundingBox(Cartesian3.fromArray(bound.box),Matrix3.fromArray(bound.box,3)))
  const rootSphere=BoundingSphere.transform(localSphere,rootTransform)
  const anchor=Matrix4.fromTranslation(rootSphere.center),inverse=Matrix4.inverse(anchor,new Matrix4())
  const rows=[],sources=[],ancestors=new Set(),before={primitives:0,triangles:0}
  let featureLabel
  async function content(file, transform, floor) {
    const bytes=await fs.readFile(file)
    const jsonDoc=await io.binaryToJSON(new Uint8Array(bytes))
    for(const name of new Set([...(jsonDoc.json.extensionsUsed||[]),...(jsonDoc.json.extensionsRequired||[])])){
      if(!supported.has(name))throw new Error('Unsupported extension: '+name)
    }
    let normalizedDracoIndices=0
    if(jsonDoc.json.extensionsRequired?.includes('KHR_draco_mesh_compression')){
      for(const mesh of jsonDoc.json.meshes||[])for(const prim of mesh.primitives){
        const compressed=prim.extensions?.KHR_draco_mesh_compression,accessor=jsonDoc.json.accessors?.[prim.indices]
        // Some exporters incorrectly label the compressed blob as an ordinary
        // index buffer too. Required Draco is authoritative; fix only this alias.
        if(compressed&&accessor?.bufferView===compressed.bufferView){delete accessor.bufferView;delete accessor.byteOffset;normalizedDracoIndices++}
      }
    }
    const src=await io.readJSON(jsonDoc)
    for(const ext of src.getRoot().listExtensionsUsed())if(!supported.has(ext.extensionName))throw new Error('Unsupported extension: '+ext.extensionName)
    if(src.getRoot().listAnimations().length||src.getRoot().listSkins().length||src.getRoot().listScenes().length!==1)throw new Error('Only static single-scene content is supported')
    if(src.getRoot().listMaterials().some(m=>m.getAlphaMode()==='BLEND'))throw new Error('BLEND content needs its original transparent sorting boundaries')
    const meta=src.getRoot().getExtension('EXT_structural_metadata'),offsets=new Map()
    if(!meta||meta.listPropertyTextures().length||meta.listPropertyAttributes().length)throw new Error('Expected feature property tables')
    for(const table of meta.listPropertyTables()){
      offsets.set(table,rows.length)
      const fields=table.listPropertyKeys(),klass=meta.getSchema()?.getClass(table.getClass())
      for(const field of fields)if(klass?.getProperty(field)?.getType()!=='STRING'||klass.getProperty(field).getArray())throw new Error('Only scalar string metadata is supported: '+field)
      for(let i=0;i<table.getCount();i++){
        const row={ccrSource:path.relative(sourceDir,file).replaceAll(path.sep,'/'),ccrFloor:floor}
        for(const field of fields){
          if(field==='ccrSource'||field==='ccrFloor')throw new Error('Reserved provenance property: '+field)
          const property=table.getProperty(field),offset=property.getStringOffsets(),kind=property.getStringOffsetType()||'UINT32'
          const view=new DataView(offset.buffer,offset.byteOffset,offset.byteLength)
          const read=n=>kind==='UINT16'?view.getUint16(n*2,true):kind==='UINT32'?view.getUint32(n*4,true):kind==='UINT64'?Number(view.getBigUint64(n*8,true)):(()=>{throw new Error('Unsupported offsets')})()
          row[field]=new TextDecoder().decode(property.getValues().subarray(read(i),read(i+1)))
        }
        rows.push(row)
      }
    }
    const remapped=new Map()
    for(const mesh of src.getRoot().listMeshes())for(const prim of mesh.listPrimitives()){
      if(prim.getMode()!==4||prim.listTargets().length||Object.keys(prim.getExtras()).length)throw new Error('Unsupported primitive semantics')
      const features=prim.getExtension('EXT_mesh_features')?.listFeatureIDs()
      if(features?.length!==1||features[0].getAttribute()!==0||features[0].getTexture()||features[0].getNullFeatureID()!==null)throw new Error('Expected one explicit feature-ID attribute')
      const feature=features[0],table=feature.getPropertyTable(),base=offsets.get(table)
      if(base===undefined)throw new Error('Missing property table')
      if(featureLabel!==undefined&&featureLabel!==feature.getLabel())throw new Error('Incompatible feature labels')
      featureLabel=feature.getLabel()
      const attribute=prim.getAttribute('_FEATURE_ID_0')
      if(attribute.getNormalized())throw new Error('Normalized feature IDs are unsupported')
      if(!remapped.has(attribute)){
        const data=Uint32Array.from(attribute.getArray(),id=>{if(!Number.isInteger(id)||id<0||id>=table.getCount())throw new Error('Invalid feature ID');return base+id})
        attribute.setArray(data);remapped.set(attribute,base)
      }else if(remapped.get(attribute)!==base)throw new Error('Shared feature attribute uses different property tables')
      prim.setExtension('EXT_mesh_features',null)
    }
    const counts=stat(src);before.primitives+=counts.primitives;before.triangles+=counts.triangles
    // Cesium applies Y-up -> Z-up outside the glTF node graph. Conjugate tile
    // transforms so the output has the same world-space vertices and normals.
    const local=multiply(Axis.Z_UP_TO_Y_UP,multiply(inverse,multiply(transform,Axis.Y_UP_TO_Z_UP)))
    const map=mergeDocuments(doc,src),copiedScene=map.get(src.getRoot().listScenes()[0])
    const wrapper=doc.createNode().setMatrix(Matrix4.toArray(local))
    for(const node of copiedScene.listChildren())wrapper.addChild(node)
    scene.addChild(wrapper);copiedScene.dispose()
    sources.push({file:path.relative(sourceDir,file).replaceAll(path.sep,'/'),sha256:sha(bytes),bytes:bytes.length,normalizedDracoIndices,...counts})
  }
  async function document(file,parent,floor=''){
    file=await fs.realpath(file)
    if(!inside(sourceDir,file))throw new Error('Source reference escapes the input directory')
    if(ancestors.has(file))throw new Error('Cyclic tileset reference')
    ancestors.add(file)
    const json=JSON.parse(await fs.readFile(file,'utf8'))
    if(json.extensionsUsed?.length||json.extensionsRequired?.length)throw new Error('Unsupported tileset extensions')
    async function tile(t,m,f){
      if(t.implicitTiling||t.contents||t.viewerRequestVolume)throw new Error('Unsupported tile selection semantics')
      const world=t.transform?multiply(m,Matrix4.fromArray(t.transform)):m
      f=t.metadata?.name||f
      if(t.content){
        if(t.children?.length)throw new Error('Input already contains content LOD; use an explicit leaf dataset')
        const uri=t.content.uri||t.content.url
        if(/^[a-z]+:|^[\\/]|[?#]/i.test(uri))throw new Error('Only local relative content is supported')
        const next=await fs.realpath(path.resolve(path.dirname(file),decodeURIComponent(uri)))
        if(!inside(sourceDir,next))throw new Error('Source reference escapes the input directory')
        if(next.toLowerCase().endsWith('.json'))await document(next,world,f)
        else if(next.toLowerCase().endsWith('.glb'))await content(next,world,f||path.basename(path.dirname(next)))
        else throw new Error('Only GLB content is supported')
      }
      for(const child of t.children||[])await tile(child,world,f)
    }
    await tile(json.root,parent,floor);ancestors.delete(file)
  }
  await document(input,Matrix4.IDENTITY)
  if(!sources.length)throw new Error('No render content')
  // Compression is intentionally not re-encoded in this geometry-equivalent
  // experiment. A shipping encoder/LOD needs separate quality acceptance.
  doc.getRoot().listExtensionsUsed().find(e=>e.extensionName==='KHR_draco_mesh_compression')?.dispose()
  await doc.transform(dedup({propertyTypes:[PropertyType.TEXTURE,PropertyType.MATERIAL]}),flatten(),join(),unpartition(),prune({keepAttributes:true}))
  const meta=doc.createExtension(EXTStructuralMetadata).setRequired(true),features=doc.createExtension(EXTMeshFeatures).setRequired(true)
  const klass=meta.createClass(),table=meta.createPropertyTable().setClass('feature').setCount(rows.length)
  for(const key of new Set(rows.flatMap(Object.keys))){
    klass.setProperty(key,meta.createClassProperty().setType('STRING'))
    const values=rows.map(row=>Buffer.from(row[key]||'','utf8')),offsets=new Uint32Array(values.length+1)
    for(let i=0;i<values.length;i++)offsets[i+1]=offsets[i]+values[i].length
    table.setProperty(key,meta.createPropertyTableProperty().setValues(Buffer.concat(values)).setStringOffsets(new Uint8Array(offsets.buffer)).setStringOffsetType('UINT32'))
  }
  doc.getRoot().setExtension('EXT_structural_metadata',meta.createStructuralMetadata().setSchema(meta.createSchema().setId('ccr-overview').setClass('feature',klass)).addPropertyTable(table))
  for(const mesh of doc.getRoot().listMeshes())for(const prim of mesh.listPrimitives())prim.setExtension('EXT_mesh_features',features.createFeatures()
    .addFeatureID(features.createFeatureID().setAttribute(0).setLabel(featureLabel||'').setFeatureCount(rows.length).setPropertyTable(table)))
  if(compact){
    // Never quantize feature IDs, UVs or colors. Position/normal precision is
    // explicit and opt-in; this is a separate candidate from exact rebatching.
    await doc.transform(quantize({pattern:/^(POSITION|NORMAL)$/,quantizePosition:16,quantizeNormal:16}))
    const IdArray=rows.length<=256?Uint8Array:rows.length<=65536?Uint16Array:Uint32Array
    const attrs=new Set(doc.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>p.getAttribute('_FEATURE_ID_0'))))
    for(const attribute of attrs)attribute.setArray(IdArray.from(attribute.getArray()))
    await MeshoptEncoder.ready
    io.registerDependencies({'meshopt.encoder':MeshoptEncoder})
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE})
  }
  const after=stat(doc)
  if(after.triangles!==before.triangles)throw new Error('Triangle count changed')
  const glb=await io.writeBinary(doc),result={input,compact,scope:'Copy-only closed-building overview; original floor tiles remain required for expansion',before,after,features:rows.length,bytes:glb.byteLength,sources}
  await fs.mkdir(output) // exclusive output: never overwrite an existing asset
  await fs.writeFile(path.join(output,'overview.glb'),glb,{flag:'wx'})
  await fs.writeFile(path.join(output,'tileset.json'),JSON.stringify({asset:{version:'1.1'},geometricError:Math.max(rootJSON.geometricError||0,rootSphere.radius*2),root:{transform:Matrix4.toArray(anchor),boundingVolume:{sphere:[0,0,0,rootSphere.radius]},geometricError:0,refine:'REPLACE',content:{uri:'overview.glb'}}},null,2),{flag:'wx'})
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2),{flag:'wx'})
  return result
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output,option]=process.argv.slice(2)
  if(!input||!output)throw new Error('Usage: node overview.mjs <source tileset.json> <new output directory>')
  if(option&&option!=='--compact')throw new Error('Unknown option: '+option)
  console.log(JSON.stringify(await buildOverview(input,output,{compact:option==='--compact'}),null,2))
}
