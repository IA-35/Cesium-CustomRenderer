# Cesium 渲染提交与性能优化实施计划（v3）

> **变更原因**：在 v2 基础上明确 TAA 非阻塞、RenderItem/Executor 所有权、Graph allocator 合同、透明原生顺序、dispatcher 分阶段迁移、测量稳定性和 batching 验收层级。本版基线为 `cbab9e3`。

---

## 当前代码状态（2026-10-13，`cbab9e3` 基线）

### 已完成的基础设施
- ✅ **Render Graph 核心基础设施**：Pass 依赖排序、死 Pass 裁剪、transient alias 分析、外部资源绑定、单 Pass 执行去重；❌ physical transient allocation 尚未完成
- ✅ **WebGL RHI 基础设施**：`WebGLDevice143` 统一纹理/framebuffer/RenderTarget 生命周期、诊断、资源池租约；❌ Graph allocator 接管尚未完成
- ✅ **Deferred 路径 RHI 资源迁移**：GBuffer 纹理通过 RHI 分配，Graph 外部句柄绑定，释放通过 RHI 包装器；❌ direct-submit 尚未完成
- ✅ **反射目标 RHI 资源迁移**：`DeferredReflectionTarget143` 使用 RHI 分配/释放；❌ 主 Deferred 提交路径尚未切换
- ✅ **TAA RHI 历史生命周期**：双 buffer color/depth 通过 RHI 创建、Graph 绑定、拷贝、释放；❌ runtime resolve 当前仍采样 Cesium Stage history
- ✅ **能力矩阵**：`requestedMode` / `effectiveMode` / `fallback` / WebGL2/MRT/float/OIT/MSAA/scene-mode/multi-frustum 诊断
- ✅ **FrameState/RenderItem 基础**：不可变 FrameState、RenderItem 创建/比较/排序、RenderItemQueue 收集/诊断
- ✅ **Scene Adapter**：`CesiumSceneAdapter143` 桥接 Cesium scene/frame 数据到 FrameState
- ✅ **FrameBridge**：拦截 `updateDerivedCommands`、创建/收集 RenderItem、诊断报告；❌ RenderItem direct execution 尚未完成

### 当前提交路径边界
- ❌ **Deferred 仍是 `context.draw` 拦截**：`DeferredGeometry143.capture/finish` 按命令分支、shader 替换、逐命令提交
- ❌ **Transparent 仍是 `context.draw` 拦截**：`TransparentForward143.applyTo` 虽用 `onRenderItem` 入口，但实际执行仍走 Cesium `DrawCommand.execute`
- ❌ **Graph transient 仅旁路登记**：`PooledStageCache143` 自行计算 slot、调用 `RenderTargetPool143.acquire`，Graph 不实际分配物理资源
- ❌ **无批处理**：当前 `environmentGroup` 只按环境组批处理环境 uniform，无材质/shader program 批处理
- ❌ **多层 `context.draw` wrapper**：DeferredGeometry、SunUniforms、OcclusionCulling、SelectedIdPass、TaaOverlay、RenderProfiler 各自嵌套
- ❌ **RenderItem 元数据不完整**：缺 `materialKey`、`pipelineKey`、`renderStateKey`、`framebufferKey`、`execute()` 接口

### 已知关键约束
1. **TAA 历史采样问题**：直接采样 RHI 拷贝纹理会导致严重时间抖动，当前稳定方案是采样 Cesium PostProcessStage 历史（`this.frames[1-this.active].resolve.outputTexture`）
2. **Cesium 原生边界**：scene traversal、tiles、camera、原生 command 收集保持不变；Picking、Shadow、MSAA/非 3D 场景继续走原生
3. **OIT 深度排序约束**：透明物体 OIT/sorted 必须保持 Cesium 深度排序，不能为批处理跨越排序边界

---

## 修订后的实施计划

### Phase 0: 性能测量基线与契约（优先级：最高）

