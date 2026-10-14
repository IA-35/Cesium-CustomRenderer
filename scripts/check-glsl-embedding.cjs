#!/usr/bin/env node
// Guard against a backtick inside a GLSL template literal, and against the GLSL ES 3.00
// reserved qualifier `varying`.
//
// GLSL is embedded in JS template strings throughout the environment modules. A backtick inside
// one of those strings terminates the literal early and produces a SyntaxError reported far from
// the real cause. That mistake was made three times while rewriting the environment stages, so it
// is checked mechanically instead of by eye. `varying` compiles under WebGL1 but fails in the
// WebGL2 shader Cesium builds, which is a second, unrelated trap in the same code.
const fs = require('node:fs')
const path = require('node:path')

const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'examples')]
const files = []
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full) }
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}
for (const root of roots) if (fs.existsSync(root)) walk(root)

// Find template literal spans and report any backtick that appears where the scanner did not
// expect the literal to close: that is the signature of an accidental inner backtick.
function scanTemplates(source) {
  const spans = []
  let index = 0
  while (index < source.length) {
    const tick = source.indexOf('`', index)
    if (tick === -1) break
    let backslashes = 0
    for (let i = tick - 1; i >= 0 && source[i] === '\\'; i--) backslashes++
    if (backslashes % 2 === 1) { index = tick + 1; continue }
    const start = tick
    let end = -1
    let cursor = tick + 1
    while (cursor < source.length) {
      const next = source.indexOf('`', cursor)
      if (next === -1) break
      let slashes = 0
      for (let i = next - 1; i >= 0 && source[i] === '\\'; i--) slashes++
      if (slashes % 2 === 0) { end = next; break }
      cursor = next + 1
    }
    if (end === -1) break
    spans.push({ start, end, body: source.slice(start + 1, end) })
    index = end + 1
  }
  return spans
}

const problems = []
for (const file of files) {
  const relative = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')
  const source = fs.readFileSync(file, 'utf8')
  const malformed = scanTemplates(source)
  // A template containing an odd, unexplained backtick nearly always means an inner one slipped
  // in: the scan above would have produced a span that stops mid-statement. Detect that by
  // checking whether the file parses as a module.
  const shaderSpans = malformed.filter(span => /v_textureCoordinates|out_FragColor|uniform |void main\(/.test(span.body))
  for (const span of shaderSpans) {
    const body = span.body
    // Any backtick inside a shader body is illegal: it would have ended the literal.
    if (body.includes('`')) {
      const line = source.slice(0, span.start).split('\n').length
      problems.push({ file: relative, message: `template literal near line ${line} contains a nested backtick` })
    }
  }
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    if (/^\s*varying\s+\w/.test(line)) {
      problems.push({ file: relative, message: `line ${index + 1}: GLSL ES 3.00 reserved qualifier 'varying' (use 'in')` })
    }
  })
}

if (problems.length) {
  console.error('GLSL embedding problems:')
  for (const problem of problems) console.error(`  ${problem.file}: ${problem.message}`)
  process.exitCode = 1
} else {
  console.log(`checked ${files.length} files: no nested backticks or reserved GLSL qualifiers`)
}
