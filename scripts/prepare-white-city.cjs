// Create a local material variant without changing the user's original model.
const fs=require('node:fs'),path=require('node:path')
const input=process.argv[2]
if(!input)throw new Error('Usage: node scripts/prepare-white-city.cjs <city-set-draco.glb>')
const source=fs.readFileSync(input)
if(source.readUInt32LE(0)!==0x46546c67||source.readUInt32LE(4)!==2||source.readUInt32LE(16)!==0x4e4f534a)throw new Error('Expected GLB 2 with JSON first chunk')
const jsonLength=source.readUInt32LE(12),gltf=JSON.parse(source.subarray(20,20+jsonLength).toString())
gltf.materials=gltf.materials.map(material=>({name:material.name,pbrMetallicRoughness:{
  baseColorFactor:material.name==='sidewalk_mat'?[.45,.48,.5,1]:[.82,.82,.8,1],
  metallicFactor:0,roughnessFactor:material.name==='sidewalk_mat'?.5:.22}}))
gltf.meshes.forEach(mesh=>mesh.primitives.forEach(primitive=>{delete primitive.attributes.COLOR_0}))
let json=Buffer.from(JSON.stringify(gltf))
json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)])
const tail=source.subarray(20+jsonLength),header=Buffer.alloc(20)
header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+tail.length,8)
header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16)
const target=path.resolve(__dirname,'../assets/white-city/city-white.glb')
fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.concat([header,json,tail]))
console.log(JSON.stringify({target,bytes:fs.statSync(target).size}))
