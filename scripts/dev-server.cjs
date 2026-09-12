// Zero-dependency static server for this project.
//
// Two things it does beyond serving files:
//
//   1. Serves the project root, so `/src/...`, `/tests/rendering/...` and
//      `/node_modules/cesium/Build/Cesium/...` are all reachable by URL.
//
//   2. Maps Cesium's SMAA lookup path onto `public/rendering/smaa/`.
//      `src/antialiasing/smaaLookupUrls.js` asks Cesium for
//      `C.buildModuleUrl('../rendering/smaa/<name>')`, which resolves to
//      `<CESIUM_BASE_URL>/../rendering/smaa/<name>`. With Cesium served from
//      `/node_modules/cesium/Build/Cesium/` that becomes
//      `/node_modules/cesium/Build/rendering/smaa/<name>` — a directory that does not
//      exist in the npm package and must not be written into. This alias points it at
//      the project's own copy instead, so the source stays unmodified.
//
// Usage: node scripts/dev-server.cjs [--port 8766] [--root .]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const url = require('node:url')

const argv = process.argv.slice(2)
const argOf = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] }
const port = Number(argOf('--port') || process.env.PORT || 8766)
const root = path.resolve(argOf('--root') || path.join(__dirname, '..'))

const SMAA_URL_PREFIX = '/node_modules/cesium/Build/rendering/smaa/'
const SMAA_DIR = path.join(root, 'public', 'rendering', 'smaa')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
  '.i3dm': 'application/octet-stream', '.cmpt': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.terrain': 'application/octet-stream', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8'
}

function send(response, status, headers, body) {
  response.writeHead(status, headers)
  if (body === undefined || body === null) response.end()
  else if (Buffer.isBuffer(body) || typeof body === 'string') response.end(body)
  else body.pipe(response)
}

function resolveWithin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath).replace(/\\/g, '/')
  const target = path.resolve(base, '.' + decoded)
  const rel = path.relative(base, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

function serveFile(request, response, filePath, directoryUrl) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) { send(response, 404, { 'Content-Type': 'text/plain' }, `Not found: ${request.url}`); return }
    if (directoryUrl && !directoryUrl.endsWith('/')) {
      // Relative asset URLs inside an extensionless index must still resolve.
      send(response, 301, { Location: directoryUrl + '/' }); return
    }
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
    if (request.method === 'HEAD') { send(response, 200, headers); return }
    send(response, 200, headers, fs.createReadStream(filePath))
  })
}

const server = http.createServer((request, response) => {
  const parsed = url.parse(request.url)
  const pathname = parsed.pathname || '/'

  // Alias: Cesium's SMAA lookup path -> the project's own tables.
  if (pathname.startsWith(SMAA_URL_PREFIX)) {
    const name = pathname.slice(SMAA_URL_PREFIX.length)
    const target = resolveWithin(SMAA_DIR, '/' + name)
    if (!target) { send(response, 403, { 'Content-Type': 'text/plain' }, 'Forbidden'); return }
    serveFile(request, response, target)
    return
  }

  let target = resolveWithin(root, pathname)
  if (!target) { send(response, 403, { 'Content-Type': 'text/plain' }, 'Forbidden'); return }

  fs.stat(target, (error, stats) => {
    if (!error && stats.isDirectory()) {
      const asIndex = path.join(target, 'index.html')
      if (fs.existsSync(asIndex)) { serveFile(request, response, asIndex); return }
      serveFile(request, response, asIndex, pathname) // 301 onto a trailing slash
      return
    }
    serveFile(request, response, target)
  })
})

server.on('error', error => {
  console.error(`[dev-server] ${error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message}`)
  process.exitCode = 1
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[dev-server] root   ${root}`)
  console.log(`[dev-server] cesium ${path.join(root, 'node_modules/cesium/Build/Cesium')}`)
  console.log(`[dev-server] smaa   ${SMAA_DIR} (aliased to ${SMAA_URL_PREFIX})`)
  console.log(`[dev-server] http://127.0.0.1:${port}/examples/index.html`)
  console.log(`[dev-server] http://127.0.0.1:${port}/tests/rendering/preview.html`)
})
