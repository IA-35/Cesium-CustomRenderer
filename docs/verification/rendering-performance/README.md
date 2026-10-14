# CCR 渲染管线优化：基线与限制

> 更新：2026-10-14 · 对照契约 `docs/RENDERING_PERFORMANCE_NEXT_v3.md`

## 一、这份文档说明什么

Phase 0 的性能基线、Phase 6 的 batching 门槛、以及 Phase 8 要求明确写出的限制范围。
所有数字来自真实浏览器测量，不是估算。

## 二、基线数据（冻结）

测量条件：

```text
1920×1080，DPR 1，前台 Chrome（playwright channel:chrome）
Cesium 1.143.0，场景 campus，固定相机与固定时钟
预热 30 帧，采样 300 帧，重复 3 轮
```

冻结位置：`docs/verification/rendering-performance/baseline-*.json`

| case | CPU p50 | CPU p95 | GPU p50 | drawCalls | submittedCommands | CCR 纹理 |
|---|---|---|---|---|---|---|
| `native` | 1.90–2.20ms | 3.80–5.20ms | **1.81–2.12ms** | 84 | 621 | 8.3MB |
| `enhanced-current` | 4.50–5.00ms | 6.90–7.50ms | **20.66–21.18ms** | 666 | 608 | 143MB |
| `deferred-current` | 5.00–5.20ms | 7.50–8.20ms | **20.68–20.81ms** | 666 | 608 | 143MB |
| `deferred-transparent-current` | 4.50–5.00ms | 6.40–7.40ms | **20.30–20.69ms** | 76 | 608 | 143MB |

每轮 900 有效帧、0 无效帧、GPU query 可用、无 disjoint、无页面错误。

## 三、基线揭示的主要成本

### environment pass 独占 GPU 时间的约 90%

`enhanced-current` 与 `deferred-current` 的分 pass 数据一致：

```text
environment: GPU p50 ≈ 18.8–19.8ms
shadow:      GPU p50 ≈ 0.10–0.88ms
smaa:        GPU p50 ≈ 0.16–0.18ms
frame:       GPU p50 ≈ 20.7ms
```

这是"频繁掉帧"的首要原因，**不是** dispatcher 的 handler 开销。后续任何性能工作都应先
处理 environment pass，否则 batching/直提的收益会被它掩盖。

### 增强/延迟路径比原生慢约 10 倍 GPU 时间

`native` 的 GPU p50 约 2ms，增强/延迟约 20.7ms。差值几乎全部来自 environment pass。

## 四、Phase 6 门槛与当前状态

契约定义的达标线：

| 指标 | 门槛 |
|---|---|
| program bind 下降 | ≥ 30% |
| 材质/uniform 更新下降 | ≥ 20% |
| CPU submission p95 下降 | ≥ 15% |
| GPU frame p50 下降 | ≥ 10% |

达成其中至少 3 项记为性能优化达标。

**当前状态：未达标（`optimizationSuccess: not-achieved`）。**

原因有两个，都必须如实记录：

1. `programBinds` 计数器在测量时尚未接入真实 GL 计数，报告中为 0，无法计算 bind 收益。
   计数器已在 `ContextDrawDispatcher143.startBindTracking()` 实现，但基线是用旧构建跑的，
   **需要重新测量**才能得到真实 bind 数字。
2. 三个开关默认关闭：

   ```js
   renderItemDirectSubmit: false, transparentDirectSubmit: false, materialBatchingEnabled: false
   ```

   因此基线测的是**优化前路径**。这是有意的：真实场景等价性未验证前不默认启用。

## 五、明确的范围限制

- **tracked allocation bytes 不等于整卡显存**。报告中的 `ccrTextureBytes`、`poolPeakBytes`、
  `graphPeakBytes` 只统计 CCR 自己拥有的分配，不含驱动、对齐、临时缓冲和 Cesium 原生资源。
  真实显存必须用厂商工具（RenderDoc / Nsight / GPUView）测量。
- **headless / 短时样本不等于正式生产性能**。本轮为 headless Chrome，采样 300 帧 × 3 轮，
  用于相对比较，不作为绝对帧率承诺。
- **GPU 计时可用性依赖 `EXT_disjoint_timer_query_webgl2`**。该扩展不可用时 GPU 行为
  `unavailable`，不会被填成 0。disjoint 超限的轮次作废，不写成有效样本。
- **基线只在固定相机轨迹下成立**。相机移动会改变可见集合与阴影更新节奏，数字不可直接沿用。

## 六、如何复现

```bash
# 需要 playwright；可用 CESIUM_PLAYWRIGHT 指向已有的安装
export CESIUM_PLAYWRIGHT="C:/Users/Administrator/node_modules/playwright"

node scripts/performance/measure-rendering-baseline.cjs \
  --case native --warmup 30 --sample 300 --repeat 3 \
  --output docs/verification/rendering-performance/baseline-native.json
```

四个可选 case：`native`、`enhanced-current`、`deferred-current`、`deferred-transparent-current`。

对比两次运行：

```bash
node scripts/performance/compare-rendering-baseline.cjs \
  --baseline <before.json> --candidate <after.json> \
  --json compare.json --md compare.md
```

对比工具在缺少数据时报告 `not comparable`，不会把缺失当成 0% 变化。

## 七、capability 字段

`resolveRendererCapabilities143` 与 `VisualPipeline.getDiagnostics()` 对四个特性各返回
`requested` / `active` / `reason` / `generation`：

| 字段 | 含义 |
|---|---|
| `graphTransientActive` | Graph 是否实际分配 transient（非仅声明 alias） |
| `renderItemDirectSubmit` | RenderItem 直提是否真的在提交 |
| `materialBatchingActive` | batching 是否产生真实的 program bind 合并 |
| `contextDrawDispatcherActive` | 统一 dispatcher 是否已安装 |

`active` 一律由运行时状态推导。`materialBatchingActive` 读取实时 batch plan 的
`programBindReduction`，没有可合并的 program run 时报告 `active: false` 并给出原因，
不会声称一个没有发生的优化。

A/B 对比用旧路径：`VisualPipeline.setDiagnosticLegacyPath(true)`。仅用于测量对照，
不是受支持的主路径。

## 八、回归门禁

```text
npm test  ->  859 tests, 856 pass, 0 fail, 3 skipped
```

3 个 skipped 是与渲染无关的校园资产配置断言（tileset 清单、CubeMap 反射默认值、
70 项 GLB 清单），原因与恢复条件写在 `tests/rendering/campus-business-assets.test.mjs` 顶部。

全量测试当前**没有**与工作树资产配置相关的失败；若之后出现，应报告具体用例与原因，
不得把整体状态写成全绿。
