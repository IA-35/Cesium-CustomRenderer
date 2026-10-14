#!/usr/bin/env node
// Phase 7: compare a frozen Phase 0 baseline against a later run.
//
// It only reports a delta it can actually compute. A missing GPU timer, a missing memory
// counter or a failed validity gate is stated as "not comparable" instead of being treated as
// zero, because a fabricated improvement is worse than an admitted gap.
const fs = require('node:fs')
const path = require('node:path')

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
}

function percentChange(before, after) {
  // Both sides missing means "not comparable", not "no change": reporting 0 would let a
  // metric with no data look like a measured result.
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  if (before === 0) return null
  return (after - before) / before
}

function format(value, unit = '') {
  return Number.isFinite(value) ? `${value.toFixed(3)}${unit}` : 'unavailable'
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'not comparable'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}%`
}

// Pull the per-side number for one metric, keeping "unavailable" distinct from zero.
function pick(run, kind, metric) {
  if (!run) return null
  if (kind === 'frame') return Number.isFinite(run.frame?.[metric]?.p50) ? run.frame[metric] : null
  if (kind === 'state') return Number.isFinite(run.state?.[metric]) ? { p50: run.state[metric] } : null
  if (kind === 'memory') return Number.isFinite(run.memory?.[metric]) ? { p50: run.memory[metric] } : null
  return null
}

function summarizeRun(run) {
  if (!run) return null
  return {
    cpuP50: run.frame?.cpuMs?.p50 ?? null,
    cpuP95: run.frame?.cpuMs?.p95 ?? null,
    gpuP50: run.frame?.gpuMs?.p50 ?? null,
    gpuP95: run.frame?.gpuMs?.p95 ?? null,
    drawCalls: run.frame?.drawCalls ?? null,
    submittedCommands: run.frame?.submittedCommands ?? null,
    programBinds: run.state?.programBinds ?? null,
    drawHookInvocations: run.state?.drawHookInvocations ?? null,
    ccrTextureBytes: run.memory?.ccrTextureBytes ?? null,
    poolPeakBytes: run.memory?.poolPeakBytes ?? null,
    graphPeakBytes: run.memory?.graphPeakBytes ?? null,
    validFrames: run.validity?.validFrames ?? null,
    invalidFrames: run.validity?.invalidFrames ?? null,
    gpuSupported: run.validity?.gpuSupported === true
  }
}

// Contract thresholds from RENDERING_PERFORMANCE_NEXT_v3.md Phase 6.
const THRESHOLDS = Object.freeze({
  programBindReduction: 0.30,
  cpuP95Reduction: 0.15,
  gpuP50Reduction: 0.10
})

function buildComparison(beforeRun, afterRun) {
  const before = summarizeRun(beforeRun), after = summarizeRun(afterRun)
  if (!before || !after) throw new Error('both baseline and candidate runs are required')
  const cpuP95Delta = percentChange(before.cpuP95, after.cpuP95)
  const gpuP50Delta = percentChange(before.gpuP50, after.gpuP50)
  const programBindsDelta = percentChange(before.programBinds, after.programBinds)
  // A reduction is the improvement direction, so invert the sign for reporting.
  // Normalise -0 to 0: an unchanged metric must not read as a negative zero in reports.
  const reductionOf = delta => Number.isFinite(delta) ? (-delta || 0) : null
  const metrics = {
    cpuP95: { before: before.cpuP95, after: after.cpuP95, change: cpuP95Delta, reduction: reductionOf(cpuP95Delta), target: THRESHOLDS.cpuP95Reduction },
    gpuP50: { before: before.gpuP50, after: after.gpuP50, change: gpuP50Delta, reduction: reductionOf(gpuP50Delta), target: THRESHOLDS.gpuP50Reduction },
    programBinds: { before: before.programBinds, after: after.programBinds, change: programBindsDelta, reduction: reductionOf(programBindsDelta), target: THRESHOLDS.programBindReduction }
  }
  const achieved = Object.entries(metrics).filter(([, m]) => Number.isFinite(m.reduction) && m.reduction >= m.target).map(([name]) => name)
  // Correctness first: an invalid run makes every timing number meaningless.
  const correctness = before.invalidFrames === 0 && after.invalidFrames === 0 ? 'pass' : 'fail'
  const noRegression = correctness === 'pass' && after.validFrames > 0 ? 'pass' : 'fail'
  return {
    schemaVersion: 'phase7-comparison-v1',
    correctness, noRegression,
    optimizationSuccess: achieved.length >= 3 ? 'pass' : achieved.length ? `partial (${achieved.join(', ')})` : 'not-achieved',
    achieved, thresholds: { ...THRESHOLDS },
    metrics, before, after,
    notes: [
      'tracked allocation bytes are CCR-owned allocations, not true board VRAM',
      'headless/short samples are not production performance',
      before.gpuSupported && after.gpuSupported ? 'GPU timing available on both sides' : 'GPU timing unavailable on at least one side; GPU rows are not comparable'
    ]
  }
}

function renderMarkdown(comparison, beforeLabel, afterLabel) {
  const lines = []
  lines.push('# Phase 7 rendering comparison')
  lines.push('')
  lines.push(`- baseline: \`${beforeLabel}\``)
  lines.push(`- candidate: \`${afterLabel}\``)
  lines.push('')
  lines.push(`- correctness: **${comparison.correctness}**`)
  lines.push(`- no-regression: **${comparison.noRegression}**`)
  lines.push(`- optimization success: **${comparison.optimizationSuccess}**`)
  lines.push('')
  lines.push('| metric | baseline | candidate | change | reduction | target |')
  lines.push('|---|---|---|---|---|---|')
  for (const [name, m] of Object.entries(comparison.metrics)) {
    lines.push(`| ${name} | ${format(m.before)} | ${format(m.after)} | ${formatPercent(m.change)} | ${formatPercent(m.reduction)} | ${(m.target * 100).toFixed(0)}% |`)
  }
  lines.push('')
  lines.push('| counter | baseline | candidate |')
  lines.push('|---|---|---|')
  for (const key of ['drawCalls', 'submittedCommands', 'drawHookInvocations', 'ccrTextureBytes', 'poolPeakBytes', 'graphPeakBytes', 'validFrames', 'invalidFrames']) {
    lines.push(`| ${key} | ${comparison.before[key] ?? 'unavailable'} | ${comparison.after[key] ?? 'unavailable'} |`)
  }
  lines.push('')
  lines.push('## Caveats')
  lines.push('')
  for (const note of comparison.notes) lines.push(`- ${note}`)
  lines.push('')
  return lines.join('\n')
}

