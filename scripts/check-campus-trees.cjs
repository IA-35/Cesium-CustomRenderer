const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')

const port = process.env.CCR_TEST_PORT || 8878
const origin = `http://127.0.0.1:${port}`
const output = path.resolve(__dirname, '../docs/verification/campus-trees')
fs.mkdirSync(output, { recursive: true })

async function comparePng(page, before, after) {
  return page.evaluate(async ({ first, second }) => {
    const decode = async base64 => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
    const [a, b] = await Promise.all([decode(first), decode(second)])
    assertDimensions(a, b)
    const canvas = new OffscreenCanvas(a.width, a.height); const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(a, 0, 0); const left = context.getImageData(0, 0, a.width, a.height).data
    context.clearRect(0, 0, a.width, a.height); context.drawImage(b, 0, 0); const right = context.getImageData(0, 0, b.width, b.height).data
    let changedPixels = 0; let sum = 0; let max = 0
    for (let index = 0; index < left.length; index += 4) {
      const delta = Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2])
      if (delta > 12) changedPixels++
      sum += delta; max = Math.max(max, delta)
    }
    return { width: a.width, height: a.height, changedPixels, changedPercent: 100 * changedPixels / (a.width * a.height), meanRgbDelta: sum / (a.width * a.height * 3), maxRgbDelta: max }
    function assertDimensions(left, right) { if (left.width !== right.width || left.height !== right.height) throw new Error('Screenshot dimensions differ') }
  }, { first: before.toString('base64'), second: after.toString('base64') })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.setDefaultTimeout(180000)
    const pageErrors = []; const httpErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() }) })
    // Omit trees/grass parameters: the default campus entry must load both.
    await page.goto(`${origin}/examples/campus.html?imagery=none&contextTiles=none`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (campus?.trees?.getDiagnostics().state === 'ready' && campus?.grass?.getDiagnostics().state === 'ready') || campus?.errors?.length, null, { timeout: 180000 })
    const frames = count => page.evaluate(async count => new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{remove();reject(new Error('Render frames timed out: '+campus.errors.join(';')))},60000)
      const remove = campus.viewer.scene.postRender.addEventListener(() => { if (--count === 0) { clearTimeout(timer);remove(); resolve() } })
    }), count)
    await page.evaluate(() => {
      document.querySelectorAll('.lil-gui.lil-root,#hud').forEach(element => { element.style.display = 'none' })
      campus.stats.dom.style.display = 'none'
      // Grass has its own acceptance check and must not contaminate tree pixels.
      campus.grass.setVisible(false)
    })
    const views = [
      ['high', 123.4137, 41.7640, 1200, -70],
      ['mid', 123.4137, 41.7668, 180, -35],
      ['near', 123.4137, 41.7670, 55, -25]
    ]
    const states = []
    for (const [name, longitude, latitude, height, pitch] of views) {
      await page.evaluate(({ longitude, latitude, height, pitch }) => campus.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitch), roll: 0 }
      }), { longitude, latitude, height, pitch })
      await frames(30)
      const diagnostics = await page.evaluate(() => campus.trees.getDiagnostics())
      const screenshot = await page.screenshot({ path: path.join(output, `${name}.png`) })
      states.push({ name, diagnostics, screenshot })
    }
    const visible = states.at(-1).screenshot
    await page.evaluate(() => campus.trees.setVisible(false)); await frames(10)
    const hidden = await page.screenshot({ path: path.join(output, 'near-hidden.png') })
    const pixelDelta = await comparePng(page, visible, hidden)

    await page.evaluate(() => { campus.trees.setVisible(true); campus.pipeline.setOptions({ shadowMode: 'custom', shadowStatic: false }) })
    await frames(20)
    const shadowWithTrees = await page.evaluate(() => campus.pipeline.customShadow?.stats.casters || 0)
    await page.evaluate(() => campus.trees.setVisible(false)); await frames(20)
    const shadowWithoutTrees = await page.evaluate(() => campus.pipeline.customShadow?.stats.casters || 0)
    await page.evaluate(() => campus.trees.setVisible(true))

    // Isolate the vegetation against a neutral background so green terrain cannot
    // make a monochrome canopy pass the color check.
    await page.evaluate(()=>{
      campus.pipeline.setEnabled(false)
      campus.tiles.forEach(t=>t.show=false);campus.contextTiles.forEach(t=>t.show=false)
      const s=campus.viewer.scene;s.globe.show=false;s.skyBox.show=false;s.skyAtmosphere.show=false;s.sun.show=false;s.moon.show=false
      s.backgroundColor=new Cesium.Color(0.16,0.16,0.16,1)
      campus.viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(123.4118,41.7641,7),new Cesium.HeadingPitchRange(0,-0.06,42))
    })
    await frames(20)
    const isolated=await page.screenshot({path:path.join(output,'isolated-trees.png')})
    const colors=await page.evaluate(async base64=>{
      const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+base64)).blob())
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0)
      const data=ctx.getImageData(0,0,bitmap.width,bitmap.height).data
      let green=0,neutralBright=0
      for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if(g>r*1.12&&g>b*1.12&&g>35)green++;if(Math.max(r,g,b)-Math.min(r,g,b)<8&&g>100)neutralBright++}
      return {green,neutralBright}
    },isolated.toString('base64'))
    assert.ok(colors.green>10000,`No green tree canopy: ${JSON.stringify(colors)}`)
    assert.ok(colors.green>colors.neutralBright*3,`Canopy is predominantly white/grey: ${JSON.stringify(colors)}`)

    const browserState = await page.evaluate(() => ({ errors: [...campus.errors], diagnostics: campus.trees.getDiagnostics() }))
    assert.deepEqual(browserState.errors, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(httpErrors, [])
    assert.equal(browserState.diagnostics.instances, 720)
    assert.equal(browserState.diagnostics.groundFallbacks, 0)
    assert.equal(browserState.diagnostics.groundClamped, true)
    for (const { diagnostics } of states) {
      assert.ok(diagnostics.visibleBatches <= diagnostics.batches)
      assert.equal(diagnostics.backend, 'cesium-ez-tree')
      assert.equal(diagnostics.source, 'procedural')
      assert.equal(diagnostics.modelCount, 0)
      assert.equal(diagnostics.primitiveCount, 1)
      assert.equal(diagnostics.lodBatches.reduce((sum, count) => sum + count, 0), diagnostics.batches)
    }
    const observedLods = new Set(states.flatMap(({ diagnostics }) => diagnostics.lodBatches.map((count, lod) => count ? lod : null).filter(lod => lod !== null)))
    assert.ok(observedLods.has(0), 'Procedural presets must be rendered without point thinning')
    assert.ok(pixelDelta.changedPercent > 0.2, `Tree visibility changed only ${pixelDelta.changedPercent}% of pixels`)
    assert.ok(shadowWithTrees > shadowWithoutTrees, `Tree shadow casters were not submitted: ${shadowWithTrees} <= ${shadowWithoutTrees}`)

    const report = {
      scope: '1440x900 headless Chrome; real campus tiles; SM_NH_Shu disabled; fixed camera route',
      states: states.map(({ name, diagnostics }) => ({ name, ...diagnostics })),
      pixelDelta, colors, shadows: { withTrees: shadowWithTrees, withoutTrees: shadowWithoutTrees },
      pageErrors, httpErrors
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally { await browser.close() }
})().catch(error => {
  console.error(error)
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error?.message))) console.error(`[check-campus-trees] start the server with: node scripts/dev-server.cjs --port ${port}`)
  process.exitCode = 1
})
