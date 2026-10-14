// Execution boundary for collected RenderItems. RenderItem remains immutable metadata;
// this class owns command cloning, overrides, execution and submission diagnostics.
export default class RenderItemExecutor143 {
  constructor(C, { label = 'CCR' } = {}) { this.C = C; this.label = label; this.stats = { executed: 0, native: 0, deferred: 0, transparent: 0, fallback: 0, errors: 0 } }
  _command(item) { return item?.command || item }
  execute(item, context, passState, overrides = {}, nativeSubmit = null) {
    const source = this._command(item)
    if (!source) throw new Error('RenderItemExecutor143 requires an item or command')
    const command = Object.keys(overrides).length
      ? (this.C?.DrawCommand?.shallowClone ? this.C.DrawCommand.shallowClone(source) : { ...source }) : source
    for (const [key, value] of Object.entries(overrides)) if (value !== undefined) command[key] = value
    try {
      const submit = nativeSubmit
        ? () => nativeSubmit(command, passState)
        : () => typeof command.execute === 'function' ? command.execute(context, passState) : context.draw(command, passState)
      const result = context?._ccrDrawDispatcher?.withBypass
        ? context._ccrDrawDispatcher.withBypass(submit)
        : submit()
      this.stats.executed++
      const pass = item?.pass || 'native.forward'
      if (pass === 'transparent.forward') this.stats.transparent++
      else if (pass === 'deferred.geometry' || pass === 'deferred.lighting') this.stats.deferred++
      else this.stats.native++
      return result
    } catch (error) { this.stats.errors++; throw error }
  }
  executeMany(items, context, passState, overrides = {}) {
    const results = []
    for (const item of items || []) results.push(this.execute(item, context, passState, typeof overrides === 'function' ? overrides(item) : overrides))
    return results
  }
  fallback(item, context, passState, reason, overrides = {}) { this.stats.fallback++; return this.execute(item, context, passState, overrides) }
  getDiagnostics() { return { label: this.label, ...this.stats } }
}