**目标**：建立可重复的性能基准，避免"优化后发现无法比较"

**输出物**：
- `src/diagnostics/PassCostLedger143.js`：统一报告结构
- `scripts/performance/measure-rendering-baseline.cjs`：自动化测量脚本
- `docs/verification/rendering-performance/baseline-*.json`：冻结基线数据
- `tests/rendering/pass-cost-ledger.test.mjs`：契约单测

**实施步骤**：
1. 定义统一报告结构（JSON schema）：
   ```js
   {
     scene: { name, viewport, dpr, renderer, cesiumVersion, assetHash, cameraTrack, clock },
     mode: { native, enhanced, deferred, deferredTransparent, taa, ao, bloom },
     validity: { warmupFrames, sampledFrames, gpuSupported, disjointCount, focusLoss, configChanges },
     frame: { cpuMs: { p50, p95 }, gpuMs: { p50, p95 }, drawCalls, submittedCommands, triangles },
     passes: [{ name, gpuMs: { p50, p95 }, cpuMs: { p50, p95 }, draws, renderItems, batches }],
     state: { drawHookInstallations, drawHookInvocations, programBinds, materialBinds, uniformUploads, textureBinds },
     memory: { graphPhysicalBytes, graphPeakBytes, poolCurrentBytes, poolPeakBytes, ccrTextureBytes, tilesetReportedBytes, jsHeapBytes,
       scope: 'tracked allocations; true board VRAM requires vendor profiler' }
   }
   ```

2. 为 `RenderGraph143` 添加 GPU Pass scope：
   - `beginGpuScope(name)` / `endGpuScope(name)`
   - 使用 `EXT_disjoint_timer_query_webgl2`
   - 同一帧无法同时采样的 Pass 进入轮换计划
   - 报告必须带 `sampledFrames` 和 `discarded`

3. 将 `context.draw` 计数从多个 wrapper 移到统一位置（为 Phase 4 准备）

4. 固定基线场景：
   - 1920×1080、DPR 1、前台 Chrome、Cesium 1.143
   - 固定时间、固定相机轨迹、固定资产 hash（校园场景）
   - 每个 case 预热 30s，采样 60s，重复 3 轮

5. 运行四个 baseline：
   - `native`：Cesium 原生提交/光照
   - `enhanced-current`：当前增强路径
   - `deferred-current`：当前 Deferred + 现有 context.draw 拦截
   - `deferred-transparent-current`：含 OIT/sorted 透明

**验收标准**：
- 每轮至少保留 300 个有效帧；CPU 报告 p50/p95 和 bootstrap CI
- GPU 只在 query 可用率达到预设最低比例时比较；disjoint 超限的轮次作废，不要求所有轮次低于固定 10%
- CV < 5% 作为理想稳定性等级，不作为唯一通过条件
- 基线数据冻结到 `docs/verification/rendering-performance/baseline-*.json`

**依赖**：无；完成后 Phase 2、Phase 3 和 Phase 4A 可开始。  

---

### Phase 1: TAA 历史采样诊断（并行低优先级，3 天时间盒）

**目标**：诊断直接采样 RHI 拷贝纹理导致的时间抖动；该任务不阻塞 Graph transient、Deferred direct-submit、Transparent direct-submit 或 batching。

**问题描述**：
- 当前 `TaaPass143` 创建 RHI 双 buffer 历史、拷贝、Graph 绑定
- 但 resolve 仍采样 Cesium PostProcessStage 历史（`this.frames[1-this.active].resolve.outputTexture`）
- 注释标注直接采样 RHI 拷贝会重现严重抖动
- 需要明确：是修复根因后启用直接采样，还是保持当前方案并简化 RHI 路径

**实施选项**：

**选项 A（推荐）：诊断并修复根因**
1. 在隔离测试场景中重现抖动（固定相机、单个模型）
2. 对比 Cesium Stage 历史与 RHI 拷贝历史的：
   - 纹理参数（format/datatype/sampler/wrap/filter）
   - 拷贝时机（frame boundary、depth write 顺序）
   - 坐标系统（纹理 UV 翻转、投影矩阵差异）
