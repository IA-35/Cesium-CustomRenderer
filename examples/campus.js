import CampusAssetCompatibility from './compat/CampusAssetCompatibility.js'
import { loadCampusGlbs, assertCampusGlbBase } from './campus-glb.js'
import { SharedGlbTextureCache } from './shared-glb-textures.js'
import { prepareCampusTraffic } from './campus-traffic-placement.js'
import { buildPolygonTreeData } from './campus-polygon-trees.js'
// examples/campus.js
//
// 南湖校区实景示例的脚本部分，从 examples/campus.html 内联的 <script type="module"> 拆出。
// HTML 只保留场景容器（#scene）与一个只读输出区（#status / #aaExplanation / #aaActual），
// 所有可调控件改由右上角的 lil-gui 面板生成，不再用 querySelector 逐个手写 DOM 事件。
//
// 默认直接加载 SM_NH 建筑 GLB；?models=tiles 保留原始建筑 Tiles 对照。
// 周边白模继续使用本工程的本地副本；镜头、控件语义与采样逻辑保持不变。
import '../build/0.1.0/CCR.min.js'
import SampleGuard from '/src/diagnostics/SampleGuard.js'
import GUI from '/node_modules/lil-gui/dist/lil-gui.esm.js'
import Stats from './js/stats.module.js'

const { createVisualPipeline, createFixedTreeCollection, createGrassCollection, createWaterSurfaceCollection, createTrafficSystem, colorGradingControls, colorGradingPresets } = globalThis.CCR

const status = document.querySelector('#status')
const aaExplanation = document.querySelector('#aaExplanation')
const aaActual = document.querySelector('#aaActual')
const errors = []
const query = new URLSearchParams(location.search)
const trafficParam = query.get('traffic')
const trafficManifestUrl = false
// ['0', 'none'].includes(trafficParam) ? null :
//   (trafficParam && trafficParam !== '1' ? trafficParam : '/examples/campus-traffic/traffic.json')
let traffic = false
let campusAssetsLoaded = false, trafficLoading = null
const lightweightVegetation = query.get('vegetation') !== 'legacy'
// 固定点位树木默认启用；?trees=none 关闭，?trees=<url> 可替换清单。
const treeParam = query.get('trees')
const treeEnabled = !['0', 'none'].includes(treeParam)
const treeManifestUrl = treeParam && !['0', 'none', '1'].includes(treeParam)
  ? treeParam
  : (lightweightVegetation && query.get('treeSource') !== 'procedural'
    ? '/assets/vegetation/ez-tree/manifest.json' : '/assets/vegetation/manifest.json')
const treeSource = query.get('treeSource') === 'procedural' ? 'procedural' : 'glb'
const polygonTreesEnabled = treeEnabled && lightweightVegetation
// 面内程序化草地默认启用；?grass=none 关闭，?grass=<url> 可替换面数据。
// 轻量草默认 4 簇/平方米，按面采样地面高度；?vegetation=legacy 对照旧资产。
const grassParam = query.get('grass')
const grassEnabled = !['0', 'none'].includes(grassParam)
const grassPolygonsUrl = grassParam && !['0', 'none', '1'].includes(grassParam)
  ? grassParam
  : '/assets/grass/polygons.json'
// CGCS2000 水面已预处理为 WGS84；?water=none 关闭，?water=<url> 可替换面数据。
const waterParam = query.get('water')
const waterEnabled = !['0', 'none'].includes(waterParam)
const waterPolygonsUrl = waterParam && !['0', 'none', '1'].includes(waterParam)
  ? waterParam
  : '/assets/water/polygons.json'
// 沈阳影像服务：本机实测可达；换成 ?imagery=none 可关闭，换成 ?imagery=<模板> 可替换。
const DEFAULT_IMAGERY = window.CCR_EXAMPLE_CONFIG?.imageryUrl || null
const imageryParam = query.get('imagery')
const previewImageryUrl = imageryParam === 'none' ? null : (imageryParam || DEFAULT_IMAGERY)
// 业务系统的南湖模型清单。默认直接复用本机 9528 开发服务的 /Dongda 代理。
const CAMPUS_ASSETS = '/assets/campus-assets'
const DEFAULT_BUSINESS_ASSETS = 'http://localhost:8083/Dongda'
const base = query.get('assets') || DEFAULT_BUSINESS_ASSETS
const modelMode = query.get('models') === 'tiles' ? 'tiles' : 'glb'
const glbManifest = await fetch('./campus-glb-manifest.json').then(response => {
  if (!response.ok) throw new Error(`GLB manifest: HTTP ${response.status}`)
  return response.json()
})
let glbBase = query.get('glbAssets') || glbManifest.baseUrl
// 默认 baseUrl 走本机 nginx 8083 的 /DongdaModel_PBR/ 代理；不可达时依次回退到本地静态目录
// /assets/campus-glb-release、再回退 dev-server 的 /campus-mobile-glb。探测一次，避免 70 个 404。
const glbBaseCandidates = query.get('glbAssets')
  ? [query.get('glbAssets')]
  : [glbManifest.baseUrl, ...(glbManifest.fallbackBaseUrls || [])]
