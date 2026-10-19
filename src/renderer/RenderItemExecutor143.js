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
  // Phase 6: submit a batch that shares one program/render state. Per-item uniforms are still
  // applied per draw. A batch that throws is abandoned at the failing item so the caller can
  // replay it natively.
  //
  // 不要再在这里预绑定 program：Cesium 的 `Context.beginDraw`（1.143
  // `Source/Renderer/Context.js:1313`）对每条命令无条件 `shaderProgram._bind()`，
  // 预绑定只会多出一次 GL 调用（n 条命令 = n+1 次绑定），是净亏损。
  // 真正的「一批一次绑定」需要绕开原生 draw 才能真正省下来，见
  // `RenderBatchPlanner143.js` 的 `programBinds` 口径说明。
  executeBatch(batch, context, passState, nativeSubmit = null) {
    const items = batch?.items?.length ? batch.items : []
    if (!items.length) return { submitted: 0, failedAt: -1 }
    const program = this._command(items[0])?.shaderProgram
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        // The batch groups by shader/render-state identity; a mismatch means the plan is
        // stale and must not be submitted as one unit.
        const command = this._command(item)
        if (program && command?.shaderProgram !== program) {
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
