import { geometryEncodingShader } from './geometryEncoding.js'

let nextId = 0

const geometryShader = `
uniform sampler2D depthTexture;
uniform bool scopeValid;
in vec2 v_textureCoordinates;

bool eyePosition(vec2 uv, out vec3 positionEC) {
  positionEC = vec3(0.0);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return false;
  // PostProcessStage receives the raw depth-stencil texture, not packed globe depth.
  float rawDepth = texture(depthTexture, uv).r;
  if (!(rawDepth > 0.0 && rawDepth < 1.0)) return false;
  // The window entry point registers the screen reconstruction dependency in 1.143.
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth);
  if (abs(eye.w) < 1.0e-20) return false;
  positionEC = eye.xyz / eye.w;
  return positionEC.z < 0.0 && all(lessThan(abs(positionEC), vec3(1.0e30)));
}

bool tangent(vec3 center, vec3 before, bool hasBefore, vec3 after, bool hasAfter, out vec3 result) {
  result = vec3(0.0);
  if (!hasBefore && !hasAfter) return false;
  vec3 backward = center - before;
  vec3 forward = after - center;
  // Both candidates point in the positive screen axis direction.
  result = !hasAfter || (hasBefore && dot(backward, backward) < dot(forward, forward))
    ? backward : forward;
  float squaredLength = dot(result, result);
  if (!(squaredLength > 1.0e-12)) return false;
  result *= inversesqrt(squaredLength);
  return true;
}

void main() {
  out_FragColor = vec4(0.0);
  if (!scopeValid) return;
  vec2 uv = v_textureCoordinates;
  vec2 pixel = 1.0 / czm_viewport.zw;
  vec3 center, left, right, down, up;
  if (!eyePosition(uv, center)) return;
  bool hasLeft = eyePosition(uv - vec2(pixel.x, 0.0), left);
  bool hasRight = eyePosition(uv + vec2(pixel.x, 0.0), right);
  bool hasDown = eyePosition(uv - vec2(0.0, pixel.y), down);
  bool hasUp = eyePosition(uv + vec2(0.0, pixel.y), up);
  vec3 dx, dy;
  if (!tangent(center, left, hasLeft, right, hasRight, dx) ||
      !tangent(center, down, hasDown, up, hasUp, dy)) return;
  vec3 normalEC = cross(dx, dy);
  float squaredLength = dot(normalEC, normalEC);
  if (!(squaredLength > 1.0e-12)) return;
  normalEC *= inversesqrt(squaredLength);
  if (dot(normalEC, -center) < 0.0) normalEC = -normalEC;
  out_FragColor = encodeGeometry(normalEC, -center.z);
}`

const outputShader = `
uniform sampler2D colorTexture;
uniform sampler2D geometryTexture;
uniform bool scopeValid;
uniform int debugMode;
in vec2 v_textureCoordinates;
void main() {
  vec4 source = texture(colorTexture, v_textureCoordinates);
  out_FragColor = source;
  if (debugMode == 0 || !scopeValid) return;
  vec4 geometry = decodeGeometry(texture(geometryTexture, v_textureCoordinates));
  if (geometry.a <= 0.0) return;
  vec3 debugColor = debugMode == 1 ? geometry.rgb * 0.5 + 0.5 : vec3(clamp(geometry.a / 1000.0, 0.0, 1.0));
  out_FragColor = vec4(debugColor, source.a);
}`

function textureInfo(stage, bytesPerPixel) {
  const texture = stage && !stage.isDestroyed() && stage.enabled && stage.ready && stage.outputTexture
  if (!texture || texture.isDestroyed()) return null
  return { width: texture.width, height: texture.height, bytes: texture.width * texture.height * bytesPerPixel }
}

/** Opaque-depth geometry. Consumers must use the reported encoding and shared decoder. */
export default class ScreenSpaceGeometry143 {
  constructor(Cesium, scene) {
    if (!/^1\.143(?:\.0)?$/.test(Cesium.VERSION)) {
      throw new Error(`ScreenSpaceGeometry143 requires static Cesium 1.143; found ${Cesium.VERSION}`)
    }
    this.Cesium = Cesium
    this.scene = scene
    this.enabled = false
    this.debugMode = 'off'
    this.destroyed = false
    this.outputFrame = undefined
    const context = scene.context
    const packed = !!(context && context.webgl2 && context.halfFloatingPointTexture && context.colorBufferHalfFloat)
    this.encoding = packed ? 'oct-normal-depth-pair-v1' : 'rgb-normal-metres-v0'
    this.bytesPerPixel = packed ? 8 : 16
    const missing = (packed ? ['depthTexture'] : ['depthTexture', 'floatingPointTexture', 'colorBufferFloat'])
      .filter(capability => !scene.context || !scene.context[capability])
    this.supported = missing.length === 0
    this.unsupportedReason = missing.length ? `Missing ${missing.join(', ')}` : null
    if (!this.supported) return

    const name = `campus_geometry_143_${++nextId}`
    const preamble = `${packed ? '#define GEOMETRY_PACKED_V1\n' : ''}${geometryEncodingShader}\n`
    const scopeValid = () => this._scope().valid
    this.geometryStage = new Cesium.PostProcessStage({
      name: `${name}_data`,
      fragmentShader: preamble + geometryShader,
      uniforms: { scopeValid },
      textureScale: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: packed ? Cesium.PixelDatatype.HALF_FLOAT : Cesium.PixelDatatype.FLOAT,
      sampleMode: Cesium.PostProcessStageSampleMode.NEAREST,
      clearColor: Cesium.Color.TRANSPARENT
    })
    this.outputStage = new Cesium.PostProcessStage({
      name: `${name}_output`,
      fragmentShader: preamble + outputShader,
      uniforms: {
        geometryTexture: this.geometryStage.name,
        scopeValid,
        debugMode: () => ({ off: 0, normal: 1, depth: 2 })[this.debugMode]
      },
      textureScale: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE
    })
    this.composite = new Cesium.PostProcessStageComposite({
      name,
      stages: [this.geometryStage, this.outputStage],
      inputPreviousStageTexture: false
    })
    this.composite.enabled = false
    scene.postProcessStages.add(this.composite)
    const execute = this.geometryStage.execute, channel = this
    this.geometryStage.execute = function() {
      channel.outputFrame = undefined
      const result = execute.apply(this, arguments)
      if (channel._scope().valid && this.ready && this.outputTexture) channel.outputFrame = scene.frameState.frameNumber
      return result
    }
  }

