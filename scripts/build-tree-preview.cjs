// Builds the scratch tree-tuning preview bundle. Not part of the shipped assets.
const path = require('node:path')
const webpack = require('webpack')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'build/.generated/tree-preview')

const compiler = webpack({
  mode: 'none', target: 'web', devtool: false, performance: { hints: false },
  module: { rules: [{ test: /\.js$/, resolve: { fullySpecified: false } }] },
  entry: path.join(output, 'entry.js'),
  output: { path: output, filename: 'preview.js' },
})
compiler.run((error, stats) => {
  compiler.close(() => {})
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1 }
  else console.log('tree preview bundle written to', path.join(output, 'preview.js'))
})
