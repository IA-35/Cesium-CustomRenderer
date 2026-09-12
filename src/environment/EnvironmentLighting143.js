const alive = object => object && !(typeof object.isDestroyed === 'function' && object.isDestroyed())
const equal = (a, b) => a === b || (a && b && (
  typeof a.x === 'number' && a.x === b.x && a.y === b.y && a.z === b.z ||
  typeof a.red === 'number' && a.red === b.red && a.green === b.green && a.blue === b.blue && a.alpha === b.alpha
))

// Each property keeps its original value and relinquishes ownership if another
// tool replaces it. Cesium-owned IBL and environment manager objects stay intact.
function write(records, object, key, value) {
  if (!object) return false
  let record = records.find(item => item.object === object && item.key === key)
  if (!record) {
    record = { object, key, before: object[key], applied: object[key], owned: true }
    records.push(record)
  }
  if (!record.owned || object[key] !== record.applied) {
    record.owned = false
    return false
  }
  if (equal(object[key], value)) return false
  object[key] = value
  record.applied = object[key]
  return true
}

function restore(records) {
  let changed = false
  for (const record of records.slice().reverse()) {
    const { object, key, before, applied, owned } = record
    if (alive(object) && owned && object[key] === applied && object[key] !== before) {
      object[key] = before
      changed = true
    }
  }
  records.length = 0
  return changed
}

export default class EnvironmentLighting143 {
  constructor(C, scene) {
    this.C = C
    this.scene = scene
    this.enabled = false
    this.destroyed = false
    this.changes = []
    this.managers = new Map()
    this.sun = new C.SunLight()
    this.settings = { skyIntensity: 2.8, sunIntensity: 2, rayleighScale: 1,
      mieScale: 1, atmosphereIntensity: 10, skyAtmosphereIntensity: 20, daylight: 1 }
    this.supported = !!(scene.context && C.DynamicEnvironmentMapManager &&
      C.DynamicEnvironmentMapManager.isDynamicUpdateSupported(scene))
  }

  setEnabled(enabled) {
    if (this.destroyed || this.enabled === (enabled === true)) return
    this.enabled = enabled === true
    if (this.enabled) this.apply(this.settings)
    else this.restore()
  }

  restore() {
    if (alive(this.scene)) {
      const atmosphereChanged = restore(this.changes)
      for (const [manager, record] of this.managers) {
        if (!alive(record.primitive) || !alive(manager)) continue
        const changed = restore(record.changes)
        if (changed || atmosphereChanged) manager.position = undefined
      }
    }
    this.changes.length = 0
    this.managers.clear()
  }

  apply(settings) {
    if (this.destroyed) return
    this.settings = { ...this.settings, ...settings }
    if (!this.enabled || !alive(this.scene)) return
    const C = this.C, scene = this.scene, o = this.settings
    write(this.changes, scene, 'light', this.sun)
    write(this.changes, this.sun, 'intensity', o.sunIntensity)
    if (o.sunColor && C.Color) write(this.changes, this.sun, 'color', C.Color.clone(o.sunColor))
    write(this.changes, scene.globe, 'enableLighting', true)
    write(this.changes, scene.globe, 'dynamicAtmosphereLighting', true)
    write(this.changes, scene.globe, 'dynamicAtmosphereLightingFromSun', true)
    let atmosphereChanged = false
    const atmosphericWrite = (object, key, value) => {
      atmosphereChanged = write(this.changes, object, key, value) || atmosphereChanged
    }
    if (scene.atmosphere && C.DynamicAtmosphereLightingType) {
      atmosphericWrite(scene.atmosphere, 'dynamicLighting', C.DynamicAtmosphereLightingType.SUNLIGHT)
      atmosphericWrite(scene.atmosphere, 'lightIntensity', o.atmosphereIntensity)
    }
    if (C.Cartesian3) {
      const rayleigh = new C.Cartesian3(5.5e-6 * o.rayleighScale, 13e-6 * o.rayleighScale, 28.4e-6 * o.rayleighScale)
      const mie = new C.Cartesian3(21e-6 * o.mieScale, 21e-6 * o.mieScale, 21e-6 * o.mieScale)
      atmosphericWrite(scene.atmosphere, 'rayleighCoefficient', rayleigh)
      atmosphericWrite(scene.atmosphere, 'mieCoefficient', mie)
      write(this.changes, scene.skyAtmosphere, 'atmosphereRayleighCoefficient', C.Cartesian3.clone(rayleigh))
      write(this.changes, scene.skyAtmosphere, 'atmosphereMieCoefficient', C.Cartesian3.clone(mie))
    }
    write(this.changes, scene.skyAtmosphere, 'atmosphereLightIntensity', o.skyAtmosphereIntensity)
    write(this.changes, scene.skyAtmosphere, 'perFragmentAtmosphere', true)
    if (scene.skyBox) {
      const original = this.changes.find(item => item.object === scene.skyBox && item.key === 'show')
      write(this.changes, scene.skyBox, 'show', (original ? original.before : scene.skyBox.show) && o.daylight < 0.95)
    }
    const seen = new Set()
    const visit = primitive => {
      if (!alive(primitive)) return
      if ((C.Cesium3DTileset && primitive instanceof C.Cesium3DTileset) ||
          (C.Model && primitive instanceof C.Model)) {
        const manager = primitive.environmentMapManager
        if (!this.supported || !alive(manager) || manager.enabled === false) return
        seen.add(manager)
        let record = this.managers.get(manager)
        if (!record) {
          const ibl = primitive.imageBasedLighting
          const factor = ibl && ibl.imageBasedLightingFactor
          // These legacy exports use base-color textures and a blanket 0.45
          // roughness for grass, paving and facades. Adding the sky's specular
          // lobe turns those diffuse surfaces pale at grazing view angles.
          // Limit compatibility to the verified assets and default IBL factors.
          const diffuseOnly = !primitive.customShader && factor && factor.x === 1 && factor.y === 1 &&
            /\/SM_NH_(?:Terr|Building)\/tileset\.json(?:[?#]|$)/i.test(primitive.resource && primitive.resource.url || '')
          record = { primitive, changes: [], diffuseOnly }
          this.managers.set(manager, record)
        }
        if (record.diffuseOnly) {
          write(record.changes, primitive.imageBasedLighting, 'imageBasedLightingFactor', new C.Cartesian2(1, 0))
        }
        let changed = write(record.changes, manager, 'atmosphereScatteringIntensity', o.skyIntensity)
        changed = write(record.changes, manager, 'maximumSecondsDifference', 60) || changed
        // Public position accepts undefined. The owner refills its real bounding
        // sphere center before update; the setter invalidates the environment.
        // Do this only on changes, since repeated invalidation cancels GPU work.
        if (changed || atmosphereChanged) manager.position = undefined
      } else if (C.PrimitiveCollection && primitive instanceof C.PrimitiveCollection) {
        for (let i = 0; i < primitive.length; i++) visit(primitive.get(i))
      }
    }
    visit(scene.primitives)
    for (const [manager, record] of this.managers) {
      if (seen.has(manager)) continue
      if (alive(record.primitive) && alive(manager) && restore(record.changes)) manager.position = undefined
      this.managers.delete(manager)
    }
  }

  getDiagnostics() {
    return { supported: this.supported, enabled: this.enabled, managerCount: this.managers.size,
      ownsLight: this.scene.light === this.sun, sunIntensity: this.sun.intensity }
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this.restore()
    this.enabled = false
    this.destroyed = true
  }
}
