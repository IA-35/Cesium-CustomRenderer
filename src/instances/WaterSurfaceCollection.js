const fetchJson = async url => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Water resource request failed (${response.status}): ${url}`)
  return response.json()
}

const isClosedRing = ring => {
  if (!Array.isArray(ring) || ring.length < 4) return false
  const first = ring[0]
  const last = ring.at(-1)
  return first[0] === last[0] && first[1] === last[1]
}

function ringCentroid(ring) {
  const points = isClosedRing(ring) ? ring.slice(0, -1) : ring
  let twiceArea = 0
  let longitude = 0
  let latitude = 0
  for (let index = 0; index < points.length; index++) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const cross = current[0] * next[1] - next[0] * current[1]
    twiceArea += cross
    longitude += (current[0] + next[0]) * cross
    latitude += (current[1] + next[1]) * cross
  }
  if (Math.abs(twiceArea) < 1e-12) {
    return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0])
  }
  return [longitude / (3 * twiceArea), latitude / (3 * twiceArea)]
}

export class WaterSurfaceCollection {
  constructor(options) {
    if (!options?.Cesium || !options?.viewer?.scene || !options.dataUrl) {
      throw new Error('WaterSurfaceCollection requires Cesium, viewer and dataUrl')
    }
    this.C = options.Cesium
    this.viewer = options.viewer
    this.scene = options.viewer.scene
    this.dataUrl = new URL(options.dataUrl, typeof document !== 'undefined' ? document.baseURI : undefined).href
    this.fetchJson = options.fetchJson || fetchJson
    this.visible = options.show !== false
    this.destroyed = false
    this.state = 'loading'
    this.error = null
    this.primitive = null
    this._featureCount = 0
    this._heights = []
    this._centers = []
    this.readyPromise = this._load(options)
  }

  _validate(data) {
    if (data?.schemaVersion !== 1 || data?.targetCrs !== 'EPSG:4326' || !Array.isArray(data.features)) {
      throw new Error('Invalid prepared water polygon asset')
    }
    for (const feature of data.features) {
      if (!feature?.id || feature.geometry?.type !== 'Polygon' || !Array.isArray(feature.geometry.coordinates)) {
        throw new Error('Invalid water feature')
      }
      if (!Number.isFinite(feature.properties?.height)) throw new Error(`Water feature ${feature.id} requires a fixed height`)
      for (const ring of feature.geometry.coordinates) {
        if (!isClosedRing(ring) || !ring.every(point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite))) {
          throw new Error(`Invalid water ring: ${feature.id}`)
        }
      }
    }
    return data.features
  }

  _hierarchy(rings, height) {
    const C = this.C
    const positions = ring => {
      const open = isClosedRing(ring) ? ring.slice(0, -1) : ring
      return C.Cartesian3.fromDegreesArrayHeights(open.flatMap(point => [point[0], point[1], height]))
    }
    return new C.PolygonHierarchy(positions(rings[0]), rings.slice(1).map(ring => new C.PolygonHierarchy(positions(ring))))
  }

  _createAppearance(options) {
    const C = this.C
    const material = C.Material.fromType('Water', {
      baseWaterColor: options.baseWaterColor || new C.Color(0.02, 0.16, 0.22, 0.72),
      blendColor: options.blendColor || new C.Color(0.04, 0.28, 0.32, 0.58),
      normalMap: options.normalMap || C.buildModuleUrl('Assets/Textures/waterNormalsSmall.jpg'),
      frequency: options.frequency ?? 120,
      animationSpeed: options.animationSpeed ?? 0.018,
      amplitude: options.amplitude ?? 3,
      specularIntensity: options.specularIntensity ?? 0.8,
      fadeFactor: options.fadeFactor ?? 1,
    })
    return new C.MaterialAppearance({
      materialSupport: C.MaterialAppearance.MaterialSupport.ALL,
      material,
      translucent: true,
      faceForward: true,
      closed: false,
    })
  }

  async _load(options) {
    try {
      const features = this._validate(await this.fetchJson(this.dataUrl))
      if (this.destroyed) throw new Error('Water collection destroyed while loading')
      const C = this.C
      const geometryInstances = features.map(feature => {
        const center = ringCentroid(feature.geometry.coordinates[0])
        const height = feature.properties.height
        this._centers.push(center)
        this._heights.push(height)
        return new C.GeometryInstance({
          id: feature.id,
          geometry: new C.PolygonGeometry({
            polygonHierarchy: this._hierarchy(feature.geometry.coordinates, height),
            height,
            perPositionHeight: true,
            vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
          }),
        })
      })
      this._featureCount = features.length
      this.primitive = this.scene.primitives.add(new C.Primitive({
        geometryInstances,
        appearance: this._createAppearance(options),
        asynchronous: true,
        show: this.visible,
      }))
      if (this.destroyed) throw new Error('Water collection destroyed while loading')
      this.state = 'ready'
      this.scene.requestRender()
      return this
    } catch (error) {
      if (!this.destroyed) {
        this.state = 'error'
        this.error = error.message
        this._releasePrimitive()
      }
      throw error
    }
  }

  setVisible(value) {
    if (this.destroyed) return
    this.visible = value === true
    if (this.primitive) this.primitive.show = this.visible
    this.scene.requestRender()
  }

  getCenter() {
    if (!this._centers.length) return null
    const center = this._centers.reduce((sum, point) => [sum[0] + point[0] / this._centers.length, sum[1] + point[1] / this._centers.length], [0, 0])
    const height = this._heights.reduce((sum, value) => sum + value / this._heights.length, 0)
    return this.C.Cartesian3.fromDegrees(center[0], center[1], height)
  }

  getDiagnostics() {
    return {
      backend: 'cesium-water-material',
      state: this.state,
      visible: this.visible,
      features: this._featureCount,
      heightMode: 'per-feature-fixed',
      minimumHeight: this._heights.length ? Math.min(...this._heights) : null,
      maximumHeight: this._heights.length ? Math.max(...this._heights) : null,
      dynamic: true,
      error: this.error,
    }
  }

  _releasePrimitive() {
    if (!this.primitive) return
    this.scene.primitives.remove(this.primitive)
    this.primitive = null
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.state = 'destroyed'
    this._releasePrimitive()
    this.scene.requestRender()
  }
}

export const createWaterSurfaceCollection = options => new WaterSurfaceCollection(options)
export default WaterSurfaceCollection