3. 修复后验证抖动消失，启用直接 RHI 历史采样
4. 移除对 Cesium Stage 历史的依赖

**选项 B：保持当前稳定方案**
1. 文档化"RHI 历史用于 Graph 生命周期验证，采样仍用 Cesium Stage"
2. 移除未使用的 RHI 拷贝代码（`_copyToRhi`、`rhiCopyColor`、`rhiCopyDepth`）
3. 简化 Graph 历史绑定为"验证用占位"

**验收标准**：
- 选项 A：TAA 运行时诊断 `historyValid: true`、`bypasses: 0`、无可见抖动
- 选项 B：文档明确说明当前方案边界、移除冗余代码
- 两种方案都必须通过 `tests/rendering/taa-pass.test.mjs` + 浏览器验证

**依赖**：Phase 0（需要基线对比）；与 Phase 2、Phase 3、Phase 4A 并行。  

**时间盒规则**：最多投入 3 天。3 天内无法定位并修复根因时，明确保留 Cesium Stage history；TAA history 在 Render Graph 中继续作为 external resource，不为该任务新增主线依赖。

---

### Phase 2: 让 Render Graph 真正拥有 transient 物理分配（优先级：高）

**目标**：Graph 从"旁路 alias 诊断"升级为"实际物理资源分配者"

**当前问题**：
- `RenderGraph143` 只计算 `aliases[]`，不创建/绑定物理目标
- `PooledStageCache143` 自行计算 slot、调用 `RenderTargetPool143.acquire`
- Graph 和 Cache 维护两套独立 alias 算法

**实施步骤**：
1. 扩展 Graph 编译结果：`aliases[]` → `aliasGroups[]`
   - 每组包含 descriptor、资源句柄、first/last Pass、唯一 physical slot
   
2. 修正 root 判定：
   - 未绑定且无 side effect 的 external resource 不自动成为根
   - `present`、原生颜色输出、显式 `sideEffect` Pass 才保活依赖
   - 被断开的 transient Pass 真正被裁剪

3. 在 `beginFrame` 中为每个 physical slot 申请 RenderTargetPool lease：
   - `resolve(resource)` 返回该 slot 的 framebuffer/texture
   - 在 last Pass 完成时释放 slot
   - 帧异常时统一回收

   Graph 与 RHI/Pool 使用明确合同：

   ```js
   graph.setTransientAllocator({
     acquire(descriptor, aliasGroup) {},
     release(lease) {}
   })

   graph.resolve(resource)
   graph.resolvePhysicalSlot(aliasGroup)
   ```

   - 每个 alias group 只能有一个 active lease
   - `completePass()` 未调用时，`endFrame()` 必须兜底释放
   - `graphTransientActive: true` 必须表示真实 physical reuse，而不是只有 `aliases[]`

4. 增加 `bindExternal(resource, value)` 校验：
   - 尺寸和 context 校验
   - 记录 external/transient 实际绑定来源
   - 避免把逻辑 alias 当成物理复用

5. 迁移 `PooledStageCache143`：
   - 使用 Graph 的 alias slot
   - Graph 模式下禁止再次调用 `pool.acquire`
   - 保留无 Graph 时的旧 pool fallback，并在诊断中明确标记 `graph`/`pool-fallback`
   - AO/Bloom slot ledger 由同一份 Graph 生命周期生成

6. 资源分类：
   - **External**：TAA history、Cesium OIT/scene color、跨帧保留资源
   - **Transient**：AO/Bloom 中间目标、TAA resolve、同帧不重叠的 lighting intermediates
   - **Borrowed**：Deferred GBuffer 借用 Cesium depth/stencil（继续 external）

