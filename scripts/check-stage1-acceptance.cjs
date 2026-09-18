// B12 验收：通用场景矩阵、固定负载性能、SDK 一致性。
//
// 目标是主计划 B12 的硬验收线，逐条要有实际证据：
//   1. 固定 1920×1080 drawing buffer，三配置（隔离基线 / CCR 默认 / 效果组合），
//      并登记**实际开关值**（不是请求值）；
//   2. 预热 ≥30 秒，前台连续记录每条轨迹 60 秒、重复 3 轮；
//      窗口失焦 / 配置或资产变化 / GPU disjoint 时整组作废；
//   3. 性能起始线（候选值，非承诺）：CCR 默认 ≥30FPS 且 P95 ≤33.3ms；
//      效果组合相对门槛：帧耗时增量 ≤2×；
//   4. 源码 ESM 与 UMD 的导出/API/图像一致，manifest 记工作树 hash。
//
// 纪律：
//   * 门槛是**预先制定的候选值**；若实测不合理，必须记录旧/新阈值及原因，
//     不得静默放宽。本脚本在报告里显式写出所用阈值。
//   * 未达门槛就是未达，不进入完成状态——脚本会以失败退出并打印实际值。
//   * 窗口失焦等失效条件会使整组作废，而不是照常出结论。
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto')

const PORT = process.env.CCR_TEST_PORT || 8877
const argv = process.argv.slice(2)
const arg = (key, fallback) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1] }
const QUICK = argv.includes('--quick')

// Frame cadence, CPU submission and GPU elapsed time are independent gates.
// GPU median alone cannot certify frame P95 or detect driver synchronization.
const THRESHOLDS = {
  defaultMinFps: 30,
  defaultMaxP95Ms: 33.3,
  defaultMaxGpuMs: 33.3,
  combinedMaxCostRatio: 2,
  warmupSeconds: QUICK ? 3 : 30,
  recordSeconds: QUICK ? 2 : 60,
  rounds: QUICK ? 1 : 3
}

const WIDTH = 1920, HEIGHT = 1080

// Shared deterministic load; no synthetic draw-count fallback.
const LOAD_MODELS_SOURCE = `async function loadModels(C, scene, f) {
  return (await import('/tests/rendering/performance-scene.js')).loadPerformanceScene(f)
}`

/** 三条固定镜头轨迹（可复现）。 */
const TRACKS = [
  { name: 'orbit', apply: 'orbit' },
  { name: 'pitch', apply: 'pitch' },
  { name: 'altitude', apply: 'altitude' }
]

/** 三配置。`options` 为请求值，报告里同时记录**实际**开关值。 */
const CONFIGURATIONS = [
  { id: 'isolated', title: '隔离基线（无 CCR 效果）', options: {
    environment: false, clouds: false, shadows: false, fog: false, antialiasing: 'off',
    hdrBloomEnabled: false, materialChannelsEnabled: false, screenSpaceAoEnabled: false,
    screenSpaceReflectionEnabled: false, lightingMode: 'enhanced', shadowMode: 'native' } },
  { id: 'ccr-default', title: 'CCR 默认', options: {
    environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
    clouds: true, volumetricFog: true, shadows: true, shadowMode: 'custom', fog: true,
    antialiasing: 'smaa', hdrBloomEnabled: false, materialChannelsEnabled: false,
    screenSpaceAoEnabled: false, screenSpaceReflectionEnabled: false, lightingMode: 'enhanced' } },
  { id: 'effects-combined', title: '效果组合', options: {
    environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
    clouds: true, volumetricFog: true, shadows: true, shadowMode: 'custom', fog: true,
    antialiasing: 'smaa', hdrBloomEnabled: true, materialChannelsEnabled: true,
    screenSpaceAoEnabled: true, screenSpaceAoAlgorithm: 'hbao',
    screenSpaceReflectionEnabled: true, lightingMode: 'deferred' } }
]