const BUSINESS_TILESETS = [
  // 地形只接收阴影、不投射（RECEIVE_ONLY）。地形是一整块起伏网格，自阴影的视觉收益很低，
  // 却要在自定义级联阴影里整块再画一遍：实测 792K 三角形、每帧 65 次阴影 draw。
  // 保留接收侧，建筑和树的影子仍会落在地面上。
  { name: 'SM_NH_Terr', url: 'SM_NH_Terr/tileset.json', height: 2, shadows: Cesium.ShadowMode.RECEIVE_ONLY },
  // { name: 'SM_NH_Shu', url: 'SM_NH_Shu/tileset.json', height: 2 },
  // { name: 'SM_NH_Building', url: 'SM_NH_Building/tileset.json', height: 2 },
  // { name: 'SM_NH_YFL', url: 'SM_NH_YFL/SW/tileset.json', height: 2 },
  // { name: 'SM_NH_ZHL', url: 'SM_NH_ZHL/SW/tileset.json', height: 2 },
  // { name: 'SM_NH_SYL1', url: 'SM_NH_SYL1/SW/tileset.json', height: 2 },
  // { name: 'SM_NH_SYL2', url: 'SM_NH_SYL2/SW/tileset.json', height: 2 },
  // { name: 'SM_NH_XSST1', url: 'SM_NH_XSST1/tileset.json', height: 2 },
  // { name: 'SM_NH_XSST2', url: 'SM_NH_XSST2/tileset.json', height: 2 },
  // { name: 'SM_NH_XSCST', url: 'SM_NH_XSCST/tileset.json', height: 2 },
  // { name: 'SM_NH_ZXST', url: 'SM_NH_ZXST/tileset.json', height: 2 },
  // { name: 'SM_NH_DDFW', url: 'SM_NH_DDFW/tileset.json', height: 2 },
  // { name: 'SM_NH_TSG', url: 'SM_NH_TSG/SW/tileset.json', height: 2 }
]
const contextParam = query.get('contextTiles')
const previewWhiteModelUrl = contextParam === 'none' ? null
  : (contextParam || `${CAMPUS_ASSETS}/Dongda2.5bm_3dtiles/tileset.json`)

const viewer = new Cesium.Viewer('scene', {
  baseLayer: false, baseLayerPicker: false, geocoder: false, navigationHelpButton: false,
  timeline: true, animation: false, sceneModePicker: false, homeButton: false,
  requestRenderMode: false
})
viewer.scene.globe.show = true
// 修改鼠标右键旋转
viewer.scene.screenSpaceCameraController.tiltEventTypes = [Cesium.CameraEventType.PINCH, Cesium.CameraEventType.RIGHT_DRAG];
// 修改鼠标中键为缩放
viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
if (previewImageryUrl) viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url: previewImageryUrl })))
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-09-08T03:00:00Z')
viewer.clock.shouldAnimate = false
viewer.timeline.zoomTo(
  Cesium.JulianDate.fromIso8601('2026-09-07T16:00:00Z'),
  Cesium.JulianDate.fromIso8601('2026-09-08T16:00:00Z'))
// Explicit bounded experiment, applied equally to both measurements. The default
// full-globe camera can span multiple frusta and must remain unsupported.
const singleFrustumSample = query.get('singleFrustum') === '1'
if (singleFrustumSample) viewer.camera.frustum.far = 50000
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#52654c')
// 校园地形是 3D Tiles；globe 没有地形服务、默认也没有影像，只是一张底色椭球。默认 SSE 2 在近地视角
// 要画 253 块瓦片（每块一条 draw），8 降到 49 块，scene.render CPU 约 −2.5 ms；三个视角的画面差异
// 只在建筑与地面交界处的个别像素（2026-10-23 实测）。加影像时可酌情调回。
viewer.scene.globe.maximumScreenSpaceError = 8
viewer.scene.renderError.addEventListener((scene, error) => { errors.push(error.message); status.textContent = error.message })
const requestedShadow = query.get('shadow')
// ?environment=off disables the volumetric environment pass (clouds + volumetric fog) so its
// GPU cost can be compared directly against the default. ?clouds=off keeps the atmosphere but
// drops the cloud raymarch. Both are diagnostic comparisons, not production defaults.
const environmentParam = query.get('environment')
const cloudsParam = query.get('clouds')
const environmentOverrides = {}
if (environmentParam === 'off') { environmentOverrides.environment = false; environmentOverrides.clouds = false; environmentOverrides.volumetricFog = false }
else if (environmentParam === 'on') environmentOverrides.environment = true
if (cloudsParam === 'off') environmentOverrides.clouds = false
const pipeline = createVisualPipeline({ Cesium, viewer,
  options: { environmentReflectionEnabled: true,
    environmentReflectionMap: '/assets/environment/98_ibl.ktx2',
    ...environmentOverrides,
    ...(['custom', 'native'].includes(requestedShadow) ? { shadowMode: requestedShadow } : {}) } })