**验收标准**：
- Graph 单测验证：
  ```js
  assert.equal(report.aliasGroups.length, 1)
  assert.equal(report.physicalSlots, 1)
  assert.equal(pool.getDiagnostics().allocated, 1)
  assert.equal(report.feedbackConflicts.length, 0)
  ```
- 真实场景门槛：AO+Bloom+TAA 组合的 `graphPeakBytes` 相比当前 pool-only 实现至少下降 **20%**
- 若下降不足，保留 ledger 说明重叠原因，不强行复用不同格式资源

**依赖**：Phase 0（需要显存基线）  

---

### Phase 3: RenderItem 直接提交 Deferred（优先级：高）

**目标**：Deferred geometry/lighting 从"逐命令 `context.draw` 拦截"迁移为"RenderItem 直接提交"

**当前问题**：
- `DeferredGeometry143.capture/finish` 逐命令判断、shader 替换、独立提交
- `DeferredLighting143.render` 仍遍历 command map
- RenderItem 只作元数据收集，未实际执行

**实施步骤**：
1. 扩充 `RenderItem143` 合同：
   - 添加 `materialKey`、`pipelineKey`、`renderStateKey`、`framebufferKey`
   - 添加 `frustumIndex`、`sourcePass`、`commandIndex`、`nativeOrderKey`
   - RenderItem 只描述 command，不增加 `execute()` 方法，不拥有执行权

2. 修改 `FrameBridge`：
   - 在颜色帧收集当前 frustum 的 command
   - 一次性提交到 `RenderItemQueue`
   - Deferred/Transparent 只消费 queue snapshot，不再从 command map 重新扫描

3. 创建 `RenderItemExecutor143`：
   - 按 Pass 执行：原生兼容 item、Deferred GBuffer item、Deferred lighting item
   - 由 `executor.execute(item, context, passState, overrides)` 负责受控执行
   - 所有 override（shader、uniform、framebuffer、renderState）在 executor 内临时组装并恢复
   - 记录批次、draw 数、fallback 原因

4. 修改 `DeferredGeometry143`：
   - Supported item 直接提交到 Graph 管理的 GBuffer
   - Compatibility item 继续原生颜色提交并写 invalid marker
   - 成功路径不再依赖每次 `context.draw` 回调决定是否 capture

5. 修改 `DeferredLighting143`：
   - 消费 geometry 阶段生成的批次 ledger（沿用现有 `environmentGroup` 机制，不强制新增 `LightingBatch` 类）
   - 明确 ledger 的来源是 `RenderItemQueue -> GeometrySubmission -> GBuffer + environmentGroupLedger`
   - 通过 `RenderItemExecutor` 提交，不再直接调用 `context.draw`

6. 在 direct-submit 运行稳定后：
   - 移除 Deferred 对 `updateDerivedCommands` 的主动拦截
   - 该 hook 只保留兼容/诊断 fallback
   - 诊断中标记 fallback 原因

**验收标准**：
- 逐项像素回归测试：
  - Deferred GBuffer（法线/粗糙度/金属度/自发光/深度/透明度）
  - Deferred lighting（PBR/IBL/阴影/环境光）
  - 与 `deferred-current` 基线比较：颜色最大绝对通道误差 ≤ 0.03、平均绝对误差 ≤ 0.01、变化像素比例 ≤ 0.01；HDR 相对误差 ≤ 0.05
  - 深度误差 ≤ `1e-5`、法线误差 ≤ 0.01、材质附件误差 ≤ 0.02、alpha 误差 ≤ 0.02
  - MASK、选中轮廓、透明 coverage 使用独立 binary/pixel checks
- 性能不回退：
  - CPU submission p95 不增加超过 5%
  - `context.draw` 调用次数不增加
- 诊断报告：
  - `renderItems` 数、`batches` 数、`nativeFallback` 数
  - 每个 fallback 都有 reason

**依赖**：Phase 0（需要基线）  

---

### Phase 4A/4B: 统一 context.draw dispatcher（基础设施先行，迁移随后）

**目标**：减少嵌套 wrapper，统一 draw hook 管理

