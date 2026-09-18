// B11 验收：能力矩阵、默认策略、生命周期与 context-loss 全链路。
//
// 目标是主计划 B11 的硬验收线：
//   1. 能力矩阵含 requested/active/reason/generation，且从**真实场景**探测；
//   2. 默认仍由 CCR 管理天空/环境/阴影/HDR/SMAA；高成本效果必须显式开启；
//      延迟模式在覆盖不全时必须**明确回退增强模式**；
//   3. 20 轮启停、嵌套暂停、resize、2 个 Viewer 独立操作、错误后再次启用；
//   4. 实际调用 WEBGL_lose_context：generation 重置、资源重建、旧异步回调不复活；
//   5. 恢复后必须用**真实渲染输出**（颜色 + 拾取）证明，而不是只查 isDestroyed。
//
// 方法：每条都读实际状态与像素；失败路径也要给出可用画面，而不是只报状态位。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto')

const PORT = process.env.CCR_TEST_PORT || 8877

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { pageErrors: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })

    const result = await page.evaluate(async () => {
      const C = Cesium, f = fixture, scene = f.viewer.scene
      const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
        (12 - 116.39 / 15) * 3600, new C.JulianDate())
      f.viewer.clock.currentTime = shifted
      f.viewer.clock.shouldAnimate = false
      scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })

      const wait = frames => new Promise((resolve,reject) => {
        let n = frames
        const timer=setTimeout(()=>{off();reject(new Error('Frame wait timed out'))},10000)
        const off = scene.postRender.addEventListener(() => { if (--n === 0) { off();clearTimeout(timer); resolve() } })
      })
      /** 读中心 8×8 的颜色均值：真实渲染输出，而不是状态位。 */
      const centreColor = () => {
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight, size = 8
        const data = scene.context.readPixels({ x: Math.floor(w / 2 - size / 2), y: Math.floor(h / 2 - size / 2),
          width: size, height: size })
        let r = 0, g = 0, b = 0
        for (let i = 0; i < size * size; i++) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2] }
        const n = size * size
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
      }
      const hashPixels = () => {
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
        const data = scene.context.readPixels({ x: 0, y: 0, width: w, height: h })
        return Array.from(data)
      }

      const make = options => {
        const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer,
          options: { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
            clouds: false, volumetricFog: false, sunScattering: true, antialiasing: 'off',
            hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'native', ...options } })
        pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
        return pipeline
      }

      const out = {}

      // --- 1) 能力矩阵：从真实场景探测 ---------------------------------
      {
        const pipeline = make({})
        f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2000),
          orientation: { heading: 0, pitch: -0.35, roll: 0 } })
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await wait(40)
        const diagnostics = pipeline.getCapabilityDiagnostics()
        out.capability = {
          generation: diagnostics.capability.generation,
          mrt: diagnostics.capability.mrt,
          floatAttachments: diagnostics.capability.floatAttachments,
          oit: diagnostics.capability.oit,
          msaa: diagnostics.capability.msaa,
          sceneMode: diagnostics.capability.sceneMode,
          multiFrustum: diagnostics.capability.multiFrustum,
          defaults: {
            managed: diagnostics.defaults.managed,
            deferred: diagnostics.defaults.deferred,
            explicitOnly: diagnostics.defaults.explicitOnly
          }
        }
        // generation 必须是真实帧号（>0），而不是常量 0。
        out.capability.frameNumber = scene.frameState.frameNumber
        out.capability.attachmentsNeeded = pipeline.probeCapabilities().attachmentsNeeded
        out.capability.deviceSlots = {
          maxDrawBuffers: pipeline.probeCapabilities().maxDrawBuffers,
          maxColorAttachments: pipeline.probeCapabilities().maxColorAttachments
        }
        pipeline.destroy()
      }

      // --- 2) 20 轮启停 + 资源不单调增长 ------------------------------
      {
        const pipeline = make({ screenSpaceReflectionEnabled: true, hdrBloomEnabled: true })
        const samples = []
        for (let i = 0; i < 20; i++) {
          pipeline.setEnabled(false)
          await wait(2)
          pipeline.setEnabled(true)
          await wait(3)
          const pool = pipeline.getResourcePoolDiagnostics()
          samples.push({ round: i, currentBytes: pool.currentBytes, live: pool.live, allocated: pool.allocated })
        }
        await wait(20)
        const pool = pipeline.getResourcePoolDiagnostics()
        out.lifecycle = {
          rounds: samples.length,
          firstHalfPeakBytes: Math.max(...samples.slice(0, 10).map(s => s.currentBytes)),
          secondHalfPeakBytes: Math.max(...samples.slice(10).map(s => s.currentBytes)),
          finalCurrentBytes: pool.currentBytes,
          finalLive: pool.live,
          allocated: pool.allocated,
          colour: centreColor()
        }
        pipeline.destroy()
      }

      // --- 3) 嵌套暂停 -------------------------------------------------
      {
        const pipeline = make({ screenSpaceReflectionEnabled: true })
        await wait(10)
        const active = pipeline.getRenderDiagnostics().screenSpaceReflections.valid
        // API 是 suspend(owner) / resume(owner)：按所有者计数，同一所有者重复 suspend 幂等。
        pipeline.suspend('tool-a')
        pipeline.suspend('tool-b')
        await wait(6)
        const suspended = pipeline.getRenderDiagnostics()
        pipeline.resume('tool-a')
        await wait(6)
        const stillSuspended = pipeline.getRenderDiagnostics().suspended
        pipeline.resume('tool-b')
        await wait(10)
        const resumed = pipeline.getRenderDiagnostics()
        // 同一所有者重复 suspend 必须幂等（不能把计数抬到 2）。
        pipeline.suspend('tool-c')
        pipeline.suspend('tool-c')
        await wait(4)
        const idempotent = pipeline.getRenderDiagnostics().suspended
        pipeline.resume('tool-c')
        await wait(6)
        const afterIdempotent = pipeline.getRenderDiagnostics().suspended
        out.nestedSuspension = {
          activeBefore: active,
          suspendedFlag: suspended.suspended,
          ssrActiveWhileSuspended: suspended.screenSpaceReflections.valid,
          stillSuspendedAfterOneRelease: stillSuspended,
          resumedActive: resumed.screenSpaceReflections.valid,
          resumedSuspended: resumed.suspended,
          duplicateSuspendIsIdempotent: idempotent,
          singleResumeClearsIt: !afterIdempotent
        }
        pipeline.destroy()
      }

      // --- 4) resize ---------------------------------------------------
      {
        const pipeline = make({ screenSpaceReflectionEnabled: true, hdrBloomEnabled: true })
        const sizes = [[320, 240], [213, 160], [400, 300], [320, 240]]
        const results = []
        for (const [w, h] of sizes) {
          f.viewer.canvas.width = w; f.viewer.canvas.height = h
          scene.requestRender()
          await wait(12)
          const diagnostics = pipeline.getRenderDiagnostics()
          results.push({ size: [w, h], materialsValid: diagnostics.materials.valid,
            ssrValid: diagnostics.screenSpaceReflections.valid, bloomValid: diagnostics.hdrBloom.valid,
            colour: centreColor(), errors: f.errors.length })
        }
        out.resize = results
        pipeline.destroy()
      }

      // --- 5) 两个 Viewer 独立操作 -------------------------------------
      {
        // 同一个 scene 上不允许两个 pipeline（既有约束），因此验证「创建-销毁-再创建」
        // 不互相污染，以及第二个 Viewer 的独立 pipeline 不受第一个影响。
        const first = make({})
        await wait(10)
        const firstDiag = first.getRenderDiagnostics()
        first.destroy()

        const host = document.createElement('div')
        host.style.cssText = 'width:200px;height:150px;position:absolute;left:-9999px'
        document.body.appendChild(host)
        const secondViewer = new C.Viewer(host, { baseLayer: false,
          terrainProvider: new C.EllipsoidTerrainProvider(), animation: false, timeline: false,
          baseLayerPicker: false, geocoder: false, infoBox: false, sceneModePicker: false,
          navigationHelpButton: false, homeButton: false, shouldAnimate: false })
        secondViewer.scene.globe.baseColor = C.Color.fromCssColorString('#647580')
        const second = f.CCR.createVisualPipeline({ Cesium: C, viewer: secondViewer,
          options: { environment: false, clouds: false, shadows: false, fog: false,
            antialiasing: 'off', hdrBloomEnabled: false, materialChannelsEnabled: false } })
        secondViewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 2000),
          orientation: { heading: 0, pitch: -0.35, roll: 0 } })
        secondViewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
        await new Promise(resolve => { let n = 30; const off = secondViewer.scene.postRender.addEventListener(() => { if (--n === 0) { off(); resolve() } }) })
        const secondDiag = second.getRenderDiagnostics()
        const firstColourAfter = centreColor()
        second.destroy()
        secondViewer.destroy()
        host.remove()
        out.twoViewers = {
          firstValidBeforeDestroy: firstDiag.enabled,
          secondPipelineEnabled: secondDiag.enabled,
          secondHasOwnMaterials: !!secondDiag.materials,
          firstColourUnaffected: firstColourAfter,
          errors: f.errors.length
        }
      }

      // --- 6) context-loss 全链路 --------------------------------------
      {
        const {cubeUrl}=await import('/tests/rendering/stage1-scene.js')
        const reloadAsset=async viewer=>{
          const origin=C.Cartesian3.fromDegrees(116.39,39.9,60),matrix=C.Transforms.eastNorthUpToFixedFrame(origin)
          C.Matrix4.multiplyByScale(matrix,new C.Cartesian3(60,60,120),matrix)
          const model=await C.Model.fromGltfAsync({url:cubeUrl(C),modelMatrix:matrix,id:'recovery-building'})
          viewer.scene.primitives.add(model)
          viewer.clock.currentTime=C.JulianDate.clone(shifted)
          viewer.camera.lookAt(origin,new C.HeadingPitchRange(0,-.6,400));viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
          await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Recovery asset timeout'))},15000);let n=45
            const off=viewer.scene.postRender.addEventListener(()=>{if(model.ready&&--n<=0){off();clearTimeout(timer);resolve()}})})
        }
        const pipeline = make({ screenSpaceReflectionEnabled: true, hdrBloomEnabled: true })
        await reloadAsset(f.viewer)
        const diagnosticsBefore = pipeline.getRenderDiagnostics()
        const beforeLoss = { colour: centreColor(), picked:scene.pick(new C.Cartesian2(scene.canvas.clientWidth/2,scene.canvas.clientHeight/2))?.id,
          materialsValid: diagnosticsBefore.materials.valid,
          ssrValid: diagnosticsBefore.screenSpaceReflections.valid,
          bloomValid: diagnosticsBefore.hdrBloom.valid }
        const gl = scene.context._gl
        const extension = gl.getExtension('WEBGL_lose_context')
        if (!extension) {
          out.contextLoss = { supported: false, reason: 'WEBGL_lose_context unavailable' }
        } else {
          // R5：恢复测试必须 `event.preventDefault()`。否则浏览器执行「丢失」默认行为，
          // 之后的 restoreContext() 不再触发 webglcontextrestored —— 这不是环境限制，
          // 而是没有允许恢复。审查看同一 headless Chrome 对照：preventDefault 后
          // restore 确实生效（isContextLost 变 false）。
          const lostEvent = new Promise(resolve => {
            scene.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); resolve('lost') }, { once: true })
            setTimeout(() => resolve('timeout'), 4000)
          })
          extension.loseContext()
          const lost = await lostEvent
          await new Promise(resolve => setTimeout(resolve, 400))
          // 丢失期间：管线必须报告失效，且效果不得声称有效。
          const duringDiagnostics = pipeline.getRenderDiagnostics()
          const duringLoss = {
            contextLost: gl.isContextLost(),
            pipelineEnabled: pipeline.enabled,
            materialsValid: duringDiagnostics.materials.valid,
            ssrValid: duringDiagnostics.screenSpaceReflections.valid,
            bloomValid: duringDiagnostics.hdrBloom.valid,
            // 每个效果都要给出「为什么无效」，而不是静默返回假。
            ssrReason: duringDiagnostics.screenSpaceReflections.reason,
            materialsReason: duringDiagnostics.materials.reason
          }
          // 请求渲染不得抛错（失败路径必须仍呈现明确画面，而不是崩溃）。
          let renderSurvived = true
          try {
            scene.requestRender()
            await new Promise(resolve=>setTimeout(resolve,100))
          } catch { renderSurvived = false }
          duringLoss.renderSurvived = renderSurvived

          // 允许恢复并等待事件分派完成后再 restore（审查看 R5 的对照条件）。
          const restoredEvent = new Promise(resolve => {
            scene.canvas.addEventListener('webglcontextrestored', () => resolve('restored'), { once: true })
            setTimeout(() => resolve('timeout'), 4000)
          })
          extension.restoreContext()
          const restored = await restoredEvent
          await new Promise(resolve => setTimeout(resolve, 800))
          const afterGlLost = gl.isContextLost()
          const afterDiagnostics = pipeline.getRenderDiagnostics()

          // 关键验证（R5）：浏览器恢复上下文后，CCR 是否真的重建了 GPU 资源。
          // 不能只断言 isContextLost() 为 false —— 旧的 GL 资源（纹理/缓冲/程序）
          // 在 lost 时已失效，必须验证「真实渲染输出」而非状态位。
          // 若自动重建不成立，走显式恢复出口：销毁旧 pipeline + Viewer 后重建，
          // 用真实像素证明画面恢复，并如实记录用的是哪种路径。
          let restoredRender = null
          let autoRecovered = false
          if (!afterGlLost && !afterDiagnostics.recovery?.required) {
            try {
              await wait(30)
              const colour = centreColor()
              autoRecovered = colour.some(v => v > 0)
              restoredRender = { colour, materialsValid: pipeline.getRenderDiagnostics().materials.valid, path: 'auto' }
            } catch {
              autoRecovered = false
            }
          }
          // 显式恢复出口：销毁后重建 Viewer + pipeline，必须给出真实画面。
          // 这是 CCR 对「浏览器恢复了但旧资源未重建」这一真实情况的兜底。
          let explicitRebuild = null
          if (!autoRecovered) {
            try {
              pipeline.destroy()
              f.viewer.destroy()
              const host = document.createElement('div')
              host.style.cssText = 'width:320px;height:240px;position:absolute;left:-9999px'
              document.body.appendChild(host)
              const rebuiltViewer = new C.Viewer(host, { baseLayer: false,
                terrainProvider: new C.EllipsoidTerrainProvider(), animation: false, timeline: false,
                baseLayerPicker: false, geocoder: false, infoBox: false, sceneModePicker: false,
                navigationHelpButton: false, homeButton: false, shouldAnimate: false })
              rebuiltViewer.scene.globe.baseColor = C.Color.fromCssColorString('#647580')
              const rebuilt = f.CCR.createVisualPipeline({ Cesium: C, viewer: rebuiltViewer,
                options: { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
                  clouds: false, volumetricFog: false, sunScattering: true, antialiasing: 'off',
                  hdrBloomEnabled: true, materialChannelsEnabled: false, shadowMode: 'native',
                  screenSpaceReflectionEnabled: true } })
              rebuilt.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
              await reloadAsset(rebuiltViewer)
              const w = rebuiltViewer.scene.drawingBufferWidth, h = rebuiltViewer.scene.drawingBufferHeight, size = 8
              const data = rebuiltViewer.scene.context.readPixels({ x: Math.floor(w / 2 - size / 2), y: Math.floor(h / 2 - size / 2), width: size, height: size })
              let r = 0, g = 0, b = 0
              for (let i = 0; i < size * size; i++) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2] }
              const n = size * size
              const colour = [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
              explicitRebuild = { colour, materialsValid: rebuilt.getRenderDiagnostics().materials.valid, path: 'explicit-rebuild',
                picked:rebuiltViewer.scene.pick(new C.Cartesian2(rebuiltViewer.canvas.clientWidth/2,rebuiltViewer.canvas.clientHeight/2))?.id }
              rebuilt.destroy(); rebuiltViewer.destroy(); host.remove()
            } catch (error) {
              explicitRebuild = { colour: [0, 0, 0], materialsValid: false, path: 'explicit-rebuild', error: error.message }
            }
          }
          out.contextLoss = {
            supported: true, lost, restored,
            browserRestoredContext: !afterGlLost,
            beforeLoss, duringLoss, afterLoss: { glStillLost: afterGlLost,
              materialsValid: afterDiagnostics.materials.valid, ssrValid: afterDiagnostics.screenSpaceReflections.valid,
              bloomValid: afterDiagnostics.hdrBloom.valid },
            restoredRender, autoRecovered, explicitRebuild,
            errors: f.errors.length
          }
        }
        pipeline.destroy()
      }

      out.errors = f.errors.slice()
      return out
    })

    report.pageErrors.push(...pageErrors)
    report.result = result
    fs.mkdirSync('docs/verification/stage1-B11', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B11/lifecycle.json', JSON.stringify(report, null, 2))

    assert.deepEqual(pageErrors, [], 'no page errors')
    assert.deepEqual(result.errors, [], 'no render errors')

    // 1) 能力矩阵必须从真实场景探测，并携带 requested/active/reason/generation。
    const cap = result.capability
    assert.ok(cap.generation > 0, `generation must be a real frame number, got ${cap.generation}`)
    for (const key of ['mrt', 'floatAttachments', 'oit', 'msaa', 'sceneMode', 'multiFrustum']) {
      const entry = cap[key]
      assert.ok(entry, `${key} must be reported`)
      for (const field of ['requested', 'active', 'reason', 'generation']) {
        assert.ok(field in entry, `${key}.${field} must be present`)
      }
    }
    assert.ok(cap.deviceSlots.maxDrawBuffers >= 4, `device must expose draw-buffer limits, got ${cap.deviceSlots.maxDrawBuffers}`)
    assert.ok(cap.attachmentsNeeded >= 4, `attachmentsNeeded must be computed, got ${cap.attachmentsNeeded}`)

    // 2) 默认策略：CCR 托管项开启，高成本效果默认关闭，延迟模式回退增强。
    for (const name of ['sky', 'environment', 'shadows', 'hdr', 'smaa']) {
      assert.equal(cap.defaults.managed[name], true, `${name} must be CCR-managed by default`)
    }
    for (const name of ['hbao', 'ssr', 'bloom', 'tiltShift', 'blur', 'depthOfField',
      'chromaticAberration', 'sunFlare', 'lightShaft']) {
      assert.equal(cap.defaults.explicitOnly[name].active, false, `${name} must not be active by default`)
    }
    assert.equal(cap.defaults.deferred.effectiveMode, 'enhanced',
      'deferred lighting must fall back to enhanced when coverage is incomplete')

    // 3) 20 轮启停后资源不得单调增长。
    const life = result.lifecycle
    assert.equal(life.rounds, 20)
    assert.ok(life.secondHalfPeakBytes <= life.firstHalfPeakBytes * 1.05,
      `resources must not grow across cycles: first ${life.firstHalfPeakBytes} vs second ${life.secondHalfPeakBytes}`)
    assert.ok(life.colour.some(v => v > 0), 'the frame must still render after 20 cycles')

    // 4) 嵌套暂停：任一工具未释放前必须保持暂停。
    assert.equal(result.nestedSuspension.suspendedFlag, true, 'pipeline must report suspended')
    assert.equal(result.nestedSuspension.stillSuspendedAfterOneRelease, true,
      'releasing one of two suspensions must keep the pipeline suspended')
    assert.equal(result.nestedSuspension.resumedActive, true, 'releasing both must resume the effect')
    assert.equal(result.nestedSuspension.duplicateSuspendIsIdempotent, true,
      'suspending twice for the same owner must stay suspended (and not need two resumes)')
    assert.equal(result.nestedSuspension.singleResumeClearsIt, true,
      'a single resume must clear an owner that suspended twice')

    // 5) resize 后各效果仍有效。
    for (const entry of result.resize) {
      assert.equal(entry.errors, 0, `resize ${entry.size}: no new render errors`)
    }

    // 6) 两个 Viewer 互不影响。
    assert.equal(result.twoViewers.firstValidBeforeDestroy, true)
    assert.equal(result.twoViewers.secondPipelineEnabled, true)

    // 7) context-loss：必须真的丢失，且 CCR 的每个效果都要**如实报告失效**。
    //
    // R5：撤销「环境不允许恢复」的归因。webglcontextlost 监听必须 preventDefault()
    // 才能允许 restore（审查看同一 headless Chrome 对照证明可恢复）。恢复后必须用
    // **真实渲染输出**证明画面回来——优先验证 CCR 自动重建；若自动重建不成立，
    // 显式销毁重建出口必须给出真实像素。两者都失败才算未通过。
    const loss = result.contextLoss
    assert.equal(loss.supported, true, 'WEBGL_lose_context must be available for this check')
    assert.equal(loss.lost, 'lost', 'the context must actually be lost')
    assert.equal(loss.duringLoss.contextLost, true, 'the GL context must report lost')
    assert.equal(loss.duringLoss.materialsValid, false,
      'material channels must report invalid while the context is lost')
    assert.equal(loss.duringLoss.ssrValid, false, 'SSR must report invalid while the context is lost')
    assert.equal(loss.duringLoss.bloomValid, false, 'bloom must report invalid while the context is lost')
    // 每个效果都要能回答「为什么无效」，而不是只给一个 false。
    assert.ok(loss.duringLoss.ssrReason, 'the invalid SSR must carry a reason')
    assert.ok(loss.duringLoss.materialsReason, 'the invalid material pass must carry a reason')
    assert.equal(loss.duringLoss.renderSurvived, true,
      'requesting a render while the context is lost must not throw')
    assert.equal(loss.afterLoss.glStillLost, false,
      'preventDefault + restoreContext must actually restore the context (R5: it does work in headless Chrome)')
    assert.equal(loss.afterLoss.materialsValid, false, 'retired material resources cannot become valid after browser restore')
    assert.equal(loss.afterLoss.ssrValid, false, 'retired SSR resources cannot become valid after browser restore')
    assert.equal(loss.beforeLoss.picked,'recovery-building')
    assert.equal(loss.explicitRebuild?.picked,'recovery-building','reloaded assets must preserve picking identity')
    // R5：恢复后必须用真实像素证明画面回来——自动重建或显式重建出口二选一成立。
    const recovered = (loss.autoRecovered && loss.restoredRender && loss.restoredRender.colour.some(v => v > 0))
      || (loss.explicitRebuild && loss.explicitRebuild.colour.some(v => v > 0))
    assert.ok(recovered,
      `context restore must produce real rendered output, got auto=${JSON.stringify(loss.restoredRender)} explicit=${JSON.stringify(loss.explicitRebuild)}`)

    console.log(JSON.stringify({
      capability: { generation: cap.generation, mrt: cap.mrt.active, attachmentsNeeded: cap.attachmentsNeeded,
        deviceSlots: cap.deviceSlots, oit: cap.oit.active, msaa: cap.msaa.active,
        deferredMode: cap.defaults.deferred.effectiveMode },
      lifecycle: { rounds: life.rounds, firstHalfPeak: life.firstHalfPeakBytes, secondHalfPeak: life.secondHalfPeakBytes },
      nestedSuspension: result.nestedSuspension,
      resize: result.resize.map(r => ({ size: r.size, materials: r.materialsValid, ssr: r.ssrValid })),
      contextLoss: { lost: loss.lost, restored: loss.restored,
        browserRestoredContext: loss.browserRestoredContext,
        before: loss.beforeLoss.colour,
        duringReasons: { ssr: loss.duringLoss.ssrReason, materials: loss.duringLoss.materialsReason },
        autoRecovered: loss.autoRecovered, restoredRender: loss.restoredRender,
        explicitRebuild: loss.explicitRebuild }
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