const tiles = []
const models = []
const activeTilesets = modelMode === 'tiles' ? BUSINESS_TILESETS : BUSINESS_TILESETS.filter(asset => asset.name === 'SM_NH_Terr')
const cameraCenter = Cesium.Cartesian3.fromDegrees(glbManifest.origin.longitude, glbManifest.origin.latitude, glbManifest.origin.height)
const assetsReady = () => tiles.length === activeTilesets.length && tiles.every(tile => tile.tilesLoaded) &&
  (modelMode !== 'glb' || (models.length === glbManifest.models.length && models.every(model => model.ready)))
const contextTiles = []
let contextTilesReady = Promise.resolve()
let trees = null
let polygonTrees = null
let grass = null
let water = null
let sharedGlbTextures = modelMode === 'glb' ? new SharedGlbTextureCache(Cesium) : null
window.campus = { viewer, pipeline, tiles, models, modelMode, glbBase, cameraCenter, assetsReady, contextTiles, errors, base, trees, polygonTrees, grass, water, sharedGlbTextures,
  treeReady: null, polygonTreeReady: null, grassReady: null, waterReady: null, expectedTiles: activeTilesets.length, expectedModels: modelMode === 'glb' ? glbManifest.models.length : 0 }
// Legacy asset fixes belong to this example, not to the renderer.
const assetCompatibility = new CampusAssetCompatibility(Cesium, viewer.scene)
const updateAssetCompatibility = () => assetCompatibility.setEnabled(
  pipeline.enabled && !pipeline.destroyed && !pipeline.suspensions.size,
  pipeline.getOptions().environment
)
const removeAssetCompatibility = viewer.scene.preUpdate.addEventListener(updateAssetCompatibility)
updateAssetCompatibility()
window.addEventListener('pagehide', () => { removeAssetCompatibility(); assetCompatibility.destroy() }, { once: true })
window.addEventListener('pagehide', () => { traffic?.destroy(); sharedGlbTextures?.destroy(); water?.destroy(); grass?.destroy(); polygonTrees?.destroy(); trees?.destroy(); pipeline.destroy(); viewer.destroy() }, { once: true })

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
  reflection: { enabled: false, strength: 1 },
  governor: false,
  trees: { visible: true, source: treeSource === 'glb' ? (lightweightVegetation ? 'EZ-Tree 松树／松柏' : '原 GLB 四级 LOD') : 'ez-tree 程序化松树', state: treeEnabled ? '等待加载' : '未启用', instances: 0, batches: 0, lods: '0 / 0 / 0 / 0' },
  polygonTrees: { visible: true, state: polygonTreesEnabled ? '等待加载' : '未启用', instances: 0, batches: 0 },
  grass: { visible: true, state: grassEnabled ? '等待加载' : '未启用', polygons: 0, area: 0, instances: 0, draws: 0 },
  water: { visible: true, state: waterEnabled ? '等待加载' : '未启用', features: 0, heights: '' },
  environment: { on: false, high: false, playing: false, cloudCoverage: 0, cloudThickness: 1200 }
}
viewer.clock.onTick.addEventListener(clock => { ui.environment.playing = clock.shouldAnimate })
const aaNotes = {
  off: '关闭所有抗锯齿，用于对照。',
  fxaa: '单次颜色过滤，开销较低；平滑档会更柔和。',
  smaa: '三阶段边缘处理，适合屋檐、窗框；可叠加MSAA改善几何轮廓。',
  msaa: '主要平滑模型轮廓，不能单独解决纹理、SSR和阴影中的锯齿。',
  taa: 'Three.js r186 TRAA：运动重投影与亮度抗闪烁；空间质量选项不作用于TAA。'
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
  const reflection = pipeline.getEnvironmentReflectionDiagnostics().requested
  ui.reflection.enabled = reflection.enabled === true
  ui.reflection.strength = reflection.strength
  ui.governor = pipeline.getPerformanceDiagnostics().enabled === true
  ui.environment.on = options.environment === true
  ui.environment.high = options.environmentQuality === 'high'
  ui.environment.playing = viewer.clock.shouldAnimate
  const environment = pipeline.environmentRenderer.state
  ui.environment.cloudCoverage = options.cloudCoverage ?? environment.cloudCoverage
  ui.environment.cloudThickness = options.cloudThickness ?? (environment.cloudTop - environment.cloudBase)
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
// 用 setView 而非 lookAt：lookAt 会设置 lookAtTransform 让相机进入「绕目标点旋转」模式，
// 导致左键永远绕点转、无法平移。这里用经纬度+高度直接定位相机（悬空俯瞰），保持左键平移。
const look = (pitch, range) => {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      glbManifest.origin.longitude, glbManifest.origin.latitude, range),
    orientation: { heading: 0, pitch, roll: 0 }
  })
}
// 也挂到 window.campus 上：scripts/ 里的浏览器核查脚本直接调用它，不必去点 GUI 按钮。


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
environmentFolder.add(ui.environment, 'cloudCoverage', 0, 0.95, 0.01).name('云量').listen()
  .onChange(value => pipeline.setOptions({ cloudCoverage: value })).onFinishChange(() => syncUI())
