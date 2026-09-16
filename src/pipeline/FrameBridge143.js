// Cesium 1.143 experimental OIT bridge; scene management and picking remain native.
// Per-frustum events observe accumulation. Final opaque replacement is before OIT composition.
// Sorted transparency has no opaque write boundary and is explicitly observation-only.
const VERSION = /^1\.143(?:\.0)?$/
export const FRAME_BRIDGE_PHASES = ['opaqueFrame', 'opaqueReadHook', 'translucent', 'resolve']
function halfFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023
  return sign * (exponent === 0 ? fraction * 2 ** -24
    : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15))
}
export function createFrameBridge({ Cesium: C, scene, priority = 0 } = {}) {
  if (!C || !scene) throw new Error('createFrameBridge requires { Cesium, scene }')
  if (!VERSION.test(C.VERSION)) throw new Error('FrameBridge143 requires Cesium 1.143')
  const callbacks = new Set(), commandCallbacks = new Set(), viewIds = new WeakMap()
  let viewCount = 0, installation, activeContext, enabled = true
  const state = { installed: false, destroyed: false, generation: 0, frameGeneration: 0,
    frameNumber: undefined, scratch: {}, errors: [], uploadProgram: undefined }
  const stats = { frames: 0, resolves: 0, views: 0, replacementUploads: 0,
    callbacks: Object.fromEntries(FRAME_BRIDGE_PHASES.map(p => [p, 0])) }
  const alive = value => value && !(typeof value.isDestroyed === 'function' && value.isDestroyed())
  const isRender = () => {
    const passes = scene.frameState?.passes
    return passes?.render === true && !passes.pick && !passes.pickVoxel && !passes.depth &&
      (scene.mode === undefined || scene.mode === C.SceneMode?.SCENE3D) &&
      !scene.useWebVR && !scene.context?._gl?.isContextLost()
  }
  function assertAlive() { if (state.destroyed) throw new Error('FrameBridge143 is destroyed') }
  function contextFor(phase) {
    const view = scene._view, frameNumber = scene.frameState.frameNumber
    if (state.frameNumber !== frameNumber) {
      state.frameNumber = frameNumber; state.frameGeneration++; stats.frames++
    }
    if (view && !viewIds.has(view)) viewIds.set(view, viewCount++)
    const id = view ? viewIds.get(view) : -1, current = scene.context.uniformState?.currentFrustum
    return { phase, scene, view, frameNumber, frameGeneration: state.frameGeneration,
      generation: state.generation, sceneId: scene.id || 'scene-0',
      viewId: (scene.id || 'scene-0') + ':' + id, callIndex: id,
      frustum: current ? { near: current.x, far: current.y } : null,
      boundary: phase === 'translucent' ? 'oit-compose' : phase === 'resolve' ? 'post-resolve' : 'oit-frustum',
      useOIT: scene._environmentState?.useOIT === true,
      drawingBuffer: { width: scene.context.drawingBufferWidth, height: scene.context.drawingBufferHeight } }
  }
  function dispatch(phase) {
    if (!state.installed || !enabled || !isRender()) return
    const context = contextFor(phase), previous = activeContext
    stats.callbacks[phase]++; activeContext = context
    try {
      for (const record of [...callbacks].sort((a,b) => a.priority - b.priority)) {
        if (!state.installed || !enabled || state.destroyed || context.generation !== state.generation) break
        if (!record.active || !record.enabled || record.phase !== phase) continue
        try { record.fn(context) }
        catch (error) {
          record.enabled = false
          state.errors.push(String(error?.message || error)); state.errors = state.errors.slice(-8)
        }
      }
    } finally { activeContext = previous }
  }
  function patch(token, target, name, run) {
    const previous = target?.[name]
    if (typeof previous !== 'function') return
    const hadOwn = Object.hasOwn(target, name)
    const wrapper = function(...args) {
      if (!token.active || state.destroyed) return previous.apply(this, args)
      return run.call(this, previous, args)
    }
    target[name] = wrapper
    token.records.push({ target, name, previous, wrapper, hadOwn })
  }
  function patchView(token) {
    const oit = scene._view?.oit
    if (!oit || token.oits.has(oit)) return
    token.oits.add(oit)
    patch(token, oit, 'executeCommands', function(native, args) {
      if (isRender() && scene._environmentState?.useOIT && scene._view?.oit === oit) {
        stats.views++; dispatch('opaqueFrame'); dispatch('opaqueReadHook')
      }
      return native.apply(this, args)
    })
    patch(token, oit, 'execute', function(native, args) {
      if (scene._view?.oit === oit && scene._environmentState?.useOIT) dispatch('translucent')
      return native.apply(this, args)
    })
  }
  function install() {
    assertAlive()
    if (state.installed) return api
    const token = { active: true, records: [], oits: new WeakSet(), canvas: scene.canvas }
    installation = token
    state.installed = true; state.generation++; state.frameNumber = undefined
    token.onLost = () => uninstall()
    token.canvas?.addEventListener('webglcontextlost', token.onLost)
    try {
    patch(token, scene, 'updateAndExecuteCommands', function(native,args) {
      patchView(token)
      if (isRender()) contextFor('opaqueFrame')
      return native.apply(this,args)
    })
    patch(token, scene, 'resolveFramebuffers', function(native,args) {
      patchView(token)
      const result = native.apply(this,args)
      if (isRender()) { stats.resolves++; dispatch('resolve') }
      return result
    })
    // B03: a per-command hook *before* the engine derives its OIT/alpha/log-depth variants.
    //
    // `updateDerivedCommands(command)` is called for every command during the visible-set build, and
    // OIT caches its derived programs keyed on `command.shaderProgram` identity. Patching the
    // translucent command's shader any later would be too late: the derived translucent command would
    // already hold the native program, and the patched shader would never be what actually draws.
    // Exposed as a callback so the transparent-forward pass can install its own patch without this
    // bridge knowing anything about lighting.
    patch(token, scene, 'updateDerivedCommands', function(native,args) {
      const command = args[0]
      stats.derivedCalls = (stats.derivedCalls || 0) + 1
      if (command?.pass === C.Pass.TRANSLUCENT) stats.translucentDerivedCalls = (stats.translucentDerivedCalls || 0) + 1
      if (command && isRender()) dispatchCommand(command)
      return native.apply(this,args)
    })
    patchView(token)
    } catch (error) { uninstall(); throw error }
    return api
  }
  function dispatchCommand(command) {
    if (!state.installed || !enabled || state.destroyed || !isRender()) return
    const generation=state.generation
    for (const record of [...commandCallbacks].sort((a,b) => a.priority - b.priority)) {
      if (!state.installed || !enabled || state.destroyed || generation !== state.generation) break
      if (!record.active || !record.enabled) continue
      try { record.fn(command) }
      catch (error) {
        record.enabled = false
        state.errors.push(String(error?.message || error)); state.errors = state.errors.slice(-8)
      }
    }
  }
  function releaseTargets() {
    if (alive(state.scratch.framebuffer)) state.scratch.framebuffer.destroy()
    state.scratch = {}
  }
  function releaseGpu() {
    releaseTargets()
    const command = state.uploadProgram
    if (command) {
      if (alive(command.shaderProgram)) command.shaderProgram.destroy()
      C.RenderState.removeFromCache(command.renderState)
      state.uploadProgram = undefined
    }
  }
  function uninstall() {
    if (!state.installed) return
    state.installed = false
    installation.active = false // Permanently retire wrappers retained inside foreign wrappers.
    installation.canvas?.removeEventListener('webglcontextlost', installation.onLost)
    for (const r of installation.records.reverse()) {
      if (r.target[r.name] !== r.wrapper) continue
      if (r.hadOwn) r.target[r.name] = r.previous
      else delete r.target[r.name]
    }
    installation = undefined; activeContext = undefined; releaseGpu()
  }
  function on(phase, fn, options = {}) {
    assertAlive()
    if (!FRAME_BRIDGE_PHASES.includes(phase)) throw new Error('unknown frame phase: ' + phase)
    if (typeof fn !== 'function') throw new Error('on requires a function')
    const record = { phase, fn, priority: options.priority ?? priority, enabled: options.enabled !== false, active: true }
    callbacks.add(record)
    return () => { record.active = false; callbacks.delete(record) }
  }
  /**
   * Register a callback for each draw command, before its derived (OIT/alpha) variants
   * are created. Used by the transparent-forward pass to patch the command's shader in time; see the
   * `updateDerivedCommands` patch for why the ordering matters.
   */
  function onCommand(fn, options = {}) {
    assertAlive()
    if (typeof fn !== 'function') throw new Error('onCommand requires a function')
    const record = { fn, priority: options.priority ?? priority, enabled: options.enabled !== false, active: true }
    commandCallbacks.add(record)
    return () => { record.active = false; commandCallbacks.delete(record) }
  }
  function findOpaqueTargets() {
    if (!scene._environmentState?.useOIT) return []
    const oit = scene._view?.oit, texture = oit?._opaqueTexture
    if (!alive(texture) || !texture.width) return []
    return [{ texture, mode: 'oit.opaqueTexture', samples: oit._opaqueFBO?._numSamples || 1 }]
  }
  function targetFramebuffer(texture) {
    if (state.scratch.texture !== texture || !alive(state.scratch.framebuffer)) {
      releaseTargets()
      state.scratch.texture = texture
      state.scratch.framebuffer = new C.Framebuffer({
        context: scene.context, colorTextures: [texture], destroyAttachments: false,
      })
    }
    return state.scratch.framebuffer
  }
  function withBindings(fn) {
    const context = scene.context, gl = context._gl
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const cached = context._currentFramebuffer, viewport = context.uniformState.viewport
    const savedViewport = viewport ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } : null
    try { return fn() }
    finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
      context._currentFramebuffer = cached
      if (savedViewport) context.uniformState.viewport = savedViewport
    }
  }
  function writeReason() {
    if (!state.installed || !enabled || !isRender()) return 'bridge is inactive or this is not a supported render frame'
    if (!scene._environmentState?.useOIT) return 'sorted transparency has no supported opaque write boundary'
    if (!activeContext || activeContext.view !== scene._view ||
        activeContext.frameNumber !== scene.frameState.frameNumber ||
        activeContext.generation !== state.generation) return 'opaque writes require a current bridge callback'
    if (!['opaqueReadHook','translucent'].includes(activeContext.phase)) return 'this phase is not an opaque write boundary'
    const target = findOpaqueTargets()[0]
    if (!target) return 'no live OIT opaque color target'
    if (activeContext.phase === 'opaqueReadHook' &&
        (target.samples > 1 || scene._view.frustumCommandsList?.length > 1)) {
      return 'MSAA or multiple frustums require the final translucent (OIT compose) boundary'
    }
    return null
  }
  function uploadOpaqueColor(rgba) {
    assertAlive()
    const reason = writeReason()
    if (reason) return { applied: false, reason }
    if (!Array.isArray(rgba) || rgba.length !== 4 || !rgba.every(Number.isFinite)) {
      return { applied: false, reason: 'rgba must contain four finite linear HDR components' }
    }
    const target = findOpaqueTargets()[0], texture = target.texture, context = scene.context
    return withBindings(() => {
      const framebuffer = targetFramebuffer(texture)
      let command = state.uploadProgram
      if (command && (command.width !== texture.width || command.height !== texture.height)) {
        command.shaderProgram.destroy(); C.RenderState.removeFromCache(command.renderState)
        state.uploadProgram = command = undefined
      }
      if (!command) {
        const renderState = C.RenderState.fromCache({
          viewport: new C.BoundingRectangle(0, 0, texture.width, texture.height),
          depthTest: { enabled: false }, depthMask: false,
        })
        try {
          command = context.createViewportQuadCommand(
            'uniform vec4 u_color; void main() { out_FragColor = u_color; }', { renderState })
          command.width = texture.width; command.height = texture.height
          state.uploadProgram = command
        } catch (error) { C.RenderState.removeFromCache(renderState); throw error }
      }
      const color = new C.Cartesian4(...rgba)
      command.uniformMap = { u_color: () => color }; command.framebuffer = framebuffer
      const passState = new C.PassState(context)
      passState.framebuffer = framebuffer
      passState.viewport = new C.BoundingRectangle(0,0,texture.width,texture.height)
      command.execute(context, passState)
      stats.replacementUploads++
      return { applied: true, mode: target.mode, samples: target.samples, phase: activeContext.phase }
    })
  }
  function readOpaqueColor(x, y) {
    assertAlive()
    const target = findOpaqueTargets()[0]
    if (!target || !isRender()) return { supported: false, reason: 'no supported opaque render target' }
    if (![x,y].every(Number.isInteger) || x < 0 || y < 0 || x >= target.texture.width || y >= target.texture.height) {
      return { supported: false, reason: 'read coordinates outside opaque texture' }
    }
    if (target.samples > 1 && activeContext?.phase !== 'translucent') {
      return { supported: false, reason: 'MSAA read requires the resolved OIT compose boundary' }
    }
    return withBindings(() => {
      const framebuffer = targetFramebuffer(target.texture)
      const data = scene.context.readPixels({ framebuffer, x, y, width: 1, height: 1 })
      const value = Array.from(data, v => target.texture.pixelDatatype === C.PixelDatatype.HALF_FLOAT ? halfFloat(v)
        : target.texture.pixelDatatype === C.PixelDatatype.UNSIGNED_BYTE ? v / 255 : v)
      return { supported: true, value, mode: target.mode, samples: target.samples }
    })
  }
  function getDiagnostics() {
    return { ...stats, callbacks: { ...stats.callbacks }, installed: state.installed,
      destroyed: state.destroyed, generation: state.generation, frameGeneration: state.frameGeneration,
      enabled, tokens: callbacks.size, errors: state.errors.slice(),
      oitPatched: !!installation && !!scene._view?.oit && installation.oits.has(scene._view.oit),
      wrappers: installation?.records.map(r => ({ name: r.name, hadOwn: r.hadOwn })) || [],
      unidentifiedPhases: scene._environmentState?.useOIT ? [] : [{ phase: 'opaqueReadHook', detail: 'sorted transparency is observation-only' }],
      limitations: ['Only 3D render frames, not picking/stereo/2D.',
        'Context loss retires the bridge; reinstall only after the host context has recovered.',
        'Sorted transparency is observation-only; opaque writes are rejected.',
        'Per-frustum OIT events are observations; final MSAA/multi-frustum replacement belongs at OIT compose.',
        'readOpaqueColor is a synchronous diagnostic read, not a production lighting input.'] }
  }
  function destroy() {
    if (state.destroyed) return
    uninstall(); releaseGpu(); callbacks.clear(); commandCallbacks.clear(); state.destroyed = true
  }
  const api = { install, uninstall, on, onCommand, getDiagnostics, findOpaqueTargets, readOpaqueColor, uploadOpaqueColor, destroy,
    setEnabled(value) { assertAlive(); enabled = !!value },
    get installed() { return state.installed }, get scene() { return scene }, get state() { return state } }
  return api
}
