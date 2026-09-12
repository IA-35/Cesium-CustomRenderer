const owners = new WeakMap()

// 1.143's multipass OIT wrapper writes out_FragColor but its czm_out_FragColor
// temporary prevents ShaderSource from declaring that output in WebGL2.
// Patch only those derived sources; Cesium continues to own shader/cache lifetime.
export function installOitCompatibility143(C, scene) {
  const context = scene.context, cache = context && context.shaderCache
  if (!context || !context.webgl2 || !cache || !cache.createDerivedShaderProgram) return () => {}
  if (!/^1\.143(?:\.0)?$/.test(C.VERSION)) throw new Error('OIT compatibility requires Cesium 1.143')
  let owner = owners.get(cache)
  if (!owner) {
    owner = { count: 0, active: true, previous: cache.createDerivedShaderProgram }
    owner.hook = function(program, keyword, options) {
      if (owner.active && ['translucentMultipass', 'alphaMultipass'].includes(keyword)) {
        const fs = options && options.fragmentShaderSource
        const source = fs && fs.sources && fs.sources.join('\n')
        if (source && /\bczm_translucent_main\b/.test(source) && /\bczm_out_FragColor\b/.test(source) &&
            !/\bout\s+vec4\s+out_FragColor\b/.test(source)) {
          const patched = fs.clone()
          patched.sources.unshift('layout(location = 0) out vec4 out_FragColor;')
          options = { ...options, fragmentShaderSource: patched }
        }
      }
      return owner.previous.call(this, program, keyword, options)
    }
    cache.createDerivedShaderProgram = owner.hook
    owners.set(cache, owner)
  }
  owner.count++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--owner.count) return
    owner.active = false
    if (cache.createDerivedShaderProgram === owner.hook) cache.createDerivedShaderProgram = owner.previous
    owners.delete(cache)
  }
}