environmentFolder.add(ui.environment, 'cloudThickness', 100, 6000, 50).name('云层厚度（米）').listen()
  .onChange(value => pipeline.setOptions({ cloudThickness: value })).onFinishChange(() => syncUI())
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
aaFolder.add(ui.aa, 'jitterSamples', [4, 8, 16, 32]).name('TAA抖动样本').listen().onChange(value => {
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

const reflectionFolder = gui.addFolder('Cube 环境反射')
reflectionFolder.add(ui.reflection, 'enabled').name('开启环境反射').listen().onChange(value => {
  pipeline.setEnvironmentReflections({ enabled: value })
  syncUI()
  dump(pipeline.getEnvironmentReflectionDiagnostics())
})
reflectionFolder.add(ui.reflection, 'strength', 0, 1, 0.05).name('镜面强度').listen()
  .onChange(value => pipeline.setEnvironmentReflections({ strength: Number(value) })).onFinishChange(() => syncUI())

const performanceFolder = gui.addFolder('性能')
performanceFolder.add(ui, 'governor').name('调速器（目标 30fps）').listen().onChange(value => {
  dump(pipeline.setPerformance({ enabled: value, targetFps: 30 }))
  syncUI()
})
performanceFolder.close()

const syncTreeUI = () => {
  if (!trees) return
  const diagnostics = trees.getDiagnostics()
  ui.trees.visible = diagnostics.visible
  ui.trees.state = diagnostics.state
  ui.trees.instances = diagnostics.instances
  ui.trees.batches = diagnostics.batches
  ui.trees.lods = diagnostics.source === 'procedural' ? '轻量程序化几何' : diagnostics.lodBatches.join(' / ')
}
async function loadTrees() {
  if (trees) return trees.readyPromise
  ui.trees.state = 'loading'
  trees = createFixedTreeCollection({
    Cesium, viewer, manifestUrl: treeManifestUrl || '/assets/vegetation/manifest.json',
    source: treeSource,
    clampToGround: false, heightOffset: 1.5
  })
  window.campus.trees = trees
  try {
    await trees.readyPromise
    syncTreeUI()
    return trees
  } catch (error) {
    trees.destroy(); trees = null; window.campus.trees = null
    ui.trees.state = 'error'
    throw error
  }
}
window.campus.loadTrees = loadTrees
const treeFolder = gui.addFolder('固定点位树木')
treeFolder.add(ui.trees, 'source').name('树种来源').disable()
action(treeFolder, '加载树木', () => {
  window.campus.treeReady = loadTrees().then(() => dump(trees.getDiagnostics())).catch(error => dump(`树木加载失败：${error.message}`))
})
treeFolder.add(ui.trees, 'visible').name('显示').listen().onChange(value => { trees?.setVisible(value); syncTreeUI() })
treeFolder.add(ui.trees, 'state').name('状态').listen().disable()
treeFolder.add(ui.trees, 'instances').name('实例').listen().disable()
treeFolder.add(ui.trees, 'batches').name('批次').listen().disable()
treeFolder.add(ui.trees, 'lods').name('几何细节').listen().disable()
action(treeFolder, '读取诊断', () => dump(trees ? trees.getDiagnostics() : '固定树木尚未加载'))
treeFolder.close()

const syncPolygonTreeUI = () => {
  if (!polygonTrees) return
  const diagnostics = polygonTrees.getDiagnostics()
  for (const key of ['visible', 'state', 'instances', 'batches']) ui.polygonTrees[key] = diagnostics[key]
}
async function loadPolygonTrees() {
  if (polygonTrees) return polygonTrees.readyPromise
  ui.polygonTrees.state = 'loading'
  // The manifest anchors each prototype's relative url, so it must live beside the
  // generated glb files: the polygon variant reuses the same prototypes.
  const manifestUrl = new URL('/assets/vegetation/ez-tree/polygon-manifest.json', location.href).href
  const data = Promise.all(['./DS_NH_plantpolygon.json', '/assets/vegetation/ez-tree/manifest.json'].map(async url => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`面内树木数据加载失败：${url} (HTTP ${response.status})`)
    return response.json()
  })).then(([source, template]) => buildPolygonTreeData(Cesium, source, template))
  polygonTrees = createFixedTreeCollection({
    Cesium, viewer, manifestUrl, source: 'glb',
    fetchJson: async url => (await data)[url === manifestUrl ? 'manifest' : 'points'],
    clampToGround: false, heightOffset: 1.5, cellSize: 480, show: ui.polygonTrees.visible
  })
  window.campus.polygonTrees = polygonTrees
  try {
    await polygonTrees.readyPromise
    syncPolygonTreeUI()
    return polygonTrees
  } catch (error) {
    polygonTrees.destroy(); polygonTrees = null; window.campus.polygonTrees = null
    ui.polygonTrees.state = 'error'
    throw error
  }
}
window.campus.loadPolygonTrees = loadPolygonTrees
const polygonTreeFolder = gui.addFolder('面内散布树木（松柏／松树／阔叶／银杏／樱花）')
action(polygonTreeFolder, '加载树木', () => {
  window.campus.polygonTreeReady = loadPolygonTrees().then(() => dump(polygonTrees.getDiagnostics())).catch(error => dump(error.message))
})
polygonTreeFolder.add(ui.polygonTrees, 'visible').name('显示').listen().onChange(value => polygonTrees?.setVisible(value))
polygonTreeFolder.add(ui.polygonTrees, 'state').name('状态').listen().disable()
polygonTreeFolder.add(ui.polygonTrees, 'instances').name('株数').listen().disable()
polygonTreeFolder.add(ui.polygonTrees, 'batches').name('批次').listen().disable()
polygonTreeFolder.close()