**当前问题**：
- DeferredGeometry、SunUniforms、OcclusionCulling、SelectedIdPass、TaaOverlay、RenderProfiler 各自保存 `previous=context.draw` 并互相嵌套
- 无法统一计数、恢复、诊断

**Phase 4A：基础设施（Phase 0 后即可开始）**

1. 创建 `ContextDrawDispatcher143`：
   - 每个 scene/context 只安装一个 wrapper
   - 持有 ordered handler list
   - 按 phase/pass/context/frame 条件决定是否短路、改写或调用 native draw

2. Handler 返回值：
   - `pass`：调用 native draw
   - `replace`：跳过 native draw，handler 已处理
   - `skip`：跳过该 command
   - `continue`：继续下一个 handler

3. 资源/state 恢复：
   - 所有 restore 在 dispatcher 的 `finally` 完成
   - Foreign wrapper 仍能在 dispatcher 外层安装且卸载不覆盖外部替换

4. Profiler 只作为 readonly observer：
   - 不改变 command、shader、uniform、framebuffer 或 native draw 决策
   - 只统计 draw 次数、context state 变化、GPU query 和 dispatcher 事件

5. 诊断：
   - `drawHookInstallations`：永远 1 个 wrapper
   - `activeHandlers`：当前注册的 handler 数
   - `nativeFallbackDraws`：实际调用 native draw 的次数
   - `shortCircuits`：被 handler 拦截的次数
   - Dispatcher 自身 CPU overhead < frame CPU 的 2%

**Phase 4A 验收标准**：
- 每个 scene 永远 1 个 `context.draw` wrapper
- 诊断报告完整、overhead 可接受

**Phase 4A 依赖**：Phase 0；与 Phase 2、Phase 3 并行。

**Phase 4B：现有模块迁移（Phase 3 后）**

- Sun UBO、Occlusion、Selected ID、TAA overlay 注册 dispatcher handler，不再直接保存 `previous=context.draw`
- Deferred direct-submit 稳定后移除其 per-command handler，仅保留兼容/诊断 fallback
- Transparent direct-submit 稳定后移除其 per-command handler，仅保留兼容/诊断 fallback
- 外部 wrapper、context loss、卸载顺序和 foreign replacement 继续使用 dispatcher 的生命周期合同

**Phase 4B 验收标准**：
- Deferred/Transparent direct-submit 后不再注册 per-command handler
- 所有 handler 的 native fallback、short-circuit 和 state restore 有独立计数

**Phase 4B 依赖**：Phase 3。

---

### Phase 5: Transparent 直接提交与 OIT 约束（优先级：中）

**目标**：Transparent forward 从"逐命令拦截"迁移为"RenderItem 直接提交"，保持 OIT/sorted 深度排序约束

**当前问题**：
- `TransparentForward143.applyTo` 虽用 `onRenderItem` 入口，但实际执行仍走 `DrawCommand.execute`
- 无批处理

**关键约束**：
- OIT/sorted 透明必须保持 Cesium 深度排序
- 不能为减少切换而跨越深度排序或混合语义
- 当前 `compareRenderItems143` 不代表 Cesium 原生透明顺序；RenderItem 必须携带 `frustumIndex`、`sourcePass`、`commandIndex`、`nativeOrderKey`
- `nativeOrderKey` 由 frustum/pass/command 原生顺序构成；透明路径不得按 `materialKey` 重排全体命令

**实施步骤**：
1. 扩展 `RenderItemExecutor143`：
   - 添加 Transparent/OIT item 执行路径
   - 识别连续且 state-compatible 的 item 区间
   - 只在同一深度/混合排序区间内批处理

2. 修改 `TransparentForward143`：
   - 消费保留 `nativeOrderKey` 的 RenderItemQueue snapshot
   - 通过 `RenderItemExecutor` 提交
   - 保留 OIT MRT/multipass 的原生约束

