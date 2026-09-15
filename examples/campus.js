// examples/campus.js
//
// 南湖校区实景示例的脚本部分，从 examples/campus.html 内联的 <script type="module"> 拆出。
// HTML 只保留场景容器（#scene）与一个只读输出区（#status / #aaExplanation / #aaActual），
// 所有可调控件改由右上角的 lil-gui 面板生成，不再用 querySelector 逐个手写 DOM 事件。
//
// 资产来源与拆分前一致：3D Tiles 全部读本工程自带的静态目录，
// 不依赖 127.0.0.1:8083 或远端瓦片服务；镜头、控件语义与采样逻辑保持不变。
import '../build/0.1.0/CCR.min.js'
import SampleGuard from '/src/diagnostics/SampleGuard.js'
import GUI from '/node_modules/lil-gui/dist/lil-gui.esm.js'
import Stats from './js/stats.module.js'

const { createVisualPipeline, colorGradingControls, colorGradingPresets } = globalThis.CCR

const status = document.querySelector('#status')
const aaExplanation = document.querySelector('#aaExplanation')
const aaActual = document.querySelector('#aaActual')
const errors = []
const query = new URLSearchParams(location.search)
// 沈阳影像服务：本机实测可达；换成 ?imagery=none 可关闭，换成 ?imagery=<模板> 可替换。
const DEFAULT_IMAGERY = window.CCR_EXAMPLE_CONFIG?.imageryUrl || null
const imageryParam = query.get('imagery')
const previewImageryUrl = imageryParam === 'none' ? null : (imageryParam || DEFAULT_IMAGERY)
// 本地静态资产根目录，相对于 dev-server 的项目根。
const CAMPUS_ASSETS = '/assets/campus-assets'
const base = query.get('assets') || CAMPUS_ASSETS
const contextParam = query.get('contextTiles')
const previewWhiteModelUrl = contextParam === 'none' ? null
  : (contextParam || `${CAMPUS_ASSETS}/Dongda2.5bm_3dtiles/tileset.json`)

const viewer = new Cesium.Viewer('scene', {
  baseLayer: false, baseLayerPicker: false, geocoder: false, navigationHelpButton: false,
  timeline: false, animation: false, sceneModePicker: false, homeButton: false,
  requestRenderMode: false
})
viewer.scene.globe.show = true
if (previewImageryUrl) viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url: previewImageryUrl })))
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-09-08T03:00:00Z')
viewer.clock.shouldAnimate = false
// Explicit bounded experiment, applied equally to both measurements. The default
// full-globe camera can span multiple frusta and must remain unsupported.
const singleFrustumSample = query.get('singleFrustum') === '1'
if (singleFrustumSample) viewer.camera.frustum.far = 50000
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#52654c')
viewer.scene.renderError.addEventListener((scene, error) => { errors.push(error.message); status.textContent = error.message })
const requestedShadow = query.get('shadow')
const pipeline = createVisualPipeline({ Cesium, viewer,
  options: ['custom', 'native'].includes(requestedShadow) ? { shadowMode: requestedShadow } : {} })
const tiles = []
const contextTiles = []
window.campus = { viewer, pipeline, tiles, contextTiles, errors, base }
Object.defineProperty(window.campus, 'geometry', { get: () => pipeline.geometry })

