#!/usr/bin/env node
// 文档断链检查。
//
// 重组（scripts/tidy-docs.cjs 把 docs/*.md 归入主题子目录）之后，需要确认没有留下
// 指向已移动文件的坏链。本脚本解析 docs/ 下每个 markdown 的链接目标并逐一判存在性。
//
// 设计取舍：只做**检查**，不自动改写。自动重写需要知道"引用者当初的相对关系"，
// 只在重组的那一刻才有那种信息；事后猜测容易把正确的链接改坏。
//
// 用法：
//   node scripts/check-doc-links.cjs               报告坏链，有坏链则退出码 1
//   node scripts/check-doc-links.cjs --allow-json  忽略指向未入库产物的 .json 链接
//
// 退出码用于 CI 或 pre-commit：0 = 无坏链，1 = 存在坏链。
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const docsDir = path.join(root, 'docs')
const allowJson = process.argv.includes('--allow-json')

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walkMarkdown(path.join(dir, entry.name), out)
    } else if (entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

// 目标是外部资源（http/https/mailto/data/锚点/绝对 URL）时不参与校验。
const isExternal = t => /^(https?:|mailto:|data:|#|\/)/.test(t)
// 指向 repo 之外的本地绝对路径（其它工程的路径）同样跳过，它们本来就不可校验。
const isForeignAbsolute = t => /^[A-Za-z]:[\\/]/.test(t) || /^<[A-Za-z]:[\\/]/.test(t)
// docs/verification/ 是脚本输出目录：内容被 .gitignore 忽略，克隆后本就不存在。
// 指向那里的截图/JSON 链接是"本机重跑脚本才有效"的运行产物引用，不是版本化内容，
// 因此默认不计入坏链（与 .gitignore 的既有约定一致）。
// 用 --strict 可以把它们也报出来，用于检查产物是否真的生成过。
const VERIFICATION_PREFIX = 'docs/verification/'
const strict = process.argv.includes('--strict')
function pointsIntoVerification(docRel, target) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(docRel), target))
  return resolved.startsWith(VERIFICATION_PREFIX)
}

const broken = []
const verificationRefs = []
let checked = 0

for (const file of walkMarkdown(docsDir)) {
  const text = fs.readFileSync(file, 'utf8')
  const dir = path.dirname(file)
  const docRel = path.relative(root, file).split(path.sep).join('/')
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    let target = match[1]
    if (isExternal(target)) continue
    // markdown 允许 <...> 包裹含空格/非 ASCII 的路径。
    const angled = target.startsWith('<') && target.endsWith('>')
    if (angled) target = target.slice(1, -1)
    if (isForeignAbsolute(target)) continue
    const bare = target.split('#')[0]
    if (!bare) continue
    if (allowJson && bare.endsWith('.json')) continue
    const line = text.slice(0, match.index).split('\n').length
    const exists = fs.existsSync(path.resolve(dir, decodeURI(bare)))
    if (exists) { checked++; continue }
    const entry = { doc: docRel, target: match[1], line }
    if (!strict && pointsIntoVerification(docRel, decodeURI(bare).split(path.sep).join('/'))) {
      verificationRefs.push(entry)
      continue
    }
    checked++
    broken.push(entry)
  }
}

console.log(JSON.stringify({
  markdownFiles: walkMarkdown(docsDir).length,
  linksChecked: checked,
  brokenLinks: broken.length,
  // 指向 docs/verification/ 的失效引用：属于"本机产物未生成"，由 .gitignore 约定容忍。
  verificationRefs: verificationRefs.length,
  hint: verificationRefs.length
    ? 'verificationRefs 指向脚本输出目录，重跑对应 check-*.cjs 即可重新生成；用 --strict 可把它们也视为坏链。'
    : undefined,
  broken: broken.slice(0, 60),
  verificationSample: verificationRefs.slice(0, 10)
}, null, 2))

process.exitCode = broken.length ? 1 : 0
