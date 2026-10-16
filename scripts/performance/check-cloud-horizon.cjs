#!/usr/bin/env node
// Pointwise production-GLSL horizon checks; no image or timing benchmark.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
async function main(){
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'C:/Users/Administrator/node_modules/playwright')
  const server=spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8975'],{stdio:'ignore'})
  let browser
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject)
      server.once('exit',code=>reject(new Error(`Probe server exited: ${code}`)))
      setTimeout(resolve,1500)
    })
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage()
    await page.goto('http://127.0.0.1:8975/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.viewer?.scene?.context,null,{timeout:120000})
    const report=await page.evaluate(async()=>{
      const C=window.Cesium,{viewer}=campus,context=viewer.scene.context,gl=context._gl
      const {atmosphereGLSL}=await import('/src/environment/atmosphereScattering143.js')
      const {cloudGLSL}=await import('/src/environment/volumetricClouds143.js')
      viewer.useDefaultRenderLoop=false
      const radius=6371000,top=2800,base=1600,tolerance=1e-4
      const origin=new C.Cartesian3(0,0,radius+300),direction=new C.Cartesian3(1,0,0)
      const inputs=new C.Cartesian4(),zero=new C.Cartesian3(),up=new C.Cartesian3(0,0,1)
      let blend=0,mode=0,density=1e-5
      const texture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
      const framebuffer=new C.Framebuffer({context,colorTextures:[texture],destroyAttachments:false})
      const renderState=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false})
      const rangeCases=[],pathCases=[],transportCases=[]
      const error=(actual,expected)=>Math.abs(actual-expected)/Math.max(Math.abs(expected),1)
      const requireClose=(actual,expected,label,allowed=tolerance)=>{
        const relativeError=error(actual,expected)
        if(relativeError>allowed)throw new Error(`${label}: ${actual} vs ${expected}; relative error ${relativeError}`)
        return relativeError
      }
      // Independent double-precision closed forms. expm1 avoids cancellation near u=0.
      const geometricRange=height=>Math.sqrt((radius+height)**2-radius**2)+Math.sqrt((radius+top)**2-radius**2)
      const referenceRange=(height,maxDistance,b)=>maxDistance+b*(Math.max(maxDistance,1.5*geometricRange(height))-maxDistance)
      const referencePath=(u,length,maxDistance,b)=>{
        const weight=b*Math.max(0,Math.min(1,length/maxDistance-1)),scale=maxDistance*.15
        return (1-weight)*u*length+weight*scale*Math.expm1(u*Math.log1p(length/scale))
      }
      try{
        // Deliberately pin the public tier contracts independently of CLOUD_TIERS.
        for(const [tier,maxDistance,steps] of [['performance',30000,24],['balanced',40000,96],['high',50000,128]]){
          const source=cloudGLSL(tier),signature='float ccrCloudDensity(vec3 position) {'
          const start=source.indexOf(signature)
          if(start<0||source.indexOf(signature,start+1)>=0)throw new Error('Cloud density fixture target is ambiguous')
          let depth=1,end=source.indexOf('{',start)+1
          for(;end<source.length&&depth;end++){
            if(source[end]==='{')depth++
            else if(source[end]==='}')depth--
          }
          if(depth)throw new Error('Cloud density fixture target is unterminated')
          const fixture=source.slice(0,start)+'float ccrCloudDensity(vec3 position) { return probeDensity; }'+source.slice(end)
          const shader='precision highp float;precision highp sampler2D;\n'
            +'uniform int probeMode;uniform float probeDensity;uniform vec4 probeInputs;uniform vec3 probeDirection;\n'
            +atmosphereGLSL(tier)+'vec3 ccrSkyRadiance(){return vec3(0.5);}\n'+fixture
            +'void main(){if(probeMode==0){float d=ccrCloudViewPathDistance(probeInputs.x,probeInputs.y);'
            +'out_FragColor=vec4(ccrCloudViewRange(atmosphereOrigin),d,ccrCloudViewPathDistance(probeInputs.z,probeInputs.y)-d,1.0);}'
            +'else if(probeMode==1){vec2 g=ccrCloudGeometry(atmosphereOrigin,probeDirection,probeInputs.w);out_FragColor=vec4(g,0.0,1.0);}'
            +'else {float d;vec4 c=ccrClouds(atmosphereOrigin,probeDirection,probeInputs.w,d);out_FragColor=vec4(d,c.a,max(max(c.r,c.g),c.b),1.0);}}'
          const command=context.createViewportQuadCommand(shader,{framebuffer,renderState,uniformMap:{
            atmosphereParams:()=>new C.Cartesian4(radius,6471000,1/1200,1/8000),
            cloudParams:()=>new C.Cartesian4(1,base,top,1),atmosphereOrigin:()=>origin,
            cloudHorizonBlend:()=>blend,probeInputs:()=>inputs,probeMode:()=>mode,probeDensity:()=>density,
            probeDirection:()=>direction,cloudFrame:()=>new C.Cartesian2(0,0),
            atmosphereSunRadiance:()=>zero,sunDirectionAtmo:()=>up,atmosphereMieParameters:()=>new C.Cartesian2(1,.7),
            moonRadiance:()=>zero,nightSkyRadiance:()=>zero,moonDirectionAtmo:()=>up
          }})
          const draw=()=>{
            command.execute(context)
            const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),v=new Float32Array(4)
            gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer._framebuffer)
            try{
              if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete float probe framebuffer')
              gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,v)
            }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,previous)}
            const glError=gl.getError()
            if(glError||!v.every(Number.isFinite)||v[3]!==1)throw new Error(`Invalid horizon probe: GL ${glError}, ${v}`)
            return Array.from(v.slice(0,3))
          }
          try{
            mode=0;inputs.x=0;inputs.y=2000;inputs.z=1
            for(const height of [300,3500,12000,8e6])for(blend of [0,.25,.5,1]){
              origin.z=radius+height
              const gpu=draw()[0],expected=referenceRange(height,maxDistance,blend)
              const relativeError=requireClose(gpu,expected,`${tier} range h=${height} blend=${blend}`)
              if(blend===0&&gpu!==maxDistance)throw new Error('Disabled horizon changed local range')
              const horizon=geometricRange(height),fadeOnset=.7*gpu
              if(blend===1&&fadeOnset<horizon)throw new Error('Far fade starts before geometric cloud horizon')
              rangeCases.push({tier,height,blend,gpu,reference:expected,relativeError,geometricHorizon:horizon,fadeOnset})
            }
            origin.z=radius+300
            for(const length of [2000,40000,400000])for(blend of [0,.25,.5,1]){
              const sampleCount=Math.ceil(steps*(1+blend*Math.max(0,Math.min(1,length/maxDistance-1))))
              let sum=0,previous=-1,maximumRelativeError=0,maximumStepRelativeError=0
              const sampledPoints=[]
              for(let i=0;i<=sampleCount;i++){
                const u=i/sampleCount,next=Math.min(1,(i+1)/sampleCount)
                inputs.x=u;inputs.y=length;inputs.z=next
                const [,distance,dt]=draw(),expected=referencePath(u,length,maxDistance,blend)
                const expectedDt=referencePath(next,length,maxDistance,blend)-expected
                maximumRelativeError=Math.max(maximumRelativeError,requireClose(distance,expected,`${tier} path ${length}/${blend}/${u}`))
                maximumStepRelativeError=Math.max(maximumStepRelativeError,requireClose(dt,expectedDt,`${tier} dt ${length}/${blend}/${u}`))
                if(distance<previous||dt<0)throw new Error('Path distance is not monotonic')
                if(i===0&&distance!==0)throw new Error('Path origin is not zero')
                if(i===sampleCount)requireClose(distance,length,'Path endpoint')
                if(length<=maxDistance||blend===0)requireClose(distance,u*length,'Local path stopped being uniform')
                previous=distance;sum+=dt
                if(i===0||i===sampleCount||i%Math.max(1,Math.floor(sampleCount/4))===0)sampledPoints.push({u,distance,dt,reference:expected,referenceDt:expectedDt})
              }
              const segmentSumRelativeError=requireClose(sum,length,'Path segment sum')
              pathCases.push({tier,length,blend,sampleCount,maximumRelativeError,maximumStepRelativeError,segmentSum:sum,segmentSumRelativeError,sampledPoints})
            }
            // Low, horizontal rays reach the shell only beyond the old local limit.
            // Density replacement leaves production shell, fade, quadrature and depth/T untouched.
            inputs.w=1e9;origin.z=radius+300;direction.x=1;direction.z=0
            for(blend of [0,1]){
              mode=1;const geometry=draw()
              mode=2;const color=draw()
              requireClose(color[0],geometry[0],'Geometry/color depth',1e-6)
              requireClose(color[1],geometry[1],'Geometry/color transmittance',1e-6)
              if(blend===0&&(geometry[0]!==inputs.w||geometry[1]!==1||color[2]!==0))throw new Error('Local range did not clip distant horizontal cloud')
              if(blend===1&&(geometry[0]<=40000||geometry[1]>=.99||color[2]<=0))throw new Error('Extended horizon did not reveal distant horizontal cloud')
              transportCases.push({tier,case:'low-horizontal',height:300,blend,depth:geometry[0],transmittance:geometry[1],colorDepth:color[0],colorTransmittance:color[1],maximumRadiance:color[2]})
            }
            // At blend zero, the pre-existing midpoint march must remain unchanged.
            // Compare to the independent analytic uniform-medium transmission/centroid.
            blend=0;direction.x=0;direction.z=-1
            for(const height of [3500,12000]){
              origin.z=radius+height
              mode=1;const geometry=draw()
              mode=2;const color=draw()
              const length=top-base,expectedT=Math.exp(-density*length)
              const expectedDepth=height-top+1/density-length/Math.expm1(density*length)
              requireClose(geometry[1],expectedT,'Downward local transmittance',1e-5)
              requireClose(geometry[0],expectedDepth,'Downward local centroid',1e-4)
              requireClose(color[0],geometry[0],'Downward geometry/color depth',1e-6)
              requireClose(color[1],geometry[1],'Downward geometry/color transmittance',1e-6)
              transportCases.push({tier,case:'downward-local',height,blend,depth:geometry[0],referenceDepth:expectedDepth,transmittance:geometry[1],referenceTransmittance:expectedT,colorDepth:color[0],colorTransmittance:color[1]})
            }
          }finally{command.shaderProgram?.destroy()}
        }
      }finally{framebuffer.destroy();texture.destroy();C.RenderState.removeFromCache(renderState)}
      const debug=gl.getExtension('WEBGL_debug_renderer_info')
      const renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)
      if(/swiftshader|llvmpipe|software/i.test(renderer))throw new Error(`Hardware GPU required, found ${renderer}`)
      return {scope:'Real Chrome GPU pointwise production-source GLSL numeric and uniform-media transport verification; no image or performance acceptance',
        renderer,webgl:gl.getParameter(gl.VERSION),tolerance,cloudLayer:{base,top},
        fixture:'Only ccrCloudDensity body replaced with a uniform scalar; production atmosphere, horizon helpers, shell intersection, distance fade, sample scheduling, quadrature, geometry and color transport retained. Analytic atmosphere path; no LUT dependency.',
        rangeCases,pathCases,transportCases,summary:{passed:true,rangeCases:rangeCases.length,pathCases:pathCases.length,transportCases:transportCases.length,
          maximumRangeRelativeError:Math.max(...rangeCases.map(row=>row.relativeError)),
          maximumPathRelativeError:Math.max(...pathCases.map(row=>row.maximumRelativeError)),
          maximumStepRelativeError:Math.max(...pathCases.map(row=>row.maximumStepRelativeError)),
          maximumSegmentSumRelativeError:Math.max(...pathCases.map(row=>row.segmentSumRelativeError))}}
    })
    const output=path.resolve(__dirname,'../../docs/verification/rendering-performance/cloud-horizon-gpu.json')
    fs.mkdirSync(path.dirname(output),{recursive:true})
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({output,renderer:report.renderer,...report.summary},null,2))
  }finally{await browser?.close();server.kill()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
