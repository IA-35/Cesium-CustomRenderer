# GPT-6Astar 六条问题的核实与修复

日期：2026-10-19
基线：`bee30da`（`master`）+ 工作区 TRAA r186 移植改动
验证：`npm test` 1031 项 / 1028 通过 / 3 跳过 / 0 失败（46.4s）
产物：`npm run build` → `bytes 2290064`、`sha256 14713292290e4805f8c7d3f0f63f1d45377e91ec81f80457e56abc3e6d4f366f`

## §0 结论摘要

外部审查（GPT-6Astar）提出 6 条问题，**逐条追到初始化点与调用链后确认 6 条全部成立**。其中 2 条比原描述更严重：

| # | 级别 | 问题 | 核实结果 |
|---|---|---|---|
| 1 | P1 | FrameBridge 在错误时机清空命令队列 | 成立，且 `DeferredLighting` 有同一时机清空自身 `renderItems` 的副本问题 |
| 2 | P1 | 共享反射记录 restore 抛异常 | 成立，共 3 处缺陷（`changes` 缺失、所有权标记写死、外部接管未判） |
| 3 | P1 | 调曝光把色调映射改回 ACES | 成立，且 `setEnabled` 的早退让问题无法自愈 |
| 4 | P2 | RHI 格式简写未传递到 datatype | 成立；`pixelFormat` 那行有 `?? format` 回退，`pixelDatatype` 那行没有 |
| 5 | P2 | `allowResolutionScaling` 单独修改不生效 | 成立，且重建 governor 时还会丢掉未重复的旧配置 |
| 6 | P2 | 批处理预绑定未真正省绑定 | **比原描述更严重**：`directSubmitRange` 在生产代码中零调用点，整条批处理链路不可达 |

---

## §1 FrameBridge 帧重置时机

### 现象
`updateDerivedCommands()` 收集命令，随后 OIT 的 `executeCommands()` 才触发 `opaqueFrame`，而 `opaqueFrame` 里执行 `itemQueue.begin()` 清空队列。消费者到 `resolve` 阶段时刚收集的命令已经丢失。不触发 OIT 的帧则不清空，命令跨帧累积。

### 调用链（实测）
```
Scene.js:3378  executeCommandsInViewport
  → :3650      view.createPotentiallyVisibleSet(scene)
      → View.js:279  scene.updateDerivedCommands(command)
          → FrameBridge143.js:119（patch）
              → dispatchCommand → itemQueue.submit
  → :3659      executeCommands
      → :2559  view.oit.executeCommands
          → FrameBridge143.js:80-85（patch） dispatch('opaqueFrame')
              → itemQueue.begin()   ← 此时收集已完成，清空
```

### 根因
帧重置被绑在「事件」上而不是「帧号变化」上。

### 修复
`src/pipeline/FrameBridge143.js:32-48` `contextFor(phase)` 本来就在做帧号检测（`state.frameNumber !== frameNumber`），把重置移到那里：

```js
const newFrame = state.frameNumber !== frameNumber
if (newFrame) { state.frameNumber = frameNumber; state.frameGeneration++; state.commandIndex = 0; stats.frames++ }
// ...
if (newFrame) { itemQueue.begin(frameState); for (const graph of graphs) graph.beginFrame(context) }
return context
```

`dispatch()` 里原来的 `if (phase === 'opaqueFrame') { itemQueue.begin(...); graph.beginFrame(...) }` 删除。

`src/lighting/DeferredLighting143.js:33` 的 `this.bridge.on('opaqueFrame', () => this.renderItems.clear(), {priority:-100})` 同类问题，改为在收集时按帧号判断：

```js
_collect(item) {
  const frame = item.frameNumber
  if (this.collectFrame !== frame) { this.collectFrame = frame; this.renderItems.clear() }
  this.renderItems.set(item.command, item)
}
```

`detach()` 里的 `this.offFrame?.()` 同步移除。