3. OIT 材质索引跟踪：
   - 在 RenderItem 中添加 `oitMaterialIndex`
   - 保持 Cesium 原生索引分配逻辑
   - 不完全脱离 Cesium `DrawCommand`（仍作执行载体）

**验收标准**：
- 逐项像素回归测试：
  - OIT MRT（accumulation/revealage）
  - OIT multipass
  - Sorted transparency
  - MASK 模式
  - 与 `deferred-transparent-current` 基线比较：颜色最大绝对通道误差 ≤ 0.03、平均绝对误差 ≤ 0.01、变化像素比例 ≤ 0.01、alpha 误差 ≤ 0.02
  - MASK、OIT accumulation/revealage、sorted 深度顺序使用独立 binary/pixel checks
- 性能不回退：
  - CPU submission p95 不增加超过 5%
  - 深度排序正确性保持

**依赖**：Phase 3（Deferred direct-submit 完成）  
**预计工作量**：4-5 天

---

### Phase 6: 材质与 shader program batching（优先级：低，性能优化）

**目标**：减少 program bind、render state bind、material bind

**前提**：Phase 3/5 完成后，才有稳定的 RenderItem 批处理基础

**实施步骤**：
1. 定义稳定 BatchKey：
   ```
   pass + shaderSourceId + injectedVariant + renderStateId + framebufferLayout + textureLayout + featureFlags
   ```
   - 禁止把逐对象 transform、颜色、IBL factor 放进 program key

2. 创建 `ShaderProgramCache143`：
   - 只编译一次每个 BatchKey
   - 跟踪 active/lastUsed frame
   - 统一清理过期 program、RenderState、uniform wrapper

3. 按 BatchKey 排序：
   - Opaque/Deferred GBuffer 按 BatchKey 排序后提交
   - Transparent 仅合并同一深度/混合排序区间内的连续 item

4. 合并重复计算：
   - 将逐 draw 的 `new Cartesian4`、重复 shadow uniform wrapper、重复 IBL lookup 合并为 batch scope
   - 使用已有 Sun UBO/共享相机块
   - 变化的 per-item 数据留在轻量 uniform 更新

5. 诊断：
   - `programBinds`、`renderStateBinds`、`materialBinds`、`textureBinds`、`uniformUploads`
   - `batchCount`、`meanBatchSize`
   - 按 native/enhanced/deferred/transparent 分开

**性能目标（候选门槛）**：
- 同一场景、同一输出像素、同一 asset hash
- Shader/program bind 下降 ≥ **30%**
- 材质/uniform 更新下降 ≥ **20%**
- CPU submission p95 下降 ≥ **15%**
- GPU frame p50 下降 ≥ **10%**（像素回归通过后才比较）

**验收标准**：
- **Correctness gate**：像素、透明顺序、资源生命周期和 fallback 诊断通过
- **No-regression gate**：没有 CPU 回退、资源泄漏、画面错误或明显 GPU 回归
- **Optimization success tier**：program bind 下降 ≥30%、材质/uniform 更新下降 ≥20%、CPU submission p95 下降 ≥15%、GPU frame p50 下降 ≥10%，达成其中至少 3 项记为性能优化达标
- 只满足前两个 gate 时仍保持 batching 启用，并记录为“正确且无回归，性能收益待继续调优”；不因未达到目标就自动退回旧路径

**依赖**：Phase 3、Phase 5（RenderItem direct-submit 稳定）  

---

### Phase 7: 真实场景性能对比报告（优先级：最高，贯穿各 Phase）

**目标**：每个 Phase 完成后生成对比报告，验证优化效果

**场景矩阵**：

