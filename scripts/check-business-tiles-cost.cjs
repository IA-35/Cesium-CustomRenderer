// Diagnostic ablations only. Uses the real business component and real assets;
// API fixtures come from its existing test helper. No scene setting is persisted.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const host = process.env.CCR_HOST_ROOT
if (!host) throw new Error('Set CCR_HOST_ROOT to the business frontend checkout')
const mount = require(path.join(host, 'tests/helpers/mount-ccr-host.cjs'))
const root = path.resolve(__dirname, '..')
const folder = path.join(root, 'docs/verification/tiles-cost')
const label = process.env.CCR_RUN_LABEL || 'baseline'
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid run label')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
async function main() {
  fs.mkdirSync(folder, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { label, viewport: [1280, 720], engine: hash(path.join(host, 'public/Cesium/Cesium.js')),
    sdk: hash(path.join(host, 'public/js/CCR.min.js')), cases: [], errors: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', e => report.errors.push(e.message))
    if(process.env.CCR_DISABLE_SHELLS==='1'){
      await page.route('**/js/Config.js',async r=>{const response=await r.fetch();return r.fulfill({response,body:(await response.text()).replace(/^\s*overviewUrl:.*\r?\n/gm,'')})})
      report.shellsDisabledInTest=true
    }
    if (process.env.CCR_OVERVIEW_ROOT) {
      const assetRoot = path.resolve(process.env.CCR_OVERVIEW_ROOT), replacements = new Map()
      for(const directory of fs.readdirSync(assetRoot,{withFileTypes:true}).filter(e=>e.isDirectory())){
        const asset=path.join(assetRoot,directory.name),manifest=JSON.parse(fs.readFileSync(path.join(asset,'report.json')))
        const marker='/Dongda/',offset=manifest.input.replaceAll('\\','/').indexOf(marker)
        if(offset<0)throw new Error('This business adapter requires a Dongda input root')
        const url=manifest.input.replaceAll('\\','/').slice(offset),prefix=url.slice(0,url.lastIndexOf('/')+1)
        replacements.set(url,path.join(asset,'tileset.json'));replacements.set(prefix+'overview.glb',path.join(asset,'overview.glb'))
      }
      await page.route('**/Dongda/**',r=>{
        const file=replacements.get(decodeURIComponent(new URL(r.request().url()).pathname))
        if(!file)return r.continue()
        if(file.endsWith('.glb')){
          const relative=path.relative(root,file)
          if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Serve overview copies from the CCR checkout')
          return r.continue({url:(process.env.CCR_TEST_URL||'http://127.0.0.1:8894')+'/'+relative.split(path.sep).map(encodeURIComponent).join('/')})
        }
        return r.fulfill({contentType:'application/json',body:fs.readFileSync(file)})
      })
      report.overviewRoot=assetRoot
    }
    await page.route('**/__ccr_timer.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'src/diagnostics/GpuTimer.js')) }))
    await mount(page, process.env.CCR_APP_URL)
    await page.waitForFunction(() => {
      const v = hostTestVm.$actionCenter.doAction('getViewer')
      const ts = v?._campusManager?.getHandles('nanhu')?.filter(h => h.type === 'tileset')
      return ts?.length === CampusSetting.find(c => c.key === 'nanhu').resources.tilesets.length && ts.every(h => h.primitive.tilesLoaded)
    }, null, { timeout: 180000 })
    report.initial = await page.evaluate(async () => {
      const v = hostTestVm.$actionCenter.doAction('getViewer'), s = v.scene, p = CCR.getVisualPipeline(v)
      const tiles = v._campusManager.getHandles('nanhu').filter(h => h.type === 'tileset').map(h => h.primitive)
      const wait = n => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { off(); reject(new Error('Render stalled')) }, 120000)
        const off = s.postRender.addEventListener(() => { if (--n === 0) { off(); clearTimeout(timeout); resolve() } })
      })
      v.camera.cancelFlight(); s.screenSpaceCameraController.enableInputs = false
      const center = tiles.find(t => /SM_NH_Building/.test(t.resource.url)).boundingSphere.center
      v.camera.lookAt(center, new Cesium.HeadingPitchRange(0, -.4, 900))
      await wait(180)
      let stable = 0
      for (let i = 0; i < 2400 && stable < 30; i++) {
        await wait(1)
        stable = tiles.every(t => t.tilesLoaded && !t._processingQueue.length && !t._statistics.numberOfPendingRequests) ? stable + 1 : 0
      }
      if (stable < 30) throw new Error('Assets did not settle')
      if(tiles.some(t=>!t._statistics.numberOfTilesWithContentReady))throw new Error('A declared business tileset has no loaded render content; cannot accept an empty-scene benchmark')
      window.costFixture = { v, s, p, tiles, wait, center, options: p.getOptions() }
      const gl = s.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info')
      return { renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), options: p.getOptions(),
        assets: tiles.map(t => ({ url: t.resource.url, name: t.name, type: t.buildingType, bytes: t.totalMemoryUsageInBytes,
          contents: t._statistics.numberOfTilesWithContentReady, triangles: t._statisticsPerPass[0].numberOfTrianglesSelected })),
        budget: v._utilsC._tilesetMemoryBudget?.getDiagnostics() }
    })
    console.log('Loaded', JSON.stringify(report.initial.assets))
    await page.screenshot({path:path.join(folder,label+'.png')})
    report.picking = await page.evaluate(() => {
      const {s}=costFixture,found=new Map()
      for(let y=160;y<s.canvas.clientHeight;y+=50)for(let x=25;x<s.canvas.clientWidth;x+=50){
        const feature=s.pick(new Cesium.Cartesian2(x,y)),tileset=feature?.tileset||feature?.primitive
        if(tileset?.buildingType==='isLayeredBuilding'){
          found.set(tileset.name,{name:tileset.name,id:feature.getProperty?.('id'),featureName:feature.getProperty?.('name'),source:feature.getProperty?.('ccrSource'),floor:feature.getProperty?.('ccrFloor')})
        }
      }
      return [...found.values()]
    })
    if(!report.picking.length)throw new Error('No layered building feature could be picked')
    const profiler = process.argv.includes('--profile') ? await page.context().newCDPSession(page) : null
    if (profiler) { await profiler.send('Profiler.enable');await profiler.send('Profiler.start') }
    for (const mode of (process.env.CCR_CASES || 'all,no-layered,no-trees,native,all-repeat').split(',')) {
      const result = await page.evaluate(async mode => {
        const { v, s, p, tiles, wait, center } = costFixture, C = Cesium
        p.setEnabled(mode !== 'native')
        for (const t of tiles) t.show = mode === 'no-layered' ? t.buildingType !== 'isLayeredBuilding' : mode === 'no-trees' ? !/SM_NH_Shu/.test(t.resource.url) : true
        v.camera.lookAt(center, new C.HeadingPitchRange(0, -.4, 900)); await wait(90)
        let settled = 0
        for(let i=0;i<2400&&settled<30;i++) { await wait(1);settled=tiles.filter(t=>t.show).every(t=>t.tilesLoaded&&!t._processingQueue.length&&!t._statistics.numberOfPendingRequests)?settled+1:0 }
        if(settled<30)throw new Error('Mode did not settle: '+mode)
        const { default: Timer } = await import('/__ccr_timer.js'), timer = new Timer(s.context._gl)
        const gl = s.context._gl, render = s.render, update = C.Model.prototype.update, hooks = []
        const frames = []; let frame, last
        for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
          const original = gl[name]
          gl[name] = function(...a) { if (frame) { frame.draws++; if(a[0] === gl.TRIANGLES) frame.triangles += (name.startsWith('drawElements') ? a[1] : a[2]) / 3 * (name.endsWith('Instanced') ? a.at(-1) : 1) } return original.apply(this, a) }
          hooks.push(() => { gl[name] = original })
        }
        C.Model.prototype.update = function(...a) { const start = performance.now(); try { return update.apply(this,a) } finally { if(frame) {frame.modelMs += performance.now()-start;frame.models++} } }
        s.render = function(...a) {
          timer.poll(); const start = performance.now()
          frame = { cpu: 0, interval: last ? start-last : null, draws: 0, triangles: 0, modelMs: 0, models: 0 };last=start
          try { return timer.measure('frame', () => render.apply(this, a)) }
          finally { frame.cpu=performance.now()-start;frames.push(frame);frame=null }
        }
        try { for(let i=0;i<180;i++) { v.camera.lookAt(center,new C.HeadingPitchRange(i*Math.PI/90,-.4,900));await wait(1) } }
        finally { s.render=render;C.Model.prototype.update=update;for(const restore of hooks)restore() }
        await wait(5);timer.poll()
        const stat = a => { a=a.filter(Number.isFinite).sort((x,y)=>x-y); return { n:a.length, p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],mean:a.reduce((n,x)=>n+x,0)/a.length } }
        const result = { mode, cpu:stat(frames.map(f=>f.cpu)),interval:stat(frames.map(f=>f.interval)),draws:stat(frames.map(f=>f.draws)),
          triangles:stat(frames.map(f=>f.triangles)),modelMs:stat(frames.map(f=>f.modelMs)),models:stat(frames.map(f=>f.models)),
          gpu:stat(timer.samples.map(x=>x.milliseconds)),gpuSupported:timer.supported,heap:performance.memory?.usedJSHeapSize,
          pending:tiles.map(t=>({name:t.name,show:t.show,processing:t._processingQueue.length,requests:t._statistics.numberOfPendingRequests})),frames }
        timer.destroy();return result
      }, mode)
      report.cases.push(result)
      fs.writeFileSync(path.join(folder, label+'.json'), JSON.stringify(report,null,2))
      console.log(JSON.stringify({...result,frames:undefined,pending:undefined}))
    }
    if (profiler) { const {profile}=await profiler.send('Profiler.stop');fs.writeFileSync(path.join(folder,label+'.cpuprofile'),JSON.stringify(profile)) }
    if (report.errors.length) throw new Error(report.errors.join('\n'))
  } finally { await browser.close() }
}
main().catch(e => {console.error(e);process.exitCode=1})