### 附带影响
`RenderGraph143.beginFrame` 现在提前到「本帧第一条命令被收集」时触发。`RenderGraph143:112` 有 `if (this.activeFrame) return this._diagnostics(this.lastHash)` 幂等保护，而 `HdrCoordinator143:13` 是另一个入口（在 `postProcessStages.execute` 里 begin/end），两者打在同一个 graph 上靠 activeFrame 去重，行为不变。

### 测试
`tests/rendering/frame-bridge.test.mjs` 原来的 `'attached Render Graph begins with the main color command frame'`（断言恰好一个 `opaqueFrame` 事件）语义已失效，替换为三个用例：

- `attached Render Graph begins once per frame, before the frame collects commands` —— 先 `updateDerivedCommands({pass:0})` 就触发 `graph.beginFrame`；后续 `updateAndExecuteCommands` + `oit.executeCommands` + `resolveFramebuffers` 不再产生第二个事件；`frameNumber = 8` 后再收集得 `[7, 8]`。
- `commands collected before the opaque phase survive to resolve` —— 收集 2 条 → `oit.executeCommands()` 后仍 2 条 → `resolveFramebuffers()` 后 `getRenderItems('native.forward').length === 2`。
- `a new frame number resets collection, so commands never accumulate across frames` —— 帧 7/8/9 各收集 1 次，计数恰为 `[1,1,1]`，`commandIndex` 为 `[0]`。

`frame-bridge.test.mjs` 全文 27 项通过。

---

## §2 共享反射记录

### 现象
普通 GLB 的共享 IBL 记录存的是 `{ primitive, original, shared }`，没有 `changes`。`restoreReflectionRecord()` 落到 `restore(record.changes)` → `records.slice()` → `Cannot read properties of undefined (reading 'slice')`。

### 触发路径（实测两条）
1. 模型已销毁 —— `restore()` 取 `.slice()` 前就崩。
2. 外部代码替换了 `primitive.imageBasedLighting` —— `record.primitive.imageBasedLighting === record.shared` 为假，落进 `else` 分支。

### 另一缺陷
`restoreReflectionRecord` 恢复时把 `_shouldDestroyImageBasedLighting = false` **写死**，破坏模型原本的资源销毁责任。

### 上游依据
`node_modules/@cesium/engine/Source/Scene/Model/Model.js`：

- `:437` `this._shouldDestroyImageBasedLighting = !defined(options.imageBasedLighting)`
- `:1524-1536` setter：`if (value !== this._imageBasedLighting) { if (this._shouldDestroyImageBasedLighting && !this._imageBasedLighting.isDestroyed()) this._imageBasedLighting.destroy(); this._imageBasedLighting = value; this._shouldDestroyImageBasedLighting = false; this.resetDrawCommands() }` —— **setter 强制清零所有权标记**，这就是必须保存/恢复原值的原因。
- `:3116-3122` destroy 时按该标记销毁。

### 修复
`src/environment/EnvironmentLighting143.js:26` `restore()` 首行加 `if (!Array.isArray(records)) return false`（注释说明：共享记录交换整个 IBL 对象、没有 property changes，调用方不该走到这里，但缺失数组必须降级为「无需恢复」而不是抛错）。

`restoreReflectionRecord(record)` 重写为：

```js
if (!record) return
if (!record.shared) { restore(record.changes); return }
const primitive = record.primitive
if (!alive(primitive)) return
if (primitive.imageBasedLighting !== record.shared) return   // 已被外部接管，完全不碰
if (record.original && !alive(record.original)) return
primitive.imageBasedLighting = record.original
primitive._shouldDestroyImageBasedLighting = record.shouldDestroy === true
```

共享记录写入点（`:241-243` 附近）新增保存原值：

```js
const shouldDestroy = primitive._shouldDestroyImageBasedLighting === true
primitive._shouldDestroyImageBasedLighting = false
primitive.imageBasedLighting = shared
this.reflectionRecords.set(primitive, { primitive, original: ibl, shared, shouldDestroy })
```

