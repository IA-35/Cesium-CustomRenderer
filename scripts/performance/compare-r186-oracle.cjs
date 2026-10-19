// Isolated official r186 renderer/oracle. It never imports CCR runtime or old candidates.
// Default/--prepare downloads and validates dependencies without opening a GPU context.
// Run only when the shared GPU is available: node scripts/performance/compare-r186-oracle.cjs --run
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../..')
const commit = '9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8'
const upstream = `https://raw.githubusercontent.com/mrdoob/three.js/${commit}/`
const cache = path.join(os.tmpdir(), 'ccr-three-r186-oracle-9b4a2ac2')
const out = path.join(root, 'docs/verification/rendering-performance/traa-r186-2026-10-16/oracle')
const reference = path.join(root, 'src/antialiasing/reference/three-r186')
const argv = process.argv.slice(2)
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1] }
const port = Number(option('--port', '8993'))
const label = option('--label', 'official-r186-webgl2-32')
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid label')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const files = ['build/three.webgpu.js', 'build/three.core.js', 'build/three.tsl.js', 'examples/webgpu_postprocessing_traa.html']
const config = { width: 640, height: 420, warmup: 128, count: 128, samples: 32,
  horizontalFovDegrees: 60, near: 1, far: 1000, cameraHeight: 150, twistLeft: 0.173 }
