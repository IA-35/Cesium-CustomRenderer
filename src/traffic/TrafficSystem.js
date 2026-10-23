import { prepareTrafficRoutes, sampleTrafficRoute } from './trafficRoute.js'
import { prepareTrafficNetwork } from './trafficNetwork.js'
import TrafficSimulation from './TrafficSimulation.js'

const fetchJson = async (url, signal) => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Traffic resource request failed (${response.status}): ${url}`)
  return response.json()
}

export default class TrafficSystem {
  constructor(options) {
    if (!options?.Cesium || !options.viewer?.scene) throw new Error('TrafficSystem requires Cesium and viewer')
    this.C = options.Cesium
    this.viewer = options.viewer
    this.scene = this.viewer.scene
    this.pipeline = options.pipeline
    this.now = options.now || (() => performance.now())
    this.visible = options.show !== false
    this.playing = options.playing !== false
    this.speedMultiplier = 1
    this.elapsedSeconds = 0
    this.state = 'loading'
    this.destroyed = false
    this.error = null
    this.vehicles = []
    this.routes = new Map()
    this.network = null
    this.simulation = null
    this.respawnErrors = []
    this._waiters = new Set()
    this._abort = new AbortController()
    const base = typeof document !== 'undefined' ? document.baseURI : undefined
    this.manifestUrl = options.manifestUrl ? new URL(options.manifestUrl, base).href : undefined
    this.readyPromise = this._load(options)
  }

  _assertLoading() {
    if (this.destroyed) throw new Error('TrafficSystem destroyed while loading')
    if (this.state === 'error') throw new Error(this.error)
  }

  async _load(options) {
    try {
      const data = this.manifestUrl
        ? await (options.fetchJson || fetchJson)(this.manifestUrl, this._abort.signal) : options
      this._assertLoading()
      if (this.manifestUrl && data.schemaVersion !== 1) throw new Error('Invalid traffic manifest schemaVersion')
      if (data.routes && data.network) throw new Error('Traffic manifest must supply routes or network, not both')
      const routeOptions = { scene: this.scene, clampToGround: options.clampToGround === true,
        objectsToExclude: options.objectsToExclude }
      const network = data.network ? await prepareTrafficNetwork(this.C, data.network, routeOptions) : null
      const routes = network ? network.routes : await prepareTrafficRoutes(this.C, data.routes, routeOptions)
      this._assertLoading()
      this.routes = routes
      this.network = network
      if (!Array.isArray(data.vehicles) || !data.vehicles.length) throw new Error('Traffic manifest requires vehicles')
      const ids = new Set(), counts = new Map()
      for (const vehicle of data.vehicles) counts.set(vehicle.routeId, (counts.get(vehicle.routeId) || 0) + 1)
      const indices = new Map()
      this.vehicles = data.vehicles.map(vehicle => {
        const route = this.routes.get(vehicle.routeId), speed = vehicle.speed ?? 8, scale = vehicle.scale ?? 1
        const length = vehicle.length ?? 4.5, width = vehicle.width ?? 1.8
        if (typeof vehicle.id !== 'string' || !vehicle.id || ids.has(vehicle.id) || !route ||
          typeof vehicle.url !== 'string' || !vehicle.url || !Number.isFinite(speed) || speed < 0 ||
          !Number.isFinite(scale) || scale <= 0 ||
          !Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0 ||
          ['offset', 'headingOffset', 'heightOffset'].some(key => vehicle[key] !== undefined && !Number.isFinite(vehicle[key]))) {
          throw new Error(`Invalid or duplicate traffic vehicle: ${vehicle.id}`)
        }
        ids.add(vehicle.id)
        const index = indices.get(vehicle.routeId) || 0
        indices.set(vehicle.routeId, index + 1)
        return { id: vehicle.id, route, speed, scale, length, width, heightOffset: vehicle.heightOffset ?? 0,
          distance: vehicle.offset ?? index * route.length / counts.get(vehicle.routeId),
          url: new URL(vehicle.url, this.manifestUrl || (typeof document !== 'undefined' ? document.baseURI : undefined)).href,
          position: new this.C.Cartesian3(), direction: new this.C.Cartesian3(), normal: new this.C.Cartesian3(),
          rotation: new this.C.Matrix3(), heading: this.C.Matrix3.fromRotationZ(vehicle.headingOffset ?? 0), model: null }
      })
      let preparationStart = performance.now()
      this.simulation = new TrafficSimulation(this.C, this.vehicles, this.network, async () => {
        this._assertLoading()
        if (performance.now() - preparationStart < 4) return
        await new Promise(resolve => setTimeout(resolve, 0))
        this._assertLoading()
        preparationStart = performance.now()
      })
      await this.simulation.readyPromise
      // 等前一辆实际 ready 后再创建下一辆，避免入场后集中上传车型。
      for (const vehicle of this.vehicles) {
        this._assertLoading()
        await this._createModel(vehicle)
      }
      this._assertLoading()
      this.state = 'ready'
      this._lastTime = this.now()
      this._removeUpdate = this.scene.preUpdate.addEventListener(() => this._update())
      if (typeof document !== 'undefined') {
        this._resetTime = () => { this._lastTime = this.now() }
        document.addEventListener('visibilitychange', this._resetTime)
      }
      this._invalidateShadows()
      this.scene.requestRender()
      return this
    } catch (error) {
      if (!this.destroyed) { this.state = 'error'; this.error = error.message }
      this._cancelWaiters(error)
      this._releaseModels()
      throw error
    }
  }

  async _createModel(vehicle) {
    const generation = vehicle.generation
    const model = await this.C.Model.fromGltfAsync({ url: vehicle.url, scene: this.scene,
      scale: vehicle.scale, shadows: this.C.ShadowMode.ENABLED,
      modelMatrix: new this.C.Matrix4(),
      id: { type: 'traffic', id: vehicle.id, generation, routeId: vehicle.route.id },
      incrementallyLoadTextures: false })
    if (this.destroyed || this.state === 'error' || this.viewer.isDestroyed() || generation !== vehicle.generation) {
      model.destroy(); this._assertLoading(); throw new Error('Traffic vehicle retired while loading')
    }
    vehicle.model = model
    model.show = this.visible && vehicle.state === 'driving'
    this._place(vehicle)
    this.scene.primitives.add(model)
    this.scene.requestRender()
    await this._waitForModel(model)
    this._assertLoading()
    return model
  }

  async _respawn(vehicle) {
    try {
      if (!vehicle.model) await this._createModel(vehicle)
      if (this.destroyed || this.state !== 'ready' || vehicle.state !== 'spawning') return
      this.simulation.activate(vehicle)
      vehicle.model.id = { type: 'traffic', id: vehicle.id, generation: vehicle.generation, routeId: vehicle.route.id }
      vehicle.model.show = this.visible && vehicle.state === 'driving'
      this._place(vehicle)
      this._invalidateShadows(); this.scene.requestRender()
    } catch (error) {
      if (this.destroyed || this.state === 'error') return
      this._releaseModel(vehicle)
      vehicle.state = 'error'; vehicle.currentSpeed = 0
      this.respawnErrors.push({ id: vehicle.id, generation: vehicle.generation, error: error.message })
      this.scene.requestRender()
    }
  }

  _waitForModel(model) {
    if (model.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const removers = []
      const finish = error => {
        if (settled) return
        settled = true; clearTimeout(timer)
        removers.forEach(remove => remove())
        this._waiters.delete(finish)
        error ? reject(error) : resolve()
      }
      const timer = setTimeout(() => finish(new Error('Traffic model initialization timed out')), 90000)
      this._waiters.add(finish)
      removers.push(model.readyEvent.addEventListener(() => finish()))
      removers.push(model.errorEvent.addEventListener(error => finish(error)))
      removers.push(this.scene.postRender.addEventListener(() => this.scene.requestRender()))
    })
  }

  _place(vehicle) {
    const C = this.C
    sampleTrafficRoute(C, vehicle.route, vehicle.distance, vehicle.position, vehicle.direction)
    if (vehicle.heightOffset) {
      C.Ellipsoid.WGS84.geodeticSurfaceNormal(vehicle.position, vehicle.normal)
      C.Cartesian3.multiplyByScalar(vehicle.normal, vehicle.heightOffset, vehicle.normal)
      C.Cartesian3.add(vehicle.position, vehicle.normal, vehicle.position)
    }
    C.Transforms.rotationMatrixFromPositionVelocity(vehicle.position, vehicle.direction, C.Ellipsoid.WGS84, vehicle.rotation)
    C.Matrix3.multiply(vehicle.rotation, vehicle.heading, vehicle.rotation)
    C.Matrix4.fromRotationTranslation(vehicle.rotation, vehicle.position, vehicle.model.modelMatrix)
    if (vehicle.model.id?.type === 'traffic') vehicle.model.id.routeId = vehicle.route.id
    vehicle._renderRoute = vehicle.route
    vehicle._renderDistance = vehicle.distance
  }

  _update() {
    if (this.destroyed || this.state !== 'ready') return
    const now = this.now(), seconds = Math.max(0, (now - this._lastTime) / 1000)
    this._lastTime = now
    if (!this.playing || !this.visible || (typeof document !== 'undefined' && document.hidden)) return
    this.elapsedSeconds += seconds
    const events = this.simulation.advance(seconds * this.speedMultiplier)
    let moved = events.length > 0
    for (const event of events) {
      if (event.type === 'despawn') this._releaseModel(event.vehicle)
      else if (event.type === 'spawn') this._respawn(event.vehicle)
    }
    for (const vehicle of this.vehicles) {
      if (!vehicle.model || vehicle.state !== 'driving') continue
      if (vehicle._renderRoute !== vehicle.route || vehicle._renderDistance !== vehicle.distance) {
        this._place(vehicle); moved = true
      }
    }
    for (const vehicle of this.vehicles) if (vehicle.model) vehicle.model.show = this.visible && vehicle.state === 'driving'
    // Vehicles move every frame, so the caster signature is stale every frame. Use the
    // deferred form: it drops the cached signature but leaves the redraw rate to
    // shadowUpdateInterval. Asking for an immediate redraw here pinned
    // forceShadowUpdate and made the shadow pass redraw on every frame, which cost the
    // campus scene about 37 FPS (22.7 -> 59.9 measured) and made
    // shadowUpdateInterval unreachable whenever traffic was playing.
    if (moved) this._invalidateShadows({ immediate: false })
    if (this.speedMultiplier > 0 && this.vehicles.some(vehicle => vehicle.speed > 0 && vehicle.state !== 'error')) this.scene.requestRender()
  }

  _invalidateShadows(options) {
    if (this.pipeline && !this.pipeline.destroyed) this.pipeline.invalidateShadows(options)
  }

  play() {
    if (this.destroyed) return
    if (this.playing) { this.scene.requestRender(); return }
    this._lastTime = this.now(); this.playing = true; this.scene.requestRender()
  }
  pause() {
    if (this.destroyed) return
    this._update(); this.playing = false; this.scene.requestRender()
  }
  setSpeed(value) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Traffic speed multiplier must be a non-negative number')
    if (this.destroyed) return
    this._update(); this.speedMultiplier = value; this.scene.requestRender()
  }
  setVisible(value) {
    if (this.destroyed) return
    this._update(); this.visible = value === true; this._lastTime = this.now()
    for (const vehicle of this.vehicles) if (vehicle.model) vehicle.model.show = this.visible && vehicle.state === 'driving'
    this._invalidateShadows(); this.scene.requestRender()
  }
  getDiagnostics() {
    return { ...this.simulation?.getDiagnostics(), backend: 'cesium-model', state: this.state, visible: this.visible, playing: this.playing,
      speedMultiplier: this.speedMultiplier, elapsedSeconds: this.elapsedSeconds,
      vehicles: this.vehicles.length, readyModels: this.vehicles.filter(vehicle => vehicle.model?.ready).length,
      activeVehicles: this.vehicles.filter(vehicle => vehicle.state === 'driving' && vehicle.model?.ready).length,
      respawnErrors: [...this.respawnErrors],
      routes: [...this.routes.values()].map(route => ({ id: route.id, length: route.length })), error: this.error }
  }

  _cancelWaiters(error) { for (const finish of [...this._waiters]) finish(error) }
  _releaseModel(vehicle) {
    if (!vehicle.model) return
    if (!this.viewer.isDestroyed()) this.scene.primitives.remove(vehicle.model)
    if (!vehicle.model.isDestroyed()) vehicle.model.destroy()
    vehicle.model = null
  }
  _releaseModels() { for (const vehicle of this.vehicles) this._releaseModel(vehicle) }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true; this.state = 'destroyed'
    this._abort.abort(); this._removeUpdate?.()
    if (this._resetTime) document.removeEventListener('visibilitychange', this._resetTime)
    this._cancelWaiters(new Error('TrafficSystem destroyed while loading'))
    this._releaseModels(); this._invalidateShadows()
    this.simulation?.destroy()
    this.network = null
    this.routes.clear(); this.vehicles = []
    if (!this.viewer.isDestroyed()) this.scene.requestRender()
  }
}

export const createTrafficSystem = options => new TrafficSystem(options)
