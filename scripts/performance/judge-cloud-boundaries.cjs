#!/usr/bin/env node
// Visual regression fixture for cloud-shadow silhouettes and distance boundaries.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
async function main(){
  const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
  const label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)||'after'
  if(!/^[a-z-]+$/.test(label))throw new Error('Invalid label')
  const out=path.resolve(__dirname,'../../docs/verification/rendering-performance')
  const server=spawn(process.execPath,[path.resolve(__dirname,'../dev-server.cjs'),'--port','8964'],{stdio:'ignore'})
  let browser
  try{
    await new Promise(r=>setTimeout(r,1500))
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:8964/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&singleFrustum=1&models=tiles&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&assets=/assets/campus-assets',{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid,null,{timeout:120000})
    await page.waitForTimeout(7000)
    await page.evaluate(()=>{
      document.getElementById('hud')?.style.setProperty('display','none')
      document.querySelector('.lil-gui')?.style.setProperty('display','none')
      if(campus.stats?.dom)campus.stats.dom.style.setProperty('display','none')
      campus.viewer.clock.shouldAnimate=false
      campus.viewer.clock.currentTime=Cesium.JulianDate.fromIso8601('2026-09-08T11:00:00+08:00')
      campus.pipeline.setOptions({environmentAnimation:false,cloudCoverage:0.7})
    })
    const cases=[]
    for(const view of [{name:'tiles',height:1200,pitch:-75},{name:'range',height:18000,pitch:-22}]){
      await page.evaluate(view=>{
        const {viewer,pipeline}=campus,c=viewer.camera.positionCartographic
        viewer.camera.setView({destination:Cesium.Cartesian3.fromRadians(c.longitude,c.latitude,view.height),
          orientation:{heading:0,pitch:Cesium.Math.toRadians(view.pitch),roll:0}})
        // Admit surface receivers on both sides of the old 50 km cutoff while
        // retaining the supported single frustum. Scene depth is still real.
        viewer.camera.frustum.near=view.name==='range'?100:1
        viewer.camera.frustum.far=view.name==='range'?100000:50000
        pipeline.environmentRenderer.update()
        pipeline.setOptions(view.name==='tiles'?{cloudBaseHeight:3500,cloudThickness:1200}:{cloudBaseHeight:null,cloudThickness:null})
      },view)
      await page.waitForTimeout(1800)
      await page.screenshot({path:path.join(out,`cloud-boundary-${label}-${view.name}.png`)})
      const result=await page.evaluate(()=>{
        const {viewer,pipeline}=campus,e=pipeline.environmentRenderer,context=viewer.scene.context,gl=context._gl
        viewer.useDefaultRenderLoop=false
        const stage=e.stages.resolveStage,t=stage.outputTexture,fb=stage._textureCache.getFramebuffer(stage.name)
        const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING)
        gl.bindFramebuffer(gl.FRAMEBUFFER,fb._framebuffer)
        const color=new Float32Array(t.width*t.height*4)
        gl.readPixels(0,0,t.width,t.height,gl.RGBA,gl.FLOAT,color)
        gl.bindFramebuffer(gl.FRAMEBUFFER,previous)
        const hdr=e.hdr.getDiagnostics()
        const c=viewer.camera.positionCartographic
        viewer.useDefaultRenderLoop=true
        return {hdr,camera:{longitude:c.longitude,latitude:c.latitude,height:c.height},
          finite:color.every(Number.isFinite),glError:gl.getError()}
      })
      cases.push({view:view.name,...result})
      if(!result.hdr.valid||!result.finite||result.glError)throw new Error(JSON.stringify(result))
    }
    fs.writeFileSync(path.join(out,`cloud-boundary-${label}.json`),JSON.stringify({cases,errors},null,2))
    if(errors.length)throw new Error(errors.join('\n'))
    console.log(JSON.stringify({label,cases:cases.map(c=>({view:c.view,valid:c.hdr.valid,errors:c.glError}))}))
  }finally{if(browser)await browser.close();server.kill()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
