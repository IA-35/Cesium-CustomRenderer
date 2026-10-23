import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as gateway from '../../src/scene/cesiumPrivate143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')
const root = fileURLToPath(new URL('../../src/', import.meta.url))

test('accessors read the live private paths and are null-safe', () => {
  const id = {}, oit = { _opaqueTexture: {}, _accumulationTexture: {}, _revealageTexture: {}, _translucentMRTSupport: 1,
    _translucentMultipass: {}, _opaqueFBO: { _numSamples: 4 }, _translucentFBO: { framebuffer: {} }, _alphaFBO: { framebuffer: {} } }
  const bins = [{}], passState = {}
  const scene = { _view: { frustumCommandsList: bins, passState, oit, sceneFramebuffer: { idFramebuffer: id } },
    _environmentState: { useOIT: true, useWebVR: false, usePostProcessSelected: true, useGlobeDepthFramebuffer: true,
      clearGlobeDepth: true, useDepthPlane: true, useInvertClassification: false },
    _globeTranslucencyState: { translucent: true }, _depthPlane: { _command: {} } }
  assert.equal(gateway.viewOf(scene), scene._view)
  assert.equal(gateway.frustumBinsOf(scene), bins)
  assert.equal(gateway.viewPassStateOf(scene), passState)
  assert.equal(gateway.selectedIdFramebufferOf(scene), id)
  assert.equal(gateway.oitOf(scene), oit)
  assert.equal(gateway.oitOpaqueTextureOf(scene), oit._opaqueTexture)
  assert.equal(gateway.oitAccumulationTextureOf(scene), oit._accumulationTexture)
  assert.equal(gateway.oitRevealageTextureOf(scene), oit._revealageTexture)
  assert.equal(gateway.oitMrtSupported(scene), true)
  assert.equal(gateway.oitMultipassSupported(scene), true)
  assert.equal(gateway.oitOpaqueSamplesOf(scene), 4)
  assert.equal(gateway.oitTranslucentFramebufferOf(scene), oit._translucentFBO.framebuffer)
  assert.equal(gateway.oitAlphaFramebufferOf(scene), oit._alphaFBO.framebuffer)
  assert.deepEqual([gateway.usesOit(scene), gateway.usesWebVR(scene), gateway.usesPostProcessSelected(scene),
    gateway.usesGlobeDepthFramebuffer(scene), gateway.clearsGlobeDepth(scene), gateway.usesDepthPlane(scene),
    gateway.usesInvertClassification(scene), gateway.globeTranslucent(scene)], [true, false, true, true, true, true, false, true])
  assert.equal(gateway.depthPlaneCommandOf(scene), scene._depthPlane._command)
  // 实时读取：场景换视图后立即反映。
  scene._view = { frustumCommandsList: [] }
  assert.equal(gateway.frustumBinsOf(scene).length, 0)
  for (const [name, read] of Object.entries(gateway)) {
    assert.doesNotThrow(() => read(undefined), name)
    assert.doesNotThrow(() => read({}), name)
    const value = read({})
    assert.ok(value === undefined || value === false, `${name} returns undefined/false when the path is missing`)
  }
})

test('framebuffer getters on the real 1.143 classes match the manager paths, including the pick switch', () => {
  const sceneFramebuffer = new C.SceneFramebuffer(), globeDepth = new C.GlobeDepth()
  const color = {}, output = {}, pick = {}
  sceneFramebuffer._colorFramebuffer = { framebuffer: color }
  globeDepth._outputFramebuffer = { framebuffer: output }
  globeDepth._pickColorFramebuffer = { framebuffer: pick }
  const scene = { _view: { sceneFramebuffer, globeDepth } }
  assert.equal(gateway.sceneColorFramebufferOf(scene), gateway.sceneColorManagerOf(scene).framebuffer)
  assert.equal(gateway.sceneColorFramebufferOf(scene), color)
  assert.equal(gateway.globeColorFramebufferOf(scene), gateway.globeColorManagerOf(scene).framebuffer)
  assert.equal(gateway.globeColorFramebufferOf(scene), output)
  globeDepth.picking = true
  assert.equal(gateway.globeColorFramebufferOf(scene), pick)
  assert.equal(gateway.globeColorManagerOf(scene).framebuffer, pick)
})

test('no module outside the gateway reads Cesium private scene state', () => {
  const pattern = /\._view\b|_environmentState\b|_globeTranslucencyState\b|_depthPlane\b/
  const offenders = []
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) { if (name !== 'reference') walk(path); continue }
      if (!name.endsWith('.js') || path.endsWith(`scene${sep}cesiumPrivate143.js`)) continue
      // 只检查代码：去掉块注释和行注释（不处理字符串里的 //，src 中没有含这些字段名的 URL）。
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      code.split('\n').forEach((line, index) => { if (pattern.test(line)) offenders.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`) })
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], 'route these reads through src/scene/cesiumPrivate143.js')
})
