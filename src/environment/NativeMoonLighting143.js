const alive = object => object && !(typeof object.isDestroyed === 'function' && object.isDestroyed())

// Private adapter pinned to Cesium 1.143: Moon owns its EllipsoidPrimitive and
// updates material.uniforms.image; changing the material reference regenerates
// the primitive's shader. Geometry, orientation, phase and visibility stay native.
const solarMaterialSource = `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    vec4 texel = texture(image, fract(materialInput.st));
    material.diffuse = vec3(0.0);
    material.specular = 0.0;
    // Match native Image material's HDR RGB conversion; alpha stays linear.
    material.emission = czm_gammaCorrect(texel.rgb) * max(dot(materialInput.normalEC, czm_sunDirectionEC), 0.0);
    material.alpha = texel.a;
    return material;
}`

export default class NativeMoonLighting143 {
  constructor(C, scene) {
    this.C = C
    this.scene = scene
    this.supported = /^1\.143(?:\.0)?$/.test(C.VERSION) && !!C.Material
    this.released = new WeakSet()
    this.destroyed = false
  }

  restore() {
    const record = this.record
    if (record && alive(record.primitive)) {
      if (record.primitive.material === this.material) record.primitive.material = record.before
      else this.released.add(record.primitive)
    }
    this.record = null
  }

  setActive(active) {
    if (this.destroyed) return
    const moon = this.scene.moon, primitive = moon?._ellipsoidPrimitive
    if (this.record && (!active || !alive(moon) || this.record.primitive !== primitive || primitive.material !== this.material)) this.restore()
    if (!active || !this.supported || !alive(moon) || !alive(primitive) || this.released.has(primitive)) return
    if (this.record) return
    // An explicit custom material belongs to its caller.
    const before=primitive.material,uniforms=before?.uniforms
    if (before?.type !== this.C.Material.ImageType || before.translucent !== false
        || !this.C.Color.equals(uniforms?.color,this.C.Color.WHITE)
        || !this.C.Cartesian2.equals(uniforms?.repeat,new this.C.Cartesian2(1,1))) return
    if (!this.material) this.material = new this.C.Material({
      fabric: { type: 'CCR_MoonSolar143', uniforms: { image: this.C.Material.DefaultImageId }, source: solarMaterialSource },
      // Environment geometry does not write scene depth. An opaque Moon would
      // discard in czm_writeLogDepth when the single scene frustum ends at 50 km.
      // Texture alpha is still one for the native lunar JPG.
      translucent: true
    })
    this.material.uniforms.image = moon.textureUrl
    this.record = { primitive, before: primitive.material }
    primitive.material = this.material
  }

  getDiagnostics() {
    return { supported: this.supported, active: !!this.record && this.record.primitive.material === this.material,
      adapter: 'Cesium 1.143 Moon._ellipsoidPrimitive.material', lighting: 'solar Lambert emission' }
  }

  destroy() {
    if (this.destroyed) return
    this.restore()
    if (alive(this.material)) this.material.destroy()
    this.material = null
    this.destroyed = true
  }
}
