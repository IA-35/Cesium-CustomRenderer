#!/usr/bin/env node
// Real Cesium/WebGL2 LUT, shader, numerical and atomic-publication verification.
// This does not measure GPU timings or certify visual/performance acceptance.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const port = 8965
const testPage = `<!doctype html><html><head><meta charset="utf-8">
<script>window.CESIUM_BASE_URL='/node_modules/cesium/Build/Cesium/';</script>
<script src="/node_modules/cesium/Build/Cesium/Cesium.js"></script>
<style>html,body,#viewer{margin:0;width:640px;height:360px;overflow:hidden}</style></head>
<body><div id="viewer"></div><script type="module">
try {
  const { default: AtmosphereLut143 } = await import('/src/environment/AtmosphereLut143.js')
  const { hillaireRuntimeGLSL, hillaireSkyViewShader } = await import('/src/environment/hillaireAtmosphereGLSL143.js')
  const C = window.Cesium
  const viewer = new C.Viewer('viewer', { baseLayer: false, globe: false, skyBox: false, skyAtmosphere: false,
    animation: false, timeline: false, geocoder: false, baseLayerPicker: false, navigationHelpButton: false,
    sceneModePicker: false, homeButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
    useDefaultRenderLoop: false, contextOptions: { webgl: { preserveDrawingBuffer: true } } })
  viewer.render()
  const context = viewer.scene.context, gl = context._gl
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const passes = [], lut = new AtmosphereLut143(C, viewer.scene, { runPass(key, draw) { passes.push(key); return draw() } })
  const params = { atmosphereParams: new C.Cartesian4(6371000, 6471000, 1/1200, 1/8000),
    atmosphereMieParameters: new C.Cartesian2(1, 0.7), atmoOrigin: new C.Cartesian3(0, 0, 6371100), sunLocal: new C.Cartesian3(0.8, 0, 0.6) }
  const update = () => { const ready = lut.update(context, params); assert(ready, 'LUT not ready: '+JSON.stringify(lut.getDiagnostics())); return lut.getDiagnostics() }
  const readTexture = texture => {
    const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), cached = context._currentFramebuffer
    const framebuffer = new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
    const pixels = new Float32Array(texture.width * texture.height * 4)
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer._framebuffer)
      gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.FLOAT, pixels)
      assert(gl.getError() === gl.NO_ERROR, 'Texture float readback failed')
      return pixels
    } finally { framebuffer.destroy(); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw); context._currentFramebuffer = cached }
  }
  const stats = pixels => {
    let min=Infinity,max=-Infinity,positive=0,finite=true
    for(let i=0;i<pixels.length;i+=4)for(let c=0;c<3;c++){
      const v=pixels[i+c];min=Math.min(min,v);max=Math.max(max,v);positive+=v>0?1:0;finite=finite&&Number.isFinite(v)
    }
    return {min,max,positive,finite}
  }
  const validate = () => {
    const textures=lut.getTextures(), result={}
    for(const name of ['transmittance','multipleScattering','skyView']){
      result[name]=stats(readTexture(textures[name]));assert(result[name].finite&&result[name].min>=0,name+' has nonfinite/negative pixels')
      if(name==='transmittance')assert(result[name].max<=1.0001,'Transmittance exceeds unity')
    }
    return result
  }
  const initial=update(), firstTextures=lut.getTextures(), initialPixels=validate()
  assert(initialPixels.multipleScattering.positive>0&&initialPixels.skyView.positive>0,'Daylight LUT radiance empty')
  const verticalGpu=Array.from(readTexture(firstTextures.transmittance).slice(0,3))
  const verticalCpu=(()=>{
    const extinction=[0,0,0],steps=65536,dt=100000/steps,ray=[5.5e-6,13e-6,22.4e-6],oz=[2.04e-5,4.97e-5,1.95e-6]
    for(let i=0;i<steps;i++){
      const h=(i+0.5)*dt,r=Math.exp(-h/8000),m=Math.exp(-h/1200),q=(30000-h)/4000,o=r/(1+q*q)
      for(let c=0;c<3;c++)extinction[c]+=(ray[c]*r+21e-6*m+oz[c]*o)*dt
    }
    return extinction.map(v=>Math.exp(-v))
  })()
  const verticalRelativeError=verticalGpu.map((v,i)=>Math.abs(v-verticalCpu[i])/verticalCpu[i])
  assert(verticalRelativeError.every(v=>v<0.01),'Vertical spectral T differs from independent CPU integral by >=1%: '+verticalRelativeError)
  const cache=update();assert(cache.stats.updates===initial.stats.updates&&passes.length===3,'Unchanged frame rebuilt LUTs')

  // Runtime lookup compilation/readback uses exactly the backend uniform map.
  let probeOrigin=params.atmoOrigin,probeDir=new C.Cartesian3(0,0,1),probeSun=params.sunLocal,probeMode=0
  const probeTexture=new C.Texture({context,width:1,height:1,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
  const probeFramebuffer=new C.Framebuffer({context,colorTextures:[probeTexture],destroyAttachments:false})
  const probeState=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,1,1),depthTest:{enabled:false},depthMask:false})
  const probe=context.createViewportQuadCommand(hillaireRuntimeGLSL+
    '\\nuniform vec3 probeOrigin;uniform vec3 probeDir;uniform vec3 probeSun;uniform int probeMode;\\nvoid main(){out_FragColor=probeMode==0?vec4(ccrLutSkyView(probeOrigin,probeDir,probeSun),1.0):vec4(ccrLutSkyUv(probeOrigin*0.001,probeDir,probeSun),0.0,1.0);}',
    {framebuffer:probeFramebuffer,renderState:probeState,uniformMap:{...lut.getUniformMap(),probeOrigin:()=>probeOrigin,probeDir:()=>probeDir,probeSun:()=>probeSun,probeMode:()=>probeMode}})
  const sampleSky=(direction,mode=0)=>{
    probeMode=mode
    probeDir=direction;const state=new C.PassState(context);state.framebuffer=probeFramebuffer;state.viewport=probeState.viewport
    probe.execute(context,state);assert(gl.getError()===gl.NO_ERROR,'Runtime Sky-View sampling draw failed')
    const activeProgram=gl.getParameter(gl.CURRENT_PROGRAM)
    assert(activeProgram===probe.shaderProgram._program,'Unexpected active probe program')
    assert(gl.getParameter(gl.FRAMEBUFFER_BINDING)===probeFramebuffer._framebuffer,'Unexpected active probe framebuffer')
    return Array.from(readTexture(probeTexture).slice(0,3))
  }
  const cases=[]
  for(const height of [1,100,10000,200000])for(const muSun of [-0.2,-0.05,0.1,0.8]){
    params.atmoOrigin=new C.Cartesian3(0,0,6371000+height)
    params.sunLocal=new C.Cartesian3(Math.sqrt(1-muSun*muSun),0,muSun)
    probeOrigin=params.atmoOrigin;probeSun=params.sunLocal
    update();const range=validate()
    const horizonMu=-Math.sqrt((6371000+height)**2-6371000**2)/(6371000+height)
    const direction=mu=>new C.Cartesian3(Math.sqrt(Math.max(0,1-mu*mu)),0,mu)
    // A finite angular gap can legitimately cross the opaque planet limb.
    // Infinitesimal probes test continuity of the Sky-View parameterization.
    const horizonAbove=sampleSky(direction(horizonMu+1e-7)),horizonBelow=sampleSky(direction(horizonMu-1e-7)),zenith=sampleSky(new C.Cartesian3(0,0,1))
    const zenithUv=sampleSky(new C.Cartesian3(0,0,1),1)
    assert(Math.abs(zenithUv[1]-0.5/108)<1e-5,'Sky runtime zenith mapping failed: '+JSON.stringify(zenithUv))
    assert([...horizonAbove,...horizonBelow,...zenith].every(v=>Number.isFinite(v)&&v>=0),'Invalid horizon/zenith sample')
    if(height<10000){
      const delta=Math.max(...horizonAbove.map((v,i)=>Math.abs(v-horizonBelow[i])))
      const scale=Math.max(...horizonAbove,...horizonBelow,1e-5)
      assert(delta/scale<0.06,'Sky-View horizon discontinuity: '+JSON.stringify({height,muSun,delta,scale}))
    }
    if(muSun>0&&height<200000)assert(range.skyView.positive>0,'Daylight sky empty')
    cases.push({height,muSun,range,horizonAbove,horizonBelow,zenith,zenithUv})
  }

  const beforeFailure=lut.getTextures(),keyBeforeFailure=lut.getDiagnostics().keys,passesBeforeFailure=passes.length
  const pixelsBeforeFailure=Object.fromEntries(Object.entries(beforeFailure).map(([key,texture])=>[key,readTexture(texture)]))
  const originalRun=lut.runPass
  params.atmosphereMieParameters.x=2
  lut.runPass=(key,draw)=>{if(key==='atmosphere.skyViewLut')throw new Error('injected post-T/M staging failure');return originalRun(key,draw)}
  update()
  assert(Object.keys(beforeFailure).every(k=>beforeFailure[k]===lut.getTextures()[k]),'Failure published partial texture set')
  assert(JSON.stringify(keyBeforeFailure)===JSON.stringify(lut.getDiagnostics().keys),'Failure committed new invalidation keys')
  assert(lut.getUniformMap().u_lutMie().x===1,'Failure committed new medium uniforms')
  for(const [name,texture] of Object.entries(beforeFailure)){
    const after=readTexture(texture),before=pixelsBeforeFailure[name]
    assert(after.every((v,i)=>v===before[i]),'Failure overwrote published '+name+' contents')
  }
  assert(passes.length===passesBeforeFailure+2,'Injected failure did not execute real staged T and M draws')
  lut.runPass=originalRun;update();assert(lut.getUniformMap().u_lutMie().x===2,'Retry did not publish new medium')
  const beforeSun=lut.getTextures(),countsBeforeSun=lut.getDiagnostics().stats
  params.sunLocal=new C.Cartesian3(0.8,0,0.6);update()
  const afterSun=lut.getTextures(),countsAfterSun=lut.getDiagnostics().stats
  assert(beforeSun.transmittance===afterSun.transmittance&&beforeSun.multipleScattering===afterSun.multipleScattering&&beforeSun.skyView!==afterSun.skyView,'Sun update rebuilt T/M or failed to rebuild Sky')
  assert(countsBeforeSun.transmittance===countsAfterSun.transmittance,'Sun update invalidated transmittance')

  const vacuumCases=[]
  params.atmoOrigin=new C.Cartesian3(0,0,6371100);params.sunLocal=new C.Cartesian3(0.8,0,0.6)
  for(const density of [0,0.001]){
    params.rayleighBeta=[5.5e-6*density,13e-6*density,22.4e-6*density]
    params.mieBeta=21e-6*density;params.absorptionBeta=[2.04e-5*density,4.97e-5*density,1.95e-6*density]
    update();const range=validate()
    if(density===0)assert(range.transmittance.min===1&&range.transmittance.max===1&&range.skyView.max===0,'Vacuum must have unit T and zero in-scattering')
    else assert(range.transmittance.min>0.9&&range.skyView.max<initialPixels.skyView.max,'Thin-medium limit failed')
    vacuumCases.push({density,range})
  }
  const diagnostics=lut.getDiagnostics()
  // Exercise the real RGBA32F target and manual bilinear branch using the
  // same live Cesium context, with its optional half/linear gates masked.
  const floatContext=new Proxy(context,{get(target,key,receiver){
    if(['halfFloatingPointTexture','colorBufferHalfFloat','textureFloatLinear'].includes(key))return false
    return Reflect.get(target,key,receiver)
  }})
  const fallback=new AtmosphereLut143(C,{context:floatContext,isDestroyed:()=>false})
  delete params.rayleighBeta;delete params.mieBeta;delete params.absorptionBeta
  params.atmosphereMieParameters.x=1
  assert(fallback.update(floatContext,params),'RGBA32F fallback failed: '+fallback.getDiagnostics().error)
  assert(fallback.getDiagnostics().format==='rgba32f'&&fallback.getUniformMap().u_lutManualFiltering(),'Float fallback did not select manual interpolation')
  const fallbackVertical=Array.from(readTexture(fallback.getTextures().transmittance).slice(0,3))
  assert(fallbackVertical.every((v,i)=>Math.abs(v-verticalCpu[i])/verticalCpu[i]<0.01),'RGBA32F vertical T golden failed')
  probeOrigin=params.atmoOrigin;probeSun=params.sunLocal
  Object.assign(probe.uniformMap,fallback.getUniformMap())
  const fallbackSky=sampleSky(new C.Cartesian3(0,0,1))
  assert(fallbackSky.every(v=>Number.isFinite(v)&&v>0),'RGBA32F manual Sky lookup failed')
  const floatFallback={format:fallback.getDiagnostics().format,manualFiltering:true,vertical:fallbackVertical,sky:fallbackSky}
  fallback.destroy()

  // Isolate the Sky-View view quadrature by binding a zero M texture. The
  // independent reference nests a dense CPU sun integral, outside production.
  params.atmoOrigin=new C.Cartesian3(0,0,6571000);update()
  const zeroM=new C.Texture({context,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT,
    source:{width:1,height:1,arrayBufferView:new Float32Array(4)}})
  const skySingle=new C.Texture({context,width:192,height:108,pixelFormat:C.PixelFormat.RGBA,pixelDatatype:C.PixelDatatype.FLOAT})
  const skySingleFb=new C.Framebuffer({context,colorTextures:[skySingle],destroyAttachments:false})
  const skySingleState=C.RenderState.fromCache({viewport:new C.BoundingRectangle(0,0,192,108),depthTest:{enabled:false},depthMask:false})
  const skySingleCommand=context.createViewportQuadCommand(hillaireSkyViewShader,{framebuffer:skySingleFb,renderState:skySingleState,
    uniformMap:{...lut.getUniformMap(),u_atmosphereMultipleScatteringLut:()=>zeroM}})
  const skySinglePass=new C.PassState(context);skySinglePass.framebuffer=skySingleFb;skySinglePass.viewport=skySingleState.viewport
  skySingleCommand.execute(context,skySinglePass)
  const skySinglePixels=readTexture(skySingle),orbitalNadirGpu=Array.from(skySinglePixels.slice(192*107*4,192*107*4+3))
  const orbitalNadirCpu=(()=>{
    const output=[0,0,0],throughput=[1,1,1],rb=[5.5e-6,13e-6,22.4e-6],ab=[2.04e-5,4.97e-5,1.95e-6]
    const medium=h=>{h=Math.max(0,h);const r=Math.exp(-h/8000),m=Math.exp(-h/1200),o=r/(1+((30000-h)/4000)**2)
      return {ray:rb.map(v=>v*r),mie:21e-6*m,ext:rb.map((v,c)=>v*r+21e-6*m+ab[c]*o)}}
    const pr=3*(1+0.36)/(16*Math.PI),g=0.7,pm=3*(1-g*g)*(1+0.36)/(8*Math.PI*(2+g*g)*(1+g*g+1.2*g)**1.5)
    const count=8192,dt=100000/count
    for(let i=0;i<count;i++){
      const r=6471000-(i+0.5)*dt,med=medium(r-6371000)
      const length=-r*0.6+Math.sqrt(r*r*(0.36-1)+6471000**2),optical=[0,0,0],lightCount=256
      for(let j=0;j<lightCount;j++){
        const t0=(j/lightCount)**2*length,t1=((j+1)/lightCount)**2*length,t=(t0+t1)*0.5
        const sample=medium(Math.sqrt(r*r+t*t+2*r*0.6*t)-6371000)
        for(let c=0;c<3;c++)optical[c]+=sample.ext[c]*(t1-t0)
      }
      for(let c=0;c<3;c++){
        output[c]+=throughput[c]*(med.ray[c]*pr+med.mie*pm)*Math.exp(-optical[c])*(-Math.expm1(-med.ext[c]*dt))/med.ext[c]
        throughput[c]*=Math.exp(-med.ext[c]*dt)
      }
    }
    return output
  })()
  const orbitalNadirRelativeError=orbitalNadirGpu.map((v,i)=>Math.abs(v-orbitalNadirCpu[i])/orbitalNadirCpu[i])
  assert(orbitalNadirRelativeError.every(v=>v<0.012),'Orbital descending Sky quadrature >1.2% error: '+JSON.stringify({orbitalNadirGpu,orbitalNadirCpu,orbitalNadirRelativeError}))
  skySingleCommand.shaderProgram.destroy();skySingleFb.destroy();skySingle.destroy();zeroM.destroy();C.RenderState.removeFromCache(skySingleState)
  probe.shaderProgram.destroy();probeFramebuffer.destroy();probeTexture.destroy();C.RenderState.removeFromCache(probeState)
  lut.destroy();assert(!lut.ready&&Object.values(lut.getTextures()).length===0,'Destroyed LUT still published')
  const rendererInfo=gl.getExtension('WEBGL_debug_renderer_info')
  const renderer=rendererInfo?gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)
  window.__result={ok:true,renderer,initialPixels,verticalGpu,verticalCpu,verticalRelativeError,cases,vacuumCases,floatFallback,
    orbitalNadirGpu,orbitalNadirCpu,orbitalNadirRelativeError,diagnostics,
    passCount:passes.length,atomicFailureRetained:true,sunUpdateKeptMedium:true,cacheHit:true,destroyed:true}
  viewer.destroy()
} catch(error) { window.__result={ok:false,error:error.message,stack:error.stack} }
</script></body></html>`

