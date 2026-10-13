// Read the actual native edge output: stable ID alone does not prove stable outlines.
const {chromium} = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
async function main() {
  const browser = await chromium.launch({headless:true, channel:'chrome', args:['--use-angle=d3d11']})
  try {
    const page = await browser.newPage({viewport:{width:640,height:420}})
    const errors=[]; page.on('pageerror',error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${process.env.CCR_TEST_PORT || 8877}/tests/rendering/deferred-transparency-fixture.html`)
    await page.waitForFunction(()=>window.fixture)
    if(process.env.CCR_TEST_BUNDLE) {
      await page.addScriptTag({path:process.env.CCR_TEST_BUNDLE})
      await page.evaluate(()=>{fixture.CCR=window.CCR})
    }
    const result=await page.evaluate(async()=>{
      const C=Cesium, f=fixture, scene=f.viewer.scene
      const m=await import('/tests/rendering/deferred-transparency-fixture.js')
      await m.startTransparencyFixture(f)
      const wait=n=>m.waitFrames(scene,n,f.errors)
      for(const layer of f.layers) if(layer.id!=='backdrop') layer.model.show=false
      const model=f.layers[0].model
      scene.camera.twistLeft(0.23)
      f.pipeline.setAntiAliasing('taa')
      const silhouette=C.PostProcessStageLibrary.createSilhouetteStage()
      silhouette.selected=[model]; silhouette.uniforms.length=0.04
      silhouette.uniforms.color=C.Color.CYAN
      scene.postProcessStages.add(silhouette)
      await wait(60)
      const edge=silhouette.get(0)
      const read=texture=>{
        const fb=new C.Framebuffer({context:scene.context,colorTextures:[texture],destroyAttachments:false})
        try{return scene.context.readPixels({framebuffer:fb,width:texture.width,height:texture.height})}
        finally{fb.destroy()}
      }
      const sample=async()=>{
        let base,baseId,basePresented; const diffs=[],idDiffs=[],counts=[],presentedDiffs=[],presentedCounts=[]
        for(let i=0;i<16;i++){
          await wait(1)
          const pixels=read(edge.outputTexture)
          const ids=read(scene._view.sceneFramebuffer.idFramebuffer.getColorTexture(0))
          const output=read(scene.postProcessStages.outputTexture)
          const presented=Array.from({length:output.length/4},(_,j)=>output[j*4]<15 && output[j*4+1]>240 && output[j*4+2]>240)
          base ||= pixels; baseId ||= ids; basePresented ||= presented
          let diff=0,idDiff=0,count=0,presentedDiff=0,presentedCount=0
          for(let j=0;j<pixels.length;j+=4){
            if(pixels[j+3]!==base[j+3]) diff++
            if(pixels[j+3]) count++
            if(ids[j]!==baseId[j] || ids[j+1]!==baseId[j+1] || ids[j+2]!==baseId[j+2]) idDiff++
            if(presented[j/4]!==basePresented[j/4])presentedDiff++
            if(presented[j/4])presentedCount++
          }
          diffs.push(diff);idDiffs.push(idDiff);counts.push(count)
          presentedDiffs.push(presentedDiff);presentedCounts.push(presentedCount)
        }
        return {diffs,idDiffs,counts,presentedDiffs,presentedCounts}
      }
      const normal=await sample()
      // Negative control / hypothesis check: use the depth already drawn with stable IDs.
      const execute=edge.execute
      edge.execute=function(context,color,depth,id){
        return execute.call(this,context,color,scene._view.sceneFramebuffer.idFramebuffer.depthStencilTexture,id)
      }
      const stableDepth=await sample()
      edge.execute=execute
      scene.camera.moveRight(5)
      await wait(30)
      const moved=await sample()
      f.pipeline.setAntiAliasing('fxaa'); await wait(8)
      f.pipeline.setAntiAliasing('taa'); await wait(40)
      const reenabled=await sample()
      silhouette.selected=undefined;silhouette.enabled=false;await wait(8)
      const cleared=!scene.postProcessStages.hasSelected
      return {normal,stableDepth,moved,reenabled,cleared,taa:f.pipeline.getTaaDiagnostics(),errors:f.errors}
    })
    result.pageErrors=errors
    const out=process.env.CCR_TAA_REPORT || 'docs/verification/taa-silhouette/report.json'
    fs.mkdirSync(require('node:path').dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2))
    console.log(JSON.stringify({...result,taa:{valid:result.taa.valid,frames:result.taa.stats.frames}}))
    assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[])
    assert.ok(result.normal.counts.every(n=>n>100),'must render visible edges')
    assert.ok(result.normal.idDiffs.every(n=>n===0),'stable selection ID')
    assert.ok(result.normal.diffs.every(n=>n===0),'native silhouette must remain stable over all jitter samples')
    for(const state of [result.normal,result.moved,result.reenabled]) {
      assert.ok(state.diffs.every(n=>n===0),'stable edge output after movement / mode switches')
      assert.ok(state.presentedDiffs.every(n=>n===0),'actual composed cyan outline must also remain stable')
      assert.ok(state.presentedCounts.every(n=>n>100),'outline is present in final color')
    }
    assert.equal(result.cleared,true);assert.equal(result.taa.valid,true)
  } finally {await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})

