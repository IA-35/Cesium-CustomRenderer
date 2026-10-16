#!/usr/bin/env node
// Pointwise cloud source diagnosis against the actual T/M LUTs, no timing benchmark.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
async function main(){
  const label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)||'after'
  if(!/^[a-z-]+$/.test(label))throw new Error('Invalid label')
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
  const server=spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8968'],{stdio:'ignore'})
  let browser
  try{
    await new Promise(r=>setTimeout(r,1500))
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage()
    await page.goto('http://127.0.0.1:8968/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.atmosphereLut?.ready,null,{timeout:120000})
    const report=await page.evaluate(async()=>{
      const C=window.Cesium,{viewer,pipeline}=campus,context=viewer.scene.context,gl=context._gl
      const {default:AtmosphereLut}=await import('/src/environment/AtmosphereLut143.js')
      const {atmosphereGLSL}=await import('/src/environment/atmosphereScattering143.js')
      const {cloudGLSL}=await import('/src/environment/volumetricClouds143.js')
      const {resolveEnvironmentState}=await import('/src/environment/environmentState.js')
      viewer.useDefaultRenderLoop=false
      const lut=new AtmosphereLut(C,viewer.scene)
      let state=resolveEnvironmentState(),height=2200,mode=0,tau=0
      const sun=new C.Cartesian3(),origin=new C.Cartesian3(0,0,6373200)
      const moon=new C.Cartesian3(0,0,1)
      const shader='precision highp float;precision highp sampler2D;\n'
        +'uniform vec3 skyRadiance;uniform float environmentSkyScale;uniform bool atmosphereLutReady;uniform int probeMode;uniform float probeTau;\n'
        +atmosphereGLSL('balanced',{lut:true}).replace('uniform bool atmosphereLutReady;','')
        +'vec3 ccrSkyRadiance(){return skyRadiance;}vec3 ccrSunRadiance(){return vec3(0.0);}\n'+cloudGLSL('balanced')
        +'void main(){vec3 p=atmosphereOrigin;vec3 T=ccrCloudAtmosphereSunTransmittance(p);vec3 J=ccrLutMultipleScattering(p,sunDirectionAtmo)*atmosphereSunRadiance;'
        +'vec3 E=ccrLutSkyIrradiance(p,sunDirectionAtmo)*atmosphereSunRadiance;vec3 result;'
        +'if(probeMode==0)result=T;else if(probeMode==1)result=T*atmosphereSunRadiance;else if(probeMode==2)result=E;else if(probeMode==3)result=J;'
        +'else if(probeMode==4)result=T*atmosphereSunRadiance*ccrCloudScattering(probeTau,0.8);'
        +'else if(probeMode==5)result=ccrCloudSkyScatteringSource(E)*0.75;'
        +'else if(probeMode==6)result=moonRadiance*ccrCloudLightTransmittance(p,moonDirectionAtmo)*ccrCloudScattering(probeTau,0.8);'
        +'else if(probeMode==7)result=nightSkyRadiance*0.75;else result=ccrCloudLightTransmittance(p,moonDirectionAtmo);out_FragColor=vec4(result,1.0);}'
      const texture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
      const framebuffer=new C.Framebuffer({context,colorTextures:[texture],destroyAttachments:false})
      const renderState=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false})
      const uniforms={...lut.getUniformMap(),atmosphereParams:()=>new C.Cartesian4(6371000,6471000,1/1200,1/8000),
        atmosphereMieParameters:()=>new C.Cartesian2(.65,.9),atmosphereSunRadiance:()=>new C.Cartesian3(...state.atmosphereSunRadiance),
        skyRadiance:()=>new C.Cartesian3(...state.skyRadiance),sunDirectionAtmo:()=>sun,atmosphereOrigin:()=>origin,
        moonDirectionAtmo:()=>moon,moonRadiance:()=>new C.Cartesian3(...state.moonRadiance),nightSkyRadiance:()=>new C.Cartesian3(...state.nightSkyRadiance),
        atmosphereLutReady:()=>true,environmentSkyScale:()=>1,probeMode:()=>mode,probeTau:()=>tau}
      const command=context.createViewportQuadCommand(shader,{framebuffer,renderState,uniformMap:uniforms})
      const draw=m=>{
        mode=m;command.execute(context)
        const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),v=new Float32Array(4)
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer._framebuffer);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,v);gl.bindFramebuffer(gl.FRAMEBUFFER,previous)
        if(gl.getError()||!v.every(Number.isFinite))throw new Error('Invalid cloud source probe')
        return Array.from(v.slice(0,3))
      }
      const samples=[]
      for(const sunHeight of [.015,.05,.1,.4,.8])for(height of [1800,2200,2600,2790]){
        state=resolveEnvironmentState({},sunHeight);sun.x=Math.sqrt(1-sunHeight*sunHeight);sun.y=0;sun.z=sunHeight;origin.z=6371000+height
        if(!lut.update(context,{atmoOrigin:origin,sunLocal:sun,atmosphereMieParameters:new C.Cartesian2(.65,.9)}))throw new Error(lut.error)
        const T=draw(0),direct=draw(1),skyIrradiance=draw(2),meanSkyRadiance=draw(3),skySource=draw(5),directSources=[]
        for(tau of [0,1,10,50,100])directSources.push({tau,source:draw(4)})
        if(skySource.some((v,i)=>Math.abs(v-meanSkyRadiance[i]*.75)>1e-5))throw new Error('Isotropic cloud source lost mean-radiance normalization')
        const phase=(mu,g)=>(1-g*g)/(4*Math.PI*Math.pow(1+g*g-2*g*mu,1.5))
        for(const row of directSources){
          let reference=0
          for(let i=0;i<8;i++){
            const a=2**(-i)
            reference+=a*Math.exp(-row.tau*a)*.5*(phase(.8,.7*a)+phase(.8,-.2*a))
          }
          if(row.source.some((v,i)=>Math.abs(v-direct[i]*reference)>1e-5))throw new Error('Cloud scattering tail differs from eight-octave reference')
        }
        samples.push({sunHeight,height,daylight:state.daylight,solar:state.atmosphereSunRadiance,T,direct,skyIrradiance,meanSkyRadiance,skySource,directSources})
      }
      const lunar=[]
      origin.z=6373200;sun.x=Math.sqrt(1-.4*.4);sun.z=-.4;tau=10
      for(const moonHeight of [.7,.1,-.1])for(const moonPhase of [1,1/Math.PI,0]){
        state=resolveEnvironmentState({},-.4,0,{moonHeight,moonPhase})
        moon.x=Math.sqrt(1-moonHeight*moonHeight);moon.z=moonHeight
        if(!lut.update(context,{atmoOrigin:origin,sunLocal:sun,atmosphereMieParameters:new C.Cartesian2(.65,.9)}))throw new Error(lut.error)
        const direct=draw(6),ambient=draw(7),T=draw(8)
        if(state.atmosphereSunRadiance.some(v=>v!==0)||ambient.some((v,i)=>Math.abs(v-state.nightSkyRadiance[i]*.75)>1e-6))throw new Error('Night ambient depends on daylight')
        if(moonHeight<0&&T.some(v=>v!==0))throw new Error('Lunar LUT transmission penetrates the ground')
        if((moonHeight<0||moonPhase===0)&&direct.some(v=>v!==0))throw new Error('Moon phase/horizon leaked direct energy')
        if(moonHeight>0&&moonPhase>0&&!direct.every(v=>v>0))throw new Error('Lunar cloud source is zero')
        const full=lunar.find(v=>v.moonHeight===moonHeight&&v.moonPhase===1)
        if(full&&direct.some((v,i)=>Math.abs(v-full.direct[i]*moonPhase)>1e-6))throw new Error('Lunar scattering is not phase-linear')
        lunar.push({moonHeight,moonPhase,radiance:state.moonRadiance,direct,ambient,T})
      }
      command.shaderProgram.destroy();framebuffer.destroy();texture.destroy();C.RenderState.removeFromCache(renderState);lut.destroy()
      return {samples,lunar}
    })
    fs.writeFileSync(path.resolve(__dirname,`../../docs/verification/rendering-performance/cloud-irradiance-${label}.json`),JSON.stringify(report,null,2))
    console.log(JSON.stringify(report.samples.filter(s=>s.height===2200),null,2))
  }finally{await browser?.close();server.kill()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