  _scope() {
    const scene = this.scene
    if (this.destroyed || (scene.isDestroyed && scene.isDestroyed())) {
      return { valid: false, frustumCount: 0, reason: 'Destroyed' }
    }
    const list = scene._view && scene._view.frustumCommandsList
    const frustumCount = list ? list.length : 0
    let reason = this.unsupportedReason
    if (!reason && !this.enabled) reason = 'Disabled'
    if (!reason && scene.mode !== this.Cesium.SceneMode.SCENE3D) reason = 'Requires 3D scene'
    const frustum = scene.camera && scene.camera.frustum
    if (!reason && ((this.Cesium.OrthographicFrustum && frustum instanceof this.Cesium.OrthographicFrustum) ||
      (this.Cesium.OrthographicOffCenterFrustum && frustum instanceof this.Cesium.OrthographicOffCenterFrustum))) reason = 'Requires perspective camera'
    if (!reason && frustumCount !== 1) reason = 'Requires one current frustum'
    return { valid: !reason, frustumCount, reason }
  }

  setEnabled(enabled) {
    if (this.destroyed || !this.supported || (this.scene.isDestroyed && this.scene.isDestroyed())) return
    this.enabled = enabled === true
    if (!this.enabled) this.outputFrame = undefined
    // Cesium releases commands/textures on its next update after disabling.
    this.composite.enabled = this.enabled
    this.scene.requestRender()
  }

  setDebugMode(mode) {
    if (this.destroyed || !this.supported || (this.scene.isDestroyed && this.scene.isDestroyed())) return
    if (!['off', 'normal', 'depth'].includes(mode)) return
    this.debugMode = mode
    this.scene.requestRender()
  }

  getTexture() {
    if (!this._scope().valid || !this.geometryStage || !this.geometryStage.ready ||
      !this.scene.frameState || this.outputFrame !== this.scene.frameState.frameNumber) return null
    const texture = this.geometryStage.outputTexture
    return texture && !texture.isDestroyed() && texture.width === this.scene.drawingBufferWidth &&
      texture.height === this.scene.drawingBufferHeight ? texture : null
  }

  getDiagnostics() {
    const scope = this._scope()
    const alive = !this.destroyed && !(this.scene.isDestroyed && this.scene.isDestroyed())
    const width = alive ? this.scene.drawingBufferWidth || 0 : 0
    const height = alive ? this.scene.drawingBufferHeight || 0 : 0
    const geometryTexture = alive ? textureInfo(this.geometryStage, this.bytesPerPixel) : null
    const outputTexture = alive ? textureInfo(this.outputStage, 4) : null
    return {
      enabled: this.enabled && alive,
      supported: this.supported,
      debugMode: this.debugMode,
      encoding: this.encoding,
      ready: !!this.getTexture(),
      depthUnits: 'metres after decodeGeometry',
      ...scope,
      drawingBuffer: { width, height },
      geometryTexture,
      outputTexture,
      estimatedBytes: this.supported ? width * height * (this.bytesPerPixel + 4) : 0,
      // Active logical targets only: Cesium may share cache storage with other stages.
      // This is not a measurement of unique global GPU allocations or release timing.
      allocatedBytes: (geometryTexture ? geometryTexture.bytes : 0) + (outputTexture ? outputTexture.bytes : 0),
      allocationScope: 'active-logical-targets',
      names: this.composite ? { composite: this.composite.name, geometry: this.geometryStage.name,
        output: this.outputStage.name } : null
    }
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this.enabled = false
    const alive = !(this.scene.isDestroyed && this.scene.isDestroyed())
    if (this.composite && !this.composite.isDestroyed()) {
      const collection = this.scene.postProcessStages
      if (alive && collection && !collection.isDestroyed() && collection.contains(this.composite)) {
        collection.remove(this.composite)
      } else {
        this.composite.destroy()
      }
    }
    this.destroyed = true
    if (alive && this.supported) this.scene.requestRender()
  }
}
