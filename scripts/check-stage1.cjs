const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const output = path.resolve(__dirname, '../docs/verification')
fs.mkdirSync(output, { recursive: true })
// The port is shared by every check script; read it once so the failure message can name it.
const port = process.env.CCR_TEST_PORT || 8877
const origin = `http://127.0.0.1:${port}`
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
    const errors = []
    // A missing asset or shader now has a URL attached, instead of only a bare console line.
    const httpErrors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() }) })
    await page.goto(`${origin}/tests/rendering/stage1-fixture.html`)
    await page.waitForFunction(() => window.fixture)
    const result = await page.evaluate(async () => {
      const { runSyntheticAOChecks } = await import('/tests/rendering/ao-numeric-fixture.js')
      const { hbaoShader } = await import('/src/ao/hbaoShader143.js')
      const { runBloomChecks } = await import('/tests/rendering/bloom-numeric-fixture.js')
      const { runCloudShellChecks } = await import('/tests/rendering/cloud-shell-fixture.js')
      const { runNoiseChecks } = await import('/tests/rendering/noise-numeric-fixture.js')
      const { runCloudFadeChecks } = await import('/tests/rendering/cloud-fade-fixture.js')
      const { runSpatialAaChecks } = await import('/tests/rendering/spatial-aa-fixture.js')
      return { ssao: runSyntheticAOChecks(Cesium, fixture.viewer), hbao: runSyntheticAOChecks(Cesium, fixture.viewer, hbaoShader), bloom: runBloomChecks(Cesium, fixture.viewer), shell:runCloudShellChecks(Cesium,fixture.viewer),noise:runNoiseChecks(Cesium,fixture.viewer),cloudFade:runCloudFadeChecks(Cesium,fixture.viewer),spatialAA:runSpatialAaChecks(Cesium,fixture.viewer) }
    })
    result.scene=await page.evaluate(async()=>{
      const {runStage1SceneChecks}=await import('/tests/rendering/stage1-scene.js')
      return runStage1SceneChecks(fixture)
    })
    result.resize=[]
    for(const viewport of [{width:801,height:603},{width:1280,height:720}]) {
      await page.setViewportSize(viewport)
      const resize=await page.evaluate(async()=>{
        const {viewer,pipeline}=fixture
        const frames=n=>new Promise(resolve=>{const off=viewer.scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
        await frames(12)
        const size=[viewer.canvas.width,viewer.canvas.height]
        const output=pipeline.hdrBloom.collection.outputTexture
        const rebuilt=output.width===size[0]&&output.height===size[1]
        pipeline.setScreenSpaceAO({algorithm:'ssao'});await frames(4)
        const ssao=pipeline.getScreenSpaceAODiagnostics().valid
        pipeline.setScreenSpaceAO({algorithm:'hbao'});await frames(4)
        pipeline.setScreenSpaceReflections({enabled:true});await frames(8)
        const ssr=pipeline.getScreenSpaceReflectionDiagnostics()
        pipeline.setAntiAliasing('smaa');await pipeline.smaa.readyPromise;await frames(12)
        return {size,rebuilt,ssao,hbao:pipeline.getScreenSpaceAODiagnostics().valid,
          bloom:pipeline.getHdrBloomDiagnostics().valid,clouds:pipeline.environmentRenderer.getDiagnostics().hdr.valid,
          ssr:ssr.valid,smaa:pipeline.smaa.getDiagnostics().effective==='smaa',errors:fixture.errors}
      })
      assert.ok(resize.rebuilt&&resize.ssao&&resize.hbao&&resize.bloom&&resize.clouds&&resize.ssr&&resize.smaa,JSON.stringify(resize))
      result.resize.push(resize)
    }
    result.profile=await page.evaluate(async()=>{
      const {default:RenderProfiler}=await import('/src/diagnostics/RenderProfiler143.js')
      const profiler=new RenderProfiler(Cesium,fixture.pipeline)
      await new Promise(resolve=>{let n=100;const off=fixture.viewer.scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})})
      const report=profiler.getReport();profiler.destroy()
      const labels=[...new Set(report.gpu.map(s=>s.label))]
      const gpu=Object.fromEntries(labels.map(label=>{const a=report.gpu.filter(s=>s.label===label).map(s=>s.milliseconds).sort((a,b)=>a-b);return [label,{samples:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)]}]}))
      return {scope:'synthetic 1280x720 headless Chrome; not a campus performance acceptance',gpuSupported:report.gpuSupported,gpu,textures:report.textures}
    })
    await page.screenshot({path:path.join(output,'stage1-combined.png')})
    await page.goto(`${origin}/tests/rendering/stage1-fixture.html?mode=umd`)
    await page.waitForFunction(()=>window.fixture)
    result.umd=await page.evaluate(async()=>{
      const {runStage1SceneChecks}=await import('/tests/rendering/stage1-scene.js')
      return runStage1SceneChecks(fixture)
    })
    await page.goto(`${origin}/examples/stage1.html`)
    await page.waitForFunction(()=>window.stage1Demo?.pipeline?.environmentRenderer?.getDiagnostics().hdr.valid)
    await page.click('#sky')
    await page.evaluate(()=>new Promise(resolve=>{let n=15;const off=stage1Demo.viewer.scene.postRender.addEventListener(()=>{if(--n===0){off();resolve()}})}))
    await page.screenshot({path:path.join(output,'stage1-shell-sky.png')})
    assert.ok(Object.values(result.hbao.checks).every(Boolean))
    assert.equal(errors.length, 0)
    // Local assets are this suite's inputs; a 404 means the run is not valid evidence.
    const missing = httpErrors.filter(entry => entry.url.includes('/src/') || entry.url.includes('/tests/') || entry.url.includes('/examples/') || entry.url.includes('/assets/') || entry.url.includes('/build/'))
    assert.equal(missing.length, 0, `missing project assets: ${JSON.stringify(missing)}`)
    fs.writeFileSync(path.join(output, 'stage1-gpu.json'), JSON.stringify({ ...result, errors, httpErrors }, null, 2))
    console.log(JSON.stringify({checks:Object.fromEntries(['ssao','hbao','bloom','shell','noise','scene','umd'].map(key=>[key,Object.keys(result[key].checks).length])),noise:result.noise,resize:result.resize,gpu:result.profile.gpu,errors,httpErrors}))
  } finally { await browser.close() }
})().catch(error => {
  console.error(error)
  if (error && /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error.message))) {
    console.error(`[check-stage1] no dev server on ${origin}; start one with: node scripts/dev-server.cjs --port ${port}`)
  }
  process.exitCode = 1
})
