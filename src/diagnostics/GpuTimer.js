// Opt-in diagnostics only. Never waits for the GPU or overlaps another elapsed query.
export default class GpuTimer {
  constructor(gl) {
    this.gl = gl
    this.extension = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.supported = !!this.extension
    this.pending = []
    this.samples = []
    this.discarded = 0
    this.skipped = 0
    this.destroyed = false
  }

  measure(label, callback) {
    const gl = this.gl, ext = this.extension
    if (this.destroyed || !this.supported || gl.isContextLost() || this.pending.length >= 32 ||
        gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
      this.skipped++
      return callback()
    }
    const query = gl.createQuery()
    if (!query) { this.skipped++; return callback() }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    let completed = false
    try {
      const result = callback()
      completed = true
      return result
    } finally {
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      if (completed) this.pending.push({ label, query })
      else { gl.deleteQuery(query); this.discarded++ }
    }
  }

  poll() {
    if (this.destroyed || !this.supported) return
    const gl = this.gl
    const invalid = gl.isContextLost() || gl.getParameter(this.extension.GPU_DISJOINT_EXT)
    this.pending = this.pending.filter(({ label, query }) => {
      if (invalid) { gl.deleteQuery(query); this.discarded++; return false }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true
      const milliseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6
      if (Number.isFinite(milliseconds) && milliseconds >= 0) this.samples.push({ label, milliseconds })
      else this.discarded++
      gl.deleteQuery(query)
      return false
    })
  }

  destroy() {
    if (this.destroyed) return
    for (const { query } of this.pending) this.gl.deleteQuery(query)
    this.discarded += this.pending.length
    this.pending = []
    this.destroyed = true
  }
}
