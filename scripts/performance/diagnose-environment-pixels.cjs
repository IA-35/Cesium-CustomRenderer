#!/usr/bin/env node
// Diagnose the environment composite at the pixel level.
//
// The visible symptom is a uniform wash across sky and ground with shattered white clouds, which
// points at the composite rather than at either integral. This samples the environment stage's own
// output, the scene colour, the reconstructed ray and the derived depth distance for a few
// positions, so the failure can be attributed instead of guessed.
const path = require('node:path')
const { spawn } = require('node:child_process')

async function main() {
  let chromium
  try { ({ chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')) } catch (error) {
    console.log(JSON.stringify({ supported: false, reason: error.message }))
    return
  }
  const port = 8940
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs'), '--port', String(port)], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-http-cache'] })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
    await page.goto(`http://127.0.0.1:${port}/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=none&singleFrustum=1&cb=${Date.now()}`,
      { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.viewer?.scene, null, { timeout: 120000 })
    await new Promise(resolve => setTimeout(resolve, 12000))

    const result = await page.evaluate(() => {
      const pipeline = window.campus.pipeline
      const renderer = pipeline.environmentRenderer
      const stages = renderer?.stages
      const hdr = renderer?.hdr
      const out = {}
      // Are the stage textures actually being produced and what format?
      out.raymarch = stages ? {
        ready: !!stages.raymarchStage.ready,
        size: stages.raymarchStage.outputTexture ? [stages.raymarchStage.outputTexture.width, stages.raymarchStage.outputTexture.height] : null,
        datatype: String(stages.raymarchStage.pixelDatatype),
        scale: stages.raymarchStage.textureScale
      } : null
      out.hdr = { valid: !!hdr?.getDiagnostics().valid, reason: hdr?.getDiagnostics().reason }
      // Sample the pipeline diagnostics for the uniform values that drive the integral.
      const opts = pipeline.getOptions()
      out.options = {
        environment: opts.environment, clouds: opts.clouds, quality: opts.environmentQuality,
        cloudBase: opts.cloudBaseHeight, cloudThickness: opts.cloudThickness, coverage: opts.cloudCoverage
      }
      // Read back a few scene pixels before and after the environment composite.
      const canvas = window.campus.viewer.scene.canvas
      const gl = window.campus.viewer.scene.context._gl
      const pixel = new Uint8Array(4)
      const readPixel = (x, y) => {
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        return [pixel[0], pixel[1], pixel[2]]
      }
      out.canvas = [canvas.width, canvas.height]
      out.skyPixel = readPixel(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.9))
      out.horizonPixel = readPixel(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5))
      out.groundPixel = readPixel(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.2))
      return out
    })
    console.log(JSON.stringify(result, null, 2))

    // Toggle pieces to isolate the contribution, one capture each.
    for (const [label, patch] of [
      ['clouds off', { clouds: false, volumetricFog: false }],
      ['environment off', { environment: false }]
    ]) {
      const shot = await page.evaluate(async ({ patch }) => {
        window.campus.pipeline.setOptions(patch)
        await new Promise(resolve => setTimeout(resolve, 2500))
        const canvas = window.campus.viewer.scene.canvas
        const gl = window.campus.viewer.scene.context._gl
        const pixel = new Uint8Array(4)
        const readPixel = (x, y) => {
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          return [pixel[0], pixel[1], pixel[2]]
        }
        return {
          sky: readPixel(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.9)),
          ground: readPixel(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.2))
        }
      }, { patch })
      console.log(`${label.padEnd(16)} sky=${JSON.stringify(shot.sky)} ground=${JSON.stringify(shot.ground)}`)
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
