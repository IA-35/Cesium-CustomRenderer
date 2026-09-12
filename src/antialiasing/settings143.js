// One MSAA sample by default. Multisampling and a post-process AA stage (SMAA/FXAA)
// address the same coverage problem, so requesting both doubles the cost of the
// dominant scene pass without adding edge quality. The reference 1080p HDR campus
// measurement is P95 73.0 ms for SMAA+MSAA4 against P95 20.5 ms for SMAA+MSAA1.
export const antiAliasingDefaults = Object.freeze({ antialiasing: 'smaa', msaaSamples: 1, resolutionMode: 'native', resolutionScale: 1 })

export function normalizeAntiAliasing(input = {}, current = antiAliasingDefaults) {
  const result = { ...current }
  if (!input || typeof input !== 'object') return result
  if (['off', 'msaa', 'fxaa', 'smaa', 'taa'].includes(input.antialiasing)) result.antialiasing = input.antialiasing
  if ([1, 2, 4, 8].includes(input.msaaSamples)) result.msaaSamples = input.msaaSamples
  if (['native', 'css'].includes(input.resolutionMode)) result.resolutionMode = input.resolutionMode
  if (Number.isFinite(input.resolutionScale)) result.resolutionScale = Math.max(0.5, Math.min(2, input.resolutionScale))
  return result
}

// Modes that own edge coverage in a post-process pass instead of in the framebuffer.
// They are mutually exclusive with multisampling on the same coverage problem.
export const postProcessAntiAliasingModes = Object.freeze(['fxaa', 'smaa', 'taa'])

export function isPostProcessAntiAliasing(mode) {
  return postProcessAntiAliasingModes.includes(mode)
}

// Single source of truth for how many multisamples the scene framebuffer actually
// asks for. Post-process AA keeps the coverage work, so an explicit `msaaCombine`
// opt-in is required before a redundant multisample request is honoured.
export function resolveMsaaPolicy(input = {}) {
  const mode = input && input.antialiasing
  const raw = input && input.msaaSamples
  const requested = Number.isFinite(raw) && raw >= 1 ? raw : 1
  if (mode === 'msaa') return { requested, effective: requested, combined: false, reason: 'Multisample-only mode' }
  if (mode === 'off') return { requested, effective: 1, combined: false, reason: 'Anti-aliasing disabled' }
  const owner = mode === 'taa' ? 'Temporal anti-aliasing' : 'Post-process anti-aliasing'
  if (input && input.msaaCombine === true && requested > 1) {
    return { requested, effective: requested, combined: true, reason: 'Combined multisample and post-process anti-aliasing requested' }
  }
  return { requested, effective: 1, combined: false,
    reason: requested > 1 ? `${owner} owns coverage; MSAA request reduced to 1` : `${owner} owns coverage` }
}

const formatSupport = new WeakMap()

// Private GL access is isolated to this version adapter. MAX_SAMPLES alone is
// insufficient: the active HDR color and depth attachments must both support it.
export function selectMsaaSamples(scene, requested) {
  const context = scene.context
  const gl = context && context._gl
  if (!scene.msaaSupported || !gl || !gl.getInternalformatParameter) {
    return { requested, selected: 1, supported: false, reason: 'Multisample format queries unavailable', colorSamples: [], depthSamples: [] }
  }
  const colorFormat = scene.highDynamicRange ? context.halfFloatingPointTexture ? 'RGBA16F' : 'RGBA32F' : 'RGBA8'
  let formats = formatSupport.get(gl)
  if (!formats) { formats = new Map(); formatSupport.set(gl, formats) }
  if (!formats.has(colorFormat)) {
    const samples = format => Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) || [])
    formats.set(colorFormat, { maxSamples: gl.getParameter(gl.MAX_SAMPLES), colorFormat,
      colorSamples: samples(gl[colorFormat]), depthSamples: samples(gl.DEPTH24_STENCIL8) })
  }
  const support = formats.get(colorFormat)
  const selected = Math.max(1, ...support.colorSamples.filter(n => n <= requested && support.depthSamples.includes(n)))
  return { requested, selected, supported: true, reason: selected < requested ? 'Requested samples not supported by both HDR color and depth' : null, ...support }
}

export function renderResolution(viewer) {
  const canvas = viewer.canvas
  if (!canvas) return null
  const width = Number.isFinite(viewer.scene.drawingBufferWidth) ? viewer.scene.drawingBufferWidth : canvas.width
  const height = Number.isFinite(viewer.scene.drawingBufferHeight) ? viewer.scene.drawingBufferHeight : canvas.height
  return { nativeDpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    css: [canvas.clientWidth, canvas.clientHeight], drawingBuffer: [width, height],
    effectivePixelRatio: [width / canvas.clientWidth, height / canvas.clientHeight],
    imageRendering: canvas.style.imageRendering }
}

// Diagnostic-only GPU query; retain renderbuffer binding so inspection cannot
// change subsequent rendering. Configured samples alone do not prove allocation.
export function readMsaaAttachments(scene) {
  const gl = scene.context && scene.context._gl
  const view = scene._view
  if (!gl || !view || !scene.context.webgl2 || !gl.getRenderbufferParameter) return null
  const previous = gl.getParameter(gl.RENDERBUFFER_BINDING)
  const samples = buffer => {
    if (!buffer || buffer.isDestroyed()) return null
    gl.bindRenderbuffer(gl.RENDERBUFFER, buffer._getRenderbuffer())
    return gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES)
  }
  const inspect = manager => manager ? { configured: manager.numSamples,
    colorRenderbufferSamples: samples(manager.getColorRenderbuffer(0)),
    depthRenderbufferSamples: samples(manager.getDepthStencilRenderbuffer()) } : null
  try {
    return { scene: inspect(view.sceneFramebuffer && view.sceneFramebuffer._colorFramebuffer),
      globe: inspect(view.globeDepth && view.globeDepth.colorFramebufferManager) }
  } finally { gl.bindRenderbuffer(gl.RENDERBUFFER, previous) }
}
