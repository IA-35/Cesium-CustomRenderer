# CCR 渲染管线架构与模块分化

> 基线：2026-10-16 · 对应提交 `00595ee` 之后的工作区
> 规模：**124 个源文件 / 19,606 行**（不含 `environment/cloudNoiseData.js` 这个 1.4 MB 的噪声图集数据块）
>
> 本文描述**代码实际长什么样**，而不是设计意图。凡与设计不符之处都在 §6 标出。

---

## 1. 定位与根本约束

CCR 是**寄生在 Cesium 1.143 WebGL 渲染循环上的增强层**，不是 fork：

| 约束 | 含义 |
|---|---|
| 不修改 Cesium 源码 | 通过公开/内部字段介入（`scene._view`、`context.draw`、`updateDerivedCommands`、`uniformState`…） |
| Cesium 拥有帧循环与上下文 | CCR 不创建 WebGL context，不接管 RAF |
| 版本硬门禁 | 所有类要求 `Cesium.VERSION` 匹配 `/^1\.143(?:\.0)?$/`，不匹配直接抛错 |
| 升级需重新验证 | 依赖大量非公开结构，见 §7 风险清单 |

**这个约束决定了架构的主要形状**：CCR 没有"自己的渲染循环"，只能在 Cesium 的循环里**插入拦截点**与**声明自己的帧图**。因此 §4.2 的 dispatcher 与 §4.1 的 FrameBridge 是整个架构的承重墙。

---

## 2. 分层总览

```
┌─────────────────────────────────────────────────────────────────┐
│  组合根   VisualPipeline.js  (~1050 行)                          │
│           创建 18 个子系统 · 40+ set/get · 唯一的对外入口          │
└─────────────────────────────────────────────────────────────────┘
        │ 装配
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  业务/叶层   instances/ traffic/ tileset/ selection/             │
│              visibility/ performance/ diagnostics/               │
│              （植被、车流、拾取、遮挡剔除、调速器、诊断）            │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  效果层   environment/ lighting/ shadows/ antialiasing/          │
│           channels/ reflections/ ao/ bloom/ stages/              │
│           （彼此几乎不横向依赖，只依赖下层）                        │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  资源层   rhi/WebGLDevice143  ── 资源创建、生命周期、租约          │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  基础设施层   pipeline/                                          │
│     FrameBridge143        帧阶段与 RenderItem 收集               │
│     RenderGraph143        声明/编译/别名/瞬态分配                 │
│     ContextDrawDispatcher143  单点 draw 拦截                     │
│     RenderTargetPool143   租约池（跨模块复用 render target）       │
│     PooledStageCache143   把 Cesium PostProcessStage 接入池/图     │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  叶子   core/FrameState143 · renderer/ · buffers/               │
│         （帧数据快照、RenderItem 元数据、UBO 基元；无跨目录依赖）    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 模块规模排序

| 目录 | 文件 | 行数 | 职责一句话 |
|---|---:|---:|---|
| `environment/` | 24 | **4286** | 大气散射、体积云、Hillaire LUT、环境光照、夜间、HDR 合成 |
| `antialiasing/` | 17 | **2797** | SMAA / FXAA / TAA / 抖动序列 / 空间 AA 质量档 |
| `channels/` | 7 | 1375 | 材质通道（MRT）、屏幕空间几何、深度金字塔 |
| `reflections/` | 6 | 1304 | SSR、透明反射、OIT 兼容、图元反射 |
| `pipeline/` | 9 | 1152 | **基础设施**（见上） |
| `instances/` | 6 | 1009 | 固定树木、草、水面（业务适配器） |
| `shadows/` | 11 | 975 | 级联阴影、光源相机、接收器着色器改写、缓存 |
| `stages/` | 4 | 928 | 色调映射、镜头效果、调色 |
| `traffic/` | 4 | 852 | 车辆路网仿真与实例化 |
| `lighting/` | 4 | 804 | 延迟几何捕获与延迟光照 |
| `diagnostics/` | 6 | 703 | 性能采样、GPU timer、能力矩阵、代价账本 |
| `ao/` | 3 | 441 | SSAO / HBAO |
| `buffers/` | 4 | 347 | UBO 基元、太阳/相机/光源 uniform 块 |
| `performance/` | 1 | 290 | 帧预算调速器 |
| `visibility/` | 2 | 232 | 遮挡剔除（GPU query） |
| `tileset/` | 1 | 229 | 3D Tiles 优化 |
| `renderer/` | 4 | 197 | RenderItem / Queue / Executor / BatchPlanner |
| `bloom/` | 2 | 197 | HDR Bloom |
| `selection/` | 1 | 101 | 选中轮廓（复用拾取深度） |
| `rhi/` | 1 | 85 | WebGL 资源抽象（**抽象层最薄，见 §6.4**） |
| `core/` | 1 | 23 | FrameState 快照 |
| `scene/` | 1 | 17 | Cesium scene → FrameState 桥 |

---

## 3. 依赖方向（实测）

箭头 = "引用来自"。数字为引用次数。

```
buffers   ←(5) reflections   ←(3) ao   ←(2) environment   ←(1) lighting / shadows
core      ←(1) pipeline      ←(1) scene
renderer  ←(4) pipeline      ←(1) lighting   ←(1) scene   ←(1) antialiasing
pipeline  ←(3) visibility    ←(3) environment  ←(2) lighting  ←(2) bloom
          ←(1) shadows / stages / channels / ao / antialiasing / diagnostics / rhi