/** 收集一帧的耗时样本（用 requestAnimationFrame 间隔，反映前台真实帧率）。 */
async function measureTrack(page, trackName, seconds, collectGpu) {
  return page.evaluate(async ({ trackName, seconds, collectGpu }) => {
    const C = Cesium, f = fixture, scene = f.viewer.scene
    const pipeline = f.activePipeline
    const {applyPerformanceTrack,readPerformanceLoad}=await import('/tests/rendering/performance-scene.js')
    let tick=0
    const applyTrack=()=>applyPerformanceTrack(f,trackName,tick++*.05)
    applyTrack()
    await new Promise(r => { let n = 10; const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); r() } }) })
    // 记录期间必须保持前台；失焦则整组作废。
    const focused = document.hasFocus()
    const intervals = [], loads=[], cpu=[]
    const originalRender=scene.render
    scene.render=function(...args){const start=performance.now();try{return originalRender.apply(this,args)}finally{cpu.push(performance.now()-start)}}
    const after=scene.postRender.addEventListener(()=>loads.push(readPerformanceLoad(f)))
    const start = performance.now()
    let previous = start
    await new Promise(resolve => {
      const step = () => {
        applyTrack()
        const now = performance.now()
        intervals.push(now - previous)
        previous = now
        if (now - start >= seconds * 1000) { resolve(); return }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    // rAF 间隔受 vsync 限制（实测三配置都卡在 ~60 FPS），因此**不能**用它
    // 区分配置成本。真实算力用 GPU 计时器（EXT_disjoint_timer_query_webgl2）测：
    // 同步阻塞式地反复渲染同一帧并读回查询结果，得到与 vsync 无关的 GPU 时间。
    let gpu = null
    if (collectGpu) {
      gpu = await (async () => {
        const gl = scene.context._gl
        const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2')
        if (!extension) return { supported: false, reason: 'EXT_disjoint_timer_query_webgl2 unavailable' }
        const samples = []
        for (let i = 0; i < 12; i++) {
          applyTrack()
          const query = gl.createQuery()
          gl.beginQuery(extension.TIME_ELAPSED_EXT, query)
          scene.render()
          gl.endQuery(extension.TIME_ELAPSED_EXT)
          // 逐个等待完成：本诊断不追求零阻塞，只求得到真实 GPU 时间。
          let guard = 0
          while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && guard++ < 2000) {
            await new Promise(r => setTimeout(r, 0))
          }
          const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT)
          if (!disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6)
          }
          gl.deleteQuery(query)
        }
        const sorted = samples.slice().sort((a, b) => a - b)
        return { supported: true, samples: sorted.length, disjointDiscarded: 12 - sorted.length,
          minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted[sorted.length - 1],
          raw: sorted }
      })()
    }
    scene.render=originalRender;after()
    if(!loads.length||loads.some(load=>load.draws<32))throw new Error('Measured track lost its model load')
    const diagnostics = pipeline.getRenderDiagnostics()
    return {
      trackName, focused, samples: intervals.length, intervals, gpu, cpu, minVisibleDraws:Math.min(...loads.map(x=>x.draws)),
      // 实际开关值（不是请求值）。
      actual: {
        environment: !!pipeline.environmentRenderer?.enabled,
        materials: diagnostics.materials.valid,
        ssr: diagnostics.screenSpaceReflections.enabled,
        bloom: diagnostics.hdrBloom.enabled,
        ao: diagnostics.screenSpaceAO.enabled,
        lightingMode: diagnostics.lighting.activeMode ?? diagnostics.lighting.requested,
        antialiasing: diagnostics.antiAliasing.postProcess?.effective ?? diagnostics.antiAliasing.mode,
        msaa: diagnostics.antiAliasing.msaaSamples ?? diagnostics.antiAliasing.msaa?.selected
      }
    }
  }, { trackName, seconds, collectGpu })
}

function percentiles(intervals) {
  const sorted = intervals.slice().sort((a, b) => a - b)
  const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return { mean, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] }
}

/**
 * 源码 ESM 与 UMD 的一致性比对。
 *
 * 主计划要求同一配置下两者的「导出 CCR、效果/依赖资源、API 和图像」一致。
 * 做法：同一页面加载同一源码（`stage1-fixture.html?mode=umd` 走 UMD），
 * 分别在**相同镜头与相同选项**下渲染，比较导出键集合与整屏像素哈希。
 */