const browserModule = String.raw`
import * as THREE from 'three/webgpu';
import { mrt, output, pass, velocity } from 'three/tsl';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
const c = globalThis.oracleConfig;
const canvas = document.querySelector('canvas');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, depth: true, preserveDrawingBuffer: true });
if (!gl) throw new Error('The oracle requires a real WebGL2 context');
const renderer = new THREE.WebGPURenderer({ forceWebGL: true, canvas, context: gl, antialias: false, logarithmicDepthBuffer: false });
renderer.setPixelRatio(1); renderer.setSize(c.width, c.height, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();
if (!renderer.backend.isWebGLBackend) throw new Error('Oracle silently selected a non-WebGL backend');
const aspect = c.width / c.height;
// Cesium's fov=60 is horizontal at landscape aspect, while Three takes vertical FOV.
const fovy = 2 * Math.atan(Math.tan(c.horizontalFovDegrees * Math.PI / 360) / aspect);
const camera = new THREE.PerspectiveCamera(fovy * 180 / Math.PI, aspect, c.near, c.far);
camera.position.set(0, 0, c.cameraHeight);
// Cesium twistLeft rotates up around viewing direction (-Z), giving world roll -amount.
camera.rotation.z = -c.twistLeft;
camera.updateMatrixWorld();
const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.02, 0.03, 0.05, THREE.LinearSRGBColorSpace);
const geometry = new THREE.PlaneGeometry(2, 2);
const plane = (name, x, y, z, sx, sy, rgb) => {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...rgb, THREE.LinearSRGBColorSpace) });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = name;
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, 1); scene.add(mesh);
};
plane('backdrop', 0, 0, 0, 30, 30, [0.55, 0.58, 0.62]);
for (let x = -24; x <= 24; x += 4) plane('mullion-' + x, x, 0, 2, .13, 25, [.04, .05, .06]);
for (let y = -24; y <= 24; y += 4) plane('crossbar-' + y, 0, y, 2.1, 25, .12, [.04, .05, .06]);
for (let x = -23; x <= 23; x += 2) plane('railing-' + x, x, -35, 3, .09, 6, [.85, .88, .9]);
// This is the official example's MRT / pass / TRAANode / RenderPipeline graph.
const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output: output, velocity: velocity }));
const traaNode = traa(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera);
renderPipeline.outputNode = traaNode;
const rois = [{ name: 'windows', x: 170, y: 125, w: 300, h: 190 }, { name: 'railings', x: 170, y: 65, w: 300, h: 65 }, { name: 'moving-background', x: 250, y: 170, w: 140, h: 100 }];
const percentile = (values, p) => { const a = [...values].sort((a,b) => a-b); return a[Math.min(a.length-1, Math.floor(a.length*p))] || 0; };
const describe = values => ({ pixels: values.length, meanStd: values.reduce((a,b) => a+b,0)/(values.length||1), p95Std: percentile(values,.95), maxStd: values.reduce((a,b) => Math.max(a,b),0) });
const ext = gl.getExtension('WEBGL_debug_renderer_info');
globalThis.oracleReady = { revision: THREE.REVISION, backend: renderer.backend.constructor.name,
  gpu: { vendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), version: gl.getParameter(gl.VERSION) },
  camera: { fovy, near: camera.near, far: camera.far, position: camera.position.toArray(), matrixWorld: camera.matrixWorld.toArray() },
  renderer: { samples: renderer.samples, toneMapping: renderer.toneMapping, toneMappingExposure: renderer.toneMappingExposure, outputColorSpace: renderer.outputColorSpace, logarithmicDepthBuffer: renderer.logarithmicDepthBuffer, reversedDepthBuffer: renderer.reversedDepthBuffer },
  algorithm: { depthThreshold: traaNode.depthThreshold, edgeDepthDiff: traaNode.edgeDepthDiff, maxVelocityLength: traaNode.maxVelocityLength, useSubpixelCorrection: traaNode.useSubpixelCorrection },
  geometry: scene.children.map(mesh => ({ name: mesh.name, position: mesh.position.toArray(), scale: mesh.scale.toArray(), linearColor: mesh.material.color.toArray() })) };
globalThis.oracleRun = async () => {
  const size = c.width*c.height, sum = new Float64Array(size), square = new Float64Array(size), first = new Float32Array(size);
  const pixels = new Uint8Array(size*4), temporal = [], images = [];
  for (let frame = 0; frame < c.warmup; frame++) { renderPipeline.render(); if (frame%16 === 15) await new Promise(requestAnimationFrame); }
  const warmupPhase = traaNode._jitterIndex;
  for (let frame = 0; frame < c.count; frame++) {
    renderPipeline.render();
    gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error('Oracle readPixels GL error ' + error);
    const luma = new Float32Array(size);
    for (let i = 0; i < size; i++) { const j = i*4; const v = .2126*pixels[j]+.7152*pixels[j+1]+.0722*pixels[j+2]; luma[i]=v; sum[i]+=v; square[i]+=v*v; if(frame===0)first[i]=v; }
    const stats = rois.map(roi => { const values=[]; for(let y=roi.y;y<roi.y+roi.h;y++)for(let x=roi.x;x<roi.x+roi.w;x++)values.push(luma[y*c.width+x]); return { name:roi.name,mean:values.reduce((a,b)=>a+b,0)/values.length,contrast:percentile(values,.95)-percentile(values,.05) }; });
    temporal.push({ frame, nextJitterIndex: traaNode._jitterIndex, rois: stats });
    if(frame<32 || frame===127)images.push({frame,png:canvas.toDataURL('image/png')});
    if(frame%16===15)await new Promise(requestAnimationFrame);
  }
  const phases = [...new Set(temporal.map(value=>value.nextJitterIndex))].sort((a,b)=>a-b);
  if(phases.length!==32 || phases[0]!==0 || phases.at(-1)!==31)throw new Error('Official 32-phase jitter was not observed');
  const metrics=rois.map(roi=>{
    const all=[],edge=[],flat=[];
    for(let y=roi.y;y<roi.y+roi.h;y++)for(let x=roi.x;x<roi.x+roi.w;x++){
      const i=y*c.width+x,v=Math.sqrt(Math.max(0,square[i]/c.count-(sum[i]/c.count)**2));all.push(v);
      let isEdge=false;for(let dy=-2;dy<=2&&!isEdge;dy++)for(let dx=-2;dx<=2;dx++)if(Math.abs(first[i]-first[(y+dy)*c.width+x+dx])>8){isEdge=true;break;}
      (isEdge?edge:flat).push(v);
    }
    const contrast=temporal.map(value=>value.rois.find(item=>item.name===roi.name).contrast);
    const averageContrast=contrast.reduce((a,b)=>a+b,0)/contrast.length;
    return {...roi,all:describe(all),edge:describe(edge),flat:describe(flat),contrast,meanContrast:averageContrast,edgeMeanStdOverContrast:describe(edge).meanStd/Math.max(averageContrast,1e-8)};
  });
  const info={...oracleReady,warmupPhase,observedPhases:phases,metrics,temporal,images};
  renderPipeline.dispose(); traaNode.dispose(); scenePass.dispose();
  for(const mesh of scene.children)mesh.material.dispose();geometry.dispose();await renderer.dispose();
  return info;
};
`