// ---------------------------------------------------------------------------
// GUI
//
// 每个控制器绑定到 `ui` 上的一个字段：用户改动 -> 写回 pipeline -> syncUI() 把 pipeline
// 归一化后的真实值回写到 `ui`。控制器都挂了 listen()，所以外部变化（预设按钮、模式切换）
// 也会立刻反映到面板上，不必再手工去查 DOM 元素改 textContent。
// ---------------------------------------------------------------------------
const ui = {
  grading: {},
  aa: { mode: 'smaa', quality: 'balanced', msaaSamples: 1, resolutionMode: 'native', combinedMsaa: false, taa: false, jitterSamples: 8 },
  geometry: { enabled: false, debugMode: 'off' },
  materials: false,
  depthPyramid: false,
  ao: { enabled: false, radius: 3, strength: 1 },
  ssr: { enabled: false, transparent: false, distance: 150, strength: 1 },
  governor: false,
  environment: { on: false, high: false, playing: false }
}
const aaNotes = {
  off: '关闭所有抗锯齿，用于对照。',
  fxaa: '单次颜色过滤，开销较低；平滑档会更柔和。',
  smaa: '三阶段边缘处理，适合屋檐、窗框；可叠加MSAA改善几何轮廓。',
  msaa: '主要平滑模型轮廓，不能单独解决纹理、SSR和阴影中的锯齿。',
  taa: '本轮保留原TAA实现；空间质量选项不作用于TAA。'
}
// 只有 FXAA/SMAA 吃 spatialAaQuality，其余模式下把该控制器置灰（等价于原来的 disabled）。
let spatialQualityController = null
const syncUI = () => {
  const grading = pipeline.getColorGrading()
  colorGradingControls.forEach(({ key }) => { ui.grading[key] = grading[key] })
  const aa = pipeline.getAntiAliasing()
  const options = pipeline.getOptions()
  const taa = pipeline.getTaaDiagnostics()
  ui.aa.mode = aa.mode
  ui.aa.resolutionMode = aa.resolutionMode
  ui.aa.msaaSamples = aa.msaaSamples
  ui.aa.quality = options.spatialAaQuality
  ui.aa.combinedMsaa = options.msaaCombine === true
  ui.aa.taa = taa.requested.enabled
  ui.aa.jitterSamples = taa.requested.jitterSamples
  const geometry = pipeline.getGeometryDiagnostics().requested
  ui.geometry.enabled = geometry.enabled === true
  ui.geometry.debugMode = geometry.debugMode
  ui.materials = options.materialChannelsEnabled === true
  ui.depthPyramid = options.depthPyramidEnabled === true
  const ao = pipeline.getScreenSpaceAODiagnostics().requested
  ui.ao.enabled = ao.enabled === true
  ui.ao.radius = ao.radius
  ui.ao.strength = ao.strength
  const ssr = pipeline.getScreenSpaceReflectionDiagnostics().requested
  ui.ssr.enabled = ssr.enabled === true
  ui.ssr.transparent = ssr.transparent === true
  ui.ssr.distance = ssr.distance
  ui.ssr.strength = ssr.strength
  ui.governor = pipeline.getPerformanceDiagnostics().enabled === true
  ui.environment.on = options.environment === true
  ui.environment.high = options.environmentQuality === 'high'
  ui.environment.playing = viewer.clock.shouldAnimate
  aaExplanation.textContent = aaNotes[aa.mode] || ''
  if (spatialQualityController) spatialQualityController.enable(['smaa', 'fxaa'].includes(aa.mode))
}
syncUI()

const gui = new GUI({ title: 'CCR · 南湖校区', width: 300 })
let actionCount = 0
// lil-gui 里「按钮」就是值为函数的属性，但属性名同时充当标签；用 ASCII 键再 name() 覆写，
// 免得中文键名被 humanize 处理。
const action = (folder, label, handler) => folder.add({ [`action${++actionCount}`]: handler }, `action${actionCount}`).name(label)
const dump = value => { status.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2) }

const pipelineFolder = gui.addFolder('管线与阴影')
action(pipelineFolder, '原生对比', () => { pipeline.setEnabled(false); syncUI() })
action(pipelineFolder, '视觉增强', () => { pipeline.setEnabled(true); syncUI() })
const shadowFolder = pipelineFolder.addFolder('阴影')
action(shadowFolder, '自定义阴影', () => pipeline.setOptions({ shadowMode: 'custom', shadowStatic: false, shadowDebug: false }))
action(shadowFolder, '自定义静态缓存（测试）', () => {
  pipeline.setOptions({ shadowMode: 'custom', shadowStatic: true, shadowDebug: false })
  dump('静态测试：纹理/实例缓冲内容变化时必须显式invalidate；动态模型请使用逐帧模式。')
})
action(shadowFolder, '阴影深度图', () => pipeline.setOptions({ shadowMode: 'custom', shadowDebug: !pipeline.getOptions().shadowDebug }))
shadowFolder.close()

