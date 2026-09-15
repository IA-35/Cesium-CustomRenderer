// A tiny local static server for the B00 baseline run.
//
// Why this exists: the baseline must be reproducible, and a server started outside this repo can
// change under it. This one also fails loudly when a requested path is missing, which is how a
// missing campus asset becomes a visible B00 failure instead of a silent blank frame.
//
// It is deliberately *not* a replacement for `scripts/dev-server.cjs`: that server is the normal
// development entry point. This wrapper only adds:
//   1. an explicit, recorded root and port,
//   2. a request log so the report can show which assets were actually fetched,
//   3. a hard failure on 404 for campus assets.
//
// Usage: node scripts/baseline-server.cjs [--port 8878] [--root .]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1] }
const port = Number(argOf('--port', process.env.CCR_BASELINE_PORT || 8878))
const root = path.resolve(argOf('--root', path.join(__dirname, '..')))
const logFile = argOf('--log', null)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
}

const SMAA_URL_PREFIX = '/node_modules/cesium/Build/rendering/smaa/'
const SMAA_DIR = path.join(root, 'public', 'rendering', 'smaa')

const requests = []
function record(entry) {
  requests.push(entry)
  if (logFile) fs.writeFileSync(logFile, JSON.stringify(requests, null, 2))
}

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent((request.url || '/').split('?')[0])
  const respond = (status, body, type = 'text/plain; charset=utf-8') => {
    record({ path: pathname, status })
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    response.end(body)
  }

  let target
  if (pathname.startsWith(SMAA_URL_PREFIX)) {
    target = path.join(SMAA_DIR, pathname.slice(SMAA_URL_PREFIX.length))
  } else {
    target = path.resolve(root, '.' + pathname)
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) { respond(403, 'Forbidden'); return }
  }

  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) {
      // Asset misses must be loud: the baseline may not pass because a tile silently failed.
      respond(404, `Not found: ${pathname}`)
      return
    }
    record({ path: pathname, status: 200, bytes: stats.size })
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    fs.createReadStream(target).pipe(response)
  })
})

server.on('error', error => {
  console.error(`[baseline-server] ${error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message}`)
  process.exitCode = 1
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[baseline-server] root ${root}`)
  console.log(`[baseline-server] http://127.0.0.1:${port}/examples/campus.html`)
  if (logFile) console.log(`[baseline-server] request log ${logFile}`)
})