shadows   ←(2) pipeline      ←(2) lighting   ←(1) visibility
channels  ←(4) lighting      ←(1) reflections
environment ←(2) reflections ←(1) bloom / ao / antialiasing / stages
```

**总体是"向上依赖"的 DAG，但有两处例外**，见 §6.1 与 §6.2。

---

## 4. 三条主线

架构的真正复杂度集中在这三条链上；其余模块都是它们的消费者。

### 4.1 帧流程：`FrameBridge143`

CCR 通过替换 `scene.updateDerivedCommands` 介入 Cesium 的命令派生，并暴露四个可订阅阶段：

```js
export const FRAME_BRIDGE_PHASES = ['opaqueFrame', 'opaqueReadHook', 'translucent', 'resolve']
```

| 阶段 | 时机 | 当前订阅者 |
|---|---|---|
| `opaqueFrame` | 不透明帧开始 | `DeferredLighting143`（清空 RenderItem，priority −100） |
| `opaqueReadHook` | 不透明写入完成后 | 暂无订阅 |
| `translucent` | 半透明阶段 | `DeferredLighting143`（执行延迟光照） |
| `resolve` | 帧合成 | `TransparentForward143`、`OcclusionCulling143` |

**数据流**：

```
Cesium scene
   │  CesiumSceneAdapter143 读取 _view / frameState / uniformState
   ▼
FrameState143（不可变快照，generation = frameNumber）
   │  FrameBridge143 在每个命令上 createRenderItem143()
   ▼
RenderItem143（不可变元数据：pass、command、frustumIndex...）
   │  RenderItemQueue143 收集
   ▼
RenderItemExecutor143（执行边界：克隆命令、应用覆盖、经 withBypass 提交）
   ▼