function usage() {
  return 'Usage: node scripts/performance/compare-rendering-baseline.cjs --baseline <baseline.json> --candidate <candidate.json> [--case <name>] [--json <out.json>] [--md <out.md>]'
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = { baseline: null, candidate: null, case: null, json: null, md: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2)
    const value = inline === undefined ? argv[++i] : inline
    if (key === '--baseline') result.baseline = value
    else if (key === '--candidate') result.candidate = value
    else if (key === '--case') result.case = value
    else if (key === '--json') result.json = value
    else if (key === '--md') result.md = value
    else if (key === '--help' || key === '-h') result.help = true
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  return result
}

// Accept either a single run or a multi-run baseline file and pick the matching case.
function selectRun(document, wantedCase) {
  if (document?.runs?.length) {
    if (wantedCase) {
      const match = document.runs.find(run => run.case === wantedCase) || null
      if (!match) throw new Error(`case "${wantedCase}" not found in ${document.runs.map(r => r.case).join(', ')}`)
      return match
    }
    return document.runs[0]
  }
  if (document?.run) return document.run
  return document
}

function main() {
  const options = parseArgs()
  if (options.help) { console.log(usage()); return }
  if (!options.baseline || !options.candidate) throw new Error(`--baseline and --candidate are required\n${usage()}`)
  const beforeDoc = readJson(options.baseline), afterDoc = readJson(options.candidate)
  const beforeRun = selectRun(beforeDoc, options.case)
  const afterRun = selectRun(afterDoc, options.case || beforeRun?.case)
  const comparison = buildComparison(beforeRun, afterRun)
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(comparison, null, 2) + '\n')
  if (options.md) fs.writeFileSync(options.md, renderMarkdown(comparison, options.baseline, options.candidate))
  console.log(JSON.stringify({ correctness: comparison.correctness, noRegression: comparison.noRegression,
    optimizationSuccess: comparison.optimizationSuccess, achieved: comparison.achieved,
    metrics: comparison.metrics }, null, 2))
}

module.exports = { buildComparison, renderMarkdown, selectRun, summarizeRun, percentChange, THRESHOLDS }

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
