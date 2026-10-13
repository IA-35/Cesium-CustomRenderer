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
  if (!record.owned || !equal(object[key], record.applied)) {
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
    if (alive(object) && owned && equal(object[key], applied) && !equal(object[key], before)) {
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
    this.reflectionRecords = new Map()
    this.sharedReflectionIbls = new Map()
    this.reflectionKey = null
    this.reflectionIncludes = new WeakSet()
    this.reflection = { enabled: false, strength: 1, map: null }
    // Most frames do not change primitive membership or lighting settings. Avoid
    // recursively walking every model from the preUpdate hook in that case.
    this.applyDirty = true
    this.applyRootCount = -1
    this.applyKey = null
    this.reflectionDirty = true
    this.reflectionRootCount = -1
    this.collectionRemovers = []
    this.watchedCollections = new WeakSet()
    this.sun = new C.SunLight()
    this.settings = { skyIntensity: 2.8, sunIntensity: 2, rayleighScale: 1,
      mieScale: 1, atmosphereIntensity: 10, skyAtmosphereIntensity: 20, daylight: 1 }
    this.supported = !!(scene.context && C.DynamicEnvironmentMapManager &&
      C.DynamicEnvironmentMapManager.isDynamicUpdateSupported(scene))
    this.watchPrimitiveCollection(scene.primitives)
    this.removeReflectionUpdate = scene.preUpdate?.addEventListener(() => this.updateReflections())
  }

  watchPrimitiveCollection(collection) {
    if (!collection || this.watchedCollections.has(collection)) return
    this.watchedCollections.add(collection)
    const mark = primitive => {
      this.applyDirty = true
      this.reflectionDirty = true
      this.watchPrimitiveCollection(primitive)
    }
    if (collection.primitiveAdded?.addEventListener) {
      this.collectionRemovers.push(collection.primitiveAdded.addEventListener(mark))
    }
    if (collection.primitiveRemoved?.addEventListener) {
      this.collectionRemovers.push(collection.primitiveRemoved.addEventListener(() => {
        this.applyDirty = true
        this.reflectionDirty = true
      }))
    }
    if (typeof collection.get !== 'function') return
    for (let index = 0; index < collection.length; index++) {
      const primitive = collection.get(index)
      if (primitive instanceof this.C.PrimitiveCollection) this.watchPrimitiveCollection(primitive)
    }
  }

  setEnabled(enabled) {
    if (this.destroyed || this.enabled === (enabled === true)) return
    this.enabled = enabled === true
    if (this.enabled) {
      this.applyDirty = true
      this.apply(this.settings)
    }
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

  setReflection(settings = {}) {
    if (this.destroyed) return
    const input = settings || {}
    if (typeof input.enabled === 'boolean') this.reflection.enabled = input.enabled
    if (Number.isFinite(input.strength)) this.reflection.strength = Math.max(0, Math.min(1, input.strength))
    if (Object.prototype.hasOwnProperty.call(input, 'map')) {
      this.reflection.map = typeof input.map === 'string' ? input.map.trim() || null : null
    }
    this.reflectionDirty = true
    // A live scene already has a preUpdate hook that coalesces all model
    // changes into one traversal. Keep the synchronous path for small test
    // fixtures and callers without a frame lifecycle.
    if (this.reflection.enabled) {
      if (!this.scene.preUpdate) this.updateReflections()
    } else this.restoreReflections()
  }

  restoreReflections() {
    for (const record of this.reflectionRecords.values()) this.restoreReflectionRecord(record)
    this.reflectionRecords.clear()
    for (const shared of this.sharedReflectionIbls.values()) {
      if (alive(shared) && typeof shared.destroy === 'function') shared.destroy()
    }
    this.sharedReflectionIbls.clear()
    this.reflectionKey = null
  }

  setReflectionIncluded(primitive, included = true) {
    if (this.destroyed || !primitive) return false
    if (included) {
      this.reflectionIncludes.add(primitive)
      this.reflectionDirty = true
      // Model ready callbacks can arrive in bursts. Defer the tree walk to
      // preUpdate so a burst results in one scan and one IBL rebind per frame.
      if (this.reflection.enabled && !this.scene.preUpdate) this.updateReflections()
    } else {
      this.reflectionIncludes.delete(primitive)
      this.reflectionDirty = true
      const record = this.reflectionRecords.get(primitive)
      if (record) {
        this.restoreReflectionRecord(record)
        this.reflectionRecords.delete(primitive)
      }
    }
    return this.reflectionIncludes.has(primitive)
  }

  restoreReflectionRecord(record) {
    if (!record) return
    if (record.shared && record.primitive?.imageBasedLighting === record.shared) {
      record.primitive._shouldDestroyImageBasedLighting = false
      record.primitive.imageBasedLighting = record.original
    } else restore(record.changes)
  }

  updateReflections() {
    if (this.destroyed || !this.reflection.enabled || !alive(this.scene)) return
    if (!this.reflection.map) {
      this.restoreReflections()
      this.reflectionDirty = false
      this.reflectionRootCount = this.scene.primitives?.length ?? 0
      return
    }
    const rootCount = this.scene.primitives?.length ?? 0
    const reflectionKey = `${this.reflection.map}|${this.reflection.strength}`
    if (this.reflectionKey !== null && this.reflectionKey !== reflectionKey) this.restoreReflections()
    this.reflectionKey = reflectionKey
    if (!this.reflectionDirty && rootCount === this.reflectionRootCount) return
    const C = this.C, seen = new Set()
    const visit = primitive => {
      if (!alive(primitive)) return
      if ((C.Cesium3DTileset && primitive instanceof C.Cesium3DTileset) ||
          (C.Model && primitive instanceof C.Model)) {
        if (!this.reflectionIncludes.has(primitive)) {
          const record = this.reflectionRecords.get(primitive)
          if (record) {
            this.restoreReflectionRecord(record)
            this.reflectionRecords.delete(primitive)
          }
          return
        }
        const ibl = primitive.imageBasedLighting
        if (!ibl) return
        seen.add(primitive)
        if (C.Model && primitive instanceof C.Model && C.ImageBasedLighting && C.Cartesian2) {
          const factor = ibl.imageBasedLightingFactor || new C.Cartesian2(1, 1)
          const sharedKey = `${reflectionKey}|${factor.x}`
          let shared = this.sharedReflectionIbls.get(sharedKey)
          if (!shared) {
            shared = new C.ImageBasedLighting({
              imageBasedLightingFactor: new C.Cartesian2(factor.x, this.reflection.strength),
              specularEnvironmentMaps: this.reflection.map,
            })
            this.sharedReflectionIbls.set(sharedKey, shared)
          }
          const current = this.reflectionRecords.get(primitive)
          if (!current || current.shared !== shared) {
            if (current) {
              this.restoreReflectionRecord(current)
              this.reflectionRecords.delete(primitive)
            }
            primitive._shouldDestroyImageBasedLighting = false
            primitive.imageBasedLighting = shared
            this.reflectionRecords.set(primitive, { primitive, original: ibl, shared })
          }
          return
        }
        let record = this.reflectionRecords.get(primitive)
        if (!record) {
          const factor = ibl.imageBasedLightingFactor || new C.Cartesian2(1, 1)
          record = { changes: [{ object: ibl, key: 'imageBasedLightingFactor',
            before: new C.Cartesian2(factor.x, factor.y), applied: factor, owned: true }] }
          this.reflectionRecords.set(primitive, record)
        }
        const factor = ibl.imageBasedLightingFactor || new C.Cartesian2(1, 1)
        write(record.changes, ibl, 'imageBasedLightingFactor', new C.Cartesian2(factor.x, this.reflection.strength))
        write(record.changes, ibl, 'specularEnvironmentMaps', this.reflection.map)
      } else if (C.PrimitiveCollection && primitive instanceof C.PrimitiveCollection) {
        for (let i = 0; i < primitive.length; i++) visit(primitive.get(i))
      }
    }
    visit(this.scene.primitives)
    for (const [primitive, record] of this.reflectionRecords) {
      if (seen.has(primitive)) continue
      this.restoreReflectionRecord(record)
      this.reflectionRecords.delete(primitive)
    }
    this.reflectionRootCount = rootCount
    this.reflectionDirty = false
  }

  getReflectionDiagnostics() {
    const requested = this.reflection.enabled
    const count = this.reflectionRecords.size
    let readyCount = 0
    for (const primitive of this.reflectionRecords.keys()) {
      if (primitive.imageBasedLighting?.specularEnvironmentCubeMap?.ready === true) readyCount++
    }
    const configured = !!this.reflection.map
    return { enabled: requested, valid: requested && configured && count > 0, mode: 'cube-map',
      source: configured ? 'static-ktx2' : 'none', sceneReflections: false, map: this.reflection.map,
      strength: this.reflection.strength, modelCount: count, readyCount,
      reason: !requested ? 'Not requested' : !configured ? 'No static environment map configured'
        : count ? null : 'No models included for environment reflections' }
  }

  apply(settings) {
    if (this.destroyed) return
    this.settings = { ...this.settings, ...settings }
    if (!this.enabled || !alive(this.scene)) return
    const C = this.C, scene = this.scene, o = this.settings
    const rootCount = scene.primitives?.length ?? 0
    const color = o.sunColor
    const key = [o.skyIntensity, o.sunIntensity, o.rayleighScale, o.mieScale,
      o.atmosphereIntensity, o.skyAtmosphereIntensity, o.daylight,
      color?.red, color?.green, color?.blue, color?.alpha].join('|')
    const owned = this.changes.every(record => !record.owned || record.object[record.key] === record.applied)
    if (!this.applyDirty && owned && rootCount === this.applyRootCount && key === this.applyKey) return
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
          record = { primitive, changes: [] }
          this.managers.set(manager, record)
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
    this.applyRootCount = rootCount
    this.applyKey = key
    this.applyDirty = false
  }

  getDiagnostics() {
    return { supported: this.supported, enabled: this.enabled, managerCount: this.managers.size,
      ownsLight: this.scene.light === this.sun, sunIntensity: this.sun.intensity }
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this.restoreReflections()
    this.reflectionIncludes = new WeakSet()
    this.restore()
    if (this.removeReflectionUpdate) this.removeReflectionUpdate()
    this.collectionRemovers.splice(0).forEach(remove => { if (typeof remove === 'function') remove() })
    this.watchedCollections = new WeakSet()
    this.enabled = false
    this.destroyed = true
  }
}