### 测试
`tests/rendering/environment-lighting.test.mjs` 新增两个（现 15 项全通过）：

- `a shared reflection record skips a model whose IBL was taken over or destroyed` —— 用 `Object.create(C.Model.prototype)` 伪造 model；外部接管路径断言 `taken.imageBasedLighting === external` 未被改动；销毁路径断言 `lighting.reflectionRecords.size === 0`。
- `restoring a shared reflection puts back the ownership the model had before` —— 替换后 `_shouldDestroyImageBasedLighting === false`；关闭反射后 `model.imageBasedLighting === original` **且 `_shouldDestroyImageBasedLighting === true`**（不恢复该标志会让模型自建并拥有的 IBL 泄漏）。

---

## §3 tonemapper 所有权

### 现象
```js
pipeline.setLensEffects({ toneMappingCurve: 'reinhard' })  // 实际生效 reinhard
pipeline.setOptions({ exposure: 2 })                        // 实际变回 ACES
```
配置显示 reinhard，实际执行 ACES。Filmic 等原生曲线同类。

### 根因（两半）
1. `src/VisualPipeline.js:159` `this.write(p, 'tonemapper', C.Tonemapper.ACES)` 在 `apply()` 内**无条件**执行，而 `setOptions` 每次都调 `apply()`。
2. `src/stages/LensEffectPipeline143.js:58-77` `setEnabled(value)` 里 `if (this.enabled || this.failed) return` —— 已启用时重复 `setEnabled(true)` 不会重新应用曲线，所以 `applyLensEffects()` 无法把曲线纠正回来。

注意 `VisualPipeline.write`（`:92-100`）与 `EnvironmentLighting143.write`（`:9-24`）**语义不同**：前者无 owned 检查、无条件写；后者有 owned 机制会放弃被外部接管的属性。这是两套不同契约，不能混用。

### 修复
`src/stages/LensEffectPipeline143.js` 新增 `ownsNativeTonemapper()`：

```js
ownsNativeTonemapper() {
  if (!this.enabled || this.destroyed || this.failed) return false
  const tone = resolveToneMapping(this.getOptions()?.toneMappingCurve)
  if (!tone || !tone.native || !tone.enumName) return false
  const wanted = this.C?.Tonemapper?.[tone.enumName]
  const collection = this.scene?.postProcessStages
  return !!(wanted && collection && collection.tonemapper === wanted)
}
```

**不能用「有没有 `ownedTonemapper`」当判据**：`_createStages` 在 `collection.tonemapper` 本来就等于 `wanted` 时不建记录（`:129-137`），此时也是「已接管」。

`src/VisualPipeline.js:159` 改为：

```js
if (!this.lensEffects?.ownsNativeTonemapper?.()) this.write(p, 'tonemapper', C.Tonemapper.ACES)
```

### 测试
`tests/rendering/visual-pipeline.test.mjs:425` 新增 `'changing exposure keeps the tone mapping curve chosen earlier'`：用 `geometryFixture()`（真 `C.PostProcessStageCollection` + 完整 `Tonemapper` 枚举）+ `antialiasing:'off'`，断言 `setLensEffects({toneMappingCurve:'reinhard'})` 后 `stages.tonemapper === Cesium.Tonemapper.REINHARD`，再 `setOptions({exposure:2.4})` 后曲线仍 REINHARD 且 exposure 到 2.4。

**已验证用例有效**：临时撤掉修复 → 用例失败 → 恢复 → 通过。

`geometryFixture()` 的 Cesium 注入列表扩充为 `['PostProcessStage','PostProcessStageComposite','PixelFormat','PixelDatatype','PostProcessStageSampleMode','Color','SceneMode','Tonemapper','Cartesian2','Cartesian3','Cartesian4']`。

---

## §4 RHI 格式简写

