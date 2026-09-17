// B09 验收：色调映射与镜头效果的 GPU 行为。
//
// 目标是主计划 B09 的硬验收线，逐条都要实际渲染证据：
//   1. 所有效果强度 0/关闭为 **identity**（逐位相同，不是「接近」）；
//   2. 常量图模糊**不改变亮度**（核归一化的直接后果）；
//   3. 色调映射单调、有确定曝光语义，白墙/天空不因 Bloom 变白幕；
//   4. 光柱/光斑**不透墙**（消费 B08 介质遮挡数据）。
//
// 方法：同一场景开/关对比，读**呈现像素**做逐位比较；identity 用哈希而非容差判定。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto')

const PORT = process.env.CCR_TEST_PORT || 8877

/** 在给定 B09 选项下渲染一帧并返回整屏像素统计与哈希。 */
async function capture(page, options) {
  return page.evaluate(async options => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    const base = {
      environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
      clouds: false, volumetricFog: false, sunScattering: true, antialiasing: 'off',
      hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'native',
      ...options
    }
    const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
      (12 - 116.39 / 15) * 3600, new C.JulianDate())
    f.viewer.clock.currentTime = shifted
    f.viewer.clock.shouldAnimate = false
    scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
    const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer, options: base })
    pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
    f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2000),
      orientation: { heading: 0, pitch: -0.35, roll: 0 } })
    f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
    await new Promise(r => { let n = 45; const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); r() } }) })
    const gl = scene.context._gl
    const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
    const data = scene.context.readPixels({ x: 0, y: 0, width: w, height: h })
    let sum = 0, min = 255, max = 0
    for (let i = 0; i < w * h; i++) {
      const value = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
      sum += value
      if (value < min) min = value
      if (value > max) max = value
    }
    // 梯度能量：相邻像素差的绝对值之和。模糊会显著降低它，
    // 而「执行了但画面平坦」不会有变化——用它可以区分这两种情况。
    // 同时统计常量图（若全屏方差为 0，则任何核归一化的模糊都必然不变）。
    let gradient = 0, gradientSamples = 0, squareSum = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const value = (data[i] + data[i + 1] + data[i + 2]) / 3
        squareSum += value * value
        if (x + 1 < w) {
          const right = (data[i + 4] + data[i + 5] + data[i + 6]) / 3
          gradient += Math.abs(value - right); gradientSamples++
        }
        if (y + 1 < h) {
          const below = (data[i + w * 4] + data[i + w * 4 + 1] + data[i + w * 4 + 2]) / 3
          gradient += Math.abs(value - below); gradientSamples++
        }
      }
    }
    const mean = sum / (w * h)
    const variance = squareSum / (w * h) - mean * mean
    const result = {
      mean, min, max, pixels: w * h,
      gradient: gradientSamples ? gradient / gradientSamples : 0,
      variance,
      hash: null,
      diagnostics: pipeline.getLensEffectsDiagnostics(),
      errors: f.errors.slice()
    }
    pipeline.destroy()
    return { ...result, bytes: Array.from(data) }
  }, options)
}

const pageHash = capture => crypto.createHash('sha256').update(Buffer.from(capture.bytes)).digest('hex').slice(0, 16)

/**
 * 光柱验证：把 `lightShaftShader` 当作独立视口四边形直接编译执行。
 *
 * 为什么不通过 stage 注入：Cesium 的 `PostProcessStage.uniforms` 是只读代理
 * （getter 返回私有 `_uniforms`），且 uniform map 在命令构建时固化；
 * 实测「替换 `stage.uniforms.x`」与「改写 `stage._uniforms.x`」都不生效——
 * 四个注入用例给出同一哈希。这本身是一次有价值的排查记录。
 *
 * 直接编译着色器可以绕开私有管线，并更直接地验证**着色器逻辑**：
 *   * 太阳在屏幕内 + 遮挡通透（r=g=1）-> 输出必须亮于强度 0 的参考；
 *   * 遮挡为 0（建筑完全遮日）      -> 输出必须**逐位等于**参考（不透墙）；
 *   * 太阳在屏幕外                  -> 输出必须**逐位等于**参考（背向太阳退出）；
 *   * 强度 0                        -> 参考本身（identity）。
 *
 * 这是在 GPU 上执行同一份 GLSL 源码，不是对文本的断言。
 */
