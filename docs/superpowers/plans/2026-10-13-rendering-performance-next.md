# Cesium 渲染提交与性能优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前以 Cesium `context.draw` 拦截和命令 replay 为主的 Deferred/Transparent 路径，逐步迁移为 Render Graph + RenderItem 直接提交，并在真实校园场景上建立可重复的 GPU、显存和 Pass 成本基准。

**Architecture:** Cesium 继续负责场景遍历、可见性、相机和原生命令收集；Scene Adapter 在每个颜色帧生成 RenderItem，Renderer 负责排序、批处理和提交，Render Graph 负责 Pass 依赖与 transient physical slot 分配，RHI/RenderTargetPool 负责实际 WebGL 资源租约。兼容对象、Picking、Shadow 和不满足条件的视图继续走原生路径，任何回退都进入诊断。

**Tech Stack:** Cesium 1.143 WebGL2、JavaScript ESM、Render Graph、RenderItemQueue、WebGL2 `EXT_disjoint_timer_query_webgl2`、Playwright 真实浏览器场景、Node `node:test`。

---

## 当前审查结论

- `src/pipeline/RenderGraph143.js` 目前只计算 `aliasSlot` 诊断并在帧结束释放显式 lease；它没有根据 alias slot 自动创建或绑定物理目标。
- `PooledStageCache143` 仍自行计算 slot 并调用 `RenderTargetPool143.acquire`；Graph 中的 transient 句柄只是旁路登记。
- `RenderItem143` 是冻结的命令元数据，`VisualPipeline.sceneAdapter` 只用于诊断；Deferred/Transparent 的实际路径仍通过 `context.draw`、`updateDerivedCommands` 和 `DrawCommand.execute` replay。
- `DeferredGeometry143.capture/finish`、`DeferredLighting143.render` 和 `TransparentForward143.applyTo` 仍有每命令分支、shader 替换和独立提交；现有 `environmentGroup` 只批处理环境组，不能代表材质/程序批处理。
- `context.draw` 由 DeferredGeometry、SunUniforms、OcclusionCulling、SelectedIdPass、TaaOverlay 和诊断 profiler 分别包裹，存在嵌套 wrapper；FrameBridge 还按命令拦截 `updateDerivedCommands`。
- `RenderProfiler143` 已有异步 GPU query、CPU scope 和已知纹理字节统计，但 Pass 采样轮换，已知纹理字节不等于整卡 VRAM；必须补充 Graph Pass scope、RenderItem/批处理统计和 native/driver 资源边界。
- 当前工作树不干净；本计划只针对上述渲染路径，执行时必须保留无关工作树修改。

## 实施取向

- 支持范围内的 RenderItem direct-submit、Graph transient allocation 和 material/shader batching 直接作为主实现推进，不长期保留一套等价的旧 replay 作为默认提交路径。
- 原生回退只按可观测的不兼容条件触发：未知材质、复杂 stencil、MSAA/TAA 组合、非 3D/多视锥、排序透明的深度顺序约束等；每次回退必须带 reason 和计数。
- 先做最小可用的批处理和统一 dispatcher，再用真实场景数据调阈值；不因担心潜在兼容性而把所有命令留在逐命令拦截路径。
- 性能门槛用于判断是否保留实现和定位回归，不用于把 direct-submit 永远藏在默认关闭的开关后面。

## Task 1: 固化优化前基线和测量契约

**Files:**
- Modify: `src/diagnostics/GpuTimer.js`
- Modify: `src/diagnostics/RenderProfiler143.js`
- Create: `src/diagnostics/PassCostLedger143.js`
- Create: `scripts/check-rendering-performance-next.cjs`
- Create: `tests/rendering/pass-cost-ledger.test.mjs`
- Create: `tests/rendering/rendering-performance-fixture.js`

- [ ] 定义统一报告结构：