// 相机按钮在瓦片到位前点不动，注册时先留一个提示分支，避免面板在加载完成后跳动。
const look = (pitch, range) => {
  if (!tiles[1]) { dump('模型尚未加载完成，相机按钮暂不可用。'); return }
  viewer.camera.lookAt(tiles[1].boundingSphere.center, new Cesium.HeadingPitchRange(0, pitch, range))
}
// 也挂到 window.campus 上：scripts/ 里的浏览器核查脚本直接调用它，不必去点 GUI 按钮。
window.campus.look = look
const cameraFolder = gui.addFolder('相机')
action(cameraFolder, '全景', () => look(-0.65, 1800))
action(cameraFolder, '建筑近景', () => look(-0.45, 750))
action(cameraFolder, '天空视角', () => look(-0.08, 1600))
cameraFolder.close()

const environmentFolder = gui.addFolder('环境与时间')
for (const [label, preset] of [['晴天', 'clear'], ['晨雾', 'morning'], ['层云', 'overcast'], ['夕照', 'sunset'], ['霾', 'haze']]) {
  action(environmentFolder, label, () => {
    pipeline.setOptions({ environment: true, environmentPreset: preset })
    dump(pipeline.environmentRenderer.getDiagnostics())
    syncUI()
  })
}
environmentFolder.add(ui.environment, 'on').name('环境').listen()
  .onChange(value => { pipeline.setOptions({ environment: value }); syncUI() })
environmentFolder.add(ui.environment, 'high').name('高质量环境').listen()
  .onChange(value => { pipeline.setOptions({ environmentQuality: value ? 'high' : 'balanced' }); syncUI() })
const setClock = time => { viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(time); viewer.scene.requestRender() }
const clockFolder = environmentFolder.addFolder('时间')
action(clockFolder, '6:30', () => setClock('2026-09-07T22:30:00Z'))
action(clockFolder, '11:00', () => setClock('2026-09-08T03:00:00Z'))
action(clockFolder, '17:30', () => setClock('2026-09-08T09:30:00Z'))
clockFolder.add(ui.environment, 'playing').name('时间播放（10×）').listen().onChange(value => {
  viewer.clock.shouldAnimate = value
  viewer.clock.multiplier = value ? 10 : 1
})
clockFolder.close()

const gradingFolder = gui.addFolder('画面调整')
colorGradingControls.forEach(({ key, label, min, max, step }) => {
  gradingFolder.add(ui.grading, key, min, max, step).name(label).listen()
    .onChange(value => { pipeline.setColorGrading({ [key]: value }); syncUI() })
})
action(gradingFolder, '明亮清晰', () => { pipeline.setColorGrading(colorGradingPresets.clear); syncUI() })
action(gradingFolder, '中性', () => { pipeline.setColorGrading(colorGradingPresets.neutral); syncUI() })
action(gradingFolder, '重置', () => { pipeline.resetColorGrading(); syncUI() })
gradingFolder.close()