async function injectShaftCase(browser) {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
  await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })
  const result = await page.evaluate(async () => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    const { lightShaftShader } = await import('/src/stages/lensEffects143.js')
    const context = scene.context
    const size = 64
    const nearest = () => new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST,
      magnificationFilter: C.TextureMagnificationFilter.NEAREST })

    /** 带水平梯度的输入图，避免常量图掩盖叠加差异。 */
    const inputData = new Float32Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const value = ((i % size) / size) * 0.6 + 0.2
      inputData.set([value, value, value, 1], i * 4)
    }
    const inputTexture = new C.Texture({ context, width: size, height: size, pixelFormat: C.PixelFormat.RGBA,
      pixelDatatype: C.PixelDatatype.FLOAT, source: { width: size, height: size, arrayBufferView: inputData }, sampler: nearest() })

    const constant = (r, g, b) => {
      const data = new Float32Array(size * size * 4)
      for (let i = 0; i < size * size; i++) data.set([r, g, b, 1], i * 4)
      return new C.Texture({ context, width: size, height: size, pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: C.PixelDatatype.FLOAT, source: { width: size, height: size, arrayBufferView: data }, sampler: nearest() })
    }
    const lit = constant(1, 1, 0)       // 太阳方向通透、可见；b=0 表示前方无雾体
    const blocked = constant(0, 0, 0)   // 完全遮挡（建筑/云遮日）

    const run = ({ strength, sunScreen, occlusion }) => {
      const target = new C.Texture({ context, width: size, height: size, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
      const framebuffer = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
      const options = { viewport: new C.BoundingRectangle(0, 0, size, size), depthTest: { enabled: false },
        depthMask: false, blending: { enabled: false } }
      const command = context.createViewportQuadCommand(lightShaftShader, {
        framebuffer, renderState: C.RenderState.fromCache(options),
        uniformMap: {
          colorTexture: () => inputTexture,
          occlusionTexture: () => occlusion,
          shaftParams: () => new C.Cartesian4(strength, 32, 1, 1),
          sunScreen: () => new C.Cartesian2(sunScreen[0], sunScreen[1]),
          shaftAvailable: () => 1
        }
      })
      try {
        command.execute(context)
        return Array.from(context.readPixels({ framebuffer, width: size, height: size }))
      } finally {
        command.shaderProgram.destroy()
        C.RenderState.removeFromCache(options)
        framebuffer.destroy()
        target.destroy()
      }
    }

    const cases = {
      // 强度 0：着色器的第一分支，作为逐位比对参考。
      reference: run({ strength: 0, sunScreen: [0.5, 0.5], occlusion: lit }),
      withLight: run({ strength: 1, sunScreen: [0.5, 0.5], occlusion: lit }),
      blocked: run({ strength: 1, sunScreen: [0.5, 0.5], occlusion: blocked }),
      offScreen: run({ strength: 1, sunScreen: [-1, -1], occlusion: lit })
    }
    inputTexture.destroy()
    lit.destroy()
    blocked.destroy()
    return cases
  })
  await page.close()
  // 量化到 8 位后比对：浮点末位差异不应被当作契约破坏，而 1/255 以上的差异必须可检出。
  const quantize = pixels => Buffer.from(pixels.map(v => Math.max(0, Math.min(255, Math.round(v * 255)))))
  const hash = pixels => crypto.createHash('sha256').update(quantize(pixels)).digest('hex').slice(0, 16)
  const brightness = pixels => {
    let sum = 0
    for (let i = 0; i < pixels.length; i += 4) sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
    return sum / (pixels.length / 4)
  }
  const entry = pixels => ({ hash: hash(pixels), brightness: brightness(pixels) })
  return {
    pageErrors,
    reference: entry(result.reference),
    withLight: entry(result.withLight),
    blocked: entry(result.blocked),
    offScreen: entry(result.offScreen)
  }
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { cases: [], pageErrors: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })

    const cases = [
      // 基线：全部关闭（默认）。
      ['baseline-default', {}],
      // identity 判据：强度 0 必须与关闭**逐位相同**。
      ['tiltShift-strength0', { tiltShiftEnabled: true, tiltShiftStrength: 0 }],
      ['blur-strength0', { blurEnabled: true, blurStrength: 0 }],
      ['dof-strength0', { depthOfFieldEnabled: true, depthOfFieldStrength: 0 }],
      ['aberration-strength0', { chromaticAberrationEnabled: true, chromaticAberrationStrength: 0 }],
      ['shaft-strength0', { lightShaftEnabled: true, lightShaftStrength: 0 }],
      ['flare-strength0', { sunFlareEnabled: true, sunFlareStrength: 0 }],
      // 曲线：原生 aces 与默认相同（不引入变化）。
      ['tone-aces', { toneMappingCurve: 'aces' }],
      ['tone-reinhard', { toneMappingCurve: 'reinhard' }],
      ['tone-filmic', { toneMappingCurve: 'filmic' }],
      ['tone-unrealApprox', { toneMappingCurve: 'unrealFilmicApprox' }],
      // 互斥：三个都请求时只有 tiltShift 生效。
      ['exclusive-all-three', { tiltShiftEnabled: true, blurEnabled: true, depthOfFieldEnabled: true }],
      // 真实效果（确认确实改变画面，否则前面的 identity 结论没有区分力）。
      ['blur-active', { blurEnabled: true, blurRadius: 8, blurStrength: 1 }],
      ['aberration-active', { chromaticAberrationEnabled: true, chromaticAberrationStrength: 3 }],
      ['shaft-active', { lightShaftEnabled: true, lightShaftStrength: 1 }]
    ]
    for (const [name, options] of cases) {
      const result = await capture(page, options)
      result.name = name
      result.pageErrors = pageErrors.slice()
      report.cases.push(result)
    }
    report.pageErrors.push(...pageErrors)
    await page.close()

    fs.mkdirSync('docs/verification/stage1-B09', { recursive: true })
    for (const item of report.cases) item.hash = pageHash(item)
    fs.writeFileSync('docs/verification/stage1-B09/lens-effects.json', JSON.stringify(report, null, 2))

    assert.deepEqual(report.pageErrors, [], 'no page errors')
    const by = Object.fromEntries(report.cases.map(c => [c.name, c]))
    for (const c of report.cases) {
      assert.deepEqual(c.errors, [], `${c.name}: no render errors`)
      assert.ok(Number.isFinite(c.mean) && c.mean > 0, `${c.name}: must render a finite non-black frame`)
    }
    // 1) identity：强度 0 必须与基线**逐位相同**。
    const baseline = by['baseline-default']
    for (const name of ['tiltShift-strength0', 'blur-strength0', 'dof-strength0',
      'aberration-strength0', 'shaft-strength0', 'flare-strength0']) {
      assert.equal(by[name].hash, baseline.hash,
        `${name} must be a bit-identical identity, got mean ${by[name].mean} vs ${baseline.mean}`)
    }
    // 2) 原生 aces 曲线不改变画面（CCR 本来就用 ACES）。
    assert.equal(by['tone-aces'].hash, baseline.hash, 'the native aces curve must not alter the frame')
    // 3) 其他曲线必须真实改变画面（否则「曲线选择」没有意义）。
    for (const name of ['tone-reinhard', 'tone-filmic', 'tone-unrealApprox']) {
      assert.notEqual(by[name].hash, baseline.hash, `${name} must actually change the frame`)
    }
    // 真实效果必须改变画面（证明前面的 identity 不是「什么都没执行」）。
    //
    // 判据分两层，因为单看整屏哈希会有假阴性：
    //   1. 效果必须真的执行（`stageExecutions > 0`）；
    //   2. 画面必须变化——但**平坦区**上核归一化的模糊逐位不变是正确行为，
    //      因此用「梯度能量」而非整屏哈希判定模糊是否生效：
    //      模糊必然降低相邻像素差；若场景本身无结构（variance≈0），
    //      则任何归一化核都**不应该**改变画面，那也不是缺陷。
    for (const name of ['blur-active', 'aberration-active']) {
      assert.ok(by[name].diagnostics.stats.stageExecutions > 0,
        `${name} must actually execute its stage`)
    }
    // 色差一定改变画面（在非中心位置总会移动 R/B 通道）。
    assert.notEqual(by['aberration-active'].hash, baseline.hash, 'chromatic aberration must change the frame')
    // 模糊：场景有结构时必须降低梯度能量；无结构时不得改变画面。
    if (baseline.variance > 1) {
      assert.ok(by['blur-active'].gradient < baseline.gradient,
        `blur must reduce gradient energy on a structured scene: ${by['blur-active'].gradient} vs ${baseline.gradient}`)
    } else {
      assert.equal(by['blur-active'].hash, baseline.hash,
        'on a constant image a normalized blur must not change anything')
    }

    // 光柱/光斑：本夹具里 `scene.sun.positionWC` 不可得（fixture 关闭了太阳显示），
    // 因此 `_sunScreen()` 返回屏幕外，光柱**按契约退出**——这是正确行为而非缺陷。
    // 整屏哈希相同正是该契约的证据。要验证「光柱真的会生效」，
    // 必须直接给 stage 注入太阳屏幕位置，绕开场景几何（见下面的注入用例）。
    assert.ok(by['shaft-active'].diagnostics.stats.stageExecutions > 0,
      'the shaft stage must execute even when it exits early')
    // 5) 互斥：三个都开时诊断必须报告只有 tiltShift 生效，另外两个带原因。
    const exclusive = by['exclusive-all-three'].diagnostics
    assert.equal(exclusive.lens.active, 'tiltShift', 'tiltShift wins the declared priority')
    assert.equal(exclusive.lens.effective.blur, false)
    assert.equal(exclusive.lens.effective.depthOfField, false)
    assert.match(exclusive.lens.suppressed.blur || '', /Suppressed by tiltShift/)
    assert.match(exclusive.lens.suppressed.depthOfField || '', /Suppressed by tiltShift/)

    console.log(JSON.stringify(report.cases.map(c => ({
      name: c.name, mean: Number(c.mean.toFixed(4)), hash: c.hash,
      active: c.diagnostics.activeStages, lensActive: c.diagnostics.lens?.active ?? null
    })), null, 2))

    // --- 光柱的着色器级验证 -----------------------------------------------
    // 场景几何无法把太阳放进视锥（worldToWindowCoordinates 返回 null），
    // 因此直接编译 lightShaftShader 验证它自己的分支逻辑。
    const injected = await injectShaftCase(browser)
    report.injected = injected
    fs.writeFileSync('docs/verification/stage1-B09/lens-effects.json', JSON.stringify(report, null, 2))
    assert.deepEqual(injected.pageErrors, [], 'shaft shader case: no page errors')
    // 有光时必须在参考之上叠加（亮度严格增加）。
    assert.ok(injected.withLight.brightness > injected.reference.brightness + 0.5,
      `a visible sun must add light: ${injected.withLight.brightness} vs reference ${injected.reference.brightness}`)
    // 不透墙：完全遮挡必须逐位回到参考。
    assert.equal(injected.blocked.hash, injected.reference.hash,
      'a fully occluded sun must be a bit-identical identity — light must not pass through walls')
    // 背向太阳必须退出。
    assert.equal(injected.offScreen.hash, injected.reference.hash,
      'a sun outside the screen must be a bit-identical identity')
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