```js
{
  scene: { name, viewport, dpr, renderer, cesiumVersion, assetHash, cameraTrack, clock },
  mode: { native, enhanced, deferred, deferredTransparent, taa, ao, bloom },
  validity: { warmupFrames, sampledFrames, gpuSupported, disjointCount, focusLoss, configChanges },
  frame: { cpuMs: { p50, p95 }, gpuMs: { p50, p95 }, drawCalls, submittedCommands, triangles },
  passes: [{ name, gpuMs: { p50, p95 }, cpuMs: { p50, p95 }, draws, renderItems, batches }],
  state: { drawHookInstallations, drawHookInvocations, programBinds, materialBinds, uniformUploads, textureBinds },
  memory: {
    graphPhysicalBytes, graphPeakBytes, poolCurrentBytes, poolPeakBytes,
    ccrTextureBytes, tilesetReportedBytes, jsHeapBytes,
    scope: 'tracked allocations; true board VRAM requires vendor profiler'
  }
}
```

- [ ] 为每帧记录 `frameNumber`、相机矩阵、配置快照、资源 readiness 和 GPU disjoint；任何变化后的帧从样本中剔除，恢复原值也不能重新纳入。
- [ ] 给 Graph Pass 添加 `beginGpuScope(name)` / `endGpuScope(name)` 接口，使用非嵌套 query；同一帧无法同时采样的 Pass 进入轮换计划，报告必须带 `sampledFrames` 和 `discarded`。
- [ ] 将 `context.draw` 计数从 profiler 的 wrapper 中移出，改由统一 dispatcher 计数；保留 profiler 仅做报告读取。
- [ ] 基线场景固定为：1920×1080、DPR 1、前台 Chrome、Cesium 1.143、固定时间、固定相机轨迹、固定资产 hash。每个 case 预热 30 s，采样 60 s，重复 3 轮；另保留合成模型场景以区分资产加载和渲染器成本。
- [ ] 先运行 native、当前 enhanced、当前 deferred、当前 deferred+transparent 四个 case，生成 `docs/verification/rendering-performance-next/baseline-*.json`。在优化代码合入前冻结这些基线。

## Task 2: 让 Render Graph 真正拥有 transient alias 分配

**Files:**
- Modify: `src/pipeline/RenderGraph143.js`
- Modify: `src/pipeline/RenderTargetPool143.js`
- Modify: `src/pipeline/PooledStageCache143.js`
- Modify: `src/rhi/WebGLDevice143.js`
- Modify: `src/VisualPipeline.js`
- Modify: `src/antialiasing/TaaPass143.js`
- Modify: `src/lighting/DeferredGeometry143.js`
- Modify: `tests/rendering/render-graph.test.mjs`
- Create: `tests/rendering/render-graph-transient-allocation.test.mjs`

- [ ] 将 Graph 编译结果从单纯的 `aliases[]` 扩展为 `aliasGroups[]`：每组包含 descriptor、资源句柄、first/last Pass 和唯一 physical slot。
- [ ] 修正 root 判定：没有绑定且没有 side effect 的 external resource 不自动成为活跃根；`present`、原生颜色输出和显式 `sideEffect` Pass 才能保活依赖。这样被断开的 transient Pass 才能真的被裁剪。
- [ ] 在 `beginFrame` 中通过注入的 allocator 为每个 physical slot 申请一个 lease；`resolve(resource)` 返回该 slot 的 framebuffer/texture；在 last Pass 完成时释放 slot，帧异常时统一回收。
- [ ] 增加 `bindExternal(resource, value)` 的尺寸和 context 校验，并记录 external/transient 的实际绑定来源，避免把逻辑 alias 当成物理复用。
- [ ] 让 `PooledStageCache143` 使用 Graph 的 alias slot；保留无 Graph 时的旧 pool fallback。AO/Bloom 的 slot ledger 必须由同一份 Graph 生命周期生成，不能再维护第二套独立 alias 算法。
- [ ] 将 TAA history、Cesium OIT/scene color、跨帧资源保留为 external；AO/Bloom 中间目标、TAA resolve、可证明同帧不重叠的 lighting intermediates 改为 transient。Deferred G-buffer 的颜色附件由 Graph/RHI 分配，借用的 Cesium depth/stencil 继续 external。
- [ ] 增加验证：