### 现象
```js
{ width: 64, height: 64, format: 'rgba16f' }
```
实际传给纹理池的是 `UNSIGNED_BYTE`，而非 `HALF_FLOAT`。

### 根因
`src/rhi/WebGLDevice143.js` 两行不对称：

```js
pixelFormat:   resolveTransientPixelFormat143(this.C, descriptor.pixelFormat ?? descriptor.format)     // 有 format 回退
pixelDatatype: resolveTransientPixelDatatype143(this.C, descriptor.pixelDatatype ?? descriptor.datatype) // 缺
```

`resolveTransientPixelDatatype143`（`:15-27`）本身支持 `'rgba16f'`→HALF_FLOAT、`'rgba32f'`→FLOAT，但只写 `{format:'rgba16f'}` 时根本走不到它，`undefined` 落入末尾 `return datatype.UNSIGNED_BYTE`。

### 现状边界
当前环境 / AO / Bloom 主路径都显式传了 `datatype`，故**当前渲染没有受影响**。问题在公开的资源描述契约。

### 修复
```js
pixelDatatype: resolveTransientPixelDatatype143(this.C, descriptor.pixelDatatype ?? descriptor.datatype ?? descriptor.format)
```

### 测试
`tests/rendering/transient-format-mapping.test.mjs` 新增 `'a format-only transient descriptor reaches the texture with the matching datatype'`：自建 `transientFixture()`（假 Texture 记录 pixelFormat/pixelDatatype、假 Framebuffer、context `_gl` 含 addEventListener/removeEventListener），走真实 `WebGLDevice143.createTransientAllocator('format-only')` → `resize(64,64)` → `acquire({width:64,height:64,format:'rgba16f'})`，断言 `created[0].pixelDatatype === PixelDatatype.HALF_FLOAT`。

---

## §5 allowResolutionScaling

### 现象
先启用默认调速器，再传 `{ allowResolutionScaling: true }` 实际仍为 `false`；反方向关闭也被忽略。

### 根因
`src/VisualPipeline.js:959` 的 tuning 数组只有 6 个键，没有 `allowResolutionScaling`：

```js
const tuning = ['targetFps','targetFrameMs','minScale','sampleWindow','evaluateEvery','settleFrames'].some(key => input[key] !== undefined)
```

而 `src/performance/PerformanceGovernor143.js:46` `this.allowResolutionScaling = input.allowResolutionScaling === true` **只在构造函数读一次**。

### 修复
tuning 数组扩为 10 个键（补 `allowResolutionScaling`、`degradeThreshold`、`recoverThreshold`、`recoverStreakRequired`）。

重建时**合并现有配置**而不是只用 `input`，否则重建会丢掉未重复的旧配置：

```js
const merged = { ...performanceSettingsOf143(previous), ...input }
if (input.targetFps !== undefined && input.targetFrameMs === undefined) delete merged.targetFrameMs
```

（最后一行是必要的：旧 `targetFrameMs` 会压掉新传的 `targetFps`。）

新增顶层函数 `performanceSettingsOf143(governor)` 取 governor 当前生效配置。

### 测试
`tests/rendering/performance-governor.test.mjs` 新增两个：

- `setPerformance honours allowResolutionScaling changed on its own`
- `rebuilding the governor keeps settings the call did not repeat`

---

## §6 批处理预绑定（比原描述更严重）

### 现象
`executeBatch()` 先调一次 `program._bind()`，随后每条命令仍走 Cesium 原生 draw，`Context.beginDraw()` 又调 `_bind()`。三个同程序命令实际 4 次绑定（3+1），而规划器报告 1 次。

### 追加发现（原描述未提）
`directSubmitRange()` 在 `src/` 内**仅定义于 `src/pipeline/TransparentForward143.js:74`，无生产调用点**；只被 `tests/rendering/deferred-transparency.test.mjs:281-296` 打桩调用。也就是说整条批处理链路在生产中不可达，属未兑现优化。

