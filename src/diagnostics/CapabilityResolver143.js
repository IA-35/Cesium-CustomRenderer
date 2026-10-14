import { capabilityDiagnostics } from './capabilityMatrix143.js'

// Single policy entry point for requested/active/effective renderer mode.
export function resolveRendererCapabilities143(probe = {}, options = {}, coverage = {}) {
  const report = capabilityDiagnostics(probe, options, coverage)
  const requestedMode = options.lightingMode === 'deferred' ? 'deferred' : 'enhanced'
  const deferred = report.defaults?.deferred
  const effectiveMode = requestedMode === 'deferred' && deferred?.effectiveMode === 'enhanced' ? 'enhanced' : requestedMode
  const features = probe.features || {}
  const feature = (name, fallbackReason) => ({ requested: !!features[name]?.requested, active: features[name]?.active === true, reason: features[name]?.reason || (features[name]?.active === true ? null : fallbackReason), generation: report.capability?.generation ?? probe.generation ?? 0 })
  return { ...report, requestedMode, effectiveMode, fallback: effectiveMode !== requestedMode ? 'enhanced' : null,
    features: {
      graphTransientActive: feature('graphTransientActive', 'Graph allocator is not attached'),
      renderItemDirectSubmit: feature('renderItemDirectSubmit', 'RenderItem collection exists but direct execution is not active'),
      materialBatchingActive: feature('materialBatchingActive', 'Material batching is not active'),
      contextDrawDispatcherActive: feature('contextDrawDispatcherActive', 'Context draw dispatcher is not installed'),
    } }
}

export default resolveRendererCapabilities143
