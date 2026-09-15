// Builds the standalone UMD bundle for the custom Cesium 1.143 rendering pipeline.
//
// The bundle is engine-free: Cesium is never inlined. The consumer must already have a
// complete Cesium 1.143.0 distribution loaded (see the bundled example.html and README).
// The two SMAA lookup tables ARE embedded as data URLs so the bundle has no asset
// side-loading, and `smaaLookupUrls.js` is swapped for the embedded copy at build time.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')
const webpack = require('webpack')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const library = 'CCR'
const cesiumVersion = pkg.dependencies.cesium.replace(/^[^\d]*/, '')
const version = pkg.version
const output = path.join(root, 'build', version)
const generated = path.join(root, 'build/.generated')
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(generated, { recursive: true })
const source = path.join(root, 'src')
const modulePath = file => JSON.stringify(path.join(source, file).replace(/\\/g, '/'))
const entry = path.join(generated, 'entry.js')
fs.writeFileSync(entry, `export * from ${modulePath('index.js')};
export { default as LightUniforms143 } from ${modulePath('buffers/LightUniforms143.js')};
export { default as RenderProfiler143 } from ${modulePath('diagnostics/RenderProfiler143.js')};
export const VERSION = ${JSON.stringify(version)};
export const CESIUM_VERSION = ${JSON.stringify(cesiumVersion)};
`)

// Embed the SMAA area/search tables so the bundle ships as a single JavaScript file.
const lookups = Object.fromEntries(['AreaTex.png', 'SearchTex.png'].map(name => [name,
  'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/rendering/smaa', name)).toString('base64')]))
const lookupModule = path.join(generated, 'smaaLookupUrls.js')
fs.writeFileSync(lookupModule, `const urls = ${JSON.stringify(lookups)};\nexport const smaaLookupUrl = (C, name) => urls[name];\n`)

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // This project is not required to be a git checkout; the source hashes below are authoritative.
    return null
  }
}

const compiler = webpack({
  mode: 'production', context: root, entry, devtool: false,
  output: { path: output, filename: `${library}.min.js`, library, libraryTarget: 'umd',
    globalObject: "typeof self !== 'undefined' ? self : this" },
  module: { rules: [{ test: /\.js$/, include: [source, generated], use: {
    loader: require.resolve('babel-loader'), options: { babelrc: false, configFile: false,
      presets: [[require.resolve('@babel/preset-env'), { targets: { chrome: '70' }, modules: false, useBuiltIns: false }]] }
  }}] },
  plugins: [new webpack.NormalModuleReplacementPlugin(/smaaLookupUrls\.js$/, lookupModule)],
  optimization: { splitChunks: false, runtimeChunk: false },
  performance: { hints: false }
})
compiler.run((error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; return }
  const file = path.join(output, `${library}.min.js`)
  const bytes = fs.readFileSync(file), gzip = zlib.gzipSync(bytes, { level: 9 })
  fs.writeFileSync(file + '.gz', gzip)
  // The source package is ESM. This local boundary makes the UMD .js file
  // consumable by require() without changing browser script loading.
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
  fs.copyFileSync(path.join(root, 'public/rendering/smaa/LICENSE.txt'), path.join(output, 'THIRD_PARTY_LICENSES.txt'))
  fs.copyFileSync(path.join(root, 'docs/ALGORITHM_REFERENCES.md'), path.join(output, 'ALGORITHM_REFERENCES.md'))
  const hashes = {}
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name)
    if (item.isDirectory()) walk(target)
    else if (item.name.endsWith('.js')) hashes[path.relative(root, target).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  } }
  walk(source)
  const manifest = { name: library, version, cesiumVersion, format: 'UMD',
    runtimeDependencies: [`external Cesium ${cesiumVersion} distribution`, 'WebGL2 browser'],
    embeddedAssets: Object.keys(lookups), bundledEngine: false, bundledBusinessUI: false,
    sourceCommit: sourceCommit(), sourceState: 'working-tree snapshot; source hashes are authoritative',
    sourceHashes: hashes,
    bytes: bytes.length, gzipBytes: gzip.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.copyFileSync(path.join(root, 'scripts/rendering-sdk-README.md'), path.join(output, 'README.md'))
  fs.copyFileSync(path.join(root, 'scripts/rendering-sdk-example.html'), path.join(output, 'example.html'))
  console.log(JSON.stringify({ output, bytes: bytes.length, gzipBytes: gzip.length, sha256: manifest.sha256 }))
})
