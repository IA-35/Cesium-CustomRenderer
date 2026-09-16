import LegacyFoliageMask from './LegacyFoliageMask.js'

// Explicit compatibility for this example's legacy exports. Never imported by the CCR SDK.
export default class CampusAssetCompatibility {
  constructor(C, scene) {
    this.C = C
    this.scene = scene
    this.foliage = new LegacyFoliageMask(scene)
    this.records = new Map()
    this.enabled = false
    this.environmentEnabled = false
  }

  setEnabled(enabled, environmentEnabled = enabled) {
    if (this.destroyed) return
    this.enabled = !!enabled
    this.environmentEnabled = this.enabled && !!environmentEnabled
    this.foliage.setEnabled(this.enabled)
    if (this.environmentEnabled) this.apply()
    else this.restore()
  }

  apply() {
    if (!this.environmentEnabled || this.destroyed) return
    const C = this.C, seen = new Set()
    const visit = primitive => {
      if (!primitive || primitive.isDestroyed?.()) return
      if (primitive instanceof C.PrimitiveCollection) {
        for (let i = 0; i < primitive.length; i++) visit(primitive.get(i))
        return
      }
      if (!(primitive instanceof C.Cesium3DTileset)) return
      const ibl = primitive.imageBasedLighting
      if (!ibl) return
      const existing = this.records.get(ibl)
      if (existing) {
        seen.add(ibl)
        if (ibl.imageBasedLightingFactor !== existing.applied) existing.owned = false
        return
      }
      const factor = ibl.imageBasedLightingFactor, manager = primitive.environmentMapManager
      if (primitive.customShader || !manager || manager.enabled === false ||
          !C.DynamicEnvironmentMapManager.isDynamicUpdateSupported(this.scene) ||
          !factor || factor.x !== 1 || factor.y !== 1 ||
          !/\/SM_NH_(?:Terr|Building)\/tileset\.json(?:[?#]|$)/i.test(primitive.resource?.url || '')) return
      ibl.imageBasedLightingFactor = new C.Cartesian2(1, 0)
      this.records.set(ibl, { primitive, before: factor, applied: ibl.imageBasedLightingFactor, owned: true })
      seen.add(ibl)
    }
    visit(this.scene.primitives)
    for (const [ibl, record] of this.records) {
      if (!seen.has(ibl)) { this.restoreOne(ibl, record); this.records.delete(ibl) }
    }
  }

  restoreOne(ibl, record) {
    if (!record.primitive.isDestroyed?.() && !ibl.isDestroyed?.() &&
        record.owned && ibl.imageBasedLightingFactor === record.applied) {
      ibl.imageBasedLightingFactor = record.before
    }
  }

  restore() {
    for (const [ibl, record] of this.records) this.restoreOne(ibl, record)
    this.records.clear()
  }

  destroy() {
    if (this.destroyed) return
    this.setEnabled(false)
    this.foliage.destroy()
    this.destroyed = true
  }
}