const aaPresets = {
  fast: { mode: 'fxaa', quality: 'sharp', msaaSamples: 1, msaaCombine: false },
  balanced: { mode: 'smaa', quality: 'balanced', msaaSamples: 1, msaaCombine: false },
  quality: { mode: 'smaa', quality: 'balanced', msaaSamples: 4, msaaCombine: true }
}
const aaFolder = gui.addFolder('抗锯齿')
aaFolder.add(ui.aa, 'mode', {
  'SMAA（后处理抗锯齿）': 'smaa', 'FXAA（后处理抗锯齿）': 'fxaa', 'TAA（时间抗锯齿）': 'taa',
  '仅 MSAA（无后处理）': 'msaa', '关闭': 'off'
}).name('模式').listen().onChange(value => { pipeline.setAntiAliasing({ mode: value }); syncUI() })
spatialQualityController = aaFolder.add(ui.aa, 'quality', {
  '清晰：保留细纹理': 'sharp', '均衡：兼顾屋檐与纹理': 'balanced', '平滑：加强细边缘': 'smooth'
}).name('空间 AA 质量').listen().onChange(value => { pipeline.setAntiAliasing({ quality: value }); syncUI() })
aaFolder.add(ui.aa, 'msaaSamples', [1, 2, 4, 8]).name('MSAA 请求样本').listen()
  .onChange(value => { pipeline.setAntiAliasing({ msaaSamples: Number(value) }); syncUI() })
aaFolder.add(ui.aa, 'combinedMsaa').name('组合 MSAA').listen()
  .onChange(value => { pipeline.setAntiAliasing({ msaaCombine: value }); syncUI() })
aaFolder.add(ui.aa, 'jitterSamples', [4, 8, 16]).name('TAA抖动样本').listen().onChange(value => {
    // The sample count is read when the resolve stages are built, so re-arm the pass:
    // switching away tears the stages (and the jitter) down, switching back rebuilds them.
    pipeline.setTaa({ jitterSamples: Number(value), enabled: false })
    pipeline.setTaa({ enabled: true })
    syncUI()
  })
action(aaFolder, '轻量 FXAA', () => { pipeline.setAntiAliasing(aaPresets.fast); syncUI() })
action(aaFolder, '均衡 SMAA', () => { pipeline.setAntiAliasing(aaPresets.balanced); syncUI() })
action(aaFolder, 'SMAA＋4×MSAA', () => { pipeline.setAntiAliasing(aaPresets.quality); syncUI() })
aaFolder.add(ui.aa, 'resolutionMode', { '原生像素': 'native', 'CSS像素（性能优先）': 'css' }).name('分辨率').listen()
  .onChange(value => { pipeline.setAntiAliasing({ resolutionMode: value }); syncUI() })

const channelFolder = gui.addFolder('几何与通道')
channelFolder.add(ui.geometry, 'enabled').name('几何通道').listen().onChange(value => {
  pipeline.setGeometry({ enabled: value })
  syncUI()
  dump(pipeline.getGeometryDiagnostics())
})
channelFolder.add(ui.geometry, 'debugMode', { '场景颜色': 'off', '几何法线': 'normal', '线性深度': 'depth' }).name('几何调试模式').listen()
  .onChange(value => { pipeline.setGeometry({ debugMode: value }); syncUI() })
channelFolder.add(ui, 'materials').name('材质通道（MRT）').listen()
  .onChange(value => { pipeline.setMaterialChannels({ enabled: value }); syncUI() })
channelFolder.add(ui, 'depthPyramid').name('深度金字塔（Hi-Z）').listen()
  .onChange(value => { pipeline.setDepthPyramid({ enabled: value }); syncUI() })
channelFolder.close()

const aoFolder = gui.addFolder('屏幕空间 AO')
aoFolder.add(ui.ao, 'enabled').name('开启 AO（HBAO）').listen().onChange(value => {
  pipeline.setScreenSpaceAO({ enabled: value })
  syncUI()
  dump(pipeline.getScreenSpaceAODiagnostics())
})
// 拖动时逐帧生效；松手后再 syncUI，把 pipeline 归一化后的值（可能被 clamp）抄回面板。
aoFolder.add(ui.ao, 'radius', 0.1, 20, 0.1).name('半径（米）').listen()
  .onChange(value => pipeline.setScreenSpaceAO({ radius: Number(value) })).onFinishChange(() => syncUI())
