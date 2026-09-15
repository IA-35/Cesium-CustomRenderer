import * as CCR from '/src/index.js'
import { applyWhiteTileMaterial } from './white-tiles-material.js'

const C = Cesium
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2ZWNhNzBjNC01YzIwLTQ2MjctYTU1Ni1lZjRmYTRmYjAwZjEiLCJpZCI6MTExMDMwLCJpYXQiOjE2NjU2NjA3MDV9.AKgo59lBj-9zPGJDayglAtaqoi-8nqOeqnFgneuU0fA';

const viewer = new C.Viewer('scene', {
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
  infoBox: false, sceneModePicker: false, navigationHelpButton: false, homeButton: false, shouldAnimate: false,
  contextOptions: { webgl: { preserveDrawingBuffer: true } }
})
viewer.scene.globe.depthTestAgainstTerrain = true;
const errors = [], status = document.querySelector('#status')
viewer.scene.renderError.addEventListener((scene, error) => { errors.push(error.message); status.textContent = error.message })
viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T02:00:00Z')
viewer.scene.globe.baseColor = C.Color.fromCssColorString('#afb6bc')
const origin = C.Cartesian3.fromDegrees(116.38, 39.9, 5), frame = C.Transforms.eastNorthUpToFixedFrame(origin)
const model = await C.Model.fromGltfAsync({ url: '/assets/white-city/city-white.glb', modelMatrix: C.Matrix4.multiplyByUniformScale(frame, 10, new C.Matrix4()) })
viewer.scene.primitives.add(model)
// 加载白膜
async function loadLocalTileset() {
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      '/assets/井冈山建筑物_tiles/tileset.json', { shadows: C.ShadowMode.ENABLED }
    );

    tileset.tileLoad.addEventListener(applyWhiteTileMaterial);
    tileset.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(1, 1);
    viewer.scene.primitives.add(tileset);
    pipeline.setCampusOrigin(tileset.boundingSphere.center);
    // CCR owns the shadow map; the native shadow pass stays disabled.
    window.whiteCity.tileset = tileset;
    await viewer.zoomTo(tileset);

    console.log('3D Tiles 加载完成');
  } catch (error) {
    console.error('3D Tiles 加载失败:', error);
  }
}

const pipeline = CCR.createVisualPipeline({
  Cesium: C, viewer, options: {
    environment: true, environmentAnimation: false, cloudGeometry: 'shell',
    cloudCoverage: .28, fog: false, shadows: true, shadowMode: 'custom', antialiasing: 'smaa', exposure: 1.5,
    contrast: 1, brightness: 1, saturation: 1, skyLightIntensity: 3.2, sunIntensity: 2.2
  }
})
pipeline.setCampusOrigin(origin)
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao', radius: 5, strength: .6 })
pipeline.setHdrBloom({ enabled: true, strength: .08, threshold: 1.5, knee: .5, levels: 5 })
pipeline.setScreenSpaceReflections({ enabled: true, distance: 1500, thickness: 1, strength: 1 })
const view = (heading, pitch, range) => { viewer.camera.lookAt(origin, new C.HeadingPitchRange(heading, pitch, range)); viewer.camera.lookAtTransform(C.Matrix4.IDENTITY) }
view(3.7, -.18, 550)
const on = (id, fn) => document.getElementById(id).addEventListener('input', event => fn(event.target))
on('ssr', t => pipeline.setScreenSpaceReflections({ enabled: t.checked }))
on('bloom', t => pipeline.setHdrBloom({ enabled: t.checked }))
on('exposure', t => pipeline.setColorGrading({ exposure: Number(t.value) }))
on('strength', t => pipeline.setHdrBloom({ strength: Number(t.value) }))
document.querySelector('#street').onclick = () => view(.6, -.18, 350)
document.querySelector('#overview').onclick = () => view(.6, -.6, 1100)
status.textContent = '拖动镜头查看建筑表面反射；SSR 未命中时保留环境反射。'
window.CCR = CCR; window.whiteCity = { viewer, pipeline, model, origin, frame, errors, view }
loadLocalTileset()