| Case | 目的 | 何时测量 |
|------|------|----------|
| native | Cesium 原生基线 | Phase 0 |
| enhanced-current | 当前增强路径基线 | Phase 0 |
| deferred-current | 当前 Deferred 基线 | Phase 0 |
| deferred-transparent-current | 含 OIT/sorted 透明基线 | Phase 0 |
| graph-transient | Graph 实际分配 transient | Phase 2 |
| deferred-direct | Deferred direct-submit | Phase 3 |
| transparent-direct | Transparent direct-submit | Phase 5 |
| batched | 含 material/shader batching | Phase 6 |
| campus-business | 真实校园完整场景 | 各 Phase |
| synthetic-command-heavy | 固定模型数量，隔离提交开销 | Phase 6 |

**报告内容**：
1. 每个 case 记录：
   - renderer、浏览器、Cesium hash、资产 hash、drawing buffer、DPR、相机轨迹、时间
   - 实际 active/fallback mode 和错误
   - 任何 scene/config/asset/readiness 变化使该轮失效

2. GPU 指标：
   - 整帧和每个 Pass 的 p50/p95
   - Query 可用率、disjoint 丢弃数
   - Pass 至少包括：shadow、native/gbuffer、deferred lighting、transparent/OIT resolve、environment、Hi-Z/AO/Bloom、TAA/present

3. CPU 指标：
   - frame/update/submit p50/p95
   - RenderItem 数、批次数、`context.draw` 次数
   - Shader/state/material/texture bind
   - Uniform upload 次数和字节
   - Native fallback 数

4. 显存/资源指标分层：
   - **CCR exact tracked**：Graph physical slots、pool entries、各 texture `sizeInBytes`、current/peak/live bytes
   - **Cesium reported**：Tileset `totalMemoryUsageInBytes`、模型纹理/geometry 统计
   - **JS only**：`performance.memory.usedJSHeapSize`（不能当 VRAM）
   - **Board/driver VRAM**：Chrome GPU diagnostics 或 Nsight/PIX 采集，不可用时标注 `unavailable`，不能用 CCR bytes 冒充整卡峰值

5. 对比基准：
   - 同一场景、同一帧序列、同一分辨率、同一资产 hash
   - 报告优化前/后绝对值、相对变化、95% bootstrap CI
   - 单独给出"输出像素误差/功能回退"结论

**建议门槛**：
- Direct-submit 不增加像素误差
- Graph alias 物理峰值下降 ≥ 20%
- Program bind 下降 ≥ 30%
- Submission CPU p95 下降 ≥ 15%
- GPU frame p50 下降 ≥ 10%（像素回归通过后才比较）
- 未达到性能目标时保留诊断并标记“性能收益待调优”；只有 Correctness 或 No-regression gate 失败才回退，不修改场景负载迎合门槛

**验收标准**：
- 每个 Phase 完成后生成对比报告
- 每轮至少保留 300 个有效帧；CPU 使用 p50/p95 和 bootstrap CI
- GPU 仅在 query 可用率达到最低比例时比较；disjoint 超限轮次作废
- 三次测量 CV < 5% 作为理想稳定性等级，不作为唯一通过条件
- 明确标注"tracked allocation bytes"不等于整卡显存

**依赖**：Phase 0（基线契约）  

---

### Phase 8: 分阶段上线和回退门禁（优先级：高，最后阶段）

**目标**：建立能力标志、默认策略、回退门禁

**实施步骤**：
1. 增加 capability 字段：
   - `graphTransientActive`：Graph 实际分配 transient
   - `renderItemDirectSubmit`：RenderItem 直接提交
   - `materialBatchingActive`：材质/shader 批处理
   - `contextDrawDispatcherActive`：统一 draw dispatcher
   - 每项返回 `requested` / `active` / `reason` / `generation`

2. 默认行为：
   - 支持范围内直接启用 direct-submit、batching、Graph transient
   - 只有不兼容条件才回退到 enhanced/native
   - 保留诊断用强制旧路径开关用于 A/B 对比，不能作为正常主路径

3. 文档化：
   - 优化前基线、优化后报告、GPU/显存范围、像素回归、已知限制
   - 明确"tracked allocation bytes"不等于整卡显存
   - 明确"headless/短时样本"不等于正式生产性能

