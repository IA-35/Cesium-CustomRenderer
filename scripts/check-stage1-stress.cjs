// B11 验收（第 2 部分）：交互压力测试与资源漂移。
//
// 主计划要求「30 分钟交互压力测试，观察自有资源数/估算字节/查询数量不随循环增长」，
// 并明确风险：「需开工前固化『交互脚本』与『漂移阈值』（建议：资源数/字节允许
// ±5% 波动但禁止单调上升），否则不可复现」。
//
// 本脚本因此固化两件事：
//   1. **交互脚本**：固定的镜头轨迹/效果开关序列（下面是 INTERACTION_SCRIPT）；
//   2. **漂移阈值**：DRIFT_TOLERANCE = 5%，且「后半段峰值 ≤ 前半段峰值 × (1+5%)」
//      —— 这比单纯比较首尾更能发现单调上升（首尾法会被早期高水位掩盖）。
//
// 时长：完整 30 分钟由 `--minutes 30` 触发；默认跑较短时长用于常规回归，
// 并如实报告实际时长（不把短跑冒充 30 分钟）。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')

const PORT = process.env.CCR_TEST_PORT || 8877
const argv = process.argv.slice(2)
const arg = (key, fallback) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1] }
const MINUTES = Number(arg('--minutes', '2'))
const DRIFT_TOLERANCE = 0.05   // 固化阈值：±5%，与计划建议一致