### 根因
`node_modules/@cesium/engine/Source/Renderer/Context.js:1313` `beginDraw` 无条件 `shaderProgram._bind()`。预绑定是净亏损 n+1 次。

### 修复
`src/renderer/RenderItemExecutor143.js:35-62`：

- 删除 `const boundOnce = !!program?._bind` 与 `if (boundOnce) program._bind()`。
- 保留陈旧批次检测：`if (program && command?.shaderProgram !== program) { this.stats.batchBroken++; return { submitted: index, failedAt: index } }`。
- 长注释说明为什么预绑定有害。

`src/renderer/RenderBatchPlanner143.js` 上报口径修正：

```js
programBinds: ordered.length          // 实际
renderStateBinds: ordered.length      // 实际
plannedProgramBinds: batches.length   // 计划上限
plannedProgramBindReduction           // 计划上限的减少量
programBindReduction: ordered.length ? 1 - programBinds / ordered.length : 0   // 实际（当前恒为 0）
optimizationSuccess: plannedProgramBinds < ordered.length ? 'planned-only' : 'not-achieved'
```

`optimizationSuccess` **不再返回 `'pass'`** —— 当前没有任何路径真正省下绑定。

`src/VisualPipeline.js:850-873 _batchingFeature()`：`active` 用实际 `programBindReduction > 0` 判定；新增 `plannedProgramBinds` / `plannedProgramBindReduction`；`reason` 区分三种文案。

`src/pipeline/TransparentForward143.js:74` `directSubmitRange` 上方与 `:86-88` 补注释：生产代码无调用点、保留但不宣称收益、真正接线前必须先解决逐条提交问题。

### 测试
- `tests/rendering/render-item-executor.test.mjs`：`'executeBatch binds the shared program once and submits every item'`（原断言 `binds.length === 1`）→ `'executeBatch does not add a redundant program bind on top of Cesium native binds'`，假命令 `execute()` 内显式 `program._bind()`，断言 `binds.length === 2`。
- `tests/rendering/render-batch-planner.test.mjs`：原断言 `programBindReduction === 0.75` → 断言 `programBinds === 4` / `plannedProgramBinds === 1` / `programBindReduction === 0` / `plannedProgramBindReduction === 0.75` / `optimizationSuccess === 'planned-only'`，用例名改为 `'planner states real binds, not the planned upper bound, as achieved'`。

原测试的假命令只记录执行次数、不模拟原生绑定行为，所以从未检出这个差异。**这是「测试通过 ≠ 行为正确」的又一实例**。

---

## §7 仍未解决 / 需注意

1. **`DeferredLighting` 的批处理统计**仍基于规划值，若后续接线需同步核对（当前 `getDiagnostics()` 不含该类字段，无虚报，但也没有真实绑定计数）。
2. **`directSubmitRange` 仍是死代码**。要么接线，要么删除。接线的前置条件是让 `executeBatch` 真正合并提交（例如复用局部 GL 绑定去重），并以**实际 GL 调用计数**验收，而不是以规划值验收。
3. **六条都不是「性能问题」而是「契约问题」**。修完不影响帧率，只是让诊断不再虚报、让设置不再互相打架。真正的掉帧仍需按 `docs/01-architecture/REVIEW_BRIEF.md` §4 的 A2 组排查。
4. `src/VisualPipeline.js` 的 `write()` 与 `EnvironmentLighting143.write()` 两套所有权语义**长期存在混用风险**，本次只修了 tonemapper 一处，未统一。

## §8 复现命令

```bash
npm test                                    # 1031 项
node --test tests/rendering/frame-bridge.test.mjs
node --test tests/rendering/environment-lighting.test.mjs
node --test tests/rendering/visual-pipeline.test.mjs
node --test tests/rendering/transient-format-mapping.test.mjs
node --test tests/rendering/performance-governor.test.mjs
node --test tests/rendering/render-item-executor.test.mjs
node --test tests/rendering/render-batch-planner.test.mjs
npm run build
```
