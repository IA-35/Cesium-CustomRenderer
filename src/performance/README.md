# 帧预算调速器（Cesium 1.143）

`PerformanceGovernor143` 在运行时把帧间隔压在目标预算内，默认目标 30 FPS（33.3ms）。它**只降不升**：启用时快照当前配置为基线，所有降级都以基线为准，禁用时精确还原。默认不启用，`VisualPipeline` 保持确定性，便于基准测量；业务侧 `MainMapView` 在创建管线后显式开启。

```js
const pipeline = getVisualPipeline(viewer)
pipeline.setPerformance({ enabled: true, targetFps: 30 })
pipeline.getPerformanceDiagnostics()
pipeline.setPerformance({ enabled: false })   // 精确还原基线
pipeline.setPerformance({ enabled: true, targetFps: 60, minScale: 0.5 }) // 调参键会重建实例
```

## 为什么是分辨率优先

参考机器上固定 1080p HDR 校园视角：整帧 GPU 中位约 51ms，其中阴影 3.0ms、环境 0.37ms、SMAA 0.19ms——主场景填充与 MSAA 解析占绝大部分。这个场景是**填充受限**的，所以按像素数降分辨率是单位视觉损失换回最多时间的杠杆；只有当分辨率触底后，才动阴影贴图这种有明确视觉特征的东西。

## 降级阶梯

| 步骤 | 标签 | 分辨率系数 | 阴影上限 |
| --- | --- | --- | --- |
| 0 | baseline | 1.00 | 基线 |
| 1 | resolution -10% | 0.90 | 基线 |
| 2 | resolution -20% | 0.80 | 基线 |
| 3 | resolution -30% | 0.70 | 基线 |
| 4 | resolution -40%, shadow ≤2048 | 0.60 | 2048 |
| 5 | resolution -40%, shadow ≤1024 | 0.60 | 1024 |

- 阴影占用是**步骤的函数而非粘性的**：恢复到带 cap 的步骤之上会把基线尺寸交还，不会残留小贴图。
- 分辨率按基线比例缩放后夹在 `[minScale, 基线]`，`minScale` 默认 0.6（`normalizeOptions` 下限 0.5）。
- 基线分辨率低于 1 时（业务 `ViewerUtils` 会按 DPR 预降），系数仍在基线以下取值。

## 采样与滞回

- 逐帧记录 `scene.postRender` 间隔，滚动窗口默认 60 帧；丢弃非正或 ≥5000ms 的异常间隔（切标签、断点、resize 卡顿）。
- 每 `evaluateEvery`（默认 30）帧评估一次窗口的 P95：
  - `P95 > target × 1.15` → 降一级；
  - `P95 < target × 0.8` → 连续 `recoverStreakRequired`（默认 3）次评估后升一级；
  - 介于两者之间 → 不动。这个滞回带避免在阈值附近来回抖动。
- 每次调整后清空窗口并进入 `settleFrames`（默认 30）帧的沉降期，避免把重分配的卡顿当成新稳态。
- 调整在 `preUpdate` 里落地、采样在 `postRender` 里进行，保证改动发生在帧之间，不在渲染中途改状态。

## 边界与诚实性

- **不跨基线升画质**：调速器不会把用户设置的画质往上调。用户显式调高后，下一级降级仍从新基线算起。
- **按需渲染下不行动**：`scene.requestRenderMode === true` 时帧间空档是空闲而非帧成本，调速器标记 `on-demand rendering` 并保持静止，不用假样本降级。业务 viewer 目前是连续渲染。
- **挂起/禁用时不行动**：`pipeline.enabled === false` 或存在 `suspensions` 时清窗口、不降级。
- **无法挂载事件时诚实失败**：场景缺 `postRender`/`preUpdate` 时 `enabled` 保持 false，原因 `scene events unavailable`。
- **调整失败可追溯**：`setOptions` 抛错时记录 `adjustment failed: …` 且不把该级记作已应用。
- `destroy()` 先 `detach()`：停止监听并丢弃状态，不向即将销毁的 scene 写入；`VisualPipeline.destroy()` 因此先于其余拆除调用它。

## 基准测量约束

调速器会改变 `resolutionScale`，从而改变 drawingBuffer。基准采样期间必须保持关闭——否则预览页的逐帧配置/缓冲一致性检查会判为无效。`baseline` 模式不会自动启用它。