aoFolder.add(ui.ao, 'strength', 0, 2, 0.1).name('强度').listen()
  .onChange(value => pipeline.setScreenSpaceAO({ strength: Number(value) })).onFinishChange(() => syncUI())

const ssrFolder = gui.addFolder('屏幕反射')
ssrFolder.add(ui.ssr, 'enabled').name('开启反射').listen().onChange(value => {
  pipeline.setScreenSpaceReflections({ enabled: value })
  syncUI()
  dump(pipeline.getScreenSpaceReflectionDiagnostics())
})
ssrFolder.add(ui.ssr, 'transparent').name('透明反射（需开启反射）').listen().onChange(value => {
  pipeline.setScreenSpaceReflections({ transparent: value })
  syncUI()
  dump(pipeline.getTransparentReflectionDiagnostics())
})
ssrFolder.add(ui.ssr, 'distance', 1, 2000, 1).name('距离（米）').listen()
  .onChange(value => pipeline.setScreenSpaceReflections({ distance: Number(value) })).onFinishChange(() => syncUI())
ssrFolder.add(ui.ssr, 'strength', 0, 1, 0.1).name('强度').listen()
  .onChange(value => pipeline.setScreenSpaceReflections({ strength: Number(value) })).onFinishChange(() => syncUI())

const performanceFolder = gui.addFolder('性能')
performanceFolder.add(ui, 'governor').name('调速器（目标 30fps）').listen().onChange(value => {
  dump(pipeline.setPerformance({ enabled: value, targetFps: 30 }))
  syncUI()
})
performanceFolder.close()

const diagnosticsFolder = gui.addFolder('诊断与采样')
action(diagnosticsFolder, '采样 60 秒', () => measure())
action(diagnosticsFolder, '读取实际状态', () => { syncUI(); dump(pipeline.getRenderDiagnostics()) })
action(diagnosticsFolder, '几何通道状态', () => dump(pipeline.getGeometryDiagnostics()))
action(diagnosticsFolder, '材质通道状态', () => dump(pipeline.getMaterialDiagnostics()))
action(diagnosticsFolder, '深度金字塔状态', () => dump(pipeline.getDepthPyramidDiagnostics()))
action(diagnosticsFolder, 'AO 状态', () => dump(pipeline.getScreenSpaceAODiagnostics()))
action(diagnosticsFolder, '屏幕反射状态', () => dump(pipeline.getScreenSpaceReflectionDiagnostics()))
action(diagnosticsFolder, '透明反射状态', () => dump(pipeline.getTransparentReflectionDiagnostics()))
action(diagnosticsFolder, 'TAA 状态', () => dump(pipeline.getTaaDiagnostics()))
action(diagnosticsFolder, '调速器状态', () => dump(pipeline.getPerformanceDiagnostics()))
action(diagnosticsFolder, '环境状态', () => dump(pipeline.environmentRenderer ? pipeline.environmentRenderer.getDiagnostics() : '环境未启用'))
diagnosticsFolder.close()
// 面板默认展开「管线 / 环境 / 抗锯齿 / AO / 屏幕反射」五组，其余折叠；
// 根容器的位置、圆角与配色在 examples/campus.html 的 .lil-gui.lil-root 里覆盖。

// ---------------------------------------------------------------------------
// 帧率面板（js/stats.module.js）
//
// 该文件是 three.js 的 Stats（REVISION 16，原样保留、未改），以 ES module 引入。
// 它在构造时就建好了 DOM：一个固定定位的容器 + 每块面板一个 canvas
// （FPS / MS / 浏览器支持 performance.memory 时再加 MB，点击容器可切换）。
// 所以「初始化」只有两步：把 dom 挂进文档，然后按 Cesium 的场景事件驱动 begin/end。
//
// 用 preRender -> postRender 配对：MS 面板统计的是一帧从开始渲染到渲染结束的耗时
// （即场景渲染本身的成本），FPS 面板统计每秒完成多少帧。FPS 的口径与 measure()
// 里记录 postRender 间隔的采样一致，两者可以互相印证。
// ---------------------------------------------------------------------------
const stats = new Stats()
// Stats 自带样式只有 bottom:12px，横向靠静态位置落在最左边；这里与左侧 HUD 的 12px 边距对齐。
stats.dom.style.left = '12px'
document.body.appendChild(stats.dom)
viewer.scene.preRender.addEventListener(() => stats.begin())
viewer.scene.postRender.addEventListener(() => stats.end())
window.campus.stats = stats

