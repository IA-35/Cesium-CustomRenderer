#!/usr/bin/env node
// Visual/transport acceptance only. No frame-rate or GPU-time benchmark.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function main() {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
  const directory = path.resolve(__dirname,'../../docs/verification/rendering-performance')
  const server = spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8962'],{stdio:'ignore'})
  let browser
  try {
    await new Promise(resolve=>setTimeout(resolve,1500))
    browser = await chromium.launch({channel:'chrome',headless:true})
    const page = await browser.newPage({viewport:{width:960,height:540}})
    const errors=[]; page.on('pageerror',error=>errors.push(error.message))
    await page.goto('http://127.0.0.1:8962/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid,null,{timeout:120000})
    await page.waitForTimeout(6000)
    await page.evaluate(()=>{
      document.getElementById('hud')?.style.setProperty('display','none')
      document.querySelector('.lil-gui')?.style.setProperty('display','none')
      if(campus.stats?.dom)campus.stats.dom.style.setProperty('display','none')
      campus.pipeline.setOptions({environmentAnimation:false,clouds:true})
      window.readCloudAcceptance = () => {
        const {viewer,pipeline}=campus,e=pipeline.environmentRenderer,gl=viewer.scene.context._gl
        const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
        const read=(stage)=>{
          const texture=stage.outputTexture,framebuffer=stage._textureCache.getFramebuffer(stage.name)
          gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer._framebuffer)
          const pixels=new Float32Array(texture.width*texture.height*4)
          gl.readPixels(0,0,texture.width,texture.height,gl.RGBA,gl.FLOAT,pixels)
          return pixels
        }
        const color=read(e.stages.cloudStage),depth=read(e.stages.cloudDepthStage),transmission=read(e.stages.transmissionStage)
        let occupied=0,weightedDistance=0,minT=1,maxDepthDifference=0
        for(let i=0;i<color.length;i+=4){
          if(color[i+3]<0.99){occupied++;weightedDistance+=depth[i]}
          minT=Math.min(minT,color[i+3]);maxDepthDifference=Math.max(maxDepthDifference,Math.abs(color[i+3]-depth[i+1]))
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER,previous)
        return {hdr:e.hdr.getDiagnostics(),coverage:e.state.cloudCoverage,height:[e.state.cloudBase,e.state.cloudTop],
          occupiedRatio:occupied/(color.length/4),meanCloudDistance:occupied?weightedDistance/occupied:0,minT,
          maxDepthDifference,finite:[color,depth,transmission].every(p=>p.every(Number.isFinite)),glError:gl.getError()}
      }
    })
    const cases=[]
    for(const time of ['0530','1100','1800']){
      for(const view of [{name:'below',height:300,pitch:10},{name:'inside',height:2200,pitch:0},
        {name:'above',height:3500,pitch:-15},{name:'high',height:12000,pitch:0}]){
        await page.evaluate(({time,view})=>{
          campus.viewer.clock.shouldAnimate=false
          campus.viewer.clock.currentTime=Cesium.JulianDate.fromIso8601('2026-09-08T'+time.slice(0,2)+':'+time.slice(2)+':00+08:00')
          campus.pipeline.environmentRenderer.update()
          const c=campus.viewer.camera.positionCartographic,s=campus.pipeline.environmentRenderer.sunLocal
          campus.viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,view.height),
            orientation:{heading:Math.atan2(s.x,s.y),pitch:Cesium.Math.toRadians(view.pitch),roll:0}})
        },{time,view})
        await page.waitForTimeout(900)
        const result=await page.evaluate(()=>window.readCloudAcceptance())
        if(!result.hdr.valid||!result.finite||result.glError||result.hdr.cloudTemporal.error)throw new Error(JSON.stringify(result))
        if(result.maxDepthDifference>1e-5)throw new Error('Cloud color/depth sampled different fields')
        const file=`cloud-transport-${time}-${view.name}.png`
        await page.screenshot({path:path.join(directory,file)})
        cases.push({time,view:view.name,file,...result})
        console.log(JSON.stringify({time,view:view.name,occupiedRatio:result.occupiedRatio,historyAge:result.hdr.cloudTemporal.age}))
      }
    }
    // Coverage controls must alter the actual volume, including exact empty space.
    const controls=[]
    for(const coverage of [0,0.42,0.9]){
      await page.evaluate(coverage=>{
        const c=campus.viewer.camera.positionCartographic
        campus.viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,3500),orientation:{heading:0,pitch:-0.25,roll:0}})
        campus.pipeline.setOptions({cloudCoverage:coverage})
      },coverage)
      await page.waitForTimeout(700)
      controls.push(await page.evaluate(()=>window.readCloudAcceptance()))
    }
    if(controls[0].minT!==1||controls[0].occupiedRatio!==0||controls[2].occupiedRatio<=controls[1].occupiedRatio)throw new Error('Coverage control failed')
    const shadows=await page.evaluate(()=>{
      const {viewer,pipeline}=campus,e=pipeline.environmentRenderer,gl=viewer.scene.context._gl
      viewer.useDefaultRenderLoop=false
      viewer.clock.currentTime=Cesium.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
      pipeline.setOptions({cloudCoverage:0.7});e.update()
      const c=viewer.camera.positionCartographic
      viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,300),orientation:{heading:0,pitch:-Math.PI/3,roll:0}})
      for(let i=0;i<12;i++)viewer.render()
      // Cesium captures function-valued uniforms in the command map at update;
      // replacing the public property afterwards does not alter that callback.
      const stage=e.stages.resolveStage,map=stage._command.uniformMap,saved=map.effectFlags
      const read=()=>{
        const t=stage.outputTexture,pixels=new Float32Array(t.width*t.height*4),previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
        gl.bindFramebuffer(gl.FRAMEBUFFER,stage._textureCache.getFramebuffer(stage.name)._framebuffer)
        gl.readPixels(0,0,t.width,t.height,gl.RGBA,gl.FLOAT,pixels)
        gl.bindFramebuffer(gl.FRAMEBUFFER,previous);return pixels
      }
      const withShadow=read()
      map.effectFlags=()=>{const flags=saved();return new Cesium.Cartesian4(flags.x,0,flags.z,flags.w)}
      viewer.render();const withoutShadow=read();map.effectFlags=saved;viewer.render()
      let changed=0,maxDelta=0,maxAlphaDelta=0
      for(let i=0;i<withShadow.length;i+=4){
        const delta=Math.max(...[0,1,2].map(c=>withoutShadow[i+c]-withShadow[i+c]))
        if(delta>1e-4)changed++;maxDelta=Math.max(maxDelta,delta)
        maxAlphaDelta=Math.max(maxAlphaDelta,Math.abs(withShadow[i+3]-withoutShadow[i+3]))
      }
      viewer.useDefaultRenderLoop=true
      return {changedRatio:changed/(withShadow.length/4),maxDelta,maxAlphaDelta,glError:gl.getError()}
    })
    if(shadows.changedRatio<0.001||shadows.maxDelta<=0.001||shadows.maxAlphaDelta>1e-6||shadows.glError)throw new Error('Receiver shadows not active: '+JSON.stringify(shadows))
    // Exercise real host invalidation; the first frame after a cut must start clean.
    const transitions=await page.evaluate(()=>{
      const {viewer,pipeline}=campus,e=pipeline.environmentRenderer
      viewer.useDefaultRenderLoop=false
      const render=()=>{viewer.render();return e.hdr.cloudTemporal.getDiagnostics()}
      const settle=()=>{for(let i=0;i<12;i++)render();return e.hdr.cloudTemporal.getDiagnostics()}
      const before=settle()
      viewer.camera.moveRight(10);const smallMove=render()
      viewer.camera.moveRight(1000);const cameraCut=render()
      const settled=settle()
      viewer.clock.currentTime=Cesium.JulianDate.addSeconds(viewer.clock.currentTime,3600,new Cesium.JulianDate())
      e.update();const timeJump=render()
      return {before,smallMove,cameraCut,settled,timeJump}
    })
    if(transitions.smallMove.age<=transitions.before.age||transitions.cameraCut.age!==1||transitions.timeJump.age!==1)throw new Error('Host history invalidation failed: '+JSON.stringify(transitions))
    fs.writeFileSync(path.join(directory,'cloud-transport-acceptance.json'),JSON.stringify({cases,controls,shadows,transitions,errors},null,2))
    if(errors.length)throw new Error(errors.join('\n'))
    console.log('cloud transport visual/lifecycle checks passed')
  }finally{if(browser)await browser.close();server.kill()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
