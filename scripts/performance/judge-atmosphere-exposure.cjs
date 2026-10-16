#!/usr/bin/env node
// Visual correctness check, not a performance benchmark. Uses the shipped SDK and local scene.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function main() {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
  const label = process.argv.find(arg => arg.startsWith('--label='))?.split('=')[1] || 'after'
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid output label')
  const timeArg = process.argv.find(arg => arg.startsWith('--times='))?.split('=')[1]
  const times = timeArg ? timeArg.split(',') : ['1100']
  if(times.some(time=>!/^([01]\d|2[0-3])[0-5]\d$/.test(time))) throw new Error('Invalid local time')
  const compareNative = process.argv.includes('--native')
  const altitude = Number(process.argv.find(arg => arg.startsWith('--altitude='))?.split('=')[1] || 300)
  if (!(altitude >= 0 && altitude <= 100000)) throw new Error('Invalid camera altitude')
  const requestedViews = process.argv.find(arg => arg.startsWith('--views='))?.split('=')[1]?.split(',') || ['horizon', 'sun-horizon', 'sun']
  if (requestedViews.some(view => !['horizon','sun-horizon','sun'].includes(view))) throw new Error('Invalid view')
  const outDir = path.resolve(__dirname, '../../docs/verification/rendering-performance')
  fs.mkdirSync(outDir, { recursive: true })
  const server = spawn(process.execPath, [path.resolve(__dirname, '../dev-server.cjs'), '--port', '8961'], { stdio: 'ignore' })
  let browser
  try {
    await new Promise(resolve => setTimeout(resolve, 1500))
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:8961/examples/campus.html?traffic=none&trees=none&grass=none&water=none&imagery=none&contextTiles=/assets/campus-assets/Dongda2.5bm_3dtiles/tileset.json&singleFrustum=1&models=tiles&assets=/assets/campus-assets', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.campus?.pipeline?.environmentRenderer?.hdr?.getDiagnostics().valid, null, { timeout: 120000 })
    await page.waitForTimeout(8000)
    await page.evaluate(({neutral,compareNative}) => {
      document.getElementById('hud')?.style.setProperty('display', 'none')
      document.querySelector('.lil-gui')?.style.setProperty('display', 'none')
      if (campus.stats?.dom) campus.stats.dom.style.display = 'none'
      campus.pipeline.setOptions({ environmentAnimation: false })
      if (neutral) campus.pipeline.setOptions({ contrast:1,brightness:1,saturation:1 })
      // With imagery=none Cesium may never render a globe tile and consequently
      // suppress its sky (isReadyForAtmosphere=false). Isolate the sky in both
      // modes instead of accidentally measuring black as the native reference.
      if(compareNative){
        campus.viewer.scene.globe.show=false
        // The native sky is a mesh ~160 km above Earth. The campus single-frustum
        // fixture's 50 km far plane clips it entirely. Keep one frustum while
        // admitting the shell; this mode compares sky, not nearby geometry.
        campus.viewer.camera.frustum.near=10000
        campus.viewer.camera.frustum.far=10000000
        // Native SunPostProcess uses an LDR intermediate. Compare atmospheric
        // transport, not its clipped sun-bloom composite or the solar billboard.
        campus.viewer.scene.sunBloom=false
        if(campus.viewer.scene.sun)campus.viewer.scene.sun.show=false
      }
    }, {neutral:process.argv.includes('--neutral'),compareNative})
    const cases = []
    for (const time of times) {
      await page.evaluate(time=>{
        campus.viewer.clock.shouldAnimate=false
        campus.viewer.clock.currentTime=Cesium.JulianDate.fromIso8601('2026-09-08T'+time.slice(0,2)+':'+time.slice(2)+':00+08:00')
        campus.pipeline.environmentRenderer.update()
      },time)
    for (const view of requestedViews) {
      await page.evaluate(({view,altitude}) => {
        const { viewer, pipeline } = campus
        const c = viewer.camera.positionCartographic
        const sun = pipeline.environmentRenderer.sunLocal
        const heading = view === 'horizon' ? 0 : Math.atan2(sun.x, sun.y)
        const pitch = view === 'sun' ? Math.asin(sun.z) : 0
        viewer.camera.setView({ destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, altitude), orientation: { heading, pitch, roll: 0 } })
      }, {view,altitude})
      for (const clouds of compareNative ? (process.argv.includes('--clear-only')?[false,'native']:[true, false, 'native']) : (process.argv.includes('--clear-only')?[false]:[true, false])) {
        await page.evaluate(clouds => campus.pipeline.setOptions({ clouds:clouds===true,
          sunScattering:clouds!=='native',volumetricFog:clouds!=='native',fog:clouds!=='native' }), clouds)
        await page.waitForTimeout(1500)
        const report = await page.evaluate(() => {
          const { viewer, pipeline } = campus
          const scene = viewer.scene
          viewer.render()
          const gl = scene.context._gl
          const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING)
          const stages = pipeline.environmentRenderer.stages
          const read = (stage, type) => {
            const texture = stage.outputTexture
            const fb = stage._textureCache.getFramebuffer(stage.name)
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb._framebuffer)
            const pixels = new Float32Array(4)
            const samples = []
            for (const [u,v] of [[0.5,0.9],[0.5,0.75],[0.5,0.52],[0.5,0.25]]) {
              gl.readPixels(Math.floor(texture.width*u), Math.floor(texture.height*v), 1, 1, gl.RGBA, type, pixels)
              samples.push(Array.from(pixels, n => +n.toFixed(5)))
            }
            return samples
          }
          const radiance = read(stages.raymarchStage, gl.FLOAT)
          const resolved = read(stages.resolveStage, gl.FLOAT)
          const hdrSize=stages.resolveStage.outputTexture
          const hdrPixels=new Float32Array(hdrSize.width*hdrSize.height*4)
          gl.readPixels(0,0,hdrSize.width,hdrSize.height,gl.RGBA,gl.FLOAT,hdrPixels)
          const scanline=[]
          for(let y=0;y<hdrSize.height;y++){
            const i=(y*hdrSize.width+Math.floor(hdrSize.width*0.35))*4
            scanline.push(Array.from(hdrPixels.subarray(i,i+3)))
          }
          const luminance=[]
          for(let y=Math.floor(hdrSize.height*0.55);y<hdrSize.height;y+=8)for(let x=0;x<hdrSize.width;x+=8){
            if(Math.hypot(x/hdrSize.width-0.5,y/hdrSize.height-0.5)<0.05)continue
            const i=(y*hdrSize.width+x)*4
            luminance.push(hdrPixels[i]*0.2126+hdrPixels[i+1]*0.7152+hdrPixels[i+2]*0.0722)
          }
          luminance.sort((a,b)=>a-b)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          const w = viewer.canvas.width, h = viewer.canvas.height
          const pixels = new Uint8Array(w*h*4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
          // Exclude the central 5% region: the actual solar disk is expected to clip.
          let count=0, white=0, blue=0, washed=0, sum=[0,0,0]
          for (let y=Math.floor(h*0.55); y<h; y++) for (let x=0; x<w; x++) {
            if (Math.hypot(x/w-0.5,y/h-0.5)<0.05) continue
            const i=(y*w+x)*4, [r,g,b]=pixels.subarray(i,i+3)
            count++; if (r>=250&&g>=250&&b>=250) white++
            if(Math.min(r,g,b)>=220&&Math.max(r,g,b)-Math.min(r,g,b)<=18)washed++
            if (b-r>=15) blue++
            sum[0]+=r; sum[1]+=g; sum[2]+=b
          }
          if (!hdrPixels.every(Number.isFinite)) throw new Error('Non-finite HDR output')
          const o=pipeline.getOptions(), e=pipeline.environmentRenderer
          const nativeCommand=scene._environmentState.skyAtmosphereCommand
          const nativeDerived=nativeCommand?.derivedCommands?.logDepth?.command||nativeCommand
          const program=stages.raymarchStage._command.shaderProgram._program
          const activeUniforms={}
          for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){
            const name=gl.getActiveUniform(program,i).name
            if(/sunDirectionAtmo|atmosphereOrigin|atmosphereSunRadiance|atmosphereParams/.test(name)){
              const value=gl.getUniform(program,gl.getUniformLocation(program,name))
              activeUniforms[name]=typeof value==='number'?value:Array.from(value)
            }
          }
          return { radiance, resolved, scanline, whiteRatio:white/count, washedRatio:washed/count, blueRatio:blue/count,
            activeUniforms,
            hdrLuminance:{mean:luminance.reduce((a,b)=>a+b,0)/luminance.length,p50:luminance[Math.floor(luminance.length*0.5)],p95:luminance[Math.floor(luminance.length*0.95)]},
            meanRgb:sum.map(n=>n/count), sunLocal:[e.sunLocal.x,e.sunLocal.y,e.sunLocal.z],
            sunRadiance:e.state.sunRadiance, atmosphereSunRadiance:e.state.atmosphereSunRadiance, hdr:e.hdr.getDiagnostics(),
            nativeSky:{intensity:scene.skyAtmosphere.atmosphereLightIntensity,anisotropy:scene.skyAtmosphere.atmosphereMieAnisotropy,
              hdr:scene.highDynamicRange,derivedHdr:!!nativeDerived?.derivedCommands?.hdr,sunBloom:scene.sunBloom,
              inputDatatype:e.hdr.inputColor?.pixelDatatype},
            grading:{exposure:o.exposure,contrast:o.contrast,brightness:o.brightness,saturation:o.saturation}, glError:gl.getError() }
        })
        if (report.glError) throw new Error('GL readback failed: '+report.glError)
        const mode=clouds==='native'?'native':clouds?'clouds':'clear'
        const file=`p0-exposure-${label}-${timeArg?time+'-':''}${view}-${mode}.png`
        await page.screenshot({ path:path.join(outDir,file) })
        cases.push({time,view,clouds,file,...report})
        console.log(JSON.stringify({time,view,mode,whiteRatio:report.whiteRatio,meanRgb:report.meanRgb,hdrLuminance:report.hdrLuminance}))
      }
    }
    }
    const comparison=compareNative?cases.filter(c=>c.clouds===false).map(c=>{
      const native=cases.find(n=>n.time===c.time&&n.view===c.view&&n.clouds==='native')
      return {time:c.time,view:c.view,ratio:c.hdrLuminance.mean/Math.max(native.hdrLuminance.mean,1e-8)}
    }):[]
    const nativeEquivalence=compareNative?comparison.every(c=>c.ratio>=0.8&&c.ratio<=1.25):null
    fs.writeFileSync(path.join(outDir,`p0-exposure-${label}.json`),JSON.stringify({times,altitude,cases,comparison,nativeEquivalence,errors},null,2))
    if (errors.length) throw new Error(errors.join('\n'))
    if (label.endsWith('after') && cases.some(c=>c.whiteRatio>0.1)) throw new Error('Broad sky clipping remains (>10% excluding solar disk)')
    if (label.endsWith('after') && cases.some(c=>c.time==='1100'&&c.view==='horizon'&&c.clouds===false&&c.meanRgb[2]-c.meanRgb[0]<30)) throw new Error('Daylight clear sky lost blue colour')
    // Report angular/time residuals even when the mean scale fits. Different
    // atmospheric models must not be declared equivalent by fitting one scalar.
    if(compareNative)console.log(JSON.stringify({comparison,nativeEquivalence}))
  } finally { if(browser) await browser.close(); server.kill() }
}
main().catch(error=>{console.error(error);process.exitCode=1})