4. 回归门禁：
   - 先跑相关 Node tests
   - 再跑全量 `npm test`
   - 全量仍有与工作树资产配置相关的失败时，报告失败用例和原因，不把整体状态写成全绿

**验收标准**：
- 能力矩阵完整、诊断清晰
- 文档完整、限制明确
- 回归门禁通过

**依赖**：Phase 2-6 全部完成  

**执行依赖图**：

```text
Phase 0
  ├─ Phase 1（TAA，低优先级并行，3 天时间盒）
  ├─ Phase 2（Graph transient）
  └─ Phase 4A（dispatcher 基础设施）
        ↓
Phase 3（Deferred direct-submit）
  ├─ Phase 4B（dispatcher 模块迁移）
  └─ Phase 5（Transparent direct-submit）
        ↓
Phase 6（material/shader batching）
        ↓
Phase 7（持续性能报告）→ Phase 8（能力矩阵与上线门禁）
```

---

## 关键决策点

### 1. TAA 历史采样（Phase 1）
- **决策**：选项 A（修复根因）还是选项 B（保持当前方案）？
- **建议**：优先选项 A，但设置 3 天诊断时间限制；超时则降级为选项 B

### 2. OIT 边界（Phase 5）
- **决策**：OIT 是否需要完全脱离 Cesium `DrawCommand`？
- **建议**：保持 Cesium 为执行载体、RenderItem 仅作提交层；完全脱离需要额外 Phase

### 3. Batching 门槛（Phase 6）
- **决策**：性能目标未达成时是否保留实现？
- **建议**：Correctness gate 和 No-regression gate 通过后保持启用；未达到 Optimization success tier 时标注“性能收益待继续调优”，不自动退回旧路径

---

## 自检清单

每个 Phase 完成前必须通过：

- [ ] 目标明确、可测量
- [ ] 文件范围完整
- [ ] 依赖关系清晰
- [ ] 验收标准可执行
- [ ] 性能对比使用同一基线（同一场景、同一相机、同一时间、同一资源 hash）
- [ ] 没有把诊断数据当成实际能力（如 Graph alias 诊断 ≠ 物理复用）
- [ ] 没有把 RenderItem 收集当成 direct submit 完成
- [ ] 没有把 CCR 纹理字节或 JS heap 当成整卡 VRAM
- [ ] 像素回归测试通过
- [ ] 单元测试覆盖关键契约
- [ ] 文档更新（如有架构变更）

---

## 附：原计划问题总结

| 原计划问题 | 修订版改进 |
|-----------|-----------|
| TAA 历史迁移目标模糊 | Phase 1 明确两个选项，优先修复根因 |
| Frustum culling 与多视锥体分散 | 移除重复统计，保持 Cesium 原生 |
| OIT 与 RenderItem 边界不清 | Phase 5 明确保持 Cesium 为执行载体 |
| Capability fallback 目标重复 | Phase 8 聚焦运行时降级触发和可视化 |
| Deferred/Forward 统一 shader 模糊 | 移除，保持各自 shader 路径 |
| 反射探针池化概念模糊 | 移除，当前反射已 RHI 管理 |
| 阶段依赖循环 | 重新梳理为：0→(1并行、2、4A)→3→(4B、5)→6→7→8 |
| 测试覆盖计划缺失 | 每个 Phase 明确验收标准 |
| 文档维护未提及 | Phase 8 包含文档更新 |
| Cesium 原生边界模糊 | 各 Phase 明确 Cesium 保持原生部分 |

---

## 变更历史

- **v3（2026-10-13）**：整合 TAA 非阻塞、RenderItem/Executor 所有权、Graph allocator 合同、透明原生顺序、dispatcher 4A/4B、测量稳定性和 batching 三层验收门槛
- **v2（2026-10-13）**：根据 `cbab9e3` 提交代码状态重新整理，修复边界模糊、目标重复、依赖混乱问题
- **v1（2026-10-13）**：初版计划（存在上述问题，已废弃）