```js
assert.equal(report.aliasGroups.length, 1)
assert.equal(report.physicalSlots, 1)
assert.equal(pool.getDiagnostics().allocated, 1)
assert.equal(report.feedbackConflicts.length, 0)
```

- [ ] 真实场景门槛：AO+B​​loom+TAA 组合的 `graphPeakBytes` 相比当前 pool-only 实现至少下降 20%；若下降不足，保留 ledger 说明重叠原因，不强行复用不同格式或仍有读者的目标。

## Task 3: 用 RenderItem 直接提交 Deferred 与 Transparent

**Files:**
- Modify: `src/renderer/RenderItem143.js`
- Modify: `src/renderer/RenderItemQueue143.js`
- Create: `src/renderer/RenderItemExecutor143.js`
- Modify: `src/scene/CesiumSceneAdapter143.js`
- Modify: `src/pipeline/FrameBridge143.js`
- Modify: `src/lighting/DeferredGeometry143.js`
- Modify: `src/lighting/DeferredLighting143.js`
- Modify: `src/pipeline/TransparentForward143.js`
- Modify: `src/VisualPipeline.js`
- Create: `tests/rendering/render-item-executor.test.mjs`
- Modify: `tests/rendering/deferred-lighting.test.mjs`
- Modify: `tests/rendering/deferred-transparency.test.mjs`

- [ ] 扩充 RenderItem 合同，加入 `materialKey`、`pipelineKey`、`renderStateKey`、`framebufferKey`、`sourcePass` 和 `execute(context, passState, overrides)` 的受控执行入口；RenderItem 不拥有 Cesium command，不修改原 command。
- [ ] 让 FrameBridge 在颜色帧收集当前 frustum 的 command 并一次性提交 RenderItemQueue；Deferred/Transparent 只消费 queue snapshot，不再分别从 command map 重新扫描。
- [ ] 添加 RenderItemExecutor：按 Pass 执行原生兼容 item、Deferred G-buffer item、Deferred lighting item、Transparent/OIT item；所有 override（shader、uniform、framebuffer、renderState）在 executor 内临时组装并恢复。
- [ ] Deferred geometry 的 supported item 直接提交到 Graph 管理的 G-buffer；compatibility item 继续原生颜色提交并写 invalid marker。成功路径不再依赖每次 `context.draw` 回调来决定是否 capture。
- [ ] Transparent forward 保留原生 OIT/sorted 的顺序约束：只在连续且 state-compatible 的 item 区间内批处理；不能为减少切换而跨越深度排序或混合语义。
- [ ] 在 direct-submit 运行稳定后，移除 Deferred/Transparent 对 `updateDerivedCommands` 的主动拦截；该 hook 只保留兼容/诊断 fallback，并在诊断中标记 fallback 原因。
- [ ] 逐项验证：Deferred、OIT MRT、OIT multipass、sorted transparency、MASK、Picking、MSAA/TAA fallback 的像素输出与现有基线一致；失败时必须恢复 native command 和资源。

## Task 4: 材质与 shader program batching

**Files:**
- Create: `src/renderer/MaterialBatcher143.js`
- Create: `src/renderer/ShaderProgramCache143.js`
- Modify: `src/renderer/RenderItem143.js`
- Modify: `src/renderer/RenderItemQueue143.js`
- Modify: `src/lighting/DeferredGeometry143.js`
- Modify: `src/lighting/DeferredLighting143.js`
- Modify: `src/pipeline/TransparentForward143.js`
- Create: `tests/rendering/material-batching.test.mjs`