/** 固化的交互脚本：每一步是「镜头操作 + 效果开关」，可复现。 */
const INTERACTION_SCRIPT = [
  { name: 'orbit', camera: 'orbit' },
  { name: 'pitch-sweep', camera: 'pitch' },
  { name: 'zoom-in', camera: 'zoom', zoom: 0.6 },
  { name: 'zoom-out', camera: 'zoom', zoom: 1.6 },
  { name: 'toggle-ssr', effects: { screenSpaceReflectionEnabled: true } },
  { name: 'toggle-bloom', effects: { hdrBloomEnabled: true } },
  { name: 'toggle-lens', effects: { chromaticAberrationEnabled: true, chromaticAberrationStrength: 2 } },
  { name: 'toggle-deferred', lighting: 'deferred' },
  { name: 'reset', camera: 'reset', effects: { screenSpaceReflectionEnabled: false, hdrBloomEnabled: false,
    chromaticAberrationEnabled: false }, lighting: 'enhanced' }
]

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { minutes: MINUTES, driftTolerance: DRIFT_TOLERANCE, script: INTERACTION_SCRIPT, pageErrors: [], cycles: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })

    const result = await page.evaluate(async ({ minutes, script }) => {
      const C = Cesium, f = fixture, scene = f.viewer.scene
      const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
        (12 - 116.39 / 15) * 3600, new C.JulianDate())
      f.viewer.clock.currentTime = shifted
      f.viewer.clock.shouldAnimate = false
      scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
      const wait = frames => new Promise(resolve => {
        let n = frames
        const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); resolve() } })
      })
      const centre = () => {
        const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight, size = 8
        const data = scene.context.readPixels({ x: Math.floor(w / 2 - size / 2), y: Math.floor(h / 2 - size / 2),
          width: size, height: size })
        let r = 0, g = 0, b = 0
        for (let i = 0; i < size * size; i++) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2] }
        const n = size * size
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
      }

      const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer,
        options: { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
          clouds: true, volumetricFog: true, sunScattering: true, antialiasing: 'smaa',
          hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'custom', shadows: true } })
      pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
      const base = { longitude: 116.39, latitude: 39.9, height: 3000 }
      const setCamera = (step, tick) => {
        if (step.camera === 'reset') {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(base.longitude, base.latitude, base.height),
            orientation: { heading: 0, pitch: -0.5, roll: 0 } })
        } else if (step.camera === 'orbit') {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(base.longitude, base.latitude, base.height),
            orientation: { heading: (tick % 8) * (Math.PI / 4), pitch: -0.5, roll: 0 } })
        } else if (step.camera === 'pitch') {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(base.longitude, base.latitude, base.height),
            orientation: { heading: 0, pitch: -1.2 + (tick % 6) * 0.3, roll: 0 } })
        } else if (step.camera === 'zoom') {
          f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(base.longitude, base.latitude, base.height * step.zoom),
            orientation: { heading: 0, pitch: -0.5, roll: 0 } })
        }
        f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
      }

      const started = performance.now()
      const deadline = started + minutes * 60 * 1000
      const cycles = []
      let tick = 0
      while (performance.now() < deadline) {
        const step = script[tick % script.length]
        setCamera(step, tick)
        if (step.effects) pipeline.setScreenSpaceReflections({ enabled: step.effects.screenSpaceReflectionEnabled === true })
        if (step.effects && 'hdrBloomEnabled' in step.effects) pipeline.setHdrBloom({ enabled: step.effects.hdrBloomEnabled })
        if (step.effects && 'chromaticAberrationEnabled' in step.effects) {
          pipeline.setLensEffects({ chromaticAberrationEnabled: step.effects.chromaticAberrationEnabled === true,
            chromaticAberrationStrength: step.effects.chromaticAberrationStrength ?? 0 })
        }
        if (step.lighting) pipeline.setLighting({ mode: step.lighting })
        await wait(6)
        const pool = pipeline.getResourcePoolDiagnostics()
        const uniforms = pipeline.getFrameUniformDiagnostics()
        cycles.push({
          tick, step: step.name,
          poolLive: pool.live, poolTargets: pool.targets, poolBytes: pool.currentBytes,
          uniformBytes: uniforms.bytes, uniformBuffers: uniforms.buffers.length,
          colour: centre()
        })
        tick++
      }
      const elapsed = (performance.now() - started) / 1000
      const diagnostics = pipeline.getRenderDiagnostics()
      const result = {
        elapsedSeconds: elapsed, cycles: cycles.length, samples: cycles,
        finalColour: centre(),
        finalPool: pipeline.getResourcePoolDiagnostics(),
        finalUniforms: pipeline.getFrameUniformDiagnostics(),
        capabilityGeneration: diagnostics.capability.generation,
        errors: f.errors.slice()
      }
      pipeline.destroy()
      return result
    }, { minutes: MINUTES, script: INTERACTION_SCRIPT })

    report.pageErrors.push(...pageErrors)
    report.result = result
    fs.mkdirSync('docs/verification/stage1-B11', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B11/stress.json', JSON.stringify(report, null, 2))

    assert.deepEqual(pageErrors, [], 'no page errors')
    assert.deepEqual(result.errors, [], 'no render errors during the stress run')
    assert.ok(result.cycles > 10, `the script must execute many cycles, got ${result.cycles}`)

    // 漂移判定：后半段峰值不得比前半段峰值高出容忍度。
    // 用「分段峰值」而不是首尾比较——首尾比较会被早期高水位掩盖单调上升。
    const half = Math.floor(result.samples.length / 2)
    const peak = (list, key) => Math.max(...list.map(s => s[key]))
    const metrics = [['poolBytes', '资源字节'], ['poolLive', '活跃目标数'], ['poolTargets', '目标总数'],
      ['uniformBytes', 'UBO 字节'], ['uniformBuffers', 'UBO 数量']]
    const drift = {}
    for (const [key, label] of metrics) {
      const first = peak(result.samples.slice(0, half), key)
      const second = peak(result.samples.slice(half), key)
      const growth = first > 0 ? (second - first) / first : (second > 0 ? Infinity : 0)
      drift[key] = { label, firstPeak: first, secondPeak: second, growth }
      assert.ok(growth <= DRIFT_TOLERANCE,
        `${label} must not grow beyond ${DRIFT_TOLERANCE * 100}%: first ${first} -> second ${second} (${(growth * 100).toFixed(1)}%)`)
    }
    // 失败路径仍须呈现明确画面（不是全黑）。
    assert.ok(result.finalColour.some(v => v > 0),
      `the frame must remain visible at the end of the stress run, got ${JSON.stringify(result.finalColour)}`)

    console.log(JSON.stringify({
      requestedMinutes: MINUTES, elapsedSeconds: Number(result.elapsedSeconds.toFixed(1)),
      cycles: result.cycles, drift,
      finalColour: result.finalColour,
      note: MINUTES < 30
        ? `该次运行 ${MINUTES} 分钟；主计划要求的完整 30 分钟需以 --minutes 30 运行（时长不是通过条件，漂移才是）`
        : '达到主计划要求的 30 分钟'
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