// const syncGrassUI = () => {
//   if (!grass) return
//   const diagnostics = grass.getDiagnostics()
//   ui.grass.visible = diagnostics.visible
//   ui.grass.state = diagnostics.state
//   ui.grass.polygons = diagnostics.polygons
//   ui.grass.area = diagnostics.areaHectares
//   ui.grass.instances = diagnostics.instances
//   ui.grass.draws = diagnostics.submittedDraws
// }
// async function loadGrass() {
//   if (grass) return grass.readyPromise
//   ui.grass.state = 'loading'
//   grass = createGrassCollection({
//     Cesium, viewer, polygonsUrl: grassPolygonsUrl,
//     profile: lightweightVegetation ? 'lightweight' : 'legacy',
//     height: lightweightVegetation ? 1.85 : 1.5, scale: lightweightVegetation ? 0.5 : 0.75,
//     objectsToExclude: [...models, ...contextTiles, trees?.primitive].filter(Boolean)
//   })
//   window.campus.grass = grass
//   try {
//     await grass.readyPromise
//     syncGrassUI()
//     return grass
//   } catch (error) {
//     grass.destroy(); grass = null; window.campus.grass = null
//     ui.grass.state = 'error'
//     throw error
//   }
// }
// window.campus.loadGrass = loadGrass
// const grassFolder = gui.addFolder('面内程序化草地')
// grassFolder.add(ui.grass, 'visible').name('显示').listen().onChange(value => { grass?.setVisible(value); syncGrassUI() })
// action(grassFolder, '加载草地', () => {
//   window.campus.grassReady = loadGrass().then(() => dump(grass.getDiagnostics())).catch(error => dump(`草地加载失败：${error.message}`))
// })
// grassFolder.add(ui.grass, 'state').name('状态').listen().disable()
// grassFolder.add(ui.grass, 'polygons').name('面数').listen().disable()
// grassFolder.add(ui.grass, 'area').name('面积(公顷)').listen().disable()
// grassFolder.add(ui.grass, 'instances').name('实例').listen().disable()
// grassFolder.add(ui.grass, 'draws').name('提交批次').listen().disable()
// action(grassFolder, '读取诊断', () => dump(grass ? grass.getDiagnostics() : '草地尚未加载'))
// grassFolder.close()

const syncWaterUI = () => {
  if (!water) return
  const diagnostics = water.getDiagnostics()
  ui.water.visible = diagnostics.visible
  ui.water.state = diagnostics.state
  ui.water.features = diagnostics.features
  ui.water.heights = diagnostics.minimumHeight === null ? ''
    : `${diagnostics.minimumHeight.toFixed(2)} / ${diagnostics.maximumHeight.toFixed(2)}`
}
async function loadWater() {
  if (water) return water.readyPromise
  ui.water.state = 'loading'
  water = createWaterSurfaceCollection({
    Cesium, viewer, dataUrl: waterPolygonsUrl
  })
  window.campus.water = water
  try {
    await water.readyPromise
    syncWaterUI()
    return water
  } catch (error) {
    water.destroy(); water = null; window.campus.water = null
    ui.water.state = 'error'
    throw error
  }
}
window.campus.loadWater = loadWater
const waterFolder = gui.addFolder('动态水面')
waterFolder.add(ui.water, 'visible').name('显示').listen().onChange(value => { water?.setVisible(value); syncWaterUI() })
action(waterFolder, '加载水面', () => {
  window.campus.waterReady = loadWater().then(() => dump(water.getDiagnostics())).catch(error => dump(`水面加载失败：${error.message}`))
})
waterFolder.add(ui.water, 'state').name('状态').listen().disable()
waterFolder.add(ui.water, 'features').name('水面数').listen().disable()
waterFolder.add(ui.water, 'heights').name('高程范围').listen().disable()
action(waterFolder, '读取诊断', () => dump(water ? water.getDiagnostics() : '水面尚未加载'))
waterFolder.close()

