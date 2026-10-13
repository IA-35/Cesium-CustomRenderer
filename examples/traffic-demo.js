const query = new URLSearchParams(location.search)
const networkMode = query.get('mode') !== 'loop'
const schoolMode = networkMode && query.get('mode') !== 'sample'
if (!schoolMode) {
  document.querySelector('h1').textContent = '道路上的日常'
  document.querySelector('.description').textContent = '示例路网 · 跟车与岔路让行'
}
if (!networkMode) document.querySelector('.description').innerHTML = '双向循环路线 · 自动跟车<br>车辆保持间距，快车遇慢车减速。'
let CCR
if (query.get('sdk') === 'umd') { await import('../build/0.1.0/CCR.min.js'); CCR = globalThis.CCR }
else { CCR = await import('../src/index.js'); window.CCR = CCR }
const C = Cesium, status = document.querySelector('#status'), errors = []
const viewer = new C.Viewer('scene', { baseLayer: false, baseLayerPicker: false, geocoder: false,
  navigationHelpButton: false, timeline: false, animation: false, sceneModePicker: false, homeButton: false,
  requestRenderMode: true })
viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-10-09T03:00:00Z')
viewer.clock.shouldAnimate = false
viewer.scene.globe.show = false
viewer.scene.skyBox.show = false
viewer.scene.backgroundColor = C.Color.fromCssColorString('#d5dfd5')
viewer.scene.renderError.addEventListener((scene, error) => { errors.push(error.message); status.textContent = error.message })
const pipeline = CCR.createVisualPipeline({ Cesium: C, viewer, options: { antialiasing: 'smaa',
  clouds: false, fog: false, environment: false, shadowSize: 2048, shadowDistance: 500 } })
let traffic, ground
let center = C.Cartesian3.fromDegrees(123.42, 41.77, 0)
let overviewRange = networkMode ? 295 : 205
function resetView() { viewer.camera.lookAt(center, new C.HeadingPitchRange(-.35, -.9, overviewRange)) }
window.trafficDemo = { viewer, pipeline, errors, get traffic() { return traffic }, get center() { return center }, resetView }
window.addEventListener('pagehide', () => { traffic?.destroy(); pipeline.destroy(); viewer.destroy() }, { once: true })
try {
  const manifestUrl = new URL(schoolMode ? './campus-traffic/traffic.json' : `./traffic-assets/${networkMode ? 'network' : 'traffic'}.json`, location.href).href
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error(`车流清单加载失败：HTTP ${response.status}`)
  const manifest = await response.json()
  if (schoolMode) {
    center = C.Cartesian3.fromDegrees(manifest.origin.longitude, manifest.origin.latitude, manifest.origin.height)
    overviewRange = manifest.preview.range
    document.querySelector('h1').textContent = manifest.preview.title
    document.querySelector('.description').textContent = manifest.preview.note
  }
  const groundUrl = schoolMode ? new URL(manifest.preview.groundUrl, manifestUrl).href
    : new URL(`./traffic-assets/${networkMode ? 'network-ground' : 'ground'}.glb`, location.href).href
  ground = await C.Model.fromGltfAsync({ url: groundUrl,
    modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center), shadows: C.ShadowMode.RECEIVE_ONLY })
  viewer.scene.primitives.add(ground)
  resetView()
  traffic = CCR.createTrafficSystem({ Cesium: C, viewer, pipeline, manifestUrl })
  await traffic.readyPromise
  document.querySelector('#count').textContent = traffic.getDiagnostics().vehicles
  for (const control of document.querySelectorAll('button, input')) control.disabled = false
  status.textContent = networkMode ? '车辆按路网行驶，岔路让行，尽头离场后在其他入口再生。' : '车辆跟车循环行驶，太阳时间保持不变。'
} catch (error) { errors.push(error.message); status.textContent = `加载失败：${error.message}` }
document.querySelector('#play').addEventListener('click', event => {
  if (traffic.playing) traffic.pause(); else traffic.play()
  event.target.textContent = traffic.playing ? '暂停车流' : '继续行驶'
  status.textContent = traffic.playing ? '车辆正在行驶，太阳时间保持不变。' : '车流已暂停。'
})
document.querySelector('#speed').addEventListener('input', event => {
  const value = Number(event.target.value); traffic.setSpeed(value)
  document.querySelector('#speedValue').textContent = `${value.toFixed(2).replace(/0$/, '')}×`
})
document.querySelector('#visible').addEventListener('change', event => traffic.setVisible(event.target.checked))
document.querySelector('#enhanced').addEventListener('change', event => pipeline.setEnabled(event.target.checked))
document.querySelector('#reset').addEventListener('click', resetView)
document.querySelector('#closeup').addEventListener('click', () => {
  const car = traffic?.vehicles.find(vehicle => vehicle.state === 'driving' && vehicle.model?.ready)
  if (car) viewer.camera.lookAt(car.position, new C.HeadingPitchRange(-.35, -.8, 130))
})
let hudFrame = 0
viewer.scene.postRender.addEventListener(() => {
  if (!traffic || ++hudFrame % 10) return
  const diagnostics = traffic.getDiagnostics()
  document.querySelector('#count').textContent = diagnostics.activeVehicles
  document.querySelector('#waiting').textContent = traffic.vehicles.filter(v => v.state === 'waiting' || v.state === 'spawning').length
  document.querySelector('#departed').textContent = diagnostics.despawned ?? 0
})