- [ ] 定义稳定 BatchKey：`pass + shaderSourceId + injectedVariant + renderStateId + framebufferLayout + textureLayout + featureFlags`。禁止把逐对象 transform、颜色、IBL factor 放进 program key。
- [ ] ShaderProgramCache 只编译一次每个 `BatchKey`，跟踪 active/lastUsed frame；统一清理过期 program、RenderState 和 uniform wrapper。
- [ ] Opaque/Deferred G-buffer 按 BatchKey 排序后提交；Transparent 仅合并同一深度/混合排序区间内的连续 item。
- [ ] 将逐 draw 的 `new Cartesian4`、重复 shadow uniform wrapper、重复 IBL lookup 合并为 batch scope；使用已有 Sun UBO/共享相机块，并把变化的 per-item 数据留在轻量 uniform 更新。
- [ ] 记录 `programBinds`、`renderStateBinds`、`materialBinds`、`textureBinds`、`uniformUploads`、`batchCount`、`meanBatchSize`，按 native/enhanced/deferred/transparent 分开。
- [ ] 性能目标作为候选门槛：在同一真实场景、相同输出像素和相同 asset hash 下，shader/program bind 至少下降 30%，材质/uniform 更新至少下降 20%，CPU submission p95 至少下降 15%；GPU p50 只有在像素回归通过后才比较，目标下降 10% 以上。

## Task 5: 统一 context.draw dispatcher，减少拦截层

**Files:**
- Create: `src/pipeline/ContextDrawDispatcher143.js`
- Modify: `src/buffers/SunUniforms143.js`
- Modify: `src/lighting/DeferredGeometry143.js`
- Modify: `src/visibility/OcclusionCulling143.js`
- Modify: `src/selection/SelectedIdPass143.js`
- Modify: `src/antialiasing/TaaOverlay143.js`
- Modify: `src/diagnostics/RenderProfiler143.js`
- Modify: `src/index.js`
- Create: `tests/rendering/context-draw-dispatcher.test.mjs`

- [ ] 每个 scene/context 只安装一个 dispatcher wrapper；dispatcher 持有 ordered handler list，按 phase/pass/context/frame 条件决定是否短路、改写或调用 native draw。
- [ ] handler 返回 `pass`、`replace`、`skip` 或 `continue`，所有 resource/state restore 在 dispatcher 的 `finally` 完成；foreign wrapper 仍能在 dispatcher 外层安装且卸载不覆盖外部替换。
- [ ] Sun UBO、Deferred geometry、Occlusion、Selected ID、TAA overlay 和 profiler 全部注册 handler，不再直接保存 `previous=context.draw` 并互相嵌套。
- [ ] 将 `drawHookInstallations`、`activeHandlers`、`nativeFallbackDraws`、`shortCircuits` 纳入诊断。目标是每个 scene 永远 1 个 context.draw wrapper；dispatcher 自身每帧 CPU overhead 小于 frame CPU 的 2%。
- [ ] 在 direct RenderItem 路径稳定后，Deferred/Transparent 不再注册 per-command `updateDerivedCommands` handler；兼容 fallback 单独计数。

## Task 6: 真实场景性能测量与对比报告

**Files:**
- Modify: `scripts/check-rendering-performance-next.cjs`
- Modify: `scripts/check-campus-hotspots.cjs`
- Modify: `scripts/check-business-tiles-cost.cjs`
- Create: `scripts/summarize-rendering-performance.cjs`
- Create: `docs/verification/rendering-performance-next/README.md`
- Create: `tests/rendering/performance-report-schema.test.mjs`

- [ ] 场景矩阵至少包含：

| Case | 目的 |
| --- | --- |
| native | Cesium 原生提交/光照基线 |
| enhanced-current | 当前增强路径基线 |
| deferred-current | 当前 Deferred + 现有 replay 基线 |
| deferred-direct | RenderItem direct-submit |
| deferred-batched | direct-submit + material/shader batching |
| deferred-transparent-batched | 含 OIT/multipass/sorted 透明 |
| campus-business | 真实校园 GLB/3D Tiles、树、水、阴影 |
| synthetic-command-heavy | 固定模型数量/三角形，隔离提交开销 |