const trafficUI = { visible: true, playing: true, speed: 1, state: '未配置路线', vehicles: 0 }
const syncTrafficUI = () => {
  if (!traffic) return
  const diagnostics = traffic.getDiagnostics()
  Object.assign(trafficUI, { visible: diagnostics.visible, playing: diagnostics.playing,
    speed: diagnostics.speedMultiplier, state: diagnostics.state, vehicles: diagnostics.vehicles })
}
async function loadTraffic(manifestUrl = trafficManifestUrl) {
  if (traffic) return traffic.readyPromise
  if (trafficLoading) return trafficLoading
  if (!manifestUrl) throw new Error('请先提供车流路线与车型清单地址。')
  if (!campusAssetsLoaded) throw new Error('请等待校园地面与建筑加载完成。')
  trafficLoading = (async () => {
    trafficUI.state = '采样道路高程'
    const url = new URL(manifestUrl, document.baseURI).href
    const response = await fetch(url)
    if (!response.ok) throw new Error(`车流清单加载失败：HTTP ${response.status}`)
    const data = await response.json()
    await contextTilesReady
    const excluded = [...models, ...contextTiles, trees?.primitive, grass?.primitive, water?.primitive].filter(Boolean)
    const prepared = await prepareCampusTraffic(Cesium, viewer.scene, data, url, excluded,
      { isCancelled: () => viewer.isDestroyed() })
    window.campus.trafficPlacement = prepared.placement
    traffic = createTrafficSystem({ Cesium, viewer, pipeline, routes: prepared.routes,
      network: prepared.network, vehicles: prepared.vehicles, show: trafficUI.visible, playing: trafficUI.playing })
    window.campus.traffic = traffic
    await traffic.readyPromise
    traffic.setSpeed(trafficUI.speed)
    syncTrafficUI()
    return traffic
  })()
  try { return await trafficLoading }
  catch (error) {
    traffic?.destroy(); traffic = null; window.campus.traffic = null
    trafficUI.state = 'error'; throw error
  } finally { trafficLoading = null }
}
window.campus.loadTraffic = loadTraffic
window.campus.traffic = null
window.campus.trafficReady = null
if (trafficManifestUrl) {
  const trafficFolder = gui.addFolder('道路车流')
  trafficFolder.add(trafficUI, 'visible').name('显示车辆').listen().onChange(value => { traffic?.setVisible(value); syncTrafficUI() })
  trafficFolder.add(trafficUI, 'playing').name('播放').listen().onChange(value => { if (value) traffic?.play(); else traffic?.pause(); syncTrafficUI() })
  trafficFolder.add(trafficUI, 'speed', 0, 3, .25).name('速度倍率').listen().onChange(value => traffic?.setSpeed(value))
  trafficFolder.add(trafficUI, 'state').name('状态').listen().disable()
  trafficFolder.add(trafficUI, 'vehicles').name('车辆数').listen().disable()
  action(trafficFolder, '读取诊断', () => dump(traffic ? traffic.getDiagnostics() : '车流尚未加载'))
  action(trafficFolder, '道路高程', () => dump(window.campus.trafficPlacement || '尚未采样'))
  action(trafficFolder, '车流近景', () => lookAtTraffic(125))
  action(trafficFolder, '车流全景', () => lookAtTraffic(1700, true))
}
function lookAtTraffic(range = 125, overview = false) {
  const car = traffic?.vehicles.find(vehicle => vehicle.state === 'driving' && vehicle.model?.ready)
  if (!car) return
  const target = overview ? cameraCenter : car.position
  viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(-.3, overview ? -.75 : -1.05, range))
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
  viewer.scene.requestRender()
}
window.campus.lookAtTraffic = lookAtTraffic

const diagnosticsFolder = gui.addFolder('诊断与采样')
action(diagnosticsFolder, '采样 60 秒', () => measure())
action(diagnosticsFolder, '读取实际状态', () => { syncUI(); dump(pipeline.getRenderDiagnostics()) })
action(diagnosticsFolder, '几何通道状态', () => dump(pipeline.getGeometryDiagnostics()))
action(diagnosticsFolder, '材质通道状态', () => dump(pipeline.getMaterialDiagnostics()))
action(diagnosticsFolder, '深度金字塔状态', () => dump(pipeline.getDepthPyramidDiagnostics()))
action(diagnosticsFolder, 'AO 状态', () => dump(pipeline.getScreenSpaceAODiagnostics()))
action(diagnosticsFolder, '环境反射状态', () => dump(pipeline.getEnvironmentReflectionDiagnostics()))
action(diagnosticsFolder, 'TAA 状态', () => dump(pipeline.getTaaDiagnostics()))
action(diagnosticsFolder, '调速器状态', () => dump(pipeline.getPerformanceDiagnostics()))
action(diagnosticsFolder, '环境状态', () => dump(pipeline.environmentRenderer ? pipeline.environmentRenderer.getDiagnostics() : '环境未启用'))
diagnosticsFolder.close()
if (query.get('vegetationCheck') === '1') {
  import('./vegetation-check.js').then(({ installVegetationCheck }) => installVegetationCheck(window.campus, gui, dump))
}
// 面板默认展开「管线 / 环境 / 抗锯齿 / AO / Cube 环境反射」五组，其余折叠；
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
stats.dom.style.bottom = '40px'
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
  syncTreeUI()
  syncPolygonTreeUI()
  const d = pipeline.getRenderDiagnostics().antiAliasing
  const actual = d.allocatedAttachments && d.allocatedAttachments.scene
  aaActual.textContent = `后处理：${d.postProcess.effective === 'off' ? '关闭' : d.postProcess.effective.toUpperCase()} · MSAA ${actual && actual.colorRenderbufferSamples || 1}× · ${viewer.canvas.width}×${viewer.canvas.height}`
})

