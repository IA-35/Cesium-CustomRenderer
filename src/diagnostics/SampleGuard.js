// Sticky per-frame comparison: returning to the starting state cannot repair a sample.
export default class SampleGuard {
  constructor(state) {
    this.initial = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, JSON.stringify(value)]))
    this.changedFields = []
  }

  observe(state) {
    for (const key of Object.keys(this.initial)) {
      if (JSON.stringify(state[key]) !== this.initial[key] && !this.changedFields.includes(key)) this.changedFields.push(key)
    }
    return this.valid
  }

  get valid() { return this.changedFields.length === 0 }
}
