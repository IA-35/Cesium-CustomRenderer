export function cubeUrl(C, color = [0.65,0.68,0.72,1], emissive = [0,0,0]) {
  const geometry = C.BoxGeometry.createGeometry(C.BoxGeometry.fromDimensions({ dimensions:new C.Cartesian3(1,1,1), vertexFormat:C.VertexFormat.POSITION_AND_NORMAL }))
  const arrays = [new Float32Array(geometry.attributes.position.values), new Float32Array(geometry.attributes.normal.values), new Uint16Array(geometry.indices)]
  const buffers = arrays.map(a => {
    const bytes=new Uint8Array(a.buffer); let text=''; for (const value of bytes) text+=String.fromCharCode(value)
    return {uri:'data:application/octet-stream;base64,'+btoa(text),byteLength:bytes.length}
  })
  return 'data:model/gltf+json,'+encodeURIComponent(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],buffers,
    bufferViews:arrays.map((a,i)=>({buffer:i,byteLength:a.byteLength})),accessors:[
      {bufferView:0,componentType:5126,count:arrays[0].length/3,type:'VEC3',min:[-.5,-.5,-.5],max:[.5,.5,.5]},
      {bufferView:1,componentType:5126,count:arrays[1].length/3,type:'VEC3'},
      {bufferView:2,componentType:5123,count:arrays[2].length,type:'SCALAR'}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:color,roughnessFactor:.8,metallicFactor:0},emissiveFactor:emissive}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}]}))
}

export async function startStage1Scene(f) {
  if (f.pipeline) return
  const C = Cesium, {viewer,CCR}=f
  const origin=C.Cartesian3.fromDegrees(123.42,41.77,0), frame=C.Transforms.eastNorthUpToFixedFrame(origin)
  viewer.clock.currentTime=C.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
  const specs=[[[0,0,-1],[200,200,2]],[[0,0,12],[18,18,24]],[[24,0,7],[12,12,14]],[[0,25,3],[8,10,6]]]
  f.models=[]
  for (let i=0;i<specs.length;i++) {
    const [p,s]=specs[i]
    const matrix=C.Matrix4.multiply(frame,C.Matrix4.fromTranslation(new C.Cartesian3(...p)),new C.Matrix4())
    C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(...s),matrix)
    const model=await C.Model.fromGltfAsync({url:cubeUrl(C,undefined,i===3?[8,3,1]:[0,0,0]),modelMatrix:matrix})
    viewer.scene.primitives.add(model); f.models.push(model)
  }
  f.pipeline=CCR.createVisualPipeline({Cesium:C,viewer,options:{environment:false,shadows:false,shadowMode:'native',antialiasing:'fxaa',fog:false}})
  f.pipeline.setCampusOrigin(origin)
  f.pipeline.setScreenSpaceAO({enabled:true,algorithm:'hbao'})
  f.pipeline.setHdrBloom({enabled:true,strength:.15,threshold:1,levels:4})
  viewer.camera.lookAt(origin,new C.HeadingPitchRange(0,-.6,160))
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
  f.origin=origin
}

export async function runStage1SceneChecks(f) {
  await startStage1Scene(f)
  const C=Cesium, {viewer,pipeline}=f, scene=viewer.scene, checks={}, measurements={}
  const frames=n=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(new Error('Frame timeout: '+f.errors.join(';')))},20000)
    const off=scene.postRender.addEventListener(()=>{if(--n===0){off();clearTimeout(timer);resolve()}})
  })
  const check=(name,value)=>{checks[name]=!!value;if(!value)throw new Error(name+': '+JSON.stringify({measurements,errors:f.errors,diagnostics:pipeline.getRenderDiagnostics()}))}
  const sampleClouds=()=>{
    const t=pipeline.environmentRenderer.stages.raymarchStage.outputTexture
    const context=scene.context,gl=context._gl,read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const fbo=new C.Framebuffer({context,colorTextures:[t],destroyAttachments:false})
    try {
      const data=context.readPixels({framebuffer:fbo,width:t.width,height:t.height})
      let min=1,max=0; for(let i=3;i<data.length;i+=4){min=Math.min(min,data[i]);max=Math.max(max,data[i])}
      return {min,max,finite:data.every(Number.isFinite)}
    }finally{fbo.destroy();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)}
  }
  await frames(15)
  check('hbaoSceneValid',pipeline.getScreenSpaceAODiagnostics().valid)
  check('bloomSceneValid',pipeline.getHdrBloomDiagnostics().valid)
  pipeline.setOptions({environment:true,cloudGeometry:'shell',environmentAnimation:false,cloudCoverage:.8,cloudBaseHeight:1000,cloudThickness:1000,fog:false})
  measurements.cloudCases=[]
  for(const [height,pitch,expectCloud] of [[100,-Math.PI/2,false],[100,Math.PI/2,true],[1500,Math.PI/2,true],[3000,Math.PI/2,false],[3000,-Math.PI/2,true],[2000000,-Math.PI/2,false]]){
    viewer.camera.setView({destination:C.Cartesian3.fromDegrees(123.42,41.77,height),orientation:{heading:0,pitch,roll:0}})
    await frames(10)
    check('shellValidAt'+height+'_'+pitch,pipeline.environmentRenderer.getDiagnostics().hdr.valid)
    const samples=sampleClouds(); measurements.cloudCases.push({height,pitch,...samples})
    check('shellFiniteAt'+height+'_'+pitch,samples.finite)
    check('shellCoverageAt'+height+'_'+pitch,expectCloud?samples.min<.99:samples.min>.9999)
  }
  for(const latitude of [0,80]) {
    viewer.camera.setView({destination:C.Cartesian3.fromDegrees(123.42,latitude,100),orientation:{heading:0,pitch:-Math.PI/2,roll:0}})
    await frames(8)
    check('groundNotCoveredAtLatitude'+latitude,pipeline.environmentRenderer.getDiagnostics().hdr.valid&&sampleClouds().min>.9999)
  }
  viewer.camera.lookAt(f.origin,new C.HeadingPitchRange(0,-.6,160));viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
  pipeline.setTaa({enabled:true}); await frames(20)
  check('taaWithAllEffects',pipeline.getTaaDiagnostics().valid)
  check('combinedHbao',pipeline.getScreenSpaceAODiagnostics().valid)
  check('combinedBloom',pipeline.getHdrBloomDiagnostics().valid)
  check('combinedClouds',pipeline.environmentRenderer.getDiagnostics().hdr.valid)
  pipeline.setEnabled(false); await frames(3)
  check('disabledReleases',!pipeline.screenSpaceAO.collection&&!pipeline.hdrBloom.collection&&!pipeline.environmentRenderer.hdr.collection)
  pipeline.setEnabled(true); await frames(15)
  check('reenable',pipeline.getHdrBloomDiagnostics().valid&&pipeline.getScreenSpaceAODiagnostics().valid&&pipeline.environmentRenderer.getDiagnostics().hdr.valid)
  check('noRenderErrors',f.errors.length===0)
  return {checks,measurements}
}
