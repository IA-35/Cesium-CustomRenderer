import ContextDrawDispatcher143, { getContextDrawDispatcher143 } from '../pipeline/ContextDrawDispatcher143.js'

const keyword = 'ccr-globe-night-143'
const clippingMarker = /#ifdef ENABLE_CLIPPING_PLANES\r?\n    vec4 clippingPlanesEdgeColor/

export default class GlobeNightLighting143 {
  constructor(C, scene, getState) {
    Object.assign(this, { C, scene, getState, enabled: false, destroyed: false, draws: 0, variants: 0 })
    this.programs = new WeakMap()
    this.uniformMaps = new WeakMap()
    this.sky = new C.Cartesian3()
    const context = scene.context
    this.supported = /^1\.143(?:\.0)?$/.test(C.VERSION) && typeof context?.draw === 'function' &&
      typeof context.shaderCache?.getDerivedShaderProgram === 'function' &&
      typeof context.shaderCache?.createDerivedShaderProgram === 'function'
    if (this.supported) {
      this.dispatcher = getContextDrawDispatcher143(context) || new ContextDrawDispatcher143(context)
      this.dispatcher.install()
      this.off = this.dispatcher.addHandler(event => this.draw(event), { name: 'globe-night-lighting', priority: -30 })
    }
  }

  setActive(active) { if (!this.destroyed) this.enabled = active === true }

  program(source) {
    if (this.programs.has(source)) return this.programs.get(source)
    const fragment = source.fragmentShaderSource
    const index = fragment?.sources?.findIndex(text => text.includes('czm_geodeticSurfaceNormal(v_positionMC,') &&
      text.includes('color.rgb * czm_lightColor * diffuseIntensity') && clippingMarker.test(text)) ?? -1
    if (index < 0 || fragment.pickColorQualifier || fragment.defines.some(value => /^SHADOW_MAP(?:\s|$)/.test(value))) {
      this.programs.set(source, null)
      return null
    }
    const cache = this.scene.context.shaderCache
    let program = cache.getDerivedShaderProgram(source, keyword)
    if (!program) {
      const patched = fragment.clone()
      // color already contains decoded and blended native imagery/materials.
      // Add material-weighted sky irradiance after direct light, before clipping.
      patched.sources[index] = patched.sources[index].replace(clippingMarker,
        'finalColor.rgb += color.rgb * ccrGlobeNightSky;\n\n$&')
      patched.sources.unshift('uniform vec3 ccrGlobeNightSky;')
      program = cache.createDerivedShaderProgram(source, keyword, {
        vertexShaderSource: source.vertexShaderSource, fragmentShaderSource: patched,
        attributeLocations: source._attributeLocations
      })
    }
    // The native ShaderCache owns this derived program and releases it with the
    // source program. This adapter borrows the reference and never destroys it.
    this.programs.set(source, program)
    this.variants++
    return program
  }

  draw(event) {
    const command = event.command, passes = this.scene.frameState?.passes
    if (!this.enabled || this.destroyed || this.scene.globe?.enableLighting === false || command?.pass !== this.C.Pass.GLOBE ||
      (passes && (!passes.render || passes.pick || passes.pickVoxel)) || event.overrides[0] || event.overrides[1]) return 'continue'
    const state = this.getState()
    if (!(state?.nightWeight > 0) || !state.nightSkyRadiance?.some(v => v > 0)) return 'continue'
    // Shadow caster commands inherit GLOBE pass but disable color writes; their
    // shader also lacks the native GlobeFS marker. Executor bypass stays native.
    const mask = command.renderState?.colorMask
    if (mask && !mask.red && !mask.green && !mask.blue) return 'continue'
    const source = command.shaderProgram
    if (!source) return 'continue'
    const program = this.program(source)
    if (!program) return 'continue'
    const original = command.uniformMap
    let record = this.uniformMaps.get(command)
    if (!record || record.original !== original) {
      record = { original, merged: { ...original, ccrGlobeNightSky: () => {
        const sky = this.getState().nightSkyRadiance
        this.sky.x = sky[0]; this.sky.y = sky[1]; this.sky.z = sky[2]
        return this.sky
      } } }
      this.uniformMaps.set(command, record)
    }
    event.deferRestore(() => { command.shaderProgram = source; command.uniformMap = original })
    command.shaderProgram = program
    command.uniformMap = record.merged
    this.draws++
    return 'continue'
  }

  getDiagnostics() {
    return { supported: this.supported, enabled: this.enabled, draws: this.draws, variants: this.variants,
      lighting: 'native GlobeFS imagery albedo times night sky irradiance' }
  }

  destroy() {
    if (this.destroyed) return
    this.off?.()
    this.enabled = false
    this.destroyed = true
    this.programs = new WeakMap()
    this.uniformMaps = new WeakMap()
  }
}