// Each asset group loads inside its own guarded block, so one unavailable source (an
// unreachable GLB host, a missing model file) cannot stop the others. Previously the building
// GLB load ran inside the single outer try, so its failure skipped the procedural vegetation,
// water and traffic along with it — even though those share no assets with the buildings.
const reportFailure = (label, error) => {
  errors.push(`${label}加载失败：${error.message}`)
  return `${label}加载失败：${error.message}`
}

try {
  if (previewWhiteModelUrl) {
    contextTilesReady = Cesium.Cesium3DTileset.fromUrl(previewWhiteModelUrl, { maximumScreenSpaceError: 32 })
      .then(whiteModel => {
        if (viewer.isDestroyed()) { whiteModel.destroy(); return }
        viewer.scene.primitives.add(whiteModel); contextTiles.push(whiteModel)
      })
      .catch(error => { status.textContent = reportFailure('周边白模', error) })
  }
  look(-0.65, 1800)
  for (const asset of activeTilesets) {
    try {
      const tile = await Cesium.Cesium3DTileset.fromUrl(`${base}/${asset.url}`, {
        maximumScreenSpaceError: 32, shadows: asset.shadows ?? Cesium.ShadowMode.ENABLED
      })
      const cartographic = Cesium.Cartographic.fromCartesian(tile.boundingSphere.center)
      const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0)
      const offset = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, asset.height)
      tile.modelMatrix = Cesium.Matrix4.fromTranslation(
        Cesium.Cartesian3.subtract(offset, surface, new Cesium.Cartesian3())
      )
      tile.name = asset.name
      viewer.scene.primitives.add(tile)
      tiles.push(tile)
    } catch (error) {
      status.textContent = reportFailure(`地形 ${asset.name || asset.url}`, error)
    }
  }
  pipeline.setCampusOrigin(cameraCenter)
} catch (error) { errors.push(error.message); status.textContent = `地形加载失败：${error.message}` }

// Building models. Isolated from everything below: a GLB host that is down must not prevent the
// procedural vegetation from being generated, since those are independent data sources.
let glbFailure = null
if (modelMode === 'glb') {
  try {
    // Fail once, with an actionable message, instead of once per missing GLB.
    const resolvedGlbBase = await assertCampusGlbBase(
      glbBaseCandidates.map(candidate => `${candidate.replace(/\/$/, '')}/${glbManifest.models[0].file}`))
    glbBase = resolvedGlbBase.replace(/\/[^/]*$/, '')
    window.campus.glbBase = glbBase
    sharedGlbTextures = await loadCampusGlbs(Cesium, viewer, glbManifest, glbBase, models, (done, total) => {
      status.textContent = `建筑 GLB 加载中 ${done}/${total}`
    }, sharedGlbTextures)
    window.campus.sharedGlbTextures = sharedGlbTextures
    const reflectionFiles = new Set(glbManifest.models.filter(asset => asset.environmentReflection).map(asset => asset.file))
    for (const model of models) {
      if (reflectionFiles.has(model.id?.file)) pipeline.setEnvironmentReflectionIncluded(model, true)
    }
  } catch (error) {
    glbFailure = error
    status.textContent = reportFailure('建筑模型', error)
  }
}

// Viewer-level setup. `look` and the status line must not be able to abort the asset loads below,
// so this block is separate from them.
try {
  look(-0.65, 1800)
  status.textContent = glbFailure
    ? `建筑模型不可用（${glbFailure.message.split('。')[0]}）`
    : modelMode === 'glb'
      ? `已加载建筑 GLB ${models.length}/${glbManifest.models.length}，地形 ${tiles.length} 组；原生/增强使用同一时间、相机与资产。`
      : `已加载原始 3D Tiles ${tiles.length}/${BUSINESS_TILESETS.length}；可与默认 GLB 模式对照。`
} catch (error) { errors.push(error.message); status.textContent = `初始化失败：${error.message}` }