async function main() {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const server = spawn(process.execPath, [path.join(root, 'scripts/dev-server.cjs'), '--port', String(port)], { cwd: root, stdio: 'ignore' })
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.route(`http://127.0.0.1:${port}/__atmosphere-lut-check`, route => route.fulfill({ contentType: 'text/html', body: testPage }))
    await page.goto(`http://127.0.0.1:${port}/__atmosphere-lut-check`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__result, null, { timeout: 120000 })
    const result = await page.evaluate(() => window.__result)
    result.pageErrors = errors
    const out = path.join(root, 'docs/verification/rendering-performance/atmosphere-lut-acceptance.json')
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ok:result.ok,error:result.error,renderer:result.renderer,verticalRelativeError:result.verticalRelativeError,
      cases:result.cases?.length,vacuumCases:result.vacuumCases,floatFallback:result.floatFallback,orbitalNadirRelativeError:result.orbitalNadirRelativeError,diagnostics:result.diagnostics?.stats,
      atomicFailureRetained:result.atomicFailureRetained,sunUpdateKeptMedium:result.sunUpdateKeptMedium,pageErrors:errors,artifact:out},null,2))
    if (!result.ok || errors.length) throw new Error(result.error || errors.join('\n'))
  } finally { if (browser) await browser.close(); server.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
