// Compatibility entry for B00. Reuse the project server's path validation and runtime config.
if (process.argv.includes('--log')) {
  throw new Error('Use check-stage1-baseline reports for request evidence; --log is no longer supported')
}
if (!process.argv.includes('--port')) {
  process.argv.push('--port', process.env.CCR_BASELINE_PORT || '8878')
}
require('./dev-server.cjs')