async function prepare() {
  const syntax = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '--check'], { input: browserModule, encoding: 'utf8', windowsHide: true })
  if (syntax.status !== 0) throw new Error('Oracle browser module syntax: ' + syntax.stderr)
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(out, { recursive: true })
  const manifest = { commit, cache, preparedAt: new Date().toISOString(), config, files: {} }
  for (const file of files) {
    const destination = path.join(cache, path.basename(file))
    if (!fs.existsSync(destination)) {
      const response = await fetch(upstream + file, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`Download failed ${response.status}: ${file}`)
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
    }
    const bytes = fs.readFileSync(destination)
    manifest.files[file] = { url: upstream + file, sha256: hash(bytes), bytes: bytes.length }
  }
  const pinned = JSON.parse(fs.readFileSync(path.join(reference, 'manifest.json')))
  for (const name of ['TRAANode.js', 'TAAUtils.js', 'LICENSE']) {
    const bytes = fs.readFileSync(path.join(reference, name))
    if (hash(bytes) !== pinned.files[name].sha256) throw new Error(`Pinned reference hash changed: ${name}`)
    manifest.files[name] = { sha256: hash(bytes), bytes: bytes.length }
  }
  const core = fs.readFileSync(path.join(cache, 'three.core.js'), 'utf8')
  if (!core.includes("const REVISION = '186'")) throw new Error('Downloaded renderer is not r186')
  const script = fs.readFileSync(path.join(cache, 'three.webgpu.js'), 'utf8')
  for (const match of script.matchAll(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (!['./three.core.js'].includes(match[1])) throw new Error(`Unmapped renderer import: ${match[1]}`)
  }
  fs.writeFileSync(path.join(out, 'prepared.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function run(manifest) {
  const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'C:/Users/Administrator/node_modules/playwright')
  const imports = { three: '/build/three.webgpu.js', 'three/webgpu': '/build/three.webgpu.js', 'three/tsl': '/build/three.tsl.js', 'three/addons/': '/addons/' }
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style><script type="importmap">' + JSON.stringify({ imports }) + '</script></head><body><canvas></canvas><script>globalThis.oracleConfig=' + JSON.stringify(config) + '</script><script type="module">' + browserModule + '</script></body></html>'
  const routes = new Map(files.filter(name => name.startsWith('build/')).map(name => ['/' + name, path.join(cache, path.basename(name))]))
  routes.set('/addons/tsl/display/TRAANode.js', path.join(reference, 'TRAANode.js'))
  routes.set('/addons/tsl/utils/TAAUtils.js', path.join(reference, 'TAAUtils.js'))
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return }
    const file = routes.get(url.pathname)
    if (!file) { response.writeHead(404); response.end('Unknown oracle resource'); return }
    response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(fs.readFileSync(file))
  })
  const report = { label, date: new Date().toISOString(), manifest, config, errors: [], consoleErrors: [],
    limitations: ['Unlit linear RGB materials and local ENU-equivalent planes are used; this is not Cesium PBR lighting or ECEF geometry.', 'Output uses Three ACESFilmicToneMapping exposure=1 and SRGBColorSpace; it is not CCR color grading.', 'Edge ROIs and threshold match the CCR fixture, but independent first-frame edge masks can select different pixels.', 'Only official fixed 32-phase TRAA is tested; its algorithm and renderer sources are unmodified.', 'This isolates official-r186 temporal behavior; it cannot by itself establish bit-identical CCR port equivalence.'] }
  let browser
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    browser = await chromium.launch({ channel: 'chrome', headless: !argv.includes('--headed'), args: ['--use-angle=d3d11'] })
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height }, deviceScaleFactor: 1 })
    page.on('pageerror', error => report.errors.push(error.stack || error.message))
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.waitForFunction(() => globalThis.oracleReady, null, { timeout: 60000 })
    report.result = await page.evaluate(() => oracleRun())
    for (const image of report.result.images) {
      image.file = `${label}-${String(image.frame).padStart(3, '0')}.png`
      fs.writeFileSync(path.join(out, image.file), Buffer.from(image.png.split(',')[1], 'base64')); delete image.png
    }
    report.status = report.errors.length || report.consoleErrors.length ? 'render-errors' : 'measured-requires-equivalence-review'
  } catch (error) { report.status = 'failed'; report.failure = error.stack; throw error }
  finally {
    fs.writeFileSync(path.join(out, label + '.json'), JSON.stringify(report, null, 2))
    await browser?.close(); await new Promise(resolve => server.close(resolve))
  }
  console.log(JSON.stringify({ status: report.status, output: path.join(out, label + '.json'), metrics: report.result.metrics.map(value => ({ roi: value.name, edge: value.edge, meanContrast: value.meanContrast })) }, null, 2))
}

prepare().then(async manifest => {
  if (argv.includes('--run')) await run(manifest)
  else console.log(JSON.stringify({ status: 'prepared-no-gpu-run', cache, output: path.join(out, 'prepared.json'), run: 'node scripts/performance/compare-r186-oracle.cjs --run', files: manifest.files }, null, 2))
}).catch(error => { console.error(error); process.exitCode = 1 })
