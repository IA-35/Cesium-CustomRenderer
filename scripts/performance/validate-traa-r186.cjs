// Real WebGL acceptance data. This runner reports measurements and explicit gaps;
// successful execution alone is never a production-readiness assertion.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
const root = path.resolve(__dirname, '../..'), argv = process.argv.slice(2)
const option = (name, fallback) => { const exact = argv.indexOf(name); return exact >= 0 && argv[exact + 1] && !argv[exact + 1].startsWith('--') ? argv[exact + 1] : argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) || fallback }
const has = name => argv.includes(name)
const [width, height] = option('--size', '640x420').split('x').map(Number)
const baseline = has('--baseline'), campus = has('--campus'), performanceOnly = has('--performance')
const label = option('--label', baseline ? 'baseline-8' : has('--bundle') ? 'bundle' : 'source')
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid --label')
const port = Number(option('--port', process.env.CCR_TEST_PORT || '8987'))
const origin = `http://127.0.0.1:${port}`
const out = path.resolve(root, 'docs/verification/rendering-performance/traa-r186-2026-10-16', label)
const sdkFile = baseline ? path.join(os.tmpdir(), 'ccr-traa-r186-baseline/CCR.min.js') : has('--bundle') ? path.resolve(option('--bundle', path.join(root, 'build/0.1.0/CCR.min.js'))) : null
// Pin bytes once per invocation: concurrent builds cannot alter this run's implementation.
const sdkBytes = sdkFile ? fs.readFileSync(sdkFile) : null
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sdkHash = sdkBytes && sha256(sdkBytes)
const fixtureBytes = new Map(['tests/rendering/taa-r186-fixture.js', 'tests/rendering/taa-r186-fixture.html'].map(file => ['/' + file, fs.readFileSync(path.join(root, file))]))
const sourceBytes = new Map()
if (!sdkBytes) {
  const collect = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) collect(file); else if (/\.js$/.test(entry.name)) sourceBytes.set('/' + path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file)) } }
  collect(path.join(root, 'src'))
}
if (baseline && sdkHash !== 'e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f') throw new Error('Baseline hash differs from the approved rollback SDK')
if (campus && !sdkBytes) throw new Error('--campus requires --bundle or --baseline so actual UMD bytes are pinned')
fs.mkdirSync(out, { recursive: true })
const report = { date: new Date().toISOString(), label, sdkFile, sdkHash, mode: campus ? 'campus' : performanceOnly ? 'performance' : 'quality-and-motion', viewport: { width, height }, errors: [], limitations: ['Use --ui for actual Label/Billboard/picking and native silhouette checks.', 'Programmatic quality ROIs are defined for 640x420; --size is intended for performance/campus runs.', 'Metrics are evidence; no automatic production-readiness claim is made.'] }
report.harnessHashes = Object.fromEntries(['scripts/performance/validate-traa-r186.cjs', 'tests/rendering/taa-r186-fixture.js', 'tests/rendering/taa-r186-fixture.html'].map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]))
report.memoryAccounting = { baseline: 'Legacy diagnostics.bytes does not include all RHI history allocations; do not compare this number directly with revised total bytes.', current: 'Record diagnostics stageBytes/rhiHistoryBytes/motion.bytes and total bytes separately.' }
if (sourceBytes.size) report.sourceHashes = Object.fromEntries([...sourceBytes].map(([url, bytes]) => [url, sha256(bytes)]))
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
function saveSeries(series) {
  for (const item of series.images || []) { const filename = `${series.name}-${String(item.frame).padStart(3, '0')}.png`; fs.writeFileSync(path.join(out, filename), Buffer.from(item.png.split(',')[1], 'base64')); item.file = filename; delete item.png }
  fs.writeFileSync(path.join(out, series.name + '.json'), JSON.stringify(series, null, 2))
  return { name: series.name, count: series.count, metrics: series.metrics, lineMetrics: series.lineMetrics, diagnostics: series.diagnostics, file: series.name + '.json' }
}
async function runFixture(page) {
  report.url = `${origin}/tests/rendering/taa-r186-fixture.html${sdkBytes ? '?bundle=1' : ''}`
  await page.goto(report.url); await page.waitForFunction(() => window.fixture)
  report.gpu = await page.evaluate(async () => { globalThis.r186 = await import('/tests/rendering/taa-r186-fixture.js'); return r186.startR186Fixture(fixture) })
  report.series = []; report.motion = []
  const samplesList = option('--samples', null) ? [Number(option('--samples'))] : baseline ? [8] : [8, 32]
  for (const samples of samplesList) {
    await page.evaluate(async samples => { fixture.restoreCamera(); await fixture.configure(samples) }, samples)
    if (has('--no-rhi')) report.noRhi = await page.evaluate(async samples => {
      fixture.pipeline.setAntiAliasing('fxaa'); fixture.pipeline.taa.rhi = null
      await fixture.configure(samples)
      return { valid: fixture.pipeline.getTaaDiagnostics().valid, display: !!fixture.pipeline.taa.display }
    }, samples)
    if (has('--root-camera-domain') || has('--draw-camera-domain')) report[`rootCameraDepthDomain-${samples}`] = await page.evaluate(useRoot => r186.useR186RootCameraDepthDomain(fixture, useRoot), has('--root-camera-domain'))
    report[`actualSamplers-${samples}`] = await page.evaluate(() => r186.readR186Samplers(fixture))
    if (option('--compare-shader', null)) {
      const source = fs.readFileSync(path.resolve(option('--compare-shader')))
      const reference = await import('data:text/javascript;base64,' + source.toString('base64'))
      report[`resolveParity-${samples}`] = await page.evaluate(({shader, currentOnly}) => r186.compareR186Resolve(fixture, shader, currentOnly),
        { shader: reference.taaResolveShader, currentOnly: has('--compare-current') })
      write()
    }
    if (performanceOnly) {
      report[`performance-${samples}`] = await page.evaluate(() => r186.measureR186Performance(fixture))
    } else {
      for (const [name, motion] of [['static', 'static'], ['slow-pan', 'pan'], ['stopped-pan', 'static'], ['slow-rotate', 'rotate'], ['stopped-rotate', 'static'], ['moving-disocclusion', 'object'], ['stopped-object', 'static']]) {
        if (has('--motion-only') || (option('--case', null) && option('--case') !== name)) continue
        const result = await page.evaluate(({ samples, name, motion }) => r186.captureR186Series(fixture, `${samples}-${name}`, 128, motion), { samples, name, motion })
        report.series.push(saveSeries(result)); write()
        console.log(label, samples, name, JSON.stringify(result.metrics.map(item => ({ roi: item.name, edge: item.edge }))))
      }
      report.motionProbe = await page.evaluate(() => r186.attachR186MotionProbe(fixture))
      if (!option('--case', null) && report.motionProbe.available) for (const name of ['camera-static', 'translation', 'rotation', 'depth-z', 'combined', 'start-stop', 'appearance', 'occlusion', 'mask', 'unsupported']) {
        const result = await page.evaluate(name => r186.sampleR186Motion(fixture, name), name)
        const filename = `${samples}-motion-${name}.json`; fs.writeFileSync(path.join(out, filename), JSON.stringify(result, null, 2))
        report.motion.push({ name, samples, available: result.available, maxError: result.maxError, resolveMaxError: result.resolveMaxError, resolveMismatch: result.resolveMismatch, samplesRead: result.samples?.length || 0, summaries: result.summaries, file: filename }); write()
      }
    }
  }
  if (!performanceOnly) {
    await page.evaluate(() => fixture.disposeResolveProbe?.())
    report.lifecycle = await page.evaluate(() => r186.checkR186Lifecycle(fixture))
    await page.setViewportSize({ width: 704, height: 462 })
    report.resize = await page.evaluate(async () => { fixture.viewer.resize(); await fixture.steps(40); return fixture.pipeline.getTaaDiagnostics() })
    await page.setViewportSize({ width: 640, height: 420 })
    await page.evaluate(async () => { fixture.viewer.resize(); await fixture.steps(40) })
    if (has('--ui')) {
      report.ui = await page.evaluate(() => r186.checkR186Ui(fixture))
      const selectionReport = path.join(out, 'selection.json')
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, 'scripts/check-taa-silhouette.cjs')], { cwd: root, windowsHide: true,
          env: { ...process.env, CESIUM_PLAYWRIGHT: process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright',
            CCR_TEST_PORT: String(port), CCR_TEST_BUNDLE: sdkFile || '', CCR_TAA_REPORT: selectionReport }, stdio: ['ignore', 'ignore', 'pipe'] })
        let error = ''; child.stderr.on('data', value => { error += value })
        child.on('error', reject); child.on('exit', code => code ? reject(new Error(error || `Silhouette check exited ${code}`)) : resolve())
      })
      report.selection = JSON.parse(fs.readFileSync(selectionReport, 'utf8'))
    }
  }
  report.final = await page.evaluate(() => ({ taa: fixture.pipeline.getTaaDiagnostics(), errors: fixture.errors }))
  report.release = await page.evaluate(() => {
    const taa = fixture.pipeline.taa, motion = taa?.motion, texture = motion?.texture
    fixture.pipeline.destroy()
    return { destroyed: fixture.pipeline.destroyed, taaDestroyed: taa?.isDestroyed(), motionTextureDestroyed: !texture || texture.isDestroyed(), motionPrograms: motion?.programs.size || 0, motionAliases: motion?.aliases.size || 0 }
  })
}
async function runCampus(page) {
  const samples = Number(option('--samples', 8)), buildingsOnly = has('--buildings-only')
  report.requestedJitterSamples = samples
  report.url = `${origin}/examples/campus.html?imagery=none&singleFrustum=1&assets=http://localhost:8083/Dongda&glbAssets=http://localhost:8083/Dongda/DongdaModel_PBR/SM_NH/`
  if (buildingsOnly) report.url += '&traffic=none'
  report.sceneContract = { buildings: 70, traffic: 60, trees: 'default enabled', water: 'default enabled', clouds: 'default enabled; historical cloud artifacts are separate', grass: 'default initialization is commented out in examples/campus.js', imagery: 'none (external imagery network excluded)', clock: 'frozen', trafficClock: 'performance.now continues' }
  if (buildingsOnly) Object.assign(report.sceneContract, { traffic: 0, trafficClock: 'disabled', view: 'fixed building' })
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const progress = setInterval(() => page.evaluate(() => ({ models: window.campus?.models?.filter(model => model.ready).length, traffic: window.campus?.traffic?.vehicles?.length,
    trafficModelsReady: window.campus?.traffic?.vehicles?.filter(vehicle => vehicle.model?.ready).length, trees: window.campus?.trees?.getDiagnostics(), water: window.campus?.water?.getDiagnostics(), status: document.querySelector('#status')?.textContent, errors: window.campus?.errors })).then(value => { report.loading = value; write() }).catch(() => {}), 10000)
  try { await page.waitForFunction(buildingsOnly => window.campus?.models?.length === 70 && campus.models.every(model => model.ready) && campus.trees && campus.water &&
    (buildingsOnly || campus.traffic?.vehicles?.length === 60 && campus.traffic.vehicles.every(vehicle => vehicle.model?.ready)), buildingsOnly, { timeout: 300000 }) }
  finally { clearInterval(progress) }
  await page.evaluate(async buildingsOnly => {
    await Promise.all([...(buildingsOnly ? [] : [campus.trafficReady]), campus.treeReady, campus.waterReady])
    campus.viewer.clock.shouldAnimate = false; document.querySelector('#hud').style.display = 'none'
    document.querySelectorAll('.lil-gui').forEach(node => { node.style.display = 'none' })
    if (buildingsOnly) {
      const C = Cesium, model = campus.models.find(model => model.id?.file === 'SM_NH_JZXG.glb') || campus.models[0]
      campus.viewer.camera.lookAt(model.boundingSphere.center, new C.HeadingPitchRange(-.3, -.4, Math.max(60, model.boundingSphere.radius * 1.8)))
      campus.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
    } else campus.lookAtTraffic(125)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, buildingsOnly)
  report.loaded = await page.evaluate(() => {
    const gl = campus.viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info')
    return { models: campus.models.filter(model => model.ready).length, traffic: campus.traffic?.getDiagnostics() || { disabled: true }, trees: campus.trees.getDiagnostics(), water: campus.water.getDiagnostics(),
      options: campus.pipeline.getOptions(), grass: campus.grass, errors: campus.errors,
      clock: { shouldAnimate: campus.viewer.clock.shouldAnimate, time: Cesium.JulianDate.toIso8601(campus.viewer.clock.currentTime) },
      gpu: { vendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), version: gl.getParameter(gl.VERSION) } }
  })
  report.gpu = report.loaded.gpu
  await page.screenshot({ path: path.join(out, 'campus-loaded.png') })
  write()
  if (performanceOnly) {
    report.performance = await page.evaluate(async ({ samples, pairedOnly }) => {
      const tools = await import('/tests/rendering/taa-r186-fixture.js'), s = campus.viewer.scene
      campus.pipeline.setTaa({ enabled: true, jitterSamples: samples })
      campus.viewer.useDefaultRenderLoop = false
      const f = { viewer: campus.viewer, pipeline: campus.pipeline, step: () => campus.viewer.render(), beforeFrame: () => {} }
      f.steps = async n => { for (let i = 0; i < n; i++) { f.step(); await new Promise(requestAnimationFrame) } }
      if (pairedOnly) { await f.steps(128); return null }
      return tools.measureR186Performance(f)
    }, { samples, pairedOnly: has('--paired-only') })
    if (option('--compare-shader', null)) {
      const reference = await import('data:text/javascript;base64,' + fs.readFileSync(path.resolve(option('--compare-shader'))).toString('base64'))
      report.pairedResolve = await page.evaluate(async shader => {
        const tools = await import('/tests/rendering/taa-r186-fixture.js')
        return tools.compareR186Resolve({ viewer: campus.viewer, pipeline: campus.pipeline, step: () => campus.viewer.render() }, shader, false, true)
      }, reference.taaResolveShader)
    }
    await page.screenshot({ path: path.join(out, 'campus-performance.png') })
    report.final = await page.evaluate(() => ({ taa: campus.pipeline.getTaaDiagnostics(), errors: campus.errors }))
    return
  }
  report.captures = []
  for (const view of option('--view', 'traffic,traffic-close,building').split(',')) {
    await page.evaluate(({ view, samples }) => {
      if (view === 'traffic') campus.lookAtTraffic(125)
      else if (view === 'traffic-close') {
        const C = Cesium, car = campus.traffic.vehicles.find(vehicle => vehicle.state === 'driving' && vehicle.model?.ready)
        campus.viewer.camera.lookAt(car.position, new C.HeadingPitchRange(-.3, -1.45, 45)); campus.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
      }
      else { const C = Cesium, model = campus.models.find(model => model.id?.file === 'SM_NH_JZXG.glb') || campus.models[0]; campus.viewer.camera.lookAt(model.boundingSphere.center, new C.HeadingPitchRange(-.3, -.4, Math.max(60, model.boundingSphere.radius * 1.8))); campus.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY) }
      campus.pipeline.setTaa({ enabled: true, jitterSamples: samples }); campus.traffic.setSpeed(1); campus.traffic.play()
    }, { view, samples })
    const capture = await page.evaluate(async view => {
      const s = campus.viewer.scene, frames = n => new Promise(resolve => { const off = s.postRender.addEventListener(() => { if (--n === 0) { off(); resolve() } }) })
      await frames(128)
      const values = [], images = [], width = s.drawingBufferWidth, height = s.drawingBufferHeight, sum = new Float64Array(width * height), squares = new Float64Array(width * height), first = new Float32Array(width * height)
      for (let frame = 0; frame < 128; frame++) {
        await frames(1)
        const pixels = s.context.readPixels({ width, height }); let contrastMin = 255, contrastMax = 0
        for (let i = 0; i < sum.length; i++) { const value = .2126 * pixels[i * 4] + .7152 * pixels[i * 4 + 1] + .0722 * pixels[i * 4 + 2]; sum[i] += value; squares[i] += value * value; if (!frame) first[i] = value; contrastMin = Math.min(contrastMin, value); contrastMax = Math.max(contrastMax, value) }
        if (frame < 32 || [63, 95, 127].includes(frame)) {
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
          const context = canvas.getContext('2d'), data = context.createImageData(width, height)
          for (let y = 0; y < height; y++) data.data.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4)
          context.putImageData(data, 0, 0); images.push({ frame, png: canvas.toDataURL('image/png') })
        }
        const traffic = campus.traffic.getDiagnostics()
        values.push({ frame, taa: campus.pipeline.getTaaDiagnostics(), traffic: { state: traffic.state, playing: traffic.playing, elapsedSeconds: traffic.elapsedSeconds, vehicles: traffic.vehicles, readyModels: traffic.readyModels,
          positions: campus.traffic.vehicles.slice(0, 3).map(vehicle => ({ x: vehicle.model.modelMatrix[12], y: vehicle.model.modelMatrix[13], z: vehicle.model.modelMatrix[14] })) }, contrast: contrastMax - contrastMin })
      }
      const std = Array.from(sum, (value, i) => Math.sqrt(Math.max(0, squares[i] / 128 - (value / 128) ** 2))).sort((a, b) => a - b)
      const roi = { x: 80, y: 65, w: 480, h: 290 }, edgeStd = []
      for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) { const i = y * width + x; if (Math.max(Math.abs(first[i] - first[i + 1]), Math.abs(first[i] - first[i + width])) > 8) edgeStd.push(Math.sqrt(Math.max(0, squares[i] / 128 - (sum[i] / 128) ** 2))) }
      edgeStd.sort((a, b) => a - b)
      return { view, frames: values, images, edgeRoi: { ...roi, pixels: edgeStd.length, meanStd: edgeStd.reduce((a, b) => a + b, 0) / (edgeStd.length || 1), p95Std: edgeStd[Math.floor(edgeStd.length * .95)] }, temporalStdMean: std.reduce((a, b) => a + b, 0) / std.length, temporalStdP95: std[Math.floor(std.length * .95)] }
    }, view)
    for (const item of capture.images) { const file = `campus-${view}-${String(item.frame).padStart(3, '0')}.png`; fs.writeFileSync(path.join(out, file), Buffer.from(item.png.split(',')[1], 'base64')); delete item.png; item.file = file }
    fs.writeFileSync(path.join(out, `campus-${view}-series.json`), JSON.stringify(capture, null, 2))
    await page.screenshot({ path: path.join(out, `campus-${view}.png`) })
    report.captures.push({ view, meanStd: capture.temporalStdMean, p95Std: capture.temporalStdP95, edgeRoi: capture.edgeRoi, diagnostics: capture.frames.at(-1).taa }); write()
  }
  report.trafficPauseResume = await page.evaluate(async () => {
    const frames = n => new Promise(resolve => { const off = campus.viewer.scene.postRender.addEventListener(() => { if (--n === 0) { off(); resolve() } }) })
    campus.traffic.pause(); await frames(40); const paused = campus.traffic.getDiagnostics(); campus.traffic.play(); await frames(40)
    return { paused, resumed: campus.traffic.getDiagnostics(), taa: campus.pipeline.getTaaDiagnostics() }
  })
  report.final = await page.evaluate(() => ({ taa: campus.pipeline.getTaaDiagnostics(), errors: campus.errors }))
}
async function main() {
  const server = spawn(process.execPath, [path.join(root, 'scripts/dev-server.cjs'), '--port', String(port)], { cwd: root, stdio: 'ignore', windowsHide: true })
  let browser
  try {
    for (let attempt = 0; attempt < 50; attempt++) { try { const response = await fetch(origin + '/tests/rendering/taa-r186-fixture.html'); if (response.ok) break } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
    browser = await chromium.launch({ channel: 'chrome', headless: !has('--headed'), args: ['--use-angle=d3d11'] })
    const page = await browser.newPage({ viewport: report.viewport })
    page.on('pageerror', error => { report.errors.push(error.message); write() })
    await page.route('**/tests/rendering/taa-r186-fixture.*', route => {
      const url = new URL(route.request().url()).pathname, bytes = fixtureBytes.get(url)
      return bytes ? route.fulfill({ body: bytes, contentType: url.endsWith('.html') ? 'text/html' : 'application/javascript' }) : route.continue()
    })
    if (sdkBytes) {
      await page.route('**/__r186-sdk.js', route => route.fulfill({ body: sdkBytes, contentType: 'application/javascript' }))
      await page.route('**/build/0.1.0/CCR.min.js', route => route.fulfill({ body: sdkBytes, contentType: 'application/javascript' }))
    }
    if (sourceBytes.size) await page.route('**/src/**', route => { const bytes = sourceBytes.get(new URL(route.request().url()).pathname); return bytes ? route.fulfill({ body: bytes, contentType: 'application/javascript' }) : route.continue() })
    if (campus) await runCampus(page); else await runFixture(page)
    report.status = report.errors.length || report.final?.errors?.length ? 'render-errors' : 'measured-requires-acceptance-review'
  } catch (error) { report.status = 'failed'; report.failure = error.stack; throw error }
  finally { write(); await browser?.close(); server.kill() }
  console.log(JSON.stringify({ out, status: report.status, gpu: report.gpu, sdkHash: report.sdkHash }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
