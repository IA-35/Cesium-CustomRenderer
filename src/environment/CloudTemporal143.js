/*
 * Cloud variance clipping adapted from @takram/three-clouds:
 * packages/clouds/src/shaders/{cloudsResolve.frag,varianceClipping.glsl}
 * https://github.com/takram-design-engineering/three-geospatial
 * Copyright (c) 2024 Shota Matsuda. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { checkFramebufferComplete143 } from '../rhi/framebufferState143.js'

export const cloudTemporalResolveShader = `
precision highp sampler2D;
uniform sampler2D u_currentColor;
uniform sampler2D u_currentDepth;
uniform sampler2D u_historyColor;
uniform sampler2D u_historyDepth;
uniform mat4 u_inverseViewProjectionRelative;
uniform mat4 u_previousViewProjectionRelative;
uniform vec3 u_previousCameraOffset;
uniform bool u_historyValid;
uniform float u_currentWeight;
in vec2 v_textureCoordinates;

vec4 cloudSafeColor(vec4 color) {
  return vec4(max(color.rgb, vec3(0.0)), clamp(color.a, 0.0, 1.0));
}

// Upstream mean/variance clipping, with an independent scalar T bound. T is
// residual cloud transmittance here, rather than a scene alpha channel.
vec4 cloudVarianceClip(ivec2 coord, vec4 history) {
  ivec2 size = textureSize(u_currentColor, 0);
  vec3 moment1 = vec3(0.0), moment2 = vec3(0.0);
  float minimumT = 1.0, maximumT = 0.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec4 sampleColor = cloudSafeColor(texelFetch(u_currentColor, clamp(coord + ivec2(x, y), ivec2(0), size - 1), 0));
      moment1 += sampleColor.rgb;
      moment2 += sampleColor.rgb * sampleColor.rgb;
      minimumT = min(minimumT, sampleColor.a);
      maximumT = max(maximumT, sampleColor.a);
    }
  }
  vec3 mean = moment1 / 9.0;
  vec3 sigma = sqrt(max(moment2 / 9.0 - mean * mean, vec3(0.0)));
  vec3 extent = sigma + 1e-7;
  vec3 delta = history.rgb - mean;
  vec3 unit = abs(delta / extent);
  float maximum = max(unit.x, max(unit.y, unit.z));
  vec3 clipped = maximum > 1.0 ? mean + delta / maximum : history.rgb;
  return cloudSafeColor(vec4(clipped, clamp(history.a, minimumT, maximumT)));
}

void main() {
  vec2 uv = v_textureCoordinates;
  ivec2 coord = clamp(ivec2(gl_FragCoord.xy), ivec2(0), textureSize(u_currentColor, 0) - 1);
  vec4 current = cloudSafeColor(texelFetch(u_currentColor, coord, 0));
  out_FragColor = current;
  vec2 currentDepth = texelFetch(u_currentDepth, coord, 0).rg;
  if (!u_historyValid || currentDepth.r >= 19999999.0 || currentDepth.r <= 0.0) return;

  // z=0 avoids the infinite-far singularity. CPU subtraction of the camera
  // origin in homogeneous space preserves small rays at Earth-scale positions.
  vec4 relative = u_inverseViewProjectionRelative * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 ray = normalize(relative.xyz / relative.w);
  vec3 cloudPoint = ray * currentDepth.r;
  // Previous matrix already includes current-camera minus wind displacement.
  vec4 previousClip = u_previousViewProjectionRelative * vec4(cloudPoint, 1.0);
  if (previousClip.w <= 0.0) return;
  vec2 previousUv = previousClip.xy / previousClip.w * 0.5 + 0.5;
  if (any(lessThan(previousUv, vec2(0.0))) || any(greaterThanEqual(previousUv, vec2(1.0)))) return;
  float previousDepth = texture(u_historyDepth, previousUv).r;
  vec4 historySample = texture(u_historyColor, previousUv);
  float expectedDepth = length(cloudPoint + u_previousCameraOffset);
  // Filtered, resolved T is a history proxy; storing it again beside the
  // distance would duplicate color.a. Reject strong transmission changes before clipping.
  if (previousDepth >= 19999999.0 || previousDepth <= 0.0 ||
      abs(previousDepth - expectedDepth) > max(50.0, expectedDepth * 0.12) ||
      abs(historySample.a - current.a) > 0.2) return;

  vec4 history = cloudVarianceClip(coord, historySample);
  out_FragColor = cloudSafeColor(mix(history, current, u_currentWeight));
}
`

const copyDepthShader = `uniform highp sampler2D u_currentDepth;
in vec2 v_textureCoordinates;
void main() { out_FragColor = texture(u_currentDepth, v_textureCoordinates); }`
// 着色器预热用：两个全屏 pass 都在环境门控之后执行。
export const CLOUD_TEMPORAL_SHADERS = Object.freeze([cloudTemporalResolveShader, copyDepthShader])

// Independent cloud-only history: color.rgb is linear radiance, color.a is T;
// Input depth.r is weighted camera-ray distance in metres (20M means no cloud),
// .g T. History stores distance alone in R32F and reuses resolved color.a for T.
// Call only from the HDR color path after both cloud buffers have been rendered.
export default class CloudTemporal143 {
  constructor(C, scene) {
    this.C = C; this.scene = scene
    const context = scene.context
    this.supported = !!(context?.webgl2 && context.floatingPointTexture && context.colorBufferFloat)
    this.destroyed = false; this.valid = false; this.age = 0; this.active = 0
    this.resetReason = 'initial'; this.error = null; this.previous = null
    this.stats = { frames: 0, resets: 0, bypasses: 0, failures: 0 }
    this.targets = []; this.commands = []
    this.inverseRelative = new C.Matrix4(); this.previousRelative = new C.Matrix4()
    this.cameraOffset = new C.Cartesian3()
    this.linearSampler = new C.Sampler({ minificationFilter: context?.textureFloatLinear === false
      ? C.TextureMinificationFilter.NEAREST : C.TextureMinificationFilter.LINEAR,
    magnificationFilter: context?.textureFloatLinear === false ? C.TextureMagnificationFilter.NEAREST : C.TextureMagnificationFilter.LINEAR })
    this.nearestSampler = new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST,
      magnificationFilter: C.TextureMagnificationFilter.NEAREST })
  }

  reset(reason = 'manual') {
    this.valid = false; this.age = 0; this.previous = null
    this.resetReason = reason; this.stats.resets++
  }

  // Run before selecting a cloud sample jitter. False means this frame must
  // render a full fresh sample; execute also calls this for callers without jitter.
  prepare(frame, width, height) {
    if (this.destroyed) return false
    const previous = this.previous, C = this.C
    let reason
    this.frameReady = false
    if (this.scene.isDestroyed?.()) reason = 'scene-destroyed'
    else if (!frame?.cloudsActive) reason = 'inactive'
    else if (!this.supported) reason = 'unsupported'
    else if (this.scene.context._gl.isContextLost()) reason = 'context-lost'
    else if (!(width > 0 && height > 0)) reason = 'invalid-size'
    else if (!frame.inverseViewProjection || !frame.viewProjection || !frame.positionWC || !frame.directionWC ||
      !frame.windOffsetWC || !Number.isFinite(frame.simulationSeconds)) reason = 'invalid-frame'
    else this.frameReady = true
    if (this.frameReady && this.valid && previous) {
      const number = frame.frameNumber ?? this.scene.frameState.frameNumber
      if (previous.width !== width || previous.height !== height) reason = 'resize'
      else if (previous.resetKey !== frame.resetKey) reason = 'reset-key'
      else if (number !== previous.frameNumber + 1) reason = 'frame-gap'
      else if (frame.simulationSeconds < previous.simulationSeconds || frame.simulationSeconds - previous.simulationSeconds > 0.5) reason = 'time-jump'
      else if (C.Cartesian3.distance(frame.positionWC, previous.positionWC) > 500) reason = 'camera-jump'
      else if (C.Cartesian3.dot(frame.directionWC, previous.directionWC) < 0.95) reason = 'camera-rotation'
    }
    if (reason) this.reset(reason)
    return this.valid
  }

  _releaseTargets() {
    for (const target of this.targets) {
      for (const key of ['colorFramebuffer', 'depthFramebuffer', 'color', 'depth']) {
        if (target[key] && !target[key].isDestroyed()) target[key].destroy()
      }
    }
    this.targets = []; this.size = null
    if (this.renderState) this.C.RenderState.removeFromCache(this.renderState)
    this.renderState = undefined
  }

  _ensure(context, width, height) {
    const size = `${width}x${height}`
    if (size === this.size) return
    this._releaseTargets()
    const C = this.C, colorType = context.halfFloatingPointTexture && context.colorBufferHalfFloat
      ? C.PixelDatatype.HALF_FLOAT : C.PixelDatatype.FLOAT
    for (let i = 0; i < 2; i++) {
      const target = {}; this.targets.push(target)
      target.color = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: colorType, sampler: this.linearSampler })
      target.depth = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RED,
        pixelDatatype: C.PixelDatatype.FLOAT, sampler: this.nearestSampler })
      for (const key of ['color', 'depth']) {
        const framebuffer = new C.Framebuffer({ context, colorTextures: [target[key]], destroyAttachments: false })
        target[`${key}Framebuffer`] = framebuffer
        if (!checkFramebufferComplete143(context, framebuffer)) throw new Error('Cloud history framebuffer incomplete')
      }
    }
    this.renderState = C.RenderState.fromCache({ viewport: new C.BoundingRectangle(0, 0, width, height), depthTest: { enabled: false }, depthMask: false })
    this.size = size
    if (this.commands.length < 2) {
      const uniformMap = {
        u_currentColor: () => this.inputColor, u_currentDepth: () => this.inputDepth,
        u_historyColor: () => this.historyColor, u_historyDepth: () => this.historyDepth,
        u_historyValid: () => this.valid, u_currentWeight: () => Math.max(0.08, 1 / (this.age + 1)),
        u_inverseViewProjectionRelative: () => this.inverseRelative,
        u_previousViewProjectionRelative: () => this.previousRelative,
        u_previousCameraOffset: () => this.cameraOffset
      }
      if (!this.commands[0]) this.commands.push(context.createViewportQuadCommand(cloudTemporalResolveShader, { uniformMap }))
      if (!this.commands[1]) this.commands.push(context.createViewportQuadCommand(copyDepthShader, { uniformMap: { u_currentDepth: uniformMap.u_currentDepth } }))
    }
  }

  _matrices(frame) {
    const C = this.C, position = frame.positionWC
    C.Matrix4.clone(frame.inverseViewProjection, this.inverseRelative)
    // translate(-camera) * inverseVP, evaluated in JS double precision.
    for (let column = 0; column < 4; column++) {
      const i = column * 4, w = this.inverseRelative[i + 3]
      this.inverseRelative[i] -= position.x * w
      this.inverseRelative[i + 1] -= position.y * w
      this.inverseRelative[i + 2] -= position.z * w
    }
    const previous = this.previous
    if (!previous) {
      C.Matrix4.clone(frame.viewProjection, this.previousRelative)
      C.Cartesian3.clone(C.Cartesian3.ZERO, this.cameraOffset)
      return
    }
    const origin = C.Cartesian3.subtract(frame.windOffsetWC, previous.windOffsetWC, new C.Cartesian3())
    C.Cartesian3.subtract(position, origin, origin)
    C.Cartesian3.subtract(origin, previous.positionWC, this.cameraOffset)
    // multiplyByTranslation assumes an affine matrix and preserves m[15]; a
    // view-projection is projective, so its homogeneous translation needs the
    // full multiply (including clip.w) for camera-motion rejection to work.
    C.Matrix4.multiply(previous.viewProjection, C.Matrix4.fromTranslation(origin), this.previousRelative)
  }

  execute(context, color, depth, frame) {
    if (this.destroyed) return color
    this.prepare(frame, color?.width, color?.height)
    if (!this.frameReady || !depth || depth.width !== color.width || depth.height !== color.height) {
      this.reset(!depth ? 'missing-depth' : this.frameReady ? 'depth-size' : this.resetReason)
      this.stats.bypasses++; return color
    }
    // Duplicate callbacks cannot seed a history from the same frame twice.
    if (this.resetReason === 'frame-gap' && (frame.frameNumber ?? this.scene.frameState.frameNumber) === this.lastOutputFrame) { this.stats.bypasses++; return color }
    const C = this.C, gl = context._gl
    const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
    const cached = context._currentFramebuffer
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    try {
      this._ensure(context, color.width, color.height)
      // Framebuffer.status binds/unbinds raw GL without updating Cesium's
      // binding cache. The first draw must bind again after target creation.
      context._currentFramebuffer = undefined
      const target = this.targets[this.active], history = this.targets[1 - this.active]
      // Cesium stages can overwrite the sampler of an input texture; restore
      // cloud history filtering explicitly, as the scene TAA history does.
      history.color.sampler = this.linearSampler
      history.depth.sampler = this.nearestSampler
      this.inputColor = color; this.inputDepth = depth
      this.historyColor = this.valid ? history.color : color
      this.historyDepth = this.valid ? history.depth : depth
      this._matrices(frame)
      const passState = new C.PassState(context)
      passState.viewport = new C.BoundingRectangle(0, 0, color.width, color.height)
      for (let i = 0; i < this.commands.length; i++) {
        const command = this.commands[i]
        command.framebuffer = passState.framebuffer = i === 0 ? target.colorFramebuffer : target.depthFramebuffer
        command.renderState = this.renderState
        command.execute(context, passState)
      }
      this.previous = { width: color.width, height: color.height, resetKey: frame.resetKey,
        frameNumber: frame.frameNumber ?? this.scene.frameState.frameNumber, simulationSeconds: frame.simulationSeconds,
        viewProjection: C.Matrix4.clone(frame.viewProjection), positionWC: C.Cartesian3.clone(frame.positionWC),
        directionWC: C.Cartesian3.clone(frame.directionWC), windOffsetWC: C.Cartesian3.clone(frame.windOffsetWC) }
      this.lastOutputFrame = this.previous.frameNumber
      this.active = 1 - this.active; this.valid = true; this.age++; this.stats.frames++; this.error = null
      return target.color
    } catch (error) {
      this.error = error.message; this.stats.failures++; this.stats.bypasses++
      this.reset('execution-failed'); this._releaseTargets()
      return color
    } finally {
      context.uniformState.viewport = viewport
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
      context._currentFramebuffer = cached
    }
  }

  getDiagnostics() {
    return { supported: this.supported, enabled: !this.destroyed && this.supported, valid: this.valid,
      age: this.age, resetReason: this.resetReason, size: this.size || null, error: this.error,
      stats: { ...this.stats }, depthFormat: this.targets.length ? 'r32f' : null, transmittanceHistory: 'resolved-color-alpha',
      bytes: this.targets.reduce((sum, t) => sum + (t.color?.sizeInBytes || 0) + (t.depth?.sizeInBytes || 0), 0),
      rejectionMetrics: 'Per-pixel rejection is performed in the shader; no GPU rejection counter is collected.' }
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    if (this.destroyed) return
    this.reset('destroyed'); this._releaseTargets()
    for (const command of this.commands) if (command.shaderProgram && !command.shaderProgram.isDestroyed()) command.shaderProgram.destroy()
    this.commands = []; this.inputColor = this.inputDepth = this.historyColor = this.historyDepth = undefined
    this.destroyed = true
  }
}