原生 DrawCommand.execute
```

**关键设计**：`RenderItem` 是**描述性元数据**，`Executor` 才提交。这条界线让 Phase 3/5 的 direct-submit 可以在不改变收集逻辑的前提下替换提交策略。

### 4.2 命令拦截：`ContextDrawDispatcher143`

**全工程只有一个 `context.draw` 包装器**（Phase 4A 的成果）。所有需要观察/改写 draw 的模块都注册 handler，按 `priority` 升序执行，返回决策：

```js
const allowed = new Set(['pass', 'replace', 'skip', 'continue'])
```

- `pass` / `continue` → 落到 `event.native()`（计入 `nativeFallbackDraws`）
- `skip` / `replace` → 短路（计入 `shortCircuits`）

**当前 handler 链（实测优先级）**：

| priority | name | 模块 | 作用 |
|---:|---|---|---|
| **−30** | `globe-night-lighting` | `environment/GlobeNightLighting143.js` | 夜间地球光照注入 |
| **−20** | `taa-overlay` | `antialiasing/TaaOverlay143.js` | 把面向屏幕的 UI 踢出 TAA 历史 |
| **−10** | `selected-id` | `selection/SelectedIdPass143.js` | 选中轮廓：用已有深度替代重复绘制 |
| **0** | `occlusion` | `visibility/OcclusionCulling143.js` | 按遮挡 query 结果跳过绘制 |
| **0** | `sun-uniforms` | `buffers/SunUniforms143.js` | 注入太阳 UBO |
| **10** | `deferred-geometry` | `lighting/DeferredGeometry143.js` | 捕获 GBuffer，用派生命令替换原生绘制 |
| **20** | `transparent-direct-submit` | `pipeline/TransparentForward143.js` | 透明前向批次提交 |

**负优先级 = 先于其他 handler 观察**；`deferred-geometry` 取 10 是为了在其他观察者之后决定是否替换。

**降级路径**：每个消费模块都保留 `if (dispatcher) … else context.draw = hook` 的双路径，仅为无 dispatcher 的旧环境兜底；`VisualPipeline` 总是安装 dispatcher，因此运行时走 handler 分支。

### 4.3 资源生命周期：三件套

```
Cesium context
   │
   ├── RenderTargetPool143 ──── 租约池（跨模块复用同规格 render target）
   │        attach(owner) / acquire(owner, spec) / release()
   │        resize(w,h) → 尺寸变化时 invalidate
   │        getDiagnostics() → live / targets / bytes / reused / crossReused
   │
   ├── WebGLDevice143（rhi/）── 资源边界（85 行，最薄的一层）
   │        createTexture / createFramebuffer / createRenderTarget
   │        createTransientAllocator(label) → { acquire, release, resize, getDiagnostics }
   │        destroy() → 释放全部 resources + transientOwners
   │
   └── RenderGraph143 ──── 声明式帧图
            importResource()  外部资源（帧间存活，keepAlive）
            createResource()  瞬态资源（可被别名复用）
            setTransientAllocator(rhi.createTransientAllocator('graph'))
            beginFrame → compile（裁剪/拓扑排序/别名）→ executePass → endFrame
```

**当前 Graph 的 Pass 契约**（在 `VisualPipeline.rebuildRenderGraph()` 里集中声明）：

```
deferred.geometry  写 GBuffer 四附件
deferred.lighting  读 GBuffer，写 screen
transparent.forward 读写 screen
native.forward     写 screen（非延迟路径的替代分支）
taa.resolve        读 screen + history，写 resolved
taa.present        读 resolved，写 screen
present            读 screen（sideEffect，防止被裁剪）
```

另有两条**子图注册**路径：`PooledStageCache143` 为 AO/Bloom 的每个 PostProcessStage 声明 `<kind>.<name>`；`EnvironmentGraph143` 声明大气 LUT / 云 / 合成的资源与 pass。

**三种资源归属的判据**（写新模块时常错的点）：

| 资源性质 | 归属 | 理由 |
|---|---|---|
| 每帧分配、同规格可复用 | Graph **transient** | 别名分配，帧末归还池 |
| 跨帧存活（历史、LUT、持久缓存） | Graph **external** + `keepAlive` | 不能被别名回收 |
| Cesium 已拥有（scene color、globe depth） | Graph **external** 绑定 | CCR 只读，不释放 |

---

## 5. 跨模块契约

修改这些接口会同时影响多个模块，需先确认全部消费者。

| 契约 | 定义处 | 消费者 |
|---|---|---|
| `FrameBridge` 四阶段与 `on(phase, fn, {priority})` | `pipeline/FrameBridge143.js` | `lighting/`、`pipeline/TransparentForward143`、`visibility/` |
| Dispatcher 决策枚举与 `aroundDraw` / `deferRestore` | `pipeline/ContextDrawDispatcher143.js` | 7 个 handler（§4.2） |
| `RenderItem` 字段与 `compareRenderItems143` | `renderer/RenderItem143.js` | `pipeline/`、`lighting/`、`scene/`、`antialiasing/` |
| `acquire/release` 租约形状 | `pipeline/RenderTargetPool143.js` | `rhi/`、`render/` 全部效果模块 |
| Graph `importResource` / `createResource` / `bindExternal` | `pipeline/RenderGraph143.js` | `antialiasing/TaaPass143`、`environment/EnvironmentGraph143`、`PooledStageCache143` |
| 阴影采样 uniform 名（`campus_shadowDepth*` 等） | `shadows/shadowUniforms143.js` | `lighting/DeferredLighting143`、`pipeline/TransparentForward143`、`environment/` |
| 大气/云 uniform 契约（`atmosphereParams`、`cloudParams`…） | `environment/environmentStages.js` | `environment/` 内部、`EnvironmentRenderer` |

---

## 6. 已识别的问题

**以下都是实测到的结构问题，不是猜测。** 按影响排序。

### 6.1 模块环：`channels ⇄ reflections`

```
channels/MaterialChannels143.js:3
  → import { primitiveReflectionSources, globeWaterSources, primitiveReflectionDiagnostics }
    from '../reflections/PrimitiveReflection143.js'