- [ ] 每个 case 记录 renderer、浏览器、Cesium hash、资产 hash、drawing buffer、DPR、相机轨迹、时间、实际 active/fallback mode 和错误；任何 scene/config/asset/readiness 变化都会使该轮失效。
- [ ] GPU 指标：整帧和每个 Pass 的 p50/p95、query 可用率、disjoint 丢弃数。Pass 至少包括 shadow、native/gbuffer、deferred lighting、transparent/OIT resolve、environment、Hi-Z/AO/Bloom、TAA/present。
- [ ] CPU 指标：frame/update/submit p50/p95、RenderItem 数、批次数、`context.draw` 次数、shader/state/material/texture bind、uniform upload 次数和字节、native fallback 数。
- [ ] 显存/资源指标分层报告：
  - CCR exact tracked：Graph physical slots、pool entries、各 texture `sizeInBytes`、current/peak/live bytes；
  - Cesium reported：Tileset `totalMemoryUsageInBytes`、模型纹理/geometry 统计；
  - JS only：`performance.memory.usedJSHeapSize`（不能当 VRAM）；
  - board/driver VRAM：在目标机用 Chrome GPU diagnostics 或 Nsight/PIX 采集，若不可用必须标注 unavailable，不能用 CCR bytes 冒充整卡峰值。
- [ ] 对比基准固定为同一场景、同一帧序列、同一分辨率和同一资产 hash；报告优化前/后绝对值、相对变化、95% bootstrap CI，并单独给出“输出像素误差/功能回退”结论。
- [ ] 建议门槛：direct-submit 不增加像素误差；Graph alias 物理峰值下降 ≥20%；program bind 下降 ≥30%；submission CPU p95 下降 ≥15%；GPU frame p50 下降 ≥10% 才进入下一轮默认策略评估。未达到时保留诊断并回退，不修改场景负载迎合门槛。

## Task 7: 分阶段上线和回退门禁

**Files:**
- Modify: `src/diagnostics/capabilityMatrix143.js`
- Modify: `src/VisualPipeline.js`
- Modify: `docs/01-architecture/API.md`
- Create: `docs/RENDERING_PERFORMANCE_NEXT.md`

- [ ] 增加 capability 字段：`graphTransientActive`、`renderItemDirectSubmit`、`materialBatchingActive`、`contextDrawDispatcherActive`，每项返回 requested/active/reason/generation。
- [ ] 默认行为按能力矩阵选择：支持范围内直接启用 direct-submit、batching 和 Graph transient；只有不兼容条件才回退到 enhanced/native。保留一个诊断用强制旧路径开关用于 A/B 对比，不能作为正常主路径。
- [ ] 将优化前基线、优化后报告、GPU/显存范围、像素回归和已知限制写入文档；明确“tracked allocation bytes”不等于整卡显存，“headless/短时样本”不等于正式生产性能。
- [ ] 完整回归门禁：先跑相关 Node tests，再跑全量 `npm test`；全量仍有与工作树资产配置相关的失败时，报告失败用例和原因，不把整体状态写成全绿。

## 自检清单

- [ ] 每项优化都有目标、文件范围、收益假设和可观测指标。
- [ ] 没有把 Graph alias 诊断当成真实物理复用。
- [ ] 没有把 RenderItem 收集/排序当成 direct submit 完成。
- [ ] 没有把环境组 batching 当成材质/shader batching 完成。
- [ ] 没有把一次 `context.draw` wrapper 计数当成 GPU draw 数。
- [ ] 没有把 CCR 纹理字节或 JS heap 当成整卡 VRAM。
- [ ] native/enhanced/current deferred/optimized deferred 使用同一场景、同一相机、同一时间和同一资源 hash。

