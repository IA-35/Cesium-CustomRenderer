// These legacy compressed leaf mips average alpha to .25-.31. Their omitted
// glTF cutoff defaults to .5 and erases distant crowns, including shadow casters.
// Scope the compatibility value to this verified asset, without editing it.
export default class FoliageMask143 {
  constructor(scene) {
    this.scene = scene
    this.records = new Map()
    this.enabled = false
  }

  setEnabled(value) {
    if (this.destroyed || this.enabled === value) return
    this.enabled = value
    if (value) {
      const previous = this.scene.updateDerivedCommands, owner = this, token = { active: true }
      this.previous = previous; this.token = token
      this.hook = function(command, ...args) {
        if (token.active) owner.apply(command)
        return previous.call(this, command, ...args)
      }
      this.scene.updateDerivedCommands = this.hook
    } else {
      if (this.token) this.token.active = false
      if (this.scene.updateDerivedCommands === this.hook) this.scene.updateDerivedCommands = this.previous
      for (const [command, record] of this.records) this.restore(command, record)
      this.records.clear()
    }
  }

  apply(command) {
    const frame = this.scene.frameState.frameNumber
    if (frame % 120 === 0 && this.prunedFrame !== frame) {
      this.prunedFrame = frame
      for (const [old, record] of this.records) if (record.frame < frame - 120) {
        this.restore(old, record); this.records.delete(old)
      }
    }
    const map = command.uniformMap, getter = map && map.u_alphaCutoff
    if (typeof getter !== 'function') return
    let record = this.records.get(command)
    if (record) {
      record.frame = frame
      if (getter !== record.wrapper) record.active = false
      return
    }
    const resource = command.owner && command.owner._resource
    if (!resource || !/\/SM_NH_Shu\/[^/?#]+\.glb(?:[?#]|$)/i.test(resource.url || '')) return
    record = { map, getter, active: true, frame }
    record.wrapper = () => {
      const cutoff = getter()
      return record.active && cutoff === .5 ? .25 : cutoff
    }
    map.u_alphaCutoff = record.wrapper
    command.dirty = true
    this.records.set(command, record)
  }

  restore(command, record) {
    record.active = false
    for (const map of new Set([record.map, command.uniformMap])) {
      if (map && map.u_alphaCutoff === record.wrapper) map.u_alphaCutoff = record.getter
    }
    command.dirty = true
  }

  destroy() { if (!this.destroyed) { this.setEnabled(false); this.destroyed = true } }
}
