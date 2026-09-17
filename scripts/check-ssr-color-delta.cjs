// B07 补充验收：SSR 关/开时基础 PBR 色差值是否满足 B03 门槛。
//
// 为什么需要这个脚本（主计划 B07 第 1 条的硬要求）：
// 「冻结现有命中置信度/边缘角度渐隐，建立白模绕行图像基准；**SSR 关/开时基础 PBR
// 色差值沿用 B03 门槛（≤0.01 绝对或 ≤2% 相对）**，不能只以『不变灰/不跳变』的
// 定性描述代替。」
//
// 门槛语义的澄清（重要，避免误判）：
//
// B03 门槛的原始表述是（主计划第 164 行）「**独立原生线性 HDR 对照**，不变的
// ≤0.01 绝对或 ≤2% 相对误差门槛」—— 它比较的是**延迟路径 vs 原生 PBR 重放**的
// 基础 PBR 值，而不是「SSR 开 vs 关的最终画面」。
//
// 后者本来就应当有明显差异：SSR 的作用正是把环境镜面项替换成屏幕空间结果。
// 实测接收端最大色差 0.084（相对 33%）—— 那是 SSR **正常起作用**的证据，
// 不是误差超限。若把它当门槛判定，就完全误解了该条。
//
// 因此本脚本分两部分，各自对应正确的语义：
//   A) 基础 PBR 一致性（B03 门槛的适用处）：SSR 关闭时，延迟路径的
//      reflectionSpecular 必须与原生 PBR 重放一致，误差 ≤0.01 绝对或 ≤2% 相对。
//      这证明「接管本身不引入色差」。
//   B) SSR 作用范围：SSR 开启后，
//      * 接收端必须确实改变（证明 SSR 在起作用，而非空转）；
//      * 非接收端必须逐位不变（证明 SSR 不污染其它像素）。
//   两条合起来才是「基础 PBR 色差满足门槛 + 不做多余改动」的完整证据。
//
// 两个实测前提（都曾导致阈值虚假通过）：
//   1. 不能用 `enabled:false` 作为「SSR 关」。`VisualPipeline` 会由
//      `screenSpaceReflectionEnabled` 推导 `depthPyramidEnabled`（:336），
//      关闭 SSR 会同时停用材质通道与 Hi-Z，两帧逐位相同（实测 maxAbs=0），
//      测的是「通道开关」而非色差。正确对照是保持通道开启、只用 `strength=0`
//      关闭 SSR 合成（ssrShaders143.js:169/185 提前返回 identity）。
//   2. 必须有真实命中。屏幕空间射线需要屏内可命中几何；实测用 B03 的玻璃夹具
//      （背面朝上的小平面）时 trace 置信度恒为 0（`maxAlpha=0`、`nonZero=0`），
//      色差**必然为 0**。因此本脚本复用 `stage1-scene.js` 的真实场景
//      （高金属低粗糙材质），并显式报告命中数、在命中不足时**失败**。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877
// B03 门槛（沿用，不放宽）。
const ABSOLUTE_TOLERANCE = 0.01
const RELATIVE_TOLERANCE = 0.02
// 命中数下限：低于此值说明「色差为 0」是因为没有可反射的东西。
const MIN_HITS = 100

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = {
    thresholds: { absolute: ABSOLUTE_TOLERANCE, relative: RELATIVE_TOLERANCE, minHits: MIN_HITS },
    semantics: 'A) base PBR parity (deferred vs native) must meet the B03 threshold; B) SSR must change receivers and leave non-receivers bit-identical',
    modes: [], pageErrors: []
  }
  try {
    for (const umd of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
      await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })
      if (umd) {
        await page.addScriptTag({ url: `http://127.0.0.1:${PORT}/build/0.1.0/CCR.min.js` })
        await page.evaluate(() => { window.fixture.CCR = window.CCR })
      }
      const result = await page.evaluate(async ({ umd, absoluteTolerance, relativeTolerance }) => {
        const C = Cesium, f = fixture
        const { startStage1Scene } = await import('/tests/rendering/stage1-scene.js')
        const { waitFrames } = await import('/tests/rendering/deferred-lighting-fixture.js')
        await startStage1Scene(f)
        const scene = f.viewer.scene
        const pipeline = f.pipeline
        const wait = n => waitFrames(scene, n, f.errors)
        pipeline.setOptions({ environment: false, clouds: false, shadows: false, antialiasing: 'off' })
        pipeline.setScreenSpaceAO({ enabled: false })
        await wait(35)
        // 高金属度 + 低粗糙度：让表面成为强反射接收端（否则没有可测的接收端）。
        for (const model of f.models) {
          for (const node of model._sceneGraph.components.nodes) {
            for (const primitive of node.primitives || []) {
              primitive.material.metallicRoughness.roughnessFactor = 0.12
              primitive.material.metallicRoughness.metallicFactor = 0.8
            }
          }
        }
        pipeline.setLighting({ mode: 'deferred' })
        await wait(20)

        const context = scene.context, gl = context._gl
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
        const target = new C.Texture({ context, width: w, height: h, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
        const framebuffer = new C.Framebuffer({ context, colorTextures: [target], destroyAttachments: false })
        const options = { viewport: new C.BoundingRectangle(0, 0, w, h), depthTest: { enabled: false },
          depthMask: false, blending: { enabled: false } }
        let input = null
        const probe = context.createViewportQuadCommand(
          'uniform sampler2D src;in vec2 v_textureCoordinates;void main(){out_FragColor=texture(src,v_textureCoordinates);}',
          { framebuffer, renderState: C.RenderState.fromCache(options), uniformMap: { src: () => input } })
        const read = src => {
          const rd = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), dr = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
          const cached = context._currentFramebuffer
          const v = C.BoundingRectangle.clone(context.uniformState.viewport)
          try {
            input = src; probe.execute(context)
            return context.readPixels({ framebuffer, width: w, height: h })
          } finally {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rd); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dr)
            context._currentFramebuffer = cached; context.uniformState.viewport = v
          }
        }
        // 线性 HDR 场景颜色（门槛以线性量表述，不读 8 位呈现）。
        const colour = () => read(scene._view.sceneFramebuffer._colorFramebuffer.getColorTexture(0))

        // 两侧都保持材质通道与 Hi-Z 开启，只切换 SSR 强度。
        pipeline.setScreenSpaceReflections({ enabled: true, distance: 300, thickness: 1, strength: 0 })
        await wait(20)
        const off = colour()
        const diagnosticsOff = pipeline.getScreenSpaceReflectionDiagnostics()
        const readiness = {
          materials: !!pipeline.getActiveMaterialChannels()?.getTextures(),
          ssr: diagnosticsOff.valid, ssrReason: diagnosticsOff.reason,
          lightingMode: pipeline.getLightingDiagnostics().activeMode
        }

        // --- A) 基础 PBR 一致性（B03 门槛的适用处）------------------------
        const deferredSpecular = read(pipeline.getActiveMaterialChannels().getTextures().reflectionSpecular)
        pipeline.setLighting({ mode: 'enhanced' })
        await wait(20)
        const nativeSpecular = read(pipeline.materialChannels.getTextures().reflectionSpecular)
        pipeline.setLighting({ mode: 'deferred' })
        await wait(20)

        let parityCompared = 0, parityFailures = 0, parityMaxAbsolute = 0, parityMaxRelative = 0
        for (let i = 0; i < nativeSpecular.length; i += 4) {
          if (!(nativeSpecular[i + 3] > 0.5 && deferredSpecular[i + 3] > 0.5)) continue
          parityCompared++
          for (let c = 0; c < 3; c++) {
            const a = nativeSpecular[i + c], b = deferredSpecular[i + c]
            const absolute = Math.abs(a - b)
            const relative = absolute / Math.max(Math.abs(a), Math.abs(b), 1e-6)
            if (absolute > parityMaxAbsolute) parityMaxAbsolute = absolute
            if (relative > parityMaxRelative) parityMaxRelative = relative
            if (!(absolute <= absoluteTolerance || relative <= relativeTolerance)) parityFailures++
          }
        }

        // --- B) SSR 作用范围 ----------------------------------------------
        pipeline.setScreenSpaceReflections({ enabled: true, distance: 300, thickness: 1, strength: 1 })
        await wait(24)
        const on = colour()
        const textures = pipeline.getActiveMaterialChannels().getTextures()
        const trace = read(pipeline.screenSpaceReflections.getReflectionTexture())
        const specular = read(textures.reflectionSpecular)

        let receiverChanged = 0, maxAbsoluteReceiver = 0, maxRelativeReceiver = 0
        let maxAbsoluteOther = 0, maxRelativeOther = 0
        let receiverPixels = 0, otherPixels = 0, hits = 0
        for (let i = 0; i < on.length; i += 4) {
          if (trace[i + 3] > 0) hits++
          const isReceiver = specular[i + 3] > 0.5
          if (isReceiver) receiverPixels++; else otherPixels++
          let changed = false
          for (let c = 0; c < 3; c++) {
            const a = off[i + c], b = on[i + c]
            const absolute = Math.abs(a - b)
            const relative = absolute / Math.max(Math.abs(a), Math.abs(b), 1e-6)
            if (absolute > 1e-6) changed = true
            if (isReceiver) {
              if (absolute > maxAbsoluteReceiver) maxAbsoluteReceiver = absolute
              if (relative > maxRelativeReceiver) maxRelativeReceiver = relative
            } else {
              if (absolute > maxAbsoluteOther) maxAbsoluteOther = absolute
              if (relative > maxRelativeOther) maxRelativeOther = relative
            }
          }
          if (changed && isReceiver) receiverChanged++
        }
        probe.shaderProgram.destroy(); C.RenderState.removeFromCache(options)
        framebuffer.destroy(); target.destroy()

        return {
          mode: umd ? 'umd' : 'source',
          size: [w, h], readiness,
          parity: { compared: parityCompared, failures: parityFailures,
            maxAbsolute: parityMaxAbsolute, maxRelative: parityMaxRelative,
            withinAbsolute: parityMaxAbsolute <= absoluteTolerance,
            withinRelative: parityMaxRelative <= relativeTolerance },
          scope: { hits, receiverPixels, otherPixels, receiverChanged,
            maxAbsoluteReceiver, maxRelativeReceiver, maxAbsoluteOther, maxRelativeOther },
          lightingSource: diagnosticsOff.lightingSource,
          errors: f.errors.slice()
        }
      }, { umd, absoluteTolerance: ABSOLUTE_TOLERANCE, relativeTolerance: RELATIVE_TOLERANCE })
      result.pageErrors = pageErrors
      report.pageErrors.push(...pageErrors)
      report.modes.push(result)
      await page.close()
    }

    fs.mkdirSync('docs/verification/stage1-B07', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B07/pbr-color-delta.json', JSON.stringify(report, null, 2))

    assert.deepEqual(report.pageErrors, [], 'no page errors')
    for (const item of report.modes) {
      assert.deepEqual(item.errors, [], `${item.mode}: no render errors`)
      assert.equal(item.readiness.materials, true, `${item.mode}: material channels must be active`)
      assert.equal(item.readiness.ssr, true, `${item.mode}: SSR must be valid (${item.readiness.ssrReason})`)
      assert.ok(item.scope.hits >= MIN_HITS,
        `${item.mode}: need at least ${MIN_HITS} reflection hits, got ${item.scope.hits}`)
      assert.ok(item.scope.receiverPixels > 0,
        `${item.mode}: need reflection receiver pixels, got ${item.scope.receiverPixels}`)

      // A) 基础 PBR 一致性满足 B03 门槛。
      assert.ok(item.parity.compared > 100,
        `${item.mode}: parity comparison needs enough specular pixels, got ${item.parity.compared}`)
      item.parity.passed = item.parity.withinAbsolute || item.parity.withinRelative
      assert.ok(item.parity.passed,
        `${item.mode}: deferred vs native base PBR must satisfy <=${ABSOLUTE_TOLERANCE} absolute or <=${RELATIVE_TOLERANCE} relative; got absolute ${item.parity.maxAbsolute}, relative ${item.parity.maxRelative}, failures ${item.parity.failures}`)

      // B) SSR 生效且不污染非接收端。
      assert.ok(item.scope.receiverChanged > 0,
        `${item.mode}: SSR must actually change receiver pixels, otherwise it is a no-op`)
      item.untouchedOutsideReceivers = item.scope.maxAbsoluteOther === 0
      assert.equal(item.untouchedOutsideReceivers, true,
        `${item.mode}: non-receiver pixels must be bit-identical, got max delta ${item.scope.maxAbsoluteOther}`)
    }
    fs.writeFileSync('docs/verification/stage1-B07/pbr-color-delta.json', JSON.stringify(report, null, 2))

    console.log(JSON.stringify(report.modes.map(m => ({
      mode: m.mode,
      parity: { compared: m.parity.compared, failures: m.parity.failures,
        maxAbsolute: Number(m.parity.maxAbsolute.toFixed(6)),
        maxRelative: Number(m.parity.maxRelative.toFixed(6)),
        withinAbsolute: m.parity.withinAbsolute, withinRelative: m.parity.withinRelative, passed: m.parity.passed },
      scope: { hits: m.scope.hits, receivers: m.scope.receiverPixels, receiverChanged: m.scope.receiverChanged,
        maxAbsoluteOther: m.scope.maxAbsoluteOther, untouchedOutsideReceivers: m.untouchedOutsideReceivers }
    })), null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
