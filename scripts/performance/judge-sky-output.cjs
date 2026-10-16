#!/usr/bin/env node
// Judge sky/cloud/ground separation with local terrain and surrounding city geometry.
//
// The campus terrain and GLB models come from hosts that are not always available, and asserting
// on them was a mistake: the environment pass can be evaluated on sky pixels alone. This script
// points the camera at the sky at a fixed sun angle, then reports the actual pixel values the
// environment produced, so "does the sky look right" becomes a measurement instead of a guess.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: error.message }))
    process.exitCode = 1
    return
  }
  const port = 8960
  const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'rendering-performance')
  fs.mkdirSync(outDir, { recursive: true })
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message.slice(0, 200)))
    page.on('console', message => {
      const text = message.text()
      // Asset-host failures are expected here and are irrelevant to the sky.
      if (message.type() === 'error' && !text.includes('ERR_CONNECTION_REFUSED')) errors.push('console: ' + text.slice(0, 200))
    })
    // Hide the HUD so it does not cover the sky, and keep the default asset host (its failure is
    // tolerated; the environment pass does not depend on it).
    const scale = Number(process.argv.find(value => value.startsWith('--scale='))?.split('=')[1] || 0.5)
    const view = process.argv.find(value => value.startsWith('--view='))?.split('=')[1] || 'horizon'
    if (!['horizon', 'overhead', 'cloud-top'].includes(view)) throw new Error('Unsupported view: ' + view)
    await page.addInitScript(value => { window.CCR_ENV_SCALE = value }, scale)
    const query = 'traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&singleFrustum=1&models=tiles&assets=/assets/campus-assets'
    await page.goto(`http://127.0.0.1:${port}/examples/campus.html?${query}&cb=${Date.now()}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await page.evaluate(() => {
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelector('.lil-gui')?.style.setProperty('display', 'none')
      if (campus.stats?.dom) campus.stats.dom.style.display = 'none'
    })
    await new Promise(resolve => setTimeout(resolve, 8000))

    // Aim the camera at the horizon and up at the sky, so the frame is dominated by atmosphere.
    const report = await page.evaluate(async ({ view, scale }) => {
      const viewer = window.campus.viewer
      const pipeline = window.campus.pipeline
      const out = {}
      const gl = viewer.scene.context._gl
      // Read the environment stage's own output, which is where the sky is produced, rather than
      // the default framebuffer that Cesium's HDR chain owns.
      const readStage = () => {
        const stages = pipeline.environmentRenderer?.stages
        const stage = stages?.raymarchStage
        const fb = stage?._textureCache?.getFramebuffer(stage.name)
        if (!fb) throw new Error('Environment stage framebuffer unavailable: ' + JSON.stringify(pipeline.environmentRenderer?.getDiagnostics()))
        const width = stages.raymarchStage.outputTexture.width
        const height = stages.raymarchStage.outputTexture.height
        const pixels = new Float32Array(4 * 8)
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb._framebuffer || fb)
        const samples = []
        for (const [fx, fy] of [[0.5, 0.85], [0.5, 0.6], [0.2, 0.75], [0.8, 0.75]]) {
          gl.readPixels(Math.floor(width * fx), Math.floor(height * fy), 1, 1, gl.RGBA, gl.FLOAT, pixels)
          const packed = pixels[3]
          const q = [Math.floor(packed / 65536), Math.floor((packed % 65536) / 256), packed % 256]
          const t = q.map(value => value >= 255 ? 0 : Math.exp(-value * (16 / 254)))
          samples.push([+pixels[0].toFixed(4), +pixels[1].toFixed(4), +pixels[2].toFixed(4), +Math.min(...t).toFixed(5)])
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
        return samples
      }
      // Look up at the sky.
      const carto = viewer.camera.positionCartographic
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude,
          view === 'overhead' ? 12000 : view === 'cloud-top' ? 3500 : 300),
        orientation: { heading: 0, pitch: view === 'overhead' ? -Math.PI / 2 : view === 'cloud-top' ? -Math.PI / 15 : 0, roll: 0 }
      })
      await new Promise(resolve => setTimeout(resolve, 1500))
      out.skyUp = readStage()
      out.rayStage = {
        ready: !!pipeline.environmentRenderer?.stages?.raymarchStage?.ready,
        size: pipeline.environmentRenderer?.stages?.raymarchStage?.outputTexture
          ? [pipeline.environmentRenderer.stages.raymarchStage.outputTexture.width,
             pipeline.environmentRenderer.stages.raymarchStage.outputTexture.height] : null
      }
      out.hdr = pipeline.environmentRenderer.hdr.getDiagnostics()
      if (!out.hdr.valid) throw new Error('Environment HDR output invalid: ' + out.hdr.reason)
      if (!out.skyUp.flat().every(Number.isFinite)) throw new Error('Non-finite environment pixels')
      const o = pipeline.getOptions()
      const atmosphereOptions = { sunScattering: o.sunScattering, volumetricFog: o.volumetricFog, fog: o.fog }
      pipeline.setOptions({ clouds: false })
      await new Promise(resolve => setTimeout(resolve, 500))
      out.cloudsOff = readStage()
      if (!out.skyUp.some((pixel,i) => pixel[3] < out.cloudsOff[i][3] * 0.8)) throw new Error('Default clouds do not change scene transmission')
      pipeline.setOptions({ clouds: false, sunScattering: false, volumetricFog: false, fog: false })
      await new Promise(resolve => setTimeout(resolve, 500))
      out.effectsOff = readStage()
      if (out.effectsOff.some(pixel => pixel.slice(0,3).some(v => Math.abs(v) > 1e-5) || Math.abs(pixel[3]-1) > 1e-5)) throw new Error('Disabled medium is not radiance=0, T=1')
      pipeline.setOptions({ ...atmosphereOptions, clouds: true, lightShaftEnabled: true, lightShaftStrength: 0.5 })
      await new Promise(resolve => setTimeout(resolve, 500))
      out.medium = pipeline.environmentRenderer.getMediumOcclusionDiagnostics()
      // Do not serialize the Cesium texture graph.
      delete out.medium.texture
      if (!out.medium.valid) throw new Error('Medium output invalid: ' + out.medium.reason)
      pipeline.setOptions({ lightShaftEnabled: false })
      await new Promise(resolve => setTimeout(resolve, 500))
      window.CCR_ENV_SCALE = scale === 1 ? 0.5 : 1
      await new Promise(resolve => setTimeout(resolve, 500))
      const hot = pipeline.environmentRenderer.stages.raymarchStage.outputTexture
      out.hotScaleSize = [hot.width, hot.height]
      if (hot.width !== Math.ceil(viewer.canvas.width * window.CCR_ENV_SCALE)) throw new Error('Diagnostic scale did not rebuild the volume target')
      window.CCR_ENV_SCALE = scale
      await new Promise(resolve => setTimeout(resolve, 500))
      return out
    }, { view, scale })
    console.log(JSON.stringify(report, null, 2))
    const file = path.join(outDir, `p0-${view}-scale-${scale}.png`)
    await page.screenshot({ path: file })
    console.log(`wrote ${path.relative(process.cwd(), file)}`)
    const previousAtmosphere = await page.evaluate(() => {
      const o = campus.pipeline.getOptions()
      campus.pipeline.setOptions({ sunScattering: false, volumetricFog: false, fog: false })
      return { sunScattering: o.sunScattering, volumetricFog: o.volumetricFog, fog: o.fog }
    })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(outDir, `p0-${view}-clouds-only-scale-${scale}.png`) })
    await page.evaluate(patch => campus.pipeline.setOptions(patch), previousAtmosphere)
    await page.evaluate(() => window.campus.pipeline.setOptions({ clouds: true, cloudCoverage: 1 }))
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(outDir, `p0-${view}-dense-scale-${scale}.png`) })
    fs.writeFileSync(path.join(outDir, `p0-${view}-scale-${scale}.json`), JSON.stringify({ scale, view, ...report, errors }, null, 2))
    if (errors.length) process.exitCode = 1
    if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 3)))
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
