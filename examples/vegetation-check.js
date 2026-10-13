// Opt-in browser acceptance controls. Open campus.html?vegetationCheck=1.
import GpuTimer from '../src/diagnostics/GpuTimer.js'

export function installVegetationCheck(campus, gui, dump) {
  const folder = gui.addFolder('植被验收')
  const scene = campus.viewer.scene
  const frames = count => new Promise((resolve, reject) => {
    const off = scene.postRender.addEventListener(() => {
      if (--count === 0) { clearTimeout(timeout); off(); resolve() }
    })
    const timeout = setTimeout(() => { off(); reject(new Error('Rendering timed out')) }, 60000)
  })
  const summarize = values => {
    const sorted = values.slice().sort((a, b) => a - b)
    return { count: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] }
  }
  let running = false
  const actions = {
    async sample() {
      if (running || !campus.trees || !campus.grass) return
      running = true
      const visibility = [campus.trees.visible, campus.grass.visible]
      const inputEnabled = scene.screenSpaceCameraController.enableInputs
      scene.screenSpaceCameraController.enableInputs = false
      const results = []
      try {
        await Promise.all([campus.treeReady, campus.grassReady])
        for (const visible of [true, false, true]) {
          campus.trees.setVisible(visible); campus.grass.setVisible(visible)
          dump(`采样中：植被${visible ? '显示' : '隐藏'}，请保持窗口与相机不变。`)
          await frames(60)
          const timer = new GpuTimer(scene.context._gl), original = scene.render, cpu = [], intervals = []
          let previous, valid = true
          const width = scene.drawingBufferWidth, height = scene.drawingBufferHeight
          scene.render = function (...args) {
            timer.poll()
            const start = performance.now()
            const result = timer.measure('frame', () => original.apply(this, args))
            cpu.push(performance.now() - start)
            return result
          }
          const off = scene.postRender.addEventListener(() => {
            const now = performance.now()
            if (previous !== undefined) intervals.push(now - previous)
            previous = now
            valid &&= document.visibilityState === 'visible' && width === scene.drawingBufferWidth && height === scene.drawingBufferHeight
          })
          try {
            await frames(180)
            timer.poll()
            results.push({ visible, valid, width, height, cpu: summarize(cpu), frame: summarize(intervals),
              gpu: summarize(timer.samples.map(sample => sample.milliseconds)), gpuSupported: timer.supported,
              trees: campus.trees.getDiagnostics(), grass: campus.grass.getDiagnostics() })
          } finally { off(); scene.render = original; timer.destroy() }
        }
        campus.vegetationMeasurement = { url: location.href, results, errors: campus.errors.slice() }
        dump(campus.vegetationMeasurement)
      } catch (error) { dump(error.message) }
      finally {
        campus.trees.setVisible(visibility[0]); campus.grass.setVisible(visibility[1])
        scene.screenSpaceCameraController.enableInputs = inputEnabled
        running = false
      }
    },
    isolate() {
      campus.models.forEach(model => { model.show = false })
      campus.tiles.forEach(tile => { tile.show = false })
      campus.contextTiles.forEach(tile => { tile.show = false })
      scene.globe.show = false
      dump('仅用于检查植被颜色；刷新页面恢复完整校园。')
    },
    grassHeight() {
      const C = window.Cesium, grass = campus.grass
      const target = C.Cartesian3.fromDegrees(123.40925, 41.76447, 0)
      const inverse = C.Matrix4.inverseTransformation(grass._modelMatrix, new C.Matrix4())
      const local = C.Matrix4.multiplyByPoint(inverse, target, new C.Cartesian3())
      const nearest = grass.primitive._instances.slice().sort((a, b) =>
        Math.hypot(a.translation.x - local.x, a.translation.y - local.y) - Math.hypot(b.translation.x - local.x, b.translation.y - local.y)).slice(0, 4)
      dump(nearest.map(instance => {
        const world = C.Matrix4.multiplyByPoint(grass._modelMatrix, instance.translation, new C.Cartesian3())
        const position = C.Cartographic.fromCartesian(world)
        return { rootHeight: position.height, surfaceHeight: scene.sampleHeight(position, [grass.primitive, campus.trees.primitive]),
          scale: instance.scale, diagnostics: grass.getDiagnostics() }
      }))
    },
  }
  folder.add(actions, 'sample').name('植被显示／隐藏采样')
  folder.add(actions, 'isolate').name('隔离植被颜色')
  folder.add(actions, 'grassHeight').name('草地高度检查')
}
