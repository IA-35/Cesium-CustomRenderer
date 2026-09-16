// Asset-free geographic regression. Fixed coordinates are test inputs, never renderer policy.
const { chromium } = require(process.env.CESIUM_PLAYWRIGHT || 'playwright')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const port = process.env.CCR_TEST_PORT || 8877
const cases = [
  { name: 'equator', location: [0, 0, 0] },
  { name: 'southern-elevated', location: [120, -45, 800] },
  { name: 'high-latitude', location: [-60, 78, 0] },
]
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const report = { scope: 'generated PBR geometry, independent geographic inputs; no campus assets or imagery', cases: [] }
  try {
    for (const input of cases) {
      const page = await browser.newPage({ viewport: { width: 960, height: 640 } }), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('http://127.0.0.1:' + port + '/tests/rendering/stage1-fixture.html')
      await page.waitForFunction(() => window.fixture)
      const result = await page.evaluate(async input => {
        fixture.location = input.location
        const { runStage1SceneChecks } = await import('/tests/rendering/stage1-scene.js')
        const result = await runStage1SceneChecks(fixture, { requireCloudPresence: false })
        return { checks: result.checks, errors: fixture.errors }
      }, input)
      report.cases.push({ ...input, ...result, pageErrors: errors })
      assert.ok(Object.values(result.checks).every(Boolean), input.name)
      assert.deepEqual(result.errors, [])
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    fs.writeFileSync(path.join(__dirname, '../docs/verification/generic-locations.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
  console.log(JSON.stringify(report.cases.map(c => ({ name: c.name, checks: Object.keys(c.checks).length, errors: c.errors }))))
})().catch(error => { console.error(error); process.exitCode = 1 })
