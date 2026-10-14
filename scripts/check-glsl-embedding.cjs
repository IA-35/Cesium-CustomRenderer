#!/usr/bin/env node
// Guard the two traps that have repeatedly broken the environment shaders.
//
// 1. A backtick inside a GLSL template literal terminates the literal early and reports a
//    SyntaxError far from the cause. This has happened four times, so it is now caught by an
//    authoritative check rather than a heuristic: every source file is parsed, and a parse
//    failure is reported with the offending line.
// 2. The GLSL ES 3.00 reserved qualifier `varying` compiles under WebGL1 but fails in the WebGL2
//    shader Cesium builds.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const roots = [path.join(root, 'src'), path.join(root, 'examples')]
const files = []
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full) }
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full)
  }
}
for (const dir of roots) if (fs.existsSync(dir)) walk(dir)

const problems = []
for (const file of files) {
  const relative = path.relative(root, file).replace(/\\/g, '/')
  // Authoritative parse. --check reports syntax errors without executing the module, which is the
  // only reliable way to catch a stray backtick inside a template literal.
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (check.status !== 0) {
    const match = /(\d+)\n/.exec(check.stderr || '')
    const line = match ? match[1] : '?'
    problems.push({ file: relative, message: `syntax error at line ${line}: ${(check.stderr || '').split('\n')[0]}` })
    continue
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((text, index) => {
    if (/^\s*varying\s+\w/.test(text)) {
      problems.push({ file: relative, message: `line ${index + 1}: GLSL ES 3.00 reserved qualifier 'varying' (use 'in')` })
    }
  })
}

if (problems.length) {
  console.error('GLSL embedding problems:')
  for (const problem of problems) console.error(`  ${problem.file}: ${problem.message}`)
  process.exitCode = 1
} else {
  console.log(`checked ${files.length} files: all parse, no reserved GLSL qualifiers`)
}