// Procedural vegetation. Independent of the building models above: it has its own manifest and
// generates geometry at runtime, so an unreachable GLB host must not suppress it.
if (treeEnabled) {
  window.campus.treeReady = loadTrees()
  try {
    await window.campus.treeReady
    status.textContent += ` 已加载固定树木 ${trees.getDiagnostics().instances} 株。`
  } catch (error) {
    status.textContent = reportFailure('固定树木', error)
  }
}
if (polygonTreesEnabled) {
  window.campus.polygonTreeReady = loadPolygonTrees()
  try {
    await window.campus.polygonTreeReady
    status.textContent += ` 已生成面内程序化树木 ${polygonTrees.getDiagnostics().instances} 株（35 株/公顷）。`
  } catch (error) {
    status.textContent = reportFailure('面内程序化树木', error)
  }
}
// if (grassEnabled) {
//   window.campus.grassReady = loadGrass()
//   try {
//     await window.campus.grassReady
//     const diagnostics = grass.getDiagnostics()
//     status.textContent += ` 已生成面内草地 ${diagnostics.instances} 簇 / ${diagnostics.polygons} 个面（${diagnostics.areaHectares} 公顷）。`
//   } catch (error) {
//     status.textContent = reportFailure('草地', error)
//   }
// }
if (waterEnabled) {
  window.campus.waterReady = loadWater()
  try {
    await window.campus.waterReady
    const diagnostics = water.getDiagnostics()
    status.textContent += ` 已加载动态水面 ${diagnostics.features} 处。`
  } catch (error) {
    status.textContent = reportFailure('水面', error)
  }
}
campusAssetsLoaded = true
if (trafficManifestUrl) {
  status.textContent += ' 正在准备道路车流…'
  window.campus.trafficReady = loadTraffic()
  try {
    await window.campus.trafficReady
    status.textContent += ` 已加载车流 ${traffic.getDiagnostics().vehicles} 辆。`
    lookAtTraffic(350)
  } catch (error) {
    status.textContent = reportFailure('车流', error)
  }
}

async function measure() {
  if (window.campus.measuring) return
  if (document.hidden || !document.hasFocus()) {
    status.textContent = '请将测试窗口置于前台后再开始采样，后台节流数据不能用于性能验收。'
    return
  }
  if (!assetsReady()) {
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
      if (startedEnabled && startedOptions.environmentReflectionEnabled && !pipeline.getEnvironmentReflectionDiagnostics().valid) reflectionValid = false
      if (startedEnabled && startedOptions.environment && (!pipeline.environmentRenderer || !pipeline.environmentRenderer.getDiagnostics().hdr.valid)) environmentValid = false
      if (startedEnabled && startedOptions.antialiasing === 'smaa' && (!pipeline.smaa || pipeline.smaa.getDiagnostics().effective !== 'smaa')) aaValid = false
      if (startedEnabled && startedOptions.antialiasing === 'taa' && (!pipeline.taa || !pipeline.getTaaDiagnostics().valid)) taaValid = false
      if (!assetsReady()) tilesLoadedThroughoutSample = false
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
    valid: interruptions.length === 0 && unchanged && bufferUnchanged && geometryValid && materialValid && pyramidValid && aoValid && reflectionValid && environmentValid && aaValid && taaValid && tilesLoadedThroughoutSample && !shadowError && errors.length === 0 && samples.length > 90,
    interruptions, configurationUnchanged: unchanged, changedFields: guard.changedFields, bufferUnchanged,
    startedAt, endedAt: Date.now(), rawFrameIntervals,
    options: startedOptions,
    imageQuality: pipeline.getRenderDiagnostics(), aaValidThroughoutSample: aaValid,
    taaValidThroughoutSample: taaValid,
    geometry: { ...pipeline.getGeometryDiagnostics(), validThroughoutSample: geometryValid }, camera: startedCamera,
    materials: { ...pipeline.getMaterialDiagnostics(), validThroughoutSample: materialValid },
    depthPyramid: { ...pipeline.getDepthPyramidDiagnostics(), validThroughoutSample: pyramidValid },
    screenSpaceAO: { ...pipeline.getScreenSpaceAODiagnostics(), validThroughoutSample: aoValid },
    environmentReflections: { ...pipeline.getEnvironmentReflectionDiagnostics(), validThroughoutSample: reflectionValid },
    singleFrustumSample, tilesLoadedThroughoutSample,
    time: startedTime, environment: pipeline.environmentRenderer ? pipeline.environmentRenderer.getDiagnostics() : null, environmentValidThroughoutSample: environmentValid,
    drawingBuffer: [viewer.canvas.width, viewer.canvas.height], frames: samples.length,
    shadowCommands: startedOptions.shadowMode === 'custom' ? [pipeline.customShadow.stats.casters]
      : viewer.shadowMap.outOfView ? [] : viewer.shadowMap.passes.map(pass => pass.commandList.length),
    customStats: startedOptions.shadowMode === 'custom' ? { ...pipeline.customShadow.stats,
      updates: pipeline.customShadow.stats.updates - startingUpdates,
      cacheHits: pipeline.customShadow.stats.cacheHits - startingHits } : null,
    p50: samples[Math.floor(samples.length * 0.5)], p95: samples[Math.floor(samples.length * 0.95)],
    max: samples[samples.length - 1], tilesLoaded: assetsReady(), modelMode, modelCount: models.length, errors: [...errors] }
  window.campus.lastMeasurement = result
  window.campus.measuring = false
  viewer.scene.screenSpaceCameraController.enableInputs = cameraInputs
  setControlsEnabled(true)
  status.textContent = JSON.stringify(result, null, 2)
}
