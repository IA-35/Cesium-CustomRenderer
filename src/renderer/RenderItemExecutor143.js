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
  // Phase 6: submit a batch that shares one program/render state. The bind happens once for
  // the whole run; only the per-item uniform values are still applied per draw. A batch that
  // throws is abandoned at the failing item so the caller can replay it natively.
  executeBatch(batch, context, passState, nativeSubmit = null) {
    const items = batch?.items?.length ? batch.items : []
    if (!items.length) return { submitted: 0, failedAt: -1 }
    const first = this._command(items[0])
    const program = first?.shaderProgram
    const boundOnce = !!program?._bind
    try {
      if (boundOnce) program._bind()
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        // The batch groups by shader/render-state identity; a mismatch means the plan is
        // stale and must not be submitted as one unit.
        const command = this._command(item)
        if (boundOnce && command?.shaderProgram !== program) {
          this.stats.batchBroken = (this.stats.batchBroken || 0) + 1
          return { submitted: index, failedAt: index }
        }
        this.execute(item, context, passState, {}, nativeSubmit)
      }
      this.stats.batched = (this.stats.batched || 0) + items.length
      this.stats.batches = (this.stats.batches || 0) + 1
      if (this.stats.batchBroken === undefined) this.stats.batchBroken = 0
      return { submitted: items.length, failedAt: -1 }
    } catch (error) {
      this.stats.batchErrors = (this.stats.batchErrors || 0) + 1
      throw error
    }
  }
  fallback(item, context, passState, reason, overrides = {}) { this.stats.fallback++; return this.execute(item, context, passState, overrides) }
  getDiagnostics() { return { label: this.label, ...this.stats } }
}