// 采样期间面板必须锁住：原来是把页面上所有 button/input/select 一起 disabled，
// 现在换成逐个控制器 disable（lil-gui 没有 GUI 级别的 disable）。
const setControlsEnabled = enabled => {
  gui.controllersRecursive().forEach(controller => controller.enable(enabled))
  gui.domElement.style.pointerEvents = enabled ? '' : 'none'
  if (enabled) syncUI()
}

// 每 60 帧刷新一次实际的抗锯齿/缓冲区读数。
let aaDisplayFrame = 0
viewer.scene.postRender.addEventListener(() => {
  if (++aaDisplayFrame % 60 || window.campus.measuring) return
  const d = pipeline.getRenderDiagnostics().antiAliasing
  const actual = d.allocatedAttachments && d.allocatedAttachments.scene
  aaActual.textContent = `后处理：${d.postProcess.effective === 'off' ? '关闭' : d.postProcess.effective.toUpperCase()} · MSAA ${actual && actual.colorRenderbufferSamples || 1}× · ${viewer.canvas.width}×${viewer.canvas.height}`
})

try {
  if (previewWhiteModelUrl) {
    Cesium.Cesium3DTileset.fromUrl(previewWhiteModelUrl, { maximumScreenSpaceError: 128 })
      .then(whiteModel => { viewer.scene.primitives.add(whiteModel); contextTiles.push(whiteModel) })
      .catch(error => { errors.push(`周边白模加载失败：${error.message}`); status.textContent = errors.at(-1) })
  }
  for (const name of ['SM_NH_Terr', 'SM_NH_Building', 'SM_NH_Shu']) {
    const tile = await Cesium.Cesium3DTileset.fromUrl(`${base}/${name}/tileset.json`, {
      maximumScreenSpaceError: 16, shadows: Cesium.ShadowMode.ENABLED
    })
    viewer.scene.primitives.add(tile)
    tiles.push(tile)
  }
  pipeline.setCampusOrigin(tiles[1].boundingSphere.center)
  look(-0.65, 1800)
  status.textContent = '原生/增强使用同一时间、相机与资产；瓦片来自本地 assets/campus-assets。这不是完整业务页面。'
} catch (error) { errors.push(error.message); status.textContent = `模型加载失败：${error.message}` }

