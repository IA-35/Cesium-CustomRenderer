const {chromium}=require(process.env.CESIUM_PLAYWRIGHT||'playwright')
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path')
const output=path.resolve(__dirname,'../docs/verification')
;(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true})
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:8877/tests/rendering/stage1-fixture.html')
    await page.waitForFunction(()=>window.fixture)
    const numeric=await page.evaluate(async()=>{
      const a=await import('/tests/rendering/ssr-numeric-fixture.js'),b=await import('/tests/rendering/ssr-transition-fixture.js')
      return {regression:a.runSyntheticReflectionChecks(Cesium,fixture.viewer),transition:b.runReflectionTransitionChecks(Cesium,fixture.viewer)}
    })
    await page.goto('http://127.0.0.1:8877/examples/white-city.html')
    await page.waitForFunction(()=>window.whiteCity?.model.ready)
    const scene=await page.evaluate(async()=>{
      const {viewer,pipeline,view}=whiteCity,C=Cesium,scene=viewer.scene
      const frames=n=>new Promise(resolve=>{const off=scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
      await frames(30)
      const angles=[]
      for(let i=0;i<18;i++){
        view(3.4+i*.025,-.18,550);await frames(3)
        const ssr=pipeline.getScreenSpaceReflectionDiagnostics()
        const target=pipeline.screenSpaceReflections.stages.trace.outputTexture,gl=scene.context._gl
        const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
        let fbo
        try{
          fbo=new C.Framebuffer({context:scene.context,colorTextures:[target],destroyAttachments:false})
          const data=scene.context.readPixels({framebuffer:fbo,width:target.width,height:target.height})
          let hits=0;for(let j=3;j<data.length;j+=4)if(data[j]>0)hits++
          angles.push({heading:3.4+i*.025,valid:ssr.valid,hits})
        }finally{if(fbo)fbo.destroy();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)}
      }
      view(3.7,-.18,550);await frames(8)
      const pixels=()=>{const canvas=document.createElement('canvas');canvas.width=viewer.canvas.width;canvas.height=viewer.canvas.height;const c=canvas.getContext('2d');c.drawImage(viewer.canvas,0,0);return c.getImageData(0,0,canvas.width,canvas.height).data}
      const on=pixels();pipeline.setScreenSpaceReflections({enabled:false});await frames(8);const off=pixels()
      let changed=0,maximum=0;for(let i=0;i<on.length;i+=4){const d=Math.max(Math.abs(on[i]-off[i]),Math.abs(on[i+1]-off[i+1]),Math.abs(on[i+2]-off[i+2]));if(d>2)changed++;maximum=Math.max(maximum,d)}
      pipeline.setScreenSpaceReflections({enabled:true});await frames(8)
      const orbit=[];for(let i=0;i<8;i++){view(i*Math.PI/4,-.25,650);await frames(4);orbit.push(pipeline.getScreenSpaceReflectionDiagnostics().valid)}
      view(3.7,-.18,550);await frames(8)
      return {angles,orbit,comparison:{changedPixels:changed,maxChannelDifference:maximum},errors:whiteCity.errors,diagnostics:pipeline.getScreenSpaceReflectionDiagnostics()}
    })
    assert.ok(scene.angles.every(x=>x.valid));assert.ok(scene.angles.some(x=>x.hits>0))
    assert.ok(scene.orbit.every(Boolean));assert.ok(scene.comparison.changedPixels>100,JSON.stringify(scene.comparison))
    assert.equal(errors.length,0);assert.equal(scene.errors.length,0)
    await page.screenshot({path:path.join(output,'white-city-final.png')})
    fs.writeFileSync(path.join(output,'white-city-review.json'),JSON.stringify({numeric,scene,errors},null,2))
    console.log(JSON.stringify({regression:numeric.regression.checks,transition:numeric.transition,angles:scene.angles,errors}))
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
