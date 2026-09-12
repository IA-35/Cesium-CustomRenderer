// Cesium 1.143's constructor supports one or four cascades. Large campus GLBs
// intersect all four cascades, so one fitted pass avoids drawing them four times.
export default function createCampusShadowMap(Cesium, viewer, options) {
  return new Cesium.ShadowMap({
    context: viewer.scene.context,
    // Scene updates this camera from SunLight/DirectionalLight every frame.
    lightCamera: viewer.shadowMap._lightCamera,
    enabled: viewer.shadows,
    cascadesEnabled: true,
    numberOfCascades: options.shadowCascades,
    size: options.shadowSize,
    maximumDistance: options.shadowDistance,
    softShadows: true
  })
}
