// B00: lock a reproducible campus/enhanced baseline and record it as evidence.
//
// Usage (dev server must already be running, see README):
//   $env:CESIUM_PLAYWRIGHT = '<path to playwright>'
//   $env:CCR_TEST_PORT = '8877'
//   node scripts/check-stage1-baseline.cjs --target campus   # real campus assets + imagery
//   node scripts/check-stage1-baseline.cjs --target fixtures # offline synthetic scene
//   node scripts/check-stage1-baseline.cjs --target campus --repeat 2   # determinism replay
//
// Exit code 0 only when every capture ran with identical frozen inputs, produced a non-blank
// picture and reported no render error. Missing assets are failures: the script never suppresses
// imagery to turn a broken campus run into a green one.
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1] }
const target = argOf('--target', 'campus')
const repeat = Number(argOf('--repeat', '1'))
const port = process.env.CCR_TEST_PORT || '8877'
const base = `http://127.0.0.1:${port}`
const output = path.resolve(__dirname, `../docs/verification/stage1-B00/${target}`)

const TARGETS = {
  campus: {
    url: `${base}/examples/campus.html`,
    ready: () => globalThis.campus && globalThis.campus.tiles.length === 3 && globalThis.campus.tiles.every(tile => tile.tilesLoaded),
    label: '南湖校区实景（本地瓦片 + 沈阳影像）',
  },
  fixtures: {
    url: `${base}/tests/rendering/stage1-fixture.html`,
    ready: () => !!globalThis.fixture,
    label: '离线合成夹具（无底图）',
  },
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Snapshot the work tree the way the plan demands: HEAD *and* the dirty working tree, because the
// stage-one features live in uncommitted files.
function workTreeSnapshot() {
  const run = args => execFileSync('git', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim()
  const status = run(['status', '--porcelain'])
  const files = new Map()
  for (const file of run(['ls-files']).split('\n').filter(Boolean)) {
    const absolute = path.resolve(__dirname, '..', file)
    try {
      const stats = fs.statSync(absolute)
      files.set(file, `${stats.size}:${stats.mtimeMs}`)
    } catch { /* deleted in working tree */ }
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const file = line.slice(3).trim().replace(/^"|"$/g, '')
    const absolute = path.resolve(__dirname, '..', file)
    try {
      const stats = fs.statSync(absolute)
      if (!stats.isFile()) continue
      files.set(file, `${stats.size}:${stats.mtimeMs}`)
    } catch { /* untracked directory entry */ }
  }
  return {
    head: run(['rev-parse', 'HEAD']),
    headSubject: run(['log', '-1', '--pretty=%s']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    trackedFiles: files.size,
    modifiedFiles: status.split('\n').filter(Boolean).length,
    statusHash: crypto.createHash('sha256').update(status).digest('hex'),
    dirty: status.length > 0,
  }
}

function assetManifest() {
  const root = path.resolve(__dirname, '../assets/campus-assets')
  const entries = []
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const stats = fs.statSync(absolute)
      const relative = path.relative(path.resolve(__dirname, '..'), absolute).replace(/\\/g, '/')
      if (stats.isDirectory()) walk(absolute)
      else entries.push({ path: relative, bytes: stats.size, sha256: sha256File(absolute) })
    }
  }
  if (fs.existsSync(root)) walk(root)
  return entries
}

;(async () => {
  const definition = TARGETS[target]
  assert.ok(definition, `unknown --target ${target}; expected one of ${Object.keys(TARGETS).join(', ')}`)
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    const consoleErrors = []
    const failedRequests = []
    const responses = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }))
    // A console "Failed to load resource" has no URL in the message, so the response listener is what
    // makes a missing asset diagnosable. 404s on unrelated favicons/tiles must not hide campus misses.
    page.on('response', response => { if (response.status() >= 400) responses.push({ url: response.url(), status: response.status() }) })

    await page.goto(definition.url)
    await page.waitForFunction(definition.ready, null, { timeout: 90000 })
    // Freeze the noise/animation clock and hide the UI chrome so captures compare like for like.
    await page.evaluate(() => {
      const host = globalThis.campus || globalThis.fixture
      host.pipeline?.setOptions({ environmentAnimation: false })
      const scene = host.viewer.scene
      scene.screenSpaceCameraController.enableCollisionDetection = false
      scene.screenSpaceCameraController.enableInputs = false
      for (const node of document.querySelectorAll('.lil-gui.lil-root,#hud,.stats-panel')) node.style.display = 'none'
      if (host.stats?.dom) host.stats.dom.style.display = 'none'
    })

    // The scripts below live in the page; the fixture module is imported from the dev server.
    const runs = []
    for (let round = 0; round < Math.max(1, repeat); round++) {
      const result = await page.evaluate(async () => {
        const { runBaseline, cameraSnapshot, waitFrames, readDrawingBuffer, hashBytes } = await import('/tests/rendering/stage1-baseline-fixture.js')
        const host = globalThis.fixture || globalThis.campus
        const { viewer } = host
        const scene = viewer.scene
        const errors = host.errors || []
        const baseline = await runBaseline(host)
        await waitFrames(scene, 4, errors, 30000)
        const readback = readDrawingBuffer(viewer)
        // Campus assets are private; record a screenshot-ready summary rather than pixel data.
        return {
          ...baseline,
          snapshot: cameraSnapshot(viewer),
          readback: { width: readback.width, height: readback.height, hash: hashBytes(readback.data), stats: readback.stats },
        }
      })
      await page.screenshot({ path: path.join(output, `round-${round + 1}.png`) })
      runs.push(result)
    }

    // Determinism gate: two runs of the same frozen configuration must agree exactly.
    const comparison = []
    if (runs.length > 1) {
      const first = runs[0]
      for (let index = 1; index < runs.length; index++) {
        const other = runs[index]
        const pairs = first.measurements.captures.map((capture, i) => {
          const otherCapture = other.measurements.captures[i]
          const framePairs = capture.frames && otherCapture?.frames
            ? capture.frames.map((frame, j) => ({
                index: frame.index,
                hashEqual: frame.hash === otherCapture.frames[j]?.hash,
                statsEqual: JSON.stringify(frame.stats) === JSON.stringify(otherCapture.frames[j]?.stats),
              }))
            : undefined
          return {
            shot: capture.shot,
            configuration: capture.configuration,
            hashEqual: capture.hash === otherCapture?.hash,
            statsEqual: JSON.stringify(capture.stats) === JSON.stringify(otherCapture?.stats),
            frames: framePairs,
            framesStable: framePairs ? framePairs.every(pair => pair.hashEqual && pair.statsEqual) : undefined,
            first: capture.stats,
            other: otherCapture?.stats,
          }
        })
        const stable = pairs.every(pair => pair.hashEqual && pair.statsEqual && pair.framesStable !== false)
        comparison.push({ round: index + 1, stable, pairs })
        fs.mkdirSync(output, { recursive: true })
        fs.writeFileSync(path.join(output, `determinism-round${index + 1}.json`), JSON.stringify({
          snapshotEqual: JSON.stringify(first.snapshot) === JSON.stringify(other.snapshot),
          firstSnapshot: first.snapshot,
          otherSnapshot: other.snapshot,
          pairs,
        }, null, 2))
      }
    }

    // Persist the report *before* asserting, so a failed determinism gate still leaves diagnosable
    // evidence on disk instead of only a console trace.
    const report = {
      batch: 'B00',
      target,
      targetLabel: definition.label,
      generatedAt: new Date().toISOString(),
      scope: target === 'campus'
        ? '1280x720 headless Chrome, real campus assets and imagery; image baseline + determinism, not a performance acceptance'
        : '1280x720 headless Chrome, offline synthetic fixture; environment-independent baseline',
      valid: comparison.every(entry => entry.stable),
      workTree: workTreeSnapshot(),
      assets: target === 'campus' ? assetManifest() : [],
      requests: { failed: failedRequests, consoleErrors, httpErrors: responses },
      runs,
      determinism: comparison,
      limitations: [
        'Headless Chrome cannot be used as foreground performance evidence; frame timings are deliberately not recorded here.',
        'Campus imagery comes from an external tile service (redacted to a template identifier); a network change alters the panorama/horizon shots but not the local-model shots.',
        'The baseline captures the current enhanced path. It does not exercise deferred lighting, which does not exist yet (B02+).',
      ],
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))

    // Classify the residual difference instead of guessing: two frozen runs that share the same
    // camera still differ somewhere, and knowing *where* decides whether the baseline needs more
    // warm-up frames or whether the effect genuinely depends on wall-clock time.
    const classification = await page.evaluate(async shots => {
      const { waitFrames, readDrawingBuffer, diffBytes, hashBytes } = await import('/tests/rendering/stage1-baseline-fixture.js')
      const host = globalThis.fixture || globalThis.campus
      const { viewer, pipeline } = host
      const scene = viewer.scene
      const origin = host.origin || pipeline.campusOrigin || Cesium.Cartesian3.fromDegrees(123.42, 41.77, 0)
      const { holdView } = await import('/tests/rendering/stage1-baseline-fixture.js')
      const results = []
      for (const shot of shots) {
        const targetHeading = shot.kind === 'orbit' ? shot.heading : 0
        for (const settle of [shot.frames, shot.frames]) {
          holdView(viewer, origin, targetHeading, shot.pitch, shot.range)
          await waitFrames(scene, settle, [], 30000)
        }
        const a = readDrawingBuffer(viewer)
        for (let i = 0; i < 2; i++) {
          holdView(viewer, origin, targetHeading, shot.pitch, shot.range)
          await waitFrames(scene, shot.frames, [], 30000)
        }
        const b = readDrawingBuffer(viewer)
        // Locate the differing rows so the report says "sky band" vs "whole frame".
        const rows = new Set()
        for (let row = 0; row < a.height; row++) {
          for (let column = 0; column < a.width; column++) {
            const i = (row * a.width + column) * 4
            if (Math.abs(a.data[i] - b.data[i]) || Math.abs(a.data[i + 1] - b.data[i + 1]) || Math.abs(a.data[i + 2] - b.data[i + 2])) { rows.add(row); break }
          }
        }
        const sortedRows = [...rows].sort((x, y) => x - y)
        results.push({
          shot: shot.id,
          settleFrames: shot.frames,
          hashA: hashBytes(a.data),
          hashB: hashBytes(b.data),
          diff: diffBytes(a.data, b.data),
          differingRows: sortedRows.length,
          differingRowRange: sortedRows.length ? [sortedRows[0], sortedRows[sortedRows.length - 1]] : null,
          height: a.height,
        })
      }
      return results
    }, await page.evaluate(async () => {
      const { BASELINE_SHOTS } = await import('/tests/rendering/stage1-baseline-fixture.js')
      // Extra patience on the frames the two-round run reported as unstable, so the report can say
      // whether they ever converge or whether the effect depends on wall-clock time.
      const patience = { orbit: 60 }
      return BASELINE_SHOTS.map(shot => ({
        id: shot.id,
        kind: shot.kind,
        pitch: shot.pitch,
        range: shot.range,
        heading: (7 * Math.PI * 2) / 8,
        secondHeading: (6 * Math.PI * 2) / 8,
        frames: patience[shot.id] ?? (shot.kind === 'orbit' ? 12 : 40),
      }))
    }))
    fs.writeFileSync(path.join(output, 'classification.json'), JSON.stringify(classification, null, 2))

    for (const entry of comparison) {
      assert.ok(entry.stable, `baseline round ${entry.round} differs from round 1: ${JSON.stringify(entry.pairs.filter(pair => !pair.hashEqual || !pair.statsEqual))}`)
    }
    if (runs.length > 1) {
      assert.ok(JSON.stringify(runs[0].snapshot) === JSON.stringify(runs[runs.length - 1].snapshot), 'camera snapshot drifted between rounds')
    }

    for (const run of runs) {
      assert.ok(Object.values(run.checks).every(Boolean), `baseline checks failed: ${JSON.stringify(run.checks)}`)
    }
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`)
    assert.equal(failedRequests.length, 0, `failed requests: ${JSON.stringify(failedRequests)}`)
    // Assets under this repo are the baseline inputs: a missing one invalidates the reference.
    const missingAssets = responses.filter(entry => entry.url.includes('/assets/') || entry.url.includes('/examples/') || entry.url.includes('/tests/'))
    assert.equal(missingAssets.length, 0, `missing project assets: ${JSON.stringify(missingAssets)}`)
    const strayErrors = responses.filter(entry => entry.status >= 400)
    if (strayErrors.length) {
      console.log(`[baseline] non-fatal external responses: ${JSON.stringify(strayErrors)}`)
    }

    const frozen = {
      batch: 'B00',
      target,
      reference: { viewport: { width: 1280, height: 720 }, time: '2026-06-21T04:00:00Z' },
      captures: runs[0].measurements.captures,
      runtime: runs[0].measurements.configurations,
      snapshot: runs[0].snapshot,
      notes: [
        'Hashes are FNV-style hashes of the presented default framebuffer (RGBA8 readback).',
        'A later batch compares its own capture against these hashes for the same frozen configuration.',
        'The 12-50 km cloud fade is the reference for high-altitude shots; do not widen it.',
      ],
    }
    fs.writeFileSync(path.resolve(__dirname, '../tests/rendering/stage1-baseline.json'), JSON.stringify(frozen, null, 2))

    console.log(JSON.stringify({
      target,
      checks: Object.keys(runs[0].checks).length,
      allChecksPassed: Object.values(runs[0].checks).every(Boolean),
      captures: runs[0].measurements.captures.length,
      determinism: comparison.map(entry => ({ round: entry.round, stable: entry.stable })),
      drawingBuffer: runs[0].readback,
      pageErrors,
      report: path.relative(path.resolve(__dirname, '..'), path.join(output, 'report.json')),
    }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