reflections/transparentReflectionShader143.js:1
  → import { reflectionInstrumentation }
    from '../channels/reflectionShader143.js'
```

**性质**：两边交换的都是 `export function` 着色器源码生成器，**只在函数体内调用**，不在模块初始化期求值，因此运行时无害（函数声明提升）。但它是**真实的 ES module 环**。

**根因**：着色器源码聚合这一职责被拆在 `channels/reflectionShader143.js` 与 `reflections/transitiveReflectionShader143.js` 两处，而调用方横跨两边。

**建议**：把"反射着色器源码"整体归到一处（`reflections/` 更合适），`channels` 单向依赖它。属于低风险重构。

### 6.2 反向依赖：`pipeline → shadows`

```
pipeline/TransparentForward143.js:3        → shadows/shadowUniforms143.js
pipeline/transparentForwardShader143.js:1  → shadows/shaderAdapter143.js
```

**性质**：基础设施层依赖效果层，破坏了 §2 的分层假设。

**根因**：`TransparentForward143` 虽然放在 `pipeline/`，但它**不是基础设施**——它是一个具体效果（透明前向光照），与 `DeferredLighting143` 同层。放错目录导致它把 shadows 拖进了 pipeline 的依赖。

**建议**：把 `TransparentForward143.js` + `transparentForwardShader143.js` 移到 `lighting/`（与 deferred 配对）。**这是目录归属问题，不是设计问题。**

### 6.3 `pipeline/` 职责混杂

目录里同时住着两类东西：

| 类别 | 文件 |
|---|---|
| **真·基础设施** | `FrameBridge143`、`RenderGraph143`、`ContextDrawDispatcher143`、`RenderTargetPool143`、`PooledStageCache143`、`PrimitiveOrder143`、`particleBillboards143` |
| **具体效果** | `TransparentForward143`、`transparentForwardShader143`（见 §6.2） |

### 6.4 RHI 抽象最薄

`rhi/WebGLDevice143.js` 仅 85 行，而**绕过它直接 `new C.Texture` / `new C.Framebuffer` 的地方有 29 处**（分布在 lighting、shadows、antialiasing、channels、reflections、environment、pipeline）。

**含义**：RHI 目前是"资源创建的可选入口"而非"强制边界"。若目标是将来换后端，需要把直连处收敛到 RHI。**当前不做也不影响功能**，但它决定了后端可替换性的上限。

### 6.5 `environment/` 是巨型模块

4286 行 / 24 文件，是第二名的 1.5 倍，且内部把**大气散射、体积云、LUT 生成、环境光照、夜间、HDR 合成**全放在一起。

**具体表现**：`environmentStages.js`（451 行）把大气与云**拼进同一个 fragment shader**，通过 `effectFlags` 分支控制；`raymarchStage` 与 `resolveStage` 的配合需要在两个 stage 之间人肉对齐（历史上多次出错：泛白、透射率、半分辨率污染）。

**建议方向**（未实施）：拆成 `atmosphere` / `clouds` / `composite` 三个独立 pass。代价是全屏读写增加，收益是边界清晰、可单独开关与定位。

### 6.6 `VisualPipeline.js` 是上帝对象

约 1050 行，`new` 了 **18 个子系统**，暴露 **40+ 个 `set*/get*`** 方法。

**新增一个效果要改四处**：构造函数、`apply()`、`restore()`、`destroy()`，外加对应的 set/get 与诊断。

**已评估但未实施**：注册表化。读完全部方法后判断——40 个方法**各有独特业务逻辑**（时序、所有权、白名单），强行表驱动收益低、风险高。**当前选择是接受现状**，直到有更强的动机。

---

## 7. 升级 Cesium 时的风险面

下列非公开结构被直接依赖，升级时**必须逐个重新验证**（这也是版本门禁存在的原因）：

| 结构 | 依赖点举例 |
|---|---|
| `scene._view.frustumCommandsList` | 命令收集、阴影、剔除 |
| `scene._view.globeDepth` / `sceneFramebuffer` | GBuffer 深度别名、拾取 |
| `context.draw` | dispatcher 包装目标 |
| `context.uniformState` | 相机/太阳/视口 uniform |
| `context._gl` / `_currentFramebuffer` | 原生 GL 状态保存与恢复 |
| `scene.updateDerivedCommands` | FrameBridge 与阴影接收器注入 |
| `scene._environmentState` | OIT / classification / 后处理状态判定 |
| `FrameBridge143` 的 `C.VERSION` 校验 | 入口硬门禁 |

---

## 8. 新增模块的落位指南

| 你要加的东西 | 放哪 | 需要实现的契约 |
|---|---|---|
| 一个新的全屏后处理效果 | `stages/`（简单）或独立目录 | `PostProcessStage`，或经 `PooledStageCache143` 接入池/图 |
| 需要拦截 draw 的效果 | 对应效果目录 | `dispatcher.addHandler(event, {name, priority})`，返回决策枚举 |
| 需要每帧特定时机的效果 | 对应效果目录 | `bridge.on(phase, fn, {priority})` |
| 需要帧间历史/LUT | 对应效果目录 | `graph.importResource(..., {keepAlive:true})` + `bindExternal` |
| 每帧临时资源 | 对应效果目录 | `graph.createResource()`，让别名分配接管 |
| 新的业务实例类型（植被/车辆类） | `instances/` 或 `traffic/` | 参考 `FixedTreeCollection`：业务适配器 + vendor runtime |
| 只读诊断 | `diagnostics/` | 不得分配 GPU 资源 |
| UBO 基元 | `buffers/` | 参考 `UniformBuffer143` |
| 新的帧数据字段 | `core/FrameState143.js` | 保持不可变快照语义 |

**四条硬约束**：

1. **不要新增 `context.draw` 包装器** —— 注册 dispatcher handler
2. **不要绕过 RHI 创建长期资源**（临时可用 Cesium 直连，但要登记归属）
3. **不要修改 Cesium 源码** —— 只能拦截或替换行为
4. **新增效果必须同时接 `restore()` 与 `destroy()`** —— 否则禁用管线后会留下泄漏

---

## 9. 与设计文档的关系

| 文档 | 关系 |
|---|---|
| [`RENDERING_PERFORMANCE_NEXT_v3.md`](../03-rendering-perf/RENDERING_PERFORMANCE_NEXT_v3.md) | **性能契约**（8 个 Phase 的验收标准）；本文是它的"代码现状"侧写 |
| [`RENDERER_SCOPE.md`](./RENDERER_SCOPE.md) | 对外能力边界与兼容性承诺 |
| [`API.md`](./API.md) | 对外方法/选项/诊断字段的完整签名 |
| [`ALGORITHM_REFERENCES.md`](./ALGORITHM_REFERENCES.md) | 各效果的上游来源与许可 |
| [`archive/`](../archive/) | 2026-10-13 架构调整前的旧文档，**不代表当前实现** |

---

## 10. 维护约定

- 本文随**结构变化**更新（新增目录、依赖方向改变、契约变更），不随功能细节更新
- §6 的问题清单在修复后应标注日期与结论，**不直接删除**（保留判断依据）
- 引用代码位置时给出**文件路径 + 行号**，便于核对