async function measure() {
  if (window.campus.measuring) return
  if (document.hidden || !document.hasFocus()) {
    status.textContent = '请将测试窗口置于前台后再开始采样，后台节流数据不能用于性能验收。'
    return
  }
  if (!tiles.length || !tiles.every(tile => tile.tilesLoaded)) {
    status.textContent = '请等当前视角瓦片加载完成后再采样。'
    return
  }
  window.campus.measuring = true
  setControlsEnabled(false)
  const startedOptions = pipeline.getOptions()
  const startedEnabled = pipeline.enabled
  const startedBuffer = [viewer.canvas.width, viewer.canvas.height]
  const geometryConfiguration = () => ({ enabled: pipeline.getGeometryDiagnostics().enabled, debugMode: pipeline.getGeometryDiagnostics().debugMode })
  const startedGeometry = geometryConfiguration()
  const startedTime = Cesium.JulianDate.toIso8601(viewer.clock.currentTime)
  const cameraConfiguration = () => [...[viewer.camera.positionWC, viewer.camera.directionWC, viewer.camera.upWC].flatMap(v => [v.x, v.y, v.z]),
    viewer.camera.frustum.near, viewer.camera.frustum.far, viewer.camera.frustum.fov, viewer.camera.frustum.aspectRatio]
  const startedCamera = cameraConfiguration()
  const sampleState = () => ({ options: pipeline.getOptions(), enabled: pipeline.enabled,
    suspended: pipeline.suspensions.size, geometry: geometryConfiguration(), camera: cameraConfiguration(),
    time: Cesium.JulianDate.toIso8601(viewer.clock.currentTime), buffer: [viewer.canvas.width, viewer.canvas.height] })
  const guard = new SampleGuard(sampleState())
  const startedAt = Date.now()
  const cameraInputs = viewer.scene.screenSpaceCameraController.enableInputs
  viewer.scene.screenSpaceCameraController.enableInputs = false
  let geometryValid = true
  let materialValid = true
  let pyramidValid = true
  let aoValid = true
  let reflectionValid = true
  let transparentReflectionValid = true
  let environmentValid = true
  let aaValid = true
  let taaValid = true
  let tilesLoadedThroughoutSample = true
  const startingUpdates = pipeline.customShadow ? pipeline.customShadow.stats.updates : 0
  const startingHits = pipeline.customShadow ? pipeline.customShadow.stats.cacheHits : 0
  const samples = []
  const interruptions = []
  const visibility = () => { if (document.hidden) interruptions.push('hidden') }
  const blur = () => interruptions.push('blur')
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('blur', blur)
  let previous, start
  status.textContent = '采样中，请保持窗口可见。记录所有帧间隔；页面valid只检查页面状态，正式基准还需核验系统前台。'
  await new Promise(resolve => {
    const timeout = setTimeout(() => { interruptions.push('render-timeout'); remove(); resolve() }, 90000)
    const remove = viewer.scene.postRender.addEventListener(() => {
      const now = performance.now()
      guard.observe(sampleState())
      if (document.hidden || !document.hasFocus()) {
        if (!interruptions.includes('not-focused')) interruptions.push('not-focused')
      }
      if (startedGeometry.enabled && !pipeline.getGeometryDiagnostics().valid) geometryValid = false
      if (startedEnabled && startedOptions.materialChannelsEnabled && !pipeline.getMaterialDiagnostics().valid) materialValid = false
      if (startedEnabled && startedOptions.depthPyramidEnabled && !pipeline.getDepthPyramidDiagnostics().valid) pyramidValid = false
      if (startedEnabled && startedOptions.screenSpaceAoEnabled && !pipeline.getScreenSpaceAODiagnostics().valid) aoValid = false
      if (startedEnabled && startedOptions.screenSpaceReflectionEnabled && !pipeline.getScreenSpaceReflectionDiagnostics().valid) reflectionValid = false
      if (startedEnabled && startedOptions.screenSpaceReflectionEnabled && startedOptions.screenSpaceReflectionTransparent && !pipeline.getTransparentReflectionDiagnostics().valid) transparentReflectionValid = false
      if (startedEnabled && startedOptions.environment && (!pipeline.environmentRenderer || !pipeline.environmentRenderer.getDiagnostics().hdr.valid)) environmentValid = false
      if (startedEnabled && startedOptions.antialiasing === 'smaa' && (!pipeline.smaa || pipeline.smaa.getDiagnostics().effective !== 'smaa')) aaValid = false
      if (startedEnabled && startedOptions.antialiasing === 'taa' && (!pipeline.taa || !pipeline.getTaaDiagnostics().valid)) taaValid = false
      if (!tiles.every(tile => tile.tilesLoaded)) tilesLoadedThroughoutSample = false
      if (previous !== undefined) samples.push(now - previous)
      previous = now
      if (start === undefined) start = now
      if (now - start >= 60000) { clearTimeout(timeout); remove(); resolve() }
    })
  })
  const rawFrameIntervals = [...samples]
  samples.sort((a, b) => a - b)
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('blur', blur)
  guard.observe(sampleState())
  const unchanged = guard.valid && JSON.stringify(startedOptions) === JSON.stringify(pipeline.getOptions()) && startedEnabled === pipeline.enabled
    && JSON.stringify(startedGeometry) === JSON.stringify(geometryConfiguration())
    && JSON.stringify(startedCamera) === JSON.stringify(cameraConfiguration())
    && startedTime === Cesium.JulianDate.toIso8601(viewer.clock.currentTime)
  const bufferUnchanged = startedBuffer[0] === viewer.canvas.width && startedBuffer[1] === viewer.canvas.height
  const shadowError = startedOptions.shadowMode === 'custom' && pipeline.customShadow && pipeline.customShadow.stats.error
  const result = { version: Cesium.VERSION, enabled: pipeline.enabled,
    validationScope: 'page-state-only; OS foreground must be verified separately',
    valid: interruptions.length === 0 && unchanged && bufferUnchanged && geometryValid && materialValid && pyramidValid && aoValid && reflectionValid && transparentReflectionValid && environmentValid && aaValid && taaValid && tilesLoadedThroughoutSample && !shadowError && errors.length === 0 && samples.length > 90,
    interruptions, configurationUnchanged: unchanged, changedFields: guard.changedFields, bufferUnchanged,
    startedAt, endedAt: Date.now(), rawFrameIntervals,
    options: startedOptions,
    imageQuality: pipeline.getRenderDiagnostics(), aaValidThroughoutSample: aaValid,
    taaValidThroughoutSample: taaValid,
    geometry: { ...pipeline.getGeometryDiagnostics(), validThroughoutSample: geometryValid }, camera: startedCamera,
    materials: { ...pipeline.getMaterialDiagnostics(), validThroughoutSample: materialValid },
    depthPyramid: { ...pipeline.getDepthPyramidDiagnostics(), validThroughoutSample: pyramidValid },
    screenSpaceAO: { ...pipeline.getScreenSpaceAODiagnostics(), validThroughoutSample: aoValid },
    screenSpaceReflections: { ...pipeline.getScreenSpaceReflectionDiagnostics(), validThroughoutSample: reflectionValid },
    transparentReflections: { ...pipeline.getTransparentReflectionDiagnostics(), validThroughoutSample: transparentReflectionValid },
    singleFrustumSample, tilesLoadedThroughoutSample,
    time: startedTime, environment: pipeline.environmentRenderer ? pipeline.environmentRenderer.getDiagnostics() : null, environmentValidThroughoutSample: environmentValid,
    drawingBuffer: [viewer.canvas.width, viewer.canvas.height], frames: samples.length,
    shadowCommands: startedOptions.shadowMode === 'custom' ? [pipeline.customShadow.stats.casters]
      : viewer.shadowMap.outOfView ? [] : viewer.shadowMap.passes.map(pass => pass.commandList.length),
    customStats: startedOptions.shadowMode === 'custom' ? { ...pipeline.customShadow.stats,
      updates: pipeline.customShadow.stats.updates - startingUpdates,
      cacheHits: pipeline.customShadow.stats.cacheHits - startingHits } : null,
    p50: samples[Math.floor(samples.length * 0.5)], p95: samples[Math.floor(samples.length * 0.95)],
    max: samples[samples.length - 1], tilesLoaded: tiles.every(tile => tile.tilesLoaded), errors: [...errors] }
  window.campus.lastMeasurement = result
  window.campus.measuring = false
  viewer.scene.screenSpaceCameraController.enableInputs = cameraInputs
  setControlsEnabled(true)
  status.textContent = JSON.stringify(result, null, 2)
}

window.addEventListener('pagehide', () => { pipeline.destroy(); viewer.destroy() }, { once: true })
