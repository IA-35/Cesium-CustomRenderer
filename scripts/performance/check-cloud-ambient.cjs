#!/usr/bin/env node
// Pointwise production-GLSL ambient transport checks, not an image or timing benchmark.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
async function main(){
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
  const server=spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8972'],{stdio:'ignore'})
  let browser
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject)
      server.once('exit',code=>reject(new Error(`Probe server exited: ${code}`)))
      setTimeout(resolve,1500)
    })
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage()
    await page.goto('http://127.0.0.1:8972/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.viewer?.scene?.context,null,{timeout:120000})
    const report=await page.evaluate(async()=>{
      const C=window.Cesium,{viewer}=campus,context=viewer.scene.context,gl=context._gl
      const {atmosphereGLSL}=await import('/src/environment/atmosphereScattering143.js')
      const {cloudGLSL}=await import('/src/environment/volumetricClouds143.js')
      viewer.useDefaultRenderLoop=false
      // Replace only density. Production shell intersections, quadrature, up/down
      // directions and ambient visibility remain verbatim from cloudGLSL.
      const source=cloudGLSL('balanced'),signature='float ccrCloudDensity(vec3 position) {'
      const start=source.indexOf(signature)
      if(start<0||source.indexOf(signature,start+1)>=0)throw new Error('Cloud density fixture target is ambiguous')
      const opening=source.indexOf('{',start)
      let depth=1,end=opening+1
      for(;end<source.length&&depth;end++){
        if(source[end]==='{')depth++
        else if(source[end]==='}')depth--
      }
      if(depth)throw new Error('Cloud density fixture target is unterminated')
      const fixture=source.slice(0,start)+'float ccrCloudDensity(vec3 position) { return probeDensity; }'+source.slice(end)
      let mode=0,density=0
      const opticalDepth=new C.Cartesian2(),origin=new C.Cartesian3(0,0,6373200)
      const shader='precision highp float;precision highp sampler2D;\n'
        +'uniform int probeMode;uniform float probeDensity;uniform vec2 probeOpticalDepth;\n'
        +atmosphereGLSL('balanced')
        +'vec3 ccrSkyRadiance(){return vec3(0.0);}\n'+fixture
        +'void main(){if(probeMode==0){float v=ccrCloudAmbientVisibility(probeOpticalDepth);out_FragColor=vec4(v,v,v,1.0);}'
        +'else{vec2 tau=ccrCloudAmbientOpticalDepth(atmosphereOrigin);out_FragColor=vec4(tau,ccrCloudAmbientVisibility(tau),1.0);}}'
      const texture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
      const framebuffer=new C.Framebuffer({context,colorTextures:[texture],destroyAttachments:false})
      const renderState=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false})
      const command=context.createViewportQuadCommand(shader,{framebuffer,renderState,uniformMap:{
        atmosphereParams:()=>new C.Cartesian4(6371000,6471000,1/1200,1/8000),
        cloudParams:()=>new C.Cartesian4(1,1600,2800,1),atmosphereOrigin:()=>origin,
        probeMode:()=>mode,probeDensity:()=>density,probeOpticalDepth:()=>opticalDepth
      }})
      const draw=()=>{
        command.execute(context)
        const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),v=new Float32Array(4)
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer._framebuffer)
        try{
          if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete float probe framebuffer')
          gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,v)
        }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,previous)}
        const error=gl.getError()
        if(error||!v.every(Number.isFinite)||v[3]!==1)throw new Error(`Invalid cloud ambient probe: GL ${error}, ${v}`)
        return Array.from(v.slice(0,3))
      }
      // Independently sum the finite series on the CPU using powers rather than
      // mirroring the GLSL's iterative weight/attenuation updates.
      const reference=([above,below])=>{
        const weights=Array.from({length:8},(_,i)=>2**(-i))
        return weights.reduce((sum,w)=>sum+w*(Math.exp(-Math.max(above,0)*w)+Math.exp(-Math.max(below,0)*w))/2,0)
          /weights.reduce((sum,w)=>sum+w,0)
      }
      const visibilityTolerance=1e-6,depthTolerance=1e-5,visibility=[],paths=[]
      try{
        for(const tau of [[0,0],[0,10],[10,0],[1,1],[5,5],[10,10],[50,50],[100,100]]){
          opticalDepth.x=tau[0];opticalDepth.y=tau[1]
          const gpu=draw()[0],expected=reference(tau),absoluteError=Math.abs(gpu-expected)
          if(absoluteError>visibilityTolerance||gpu<0||gpu>1)throw new Error(`Ambient visibility mismatch: ${tau}: ${gpu} vs ${expected}`)
          visibility.push({opticalDepth:tau,gpu,reference:expected,absoluteError})
        }
        if(visibility[0].gpu!==1)throw new Error('Zero optical depth changed ambient identity')
        if(Math.abs(visibility[1].gpu-visibility[2].gpu)>visibilityTolerance)throw new Error('Ambient hemispheres are asymmetric')
        const symmetric=visibility.filter(row=>row.opticalDepth[0]===row.opticalDepth[1])
        if(symmetric.some((row,i)=>i>0&&row.gpu>=symmetric[i-1].gpu))throw new Error('Ambient visibility is not strictly decreasing')
        // The finite scattering tail must keep decaying through thick clouds;
        // this catches a constant artistic minimum without introducing one here.
        if(visibility.at(-1).gpu>=visibility.at(-2).gpu||visibility.at(-1).gpu>=0.01)throw new Error('Thick-cloud ambient has an artificial floor')
        mode=1
        for(density of [0,.001,.01])for(const altitude of [1610,1900,2200,2600,2790]){
          origin.z=6371000+altitude
          const gpu=draw(),expected=[density*(2800-altitude),density*(altitude-1600)]
          const absoluteErrors=expected.map((v,i)=>Math.abs(gpu[i]-v))
          if(absoluteErrors.some(v=>v>depthTolerance))throw new Error(`Ambient path mismatch at ${altitude}, density ${density}: ${gpu} vs ${expected}`)
          if(Math.abs(gpu[2]-reference(expected))>visibilityTolerance)throw new Error('Path-integrated ambient differs from independent visibility reference')
          if(density===0&&(gpu[0]!==0||gpu[1]!==0||gpu[2]!==1))throw new Error('Zero-density cloud changed ambient identity')
          paths.push({altitude,density,gpuOpticalDepth:gpu.slice(0,2),referenceOpticalDepth:expected,absoluteErrors,visibility:gpu[2]})
        }
      }finally{
        command.shaderProgram?.destroy();framebuffer.destroy();texture.destroy();C.RenderState.removeFromCache(renderState)
      }
      return {scope:'Pointwise production GLSL ambient visibility and radial uniform-density transport; no image or performance acceptance',
        renderer:gl.getParameter(gl.RENDERER),visibilityTolerance,depthTolerance,cloudLayer:{base:1600,top:2800},
        fixture:'Only ccrCloudDensity body replaced by uniform density; production atmosphere intersection, cloud shell, quadrature and ambient functions retained',
        visibility,paths,summary:{passed:true,visibilityCases:visibility.length,pathCases:paths.length,
          maximumVisibilityError:Math.max(...visibility.map(row=>row.absoluteError)),
          maximumOpticalDepthError:Math.max(...paths.flatMap(row=>row.absoluteErrors))}}
    })
    const output=path.resolve(__dirname,'../../docs/verification/rendering-performance/cloud-ambient-gpu.json')
    fs.mkdirSync(path.dirname(output),{recursive:true})
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({output,...report.summary},null,2))
  }finally{await browser?.close();server.kill()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