async function compareEsmAndUmd(browser) {
  const capture = async (mode, options) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html${mode === 'umd' ? '?mode=umd' : ''}`)
    await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })
    const result = await page.evaluate(async ({ options, loaderSource }) => {
      const C = Cesium, f = fixture, scene = f.viewer.scene
      const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
        (12 - 116.39 / 15) * 3600, new C.JulianDate())
      f.viewer.clock.currentTime = shifted
      f.viewer.clock.shouldAnimate = false
      scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
      // 固定镜头与配置，使两者可比。
      f.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(116.39, 39.9, 3000),
        orientation: { heading: 0, pitch: -0.5, roll: 0 } })
      f.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
      // R7：SDK 一致性也必须加载代表性模型，而不是只比较空场景的导出/API/图像。
      const loadModels = (0, eval)('(' + loaderSource + ')')
      const load = await loadModels(C, scene, f)
      const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer, options })
      pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
      await new Promise(r => { let n = 40; const off = scene.postRender.addEventListener(() => { if (--n === 0) { off(); r() } }) })
      const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight
      const data = scene.context.readPixels({ x: 0, y: 0, width: w, height: h })
      const exports = Object.keys(f.CCR).sort()
      const diagnostics = pipeline.getRenderDiagnostics()
      // API 形状只比较**两边共有**的入口。`VERSION`/`CESIUM_VERSION` 是构建脚本
      // 有意只加给 UMD 的便利导出，ESM 源码里没有，因此不能纳入形状一致性比较。
      const sharedApi = ['createVisualPipeline', 'VisualPipeline', 'ScreenSpaceReflection143',
        'MaterialChannels143', 'HdrBloom143', 'TaaPass143', 'SmaaPass143', 'FxaaPass143']
      const result = { exports, bytes: Array.from(data), load,
        apiShape: Object.fromEntries(sharedApi.map(key => [key, typeof f.CCR[key]])),
        // 「同一注册表」的可判定含义：两个构建注册的**版本标识**一致，
        // 且同一配置下创建出的管线诊断形状一致（不是某个策略值恰好相等）。
        version: f.CCR.VERSION ?? null,
        cesiumVersion: f.CCR.CESIUM_VERSION ?? null,
        diagnosticsShape: Object.keys(diagnostics).sort().join(','),
        materialLayout: diagnostics.materials?.materialLayoutVersion ?? null,
        errors: f.errors.slice() }
      pipeline.destroy()
      return result
    }, { options, loaderSource: LOAD_MODELS_SOURCE })
    await page.close()
    return { result, pageErrors }
  }

  const options = { environment: true, environmentPreset: 'clear', environmentQuality: 'balanced',
    clouds: false, volumetricFog: false, sunScattering: true, antialiasing: 'off',
    hdrBloomEnabled: false, materialChannelsEnabled: false, shadowMode: 'native' }
  const esm = await capture('esm', options)
  const umd = await capture('umd', options)
  const hash = bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 16)
  const esmExportSet = new Set(esm.result.exports), umdExportSet = new Set(umd.result.exports)
  // 构建脚本会**有意**为 UMD 追加 4 个便利导出（`VERSION`、`CESIUM_VERSION`、
  // `LightUniforms143`、`RenderProfiler143`），`src/index.js` 里没有它们。
  // 这是设计上的超集，不是不一致；因此契约是：
  //   * UMD 必须包含 ESM 的**全部**导出（不得少）；
  //   * UMD 多出的必须落在这个已知清单内（不得有意外新增）。
  const BUILD_ONLY_EXPORTS = ['VERSION', 'CESIUM_VERSION', 'LightUniforms143', 'RenderProfiler143']
  const exportDiff = {
    missingFromUmd: esm.result.exports.filter(k => !umdExportSet.has(k)),
    unexpectedOnlyUmd: umd.result.exports.filter(k => !esmExportSet.has(k) && !BUILD_ONLY_EXPORTS.includes(k)),
    knownBuildOnly: umd.result.exports.filter(k => !esmExportSet.has(k))
  }
  return {
    pageErrors: [...esm.pageErrors, ...umd.pageErrors],
    exportCount: esm.result.exports.length,
    loadModels: esm.result.load?.models ?? 0,
    loadDraws: esm.result.load?.draws ?? 0,
    loadTriangles: esm.result.load?.triangles ?? 0,
    exportDiff,
    // UMD 是 ESM 的超集：不得缺、也不得有清单外的新增。
    exportsMatch: exportDiff.missingFromUmd.length === 0 && exportDiff.unexpectedOnlyUmd.length === 0,
    buildOnlyExports: BUILD_ONLY_EXPORTS,
    apiShapeEsm: esm.result.apiShape,
    apiShapeUmd: umd.result.apiShape,
    // API 形状必须逐项一致（同名入口在两边的类型相同）。
    apiShapeMatch: Object.keys(esm.result.apiShape).every(key => esm.result.apiShape[key] === umd.result.apiShape[key]),
    esmHash: hash(esm.result.bytes), umdHash: hash(umd.result.bytes),
    imageMatch: hash(esm.result.bytes) === hash(umd.result.bytes),
    // 同一注册表 = 诊断结构一致（同一份源码的同一批模块都注册上了），
    // 而不是某个策略值恰好相等。
    sameRegistry: esm.result.diagnosticsShape === umd.result.diagnosticsShape &&
      esm.result.materialLayout === umd.result.materialLayout,
    diagnosticsShape: esm.result.diagnosticsShape,
    umdVersion: umd.result.version,
    umdCesiumVersion: umd.result.cesiumVersion,
    errors: [...esm.result.errors, ...umd.result.errors]
  }
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { thresholds: THRESHOLDS, viewport: [WIDTH, HEIGHT], configurations: [], pageErrors: [], invalidated: [] }
  try {
    for (const configuration of CONFIGURATIONS) {
      const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(e.message))
      await page.goto(`http://127.0.0.1:${PORT}/tests/rendering/stage1-fixture.html`)
      await page.waitForFunction(() => window.fixture, null, { timeout: 30000 })
      const setup = await page.evaluate(async ({ options, loaderSource }) => {
        const C = Cesium, f = fixture, scene = f.viewer.scene
        const shifted = C.JulianDate.addSeconds(C.JulianDate.fromIso8601('2026-06-21T00:00:00Z'),
          (12 - 116.39 / 15) * 3600, new C.JulianDate())
        f.viewer.clock.currentTime = shifted
        f.viewer.clock.shouldAnimate = false
        scene.postUpdate.addEventListener(() => { f.viewer.clock.currentTime = shifted })
        scene.screenSpaceCameraController.enableInputs = false

        // R7：性能负载必须含**代表性模型**，而不是只测 Globe + 背景 + 后处理。
        // 加载与 stage1-scene.js 相同的 4 个 cuboid Model（普通 Primitive 路径），
        // 并记录对象/命令/三角形计数，使结论能反映真实复杂场景的瓦片选择与 draw 数。
        const loadModels = (0, eval)('(' + loaderSource + ')')
        const models = await loadModels(C, scene, f)
        const pipeline = f.CCR.createVisualPipeline({ Cesium: C, viewer: f.viewer, options })
        pipeline.setCampusOrigin(C.Cartesian3.fromDegrees(116.39, 39.9, 0))
        f.activePipeline = pipeline
        return { size: [scene.drawingBufferWidth, scene.drawingBufferHeight],
          renderer: scene.context._gl.getParameter(scene.context._gl.RENDERER),
          vendor: scene.context._gl.getParameter(scene.context._gl.VENDOR),
          // R7：记录负载规模，使性能结论有可复现的输入。
          load: { models: models.models, draws: models.draws, triangles: models.triangles,
            primitives: models.primitives } }
      }, { options: configuration.options, loaderSource: LOAD_MODELS_SOURCE })

      // 预热：主计划要求 ≥30 秒。这里只跑时间、不改配置，让着色器/纹理缓存稳定。
      await page.evaluate(async seconds => {
        const scene = globalThis.fixture.viewer.scene
        if (!scene) throw new Error('fixture scene is not available')
        const start = performance.now()
        await new Promise(resolve => {
          const tick = () => {
            scene.requestRender()
            if (performance.now() - start >= seconds * 1000) resolve()
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      }, THRESHOLDS.warmupSeconds)

      const entry = { id: configuration.id, title: configuration.title, requested: configuration.options,
        setup, rounds: [], actual: null }
      let invalid = null
      for (let round = 0; round < THRESHOLDS.rounds; round++) {
        for (const track of TRACKS) {
          const measured = await measureTrack(page, track.apply, THRESHOLDS.recordSeconds, true)
          if (!measured.focused) invalid = `round ${round} track ${track.name}: window lost focus`
          entry.rounds.push({ round, track: track.name, focused: measured.focused, samples: measured.samples,
            stats: percentiles(measured.intervals), cpu:percentiles(measured.cpu), minVisibleDraws:measured.minVisibleDraws, gpu: measured.gpu, actual: measured.actual })
          entry.actual = measured.actual
        }
      }
      entry.invalidReason = invalid
      if (invalid) report.invalidated.push({ id: configuration.id, reason: invalid })
      report.pageErrors.push(...pageErrors)
      entry.pageErrors = pageErrors
      report.configurations.push(entry)
      await page.close()
    }

    fs.mkdirSync('docs/verification/stage1-B12', { recursive: true })
    fs.writeFileSync('docs/verification/stage1-B12/performance.json', JSON.stringify(report, null, 2))

    assert.deepEqual(report.pageErrors, [], 'no page errors')

    // 主计划：窗口失焦 / 配置变化时整组作废，不用于性能结论。
    assert.deepEqual(report.invalidated, [],
      `measurement groups must be valid for a performance conclusion: ${JSON.stringify(report.invalidated)}`)

    const by = Object.fromEntries(report.configurations.map(c => [c.id, c]))
    const summary = {}
    for (const [id, entry] of Object.entries(by)) {
      // 用各轮 p95 的最大值作为该配置的保守 p95。
      const p95 = Math.max(...entry.rounds.map(r => r.stats.p95))
      const mean = entry.rounds.reduce((a, r) => a + r.stats.mean, 0) / entry.rounds.length
      // GPU 中位时间：与 vsync 无关的真实算力度量，用于区分配置成本。
      const gpuMedians = entry.rounds.map(r => r.gpu?.supported ? r.gpu.medianMs : null).filter(v => Number.isFinite(v))
      summary[id] = {
        meanMs: mean, p95Ms: p95, fps: 1000 / mean, actual: entry.actual,
        gpuMedianMs: gpuMedians.length ? Math.max(...gpuMedians) : null,
        gpuSupported: gpuMedians.length > 0
      }
    }

    // Whole-frame and GPU gates both apply, including quick smoke runs.
    const ccrDefault = summary['ccr-default']
    assert.ok(ccrDefault.gpuSupported && Number.isFinite(ccrDefault.gpuMedianMs),
      'the GPU timer must be available for a performance conclusion')
    assert.ok(ccrDefault.gpuMedianMs <= THRESHOLDS.defaultMaxGpuMs,
      `CCR default GPU median must stay under ${THRESHOLDS.defaultMaxGpuMs} ms, got ${ccrDefault.gpuMedianMs.toFixed(2)} ms`)
    // 参考项照常记录但**不**作为失败条件（headless rAF 抖动不是渲染成本）。
    report.referenceMetrics = {
      defaultFps: ccrDefault.fps, defaultP95Ms: ccrDefault.p95Ms,
      note: 'Whole-frame FPS and P95 gates retained; GPU time is not a substitute'
    }

    assert.ok(ccrDefault.fps>=THRESHOLDS.defaultMinFps,'Default FPS below target')
    assert.ok(ccrDefault.p95Ms<=THRESHOLDS.defaultMaxP95Ms,'Default frame P95 exceeds target')
    const baseline = summary['isolated']
    const combined = summary['effects-combined']
    const useGpu = baseline.gpuSupported && combined.gpuSupported
    const gpuDelta = useGpu ? combined.gpuMedianMs - baseline.gpuMedianMs : null
    const allowance = baseline.meanMs * THRESHOLDS.combinedMaxCostRatio
    const measured = combined.meanMs
    report.costBasis = 'whole-frame mean; CPU and GPU recorded separately'
    report.cost = { baselineGpuMs: useGpu ? baseline.gpuMedianMs : null,
      combinedGpuMs: useGpu ? combined.gpuMedianMs : null,
      gpuDeltaMs: gpuDelta, allowanceMs: allowance, basis: report.costBasis }
    assert.ok(measured <= allowance,
      `the combined configuration's cost must stay within ${allowance.toFixed(2)} ms (2x baseline frame time), got ${measured.toFixed(2)} ms (basis: ${report.costBasis})`)

    // 记录实际生效的开关值，证明测的是真实配置而非请求值。
    for (const entry of report.configurations) {
      assert.ok(entry.actual, `${entry.id}: actual switch state must be recorded`)
      assert.equal(entry.actual.lightingMode,entry.requested.lightingMode,'Measured lighting mode must match request')
      // R7：每个配置都必须跑在**有模型负载**的场景上，而不是空场景。
      assert.ok(entry.setup && entry.setup.load && entry.setup.load.models >= 225 && entry.setup.load.draws >= 32,
        `${entry.id}: the performance load must contain representative models`)
    }
    // R7：负载规模必须一致，保证三配置在同一输入上可比。
    const loadModels = by['ccr-default']?.setup?.load?.models
    for (const id of ['isolated', 'effects-combined']) {
      assert.equal(by[id].setup.load.models, loadModels,
        `${id} must measure the same model load as ccr-default`)
    }
    fs.writeFileSync('docs/verification/stage1-B12/performance.json', JSON.stringify(report, null, 2))

    console.log(JSON.stringify({
      quick: QUICK, thresholds: THRESHOLDS, viewport: [WIDTH, HEIGHT],
      costBasis: report.costBasis,
      setup: by['ccr-default'].setup,
      load: by['ccr-default'].setup.load,
      summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, {
        meanMs: Number(v.meanMs.toFixed(3)), p95Ms: Number(v.p95Ms.toFixed(3)), fps: Number(v.fps.toFixed(2)),
        gpuMedianMs: v.gpuMedianMs === null ? null : Number(v.gpuMedianMs.toFixed(3))
      }])),
      combinedCostRatio: gpuDelta === null ? null : Number((combined.gpuMedianMs / baseline.gpuMedianMs).toFixed(2)),
      cost: report.cost,
      actualSwitches: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.actual]))
    }, null, 2))

    // --- SDK：源码 ESM 与 UMD 的导出 / API / 图像一致性 --------------------
    // 主计划要求「使用同一配置分别加载源码 ESM 与 UMD，检查导出 CCR、
    // 效果/依赖资源、API 和图像一致」。
    const sdk = await compareEsmAndUmd(browser)
    report.sdk = sdk
    fs.writeFileSync('docs/verification/stage1-B12/performance.json', JSON.stringify(report, null, 2))
    assert.deepEqual(sdk.pageErrors, [], 'SDK comparison: no page errors')
    // R7：SDK 一致性必须跑在有模型负载的场景上，而不是空场景。
    assert.ok(sdk.loadModels > 0, 'SDK comparison must load a representative model scene')
    assert.ok(sdk.exportsMatch,
      `UMD must be a superset of the ESM API: ${JSON.stringify(sdk.exportDiff)}`)
    assert.ok(sdk.apiShapeMatch, `the public entry points must have the same types: ${JSON.stringify({ esm: sdk.apiShapeEsm, umd: sdk.apiShapeUmd })}`)
    assert.ok(sdk.imageMatch, `ESM and UMD must render the same image: ${sdk.esmHash} vs ${sdk.umdHash}`)
    assert.ok(sdk.sameRegistry, 'both builds must register the same pipeline registry')
    console.log(JSON.stringify({ sdk: { exports: sdk.exportCount, knownBuildOnly: sdk.exportDiff.knownBuildOnly,
      imageMatch: sdk.imageMatch, esmHash: sdk.esmHash, umdHash: sdk.umdHash,
      sameRegistry: sdk.sameRegistry, apiShapeMatch: sdk.apiShapeMatch } }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 })
