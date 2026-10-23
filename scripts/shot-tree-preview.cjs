// Renders the tree-tuning preview page to a PNG for a given preset + overrides.
// Usage: node scripts/shot-tree-preview.cjs <preset> <overridesJson> <seed> <out.png> [label]
const path = require('node:path')
const { chromium } = require('C:/Users/Administrator/node_modules/playwright')

const [preset = 'Pine Medium', overridesJson = '{}', seedArg = '', outArg = 'G:/tmp/tree_preview.png'] = process.argv.slice(2)
const seed = seedArg === '' ? undefined : Number(seedArg)
const overrides = JSON.parse(overridesJson)
const label = process.argv[7] || preset

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11'] })
  const page = await browser.newPage({ viewport: { width: 720, height: 720 } })
  const errors = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)) })
  page.on('pageerror', error => errors.push(String(error).slice(0, 200)))
  await page.goto('http://127.0.0.1:8766/examples/tree-preview.html', { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 30000 })
  const stats = await page.evaluate(args => window.__TUNE__(args.preset, args.overrides, args.seed, args.label), { preset, overrides, seed, label })
  await page.waitForTimeout(220)
  await page.screenshot({ path: outArg })
  console.log(JSON.stringify({ out: outArg, stats, errors: errors.slice(0, 4) }))
  await browser.close()
})().catch(error => { console.error(error); process.exitCode = 1 })
