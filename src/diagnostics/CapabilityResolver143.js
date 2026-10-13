import { capabilityDiagnostics } from './capabilityMatrix143.js'

// Single policy entry point for requested/active/effective renderer mode.
export function resolveRendererCapabilities143(probe = {}, options = {}, coverage = {}) {
  const report = capabilityDiagnostics(probe, options, coverage)
  const requestedMode = options.lightingMode === 'deferred' ? 'deferred' : 'enhanced'
  const deferred = report.defaults?.deferred
  const effectiveMode = requestedMode === 'deferred' && deferred?.effectiveMode === 'enhanced' ? 'enhanced' : requestedMode
  return { ...report, requestedMode, effectiveMode, fallback: effectiveMode !== requestedMode ? 'enhanced' : null }
}

export default resolveRendererCapabilities143
