# CCR 代码审查结果

> 依据 `docs/01-architecture/REVIEW_BRIEF.md` 的验收口径执行。
> 审查分支 `codex/antialiasing-recovery-r186`，HEAD `bee30da` + 工作区未提交的 TRAA 改动。
> 本文档为审查结论存档；标注「待验证」的条目尚未取得实测数据，不得当作已确认缺陷使用。

---

## 结论摘要

1. **[高] 开启 TAA 后阴影帧缓存永不命中**：`cameraFrustumKey()` 把 `frustum.xOffset/yOffset` 纳入 key，而 TAA 抖动每帧改这两个值 → `lastFrustumKey` 每帧不等 → `shouldReuseShadowFrame` 在 :85 早退 → 每帧重画阴影。这是**性能问题**（不是画面错误），推翻了「阴影复用率高」的初判。
2. **[中] TAA 深度拒绝的米制阈值在远距离下过于宽松**：`0.02 * expectedEyeDepth` 在 100m 处等于 2m 容差，前景色可能污染远景边缘。
3. **[中] 延迟光照回退只判定 OIT 开关、不知道 OIT 是否溢出**：`scopeReason()` 检查 `!useOIT`，但没有「本帧 OIT 溢出/回退到排序半透明」的判定，属于结论性缺口（`OitCompatibility143` 未核，见「待验证」）。
4. **[中] 遮挡剔除有单元测试、无集成测试**：`tests/rendering/occlusion-culling.test.mjs` 存在（34 行，覆盖投影数学/状态机/安装失败回滚），但没有任何真实场景、dispatcher skip、GPU query poll 的验证。`ARCHITECTURE.md:322` 写的「没有任何测试文件引用」已过期。
5. **[低] Graph 瞬态分配器注入时机**：`VisualPipeline.js:64` 在构造函数即注入，晚于它创建资源的模块才会走别名；目前未发现实际绕过的证据，属需要加诊断的点。

---

## 发现（逐条）

### [高] 阴影帧缓存在 TAA 抖动下永不命中

- **位置**：`src/shadows/DirectionalShadowPass.js:82-102`（`shouldReuseShadowFrame`）、`src/shadows/DirectionalShadowPass.js:57-60`（`cameraFrustumKey`）
- **机制**（这是与初稿不同的正确机制）：
  1. `cameraFrustumKey(camera)`（:57-60）返回 `[near, far, fovy, aspectRatio, xOffset, yOffset].join('|')` —— **把 `xOffset`/`yOffset` 算进了 frustum key**。
  2. TAA 的抖动不改 `camera.viewMatrix`，它写的是 `PerspectiveFrustum.xOffset/yOffset`（`src/antialiasing/TaaJitter143.js:113-118`），再由 `FrustumJitterBridge143` 重新发布到 scene 实际绘制的 clone frustum（`FrustumJitterBridge143.js:60-69`）。
  3. 因此每帧抖动相位变化 → `this.cameraFrustumKey(camera)` 每帧变化 → :85 的 `this.lastFrustumKey !== this.cameraFrustumKey(camera)` 恒成立 → 早退，直接返回不复用。
  4. :93 的 `Matrix4.equalsEpsilon(camera.viewMatrix, this.lastCameraView, 1e-10)` 这条「camera-stable」分支实际上被上面的 key 判定提前挡死，从未有机会成立。
- **为什么是问题**：
  - `DEFAULT_SHADOW_UPDATE_INTERVAL = 2`（:16）想隔帧更新阴影，缓存不命中时这个间隔形同虚设，阴影每帧全量重画。
  - 这是长帧（p99 41.4ms、>50ms 占 0.65%）的可疑贡献者之一，属于 A2「哪条路径在什么条件下分配/释放」需要回答的路径。
- **证据**：
  ```js
  // DirectionalShadowPass.js:57-60
  cameraFrustumKey(camera) {
    const f = camera.frustum
    return [f.near, f.far, f.fovy, f.aspectRatio, f.xOffset, f.yOffset].join('|')
  }
  ```
  ```js
  // DirectionalShadowPass.js:85
  if (this.lastFrustumKey !== this.cameraFrustumKey(camera)) { /* ... return false */ }
  ```
- **建议**：
  1. `cameraFrustumKey` 不该包含抖动偏移；投影相关的缓存 key 应该用「无抖动」的 frustum 参数，或把 xOffset/yOffset 从 key 里移除、只保留 near/far/fovy/aspect。
  2. 另一条独立路径需同步核对：`shadowStatic` 的 `level.cache.signature(level.light.viewProjection, ...)` 未包含抖动偏移 —— 与上面是相反方向的偏差（该失效的地方没失效）。
  3. 修完必须用 `postRender` 间隔 + `frameNumber` 增量双向核对阴影重画次数，不能只看帧率。
- **置信度**：已确认（代码路径明确）。**画面正确性未受影响**，是纯性能缺陷。

---

### [中] TAA 米制深度拒绝在远距离下过于宽松

- **位置**：`src/antialiasing/taaShaders143.js:129` 与 `:260`
- **现象/触发条件**：
  - 两处阈值都是 `max(0.1, 0.02 * expectedEyeDepth)`。
  - 100m 处容差 = 2m：历史深度可以比预期深度远 2m 仍被接受，建筑边缘可能出现前景色「粘」在远景上。
- **为什么是问题**：
  - `PORTING.md` 说明这是 CCR 补充的「米制拒绝」，用于处理 Cesium 对数深度精度损失，**没有上游对照**。
  - three.js r186 原版用归一化深度阈值（0.0005/0.001），不随距离线性增长。
  - `taaShaders143.js:140-145` 的 `taaPerspectiveDepth` 明明已经把眼深转回归一化深度，但米制判定发生在它之前（:129 / :260），没有利用归一化域。
- **建议**：
  1. 分段阈值：近距（<10m）保留 0.02，远距收到 0.005 或加固定上限（如 0.5m）。
  2. 或改到归一化深度域判定，与上游 `u_depthThreshold` 对齐。
  3. 在 `docs/verification/` 补「远景建筑边缘拖影」用例。
- **置信度**：待验证（需 200m 外建筑边缘快速平移的可视化实测）。

---

### [中] 延迟光照回退未覆盖「OIT 容量溢出」

- **位置**：`src/lighting/DeferredGeometry143.js:108-122` 的 `scopeReason()`（实测 11 条判定，委托书说 8 条）
- **现象/触发条件**：
  - 回退条件里有 `!s._environmentState.useOIT`（排序半透明 → 增强渲染），但**只判定开关**。
  - 若 `useOIT = true` 而半透明层数超出 OIT 容量、部分物体回退到排序半透明，延迟路径仍认为「半透明已被 OIT 消化」，这些物体的 GBuffer 深度与真实半透明不一致。
- **为什么是问题**：
  - 该 `scopeReason()` 全部判定都是**静默返回字符串**，不写诊断 —— 运行时无法知道「本帧为什么回退」。
  - `presets.js:26` 默认 `lightingMode: 'enhanced'`，`presets.js:19` 默认 `occlusionCullingEnabled: false`，所以问题不会在默认配置暴露，但一旦启用延迟光照就会踩到。
- **建议**：
  1. 把 `scopeReason()` 的返回值接入诊断（哪怕只是 `stats.lastScopeReason`），这是本项目里成本最低、收益最高的一条改进。
  2. 若 `OitCompatibility143` 能提供溢出计数，把 `|| oitOverflow` 并入该条判定。
- **置信度**：待验证（`src/reflections/OitCompatibility143.js` 本次未读，溢出是否可观测尚无代码依据）。

---

### [中] 遮挡剔除：有单元测试，缺集成测试

- **位置**：`src/visibility/OcclusionCulling143.js`（169 行）、`tests/rendering/occlusion-culling.test.mjs`（34 行）
- **更正**：`ARCHITECTURE.md:322` 与委托书 §4C 说「没有任何测试文件引用」「0 个测试文件」——**已过期**。该测试文件存在，导入 `OcclusionCulling143, { projectOcclusionBounds, acceptOcclusionResult }`，有 3 个用例：相机在球内/穿近平面 fail open、投影保守包住球角（near=9、`area > 0`）、两次同 key 才 hidden 且 stale/visible 复位、安装中途失败要还原 `scene.context.draw` 与 primitives。
- **真实缺口**（不是「零测试」）：
  - 没有测试验证 `acceptOcclusionResult` 与真实 query 时序的配合（`poll()` 的 `pollFrames < 8` 超时后 fail open，`stats.timeouts` 只在代码里累加，从未被断言）。
  - 没有测试验证 dispatcher 的 `skip` 决策真的阻止了 `context.draw`。
  - 没有真实场景验证「保守投影是否真的保守」（委托书说可能与实际遮挡打架）。
  - `setEnabled` 里 `try/catch` 中途失败会 `this.failed = true; this.detach()`，但 detach 之后能否重新启用没有测试。
- **建议**：补一个「一次 dispatch 级」的集成用例（伪造 query 结果，断言 draw 被 skip / 被放过、超时后 fail open），比补 10 个数学用例有用。
- **置信度**：已确认（文件已读）。

---

### [低] Graph 瞬态分配器注入时机

- **位置**：`src/VisualPipeline.js:64`、`src/pipeline/RenderGraph143.js`
- **现象**：`new RenderGraph143` 之后立即 `setTransientAllocator`，而 `setTransientAllocator` 禁止在 `activeFrame` 期间替换。晚于构造函数创建资源的模块正常；早于它的才会绕过别名。
- **为什么是问题**：`resolvePhysicalSlot` 依赖 `this.transientAllocator`，一旦某资源绕过别名就多占一份纹理内存且不报错。
- **建议**：`beginFrame` 时若发现资源被 resolve 但没走 allocator，打一条诊断（不要 throw）；`getDiagnostics()` 里统计「绕过别名的资源数」。
- **置信度**：待验证（未发现实际绕过别名的证据）。

---

## 我无法判断的（需要实测，不能当结论）

1. **PCF 核半径与 `shadowBias143.js` 的 depthBias 是否互相打架**（§4A1）
   - `src/shadowBias143.js` 全文 10 行：`depthBias: 0.0002`、`normalOffsetScale: 0.5`，注释称「Real campus roofs exhibit acne with 0.00002」。
   - PCF 核半径在 JS 层没有定义，应在着色器里硬编码——未定位到具体文件，因此「核半径 vs bias」的冲突判不了。
2. **资源池实际复用率**（§4A2）
   - `RenderTargetPool143.acquire` 按 `JSON.stringify(descriptor)` 匹配未租用/未退役/不在 readers 中的 entry，逻辑本身正确。
   - 但 `allocated` vs `reused` 从未实测；`reused = 0` 会直接导致每帧重建纹理与 GPU stall。
3. **TRAA 在哪些场景失效但不报错**（§4A4）
   - `PORTING.md` 承认透明/蒙皮/实例仍非完整物体运动支持；`TaaMotion143.snapshot` 用 `value.valid = value.frame === frame - 1` 判活，`primitiveKey` 靠 `_sceneGraph._runtimeNodes` 抗 wrapper 重建。
   - `unsupported` 非零时**可见症状是什么**（拖影/抖动/静止残留）未确认。

---

## 与委托书 §5 的分歧/补充

- §5 的「关闭 CCR 环境后 55.4 → 37.6 FPS」：同意「这是替换成本而非环境绝对成本」的定性。**补充**：该结论只在 `scene.skyAtmosphere.show` 被恢复为 true 时成立；对照组应显式记录「CCR env = false **且** Cesium skyAtmosphere = false」，否则基线表会被误读。

---

## 按 §4D 跳过的项

MSAA（`src/antialiasing/settings143.js:36-45` 的 `resolveMsaaPolicy` 仅 `antialiasing: 'msaa'` 生效，且与 TAA 互斥 `TaaPass143.js:273`）、FXAA（`FXAA_QUALITY_PRESET 39` 已最高档，形态学上限）、色调映射（默认 ACES，单独开启不改变画面）——不再重复。

## 未检查的部分

- 大气移植的四个常数修正（§5 称已修正，信任）。
- 云噪声图集精度损失（`volumetricClouds143.js` 用 `mod(point, 64.0)` 把 64 个 Z 切片排进 8×8 图集、特征尺寸再除以 8；§5 记为已知架构债）。
- 夜间无月光（`moon|月光|lunar` 零匹配；Cesium 官方 Moon 只显示月相不照明；§5 记为已知未实现）。

---

## 附录：相对初稿的两处更正

| 项 | 初稿结论 | 更正后 |
| --- | --- | --- |
| 阴影复用 | 「TAA 改 `camera.viewMatrix` 导致 `Matrix4.equalsEpsilon` 永假」 | 抖动只写 `frustum.xOffset/yOffset`（`TaaJitter143.js:113-118`），`viewMatrix` 不变；真因是 `cameraFrustumKey()` 把 offset 纳入 key（`DirectionalShadowPass.js:57-60`） |
| 遮挡剔除测试 | 「完全缺少测试覆盖 / 0 个测试文件」 | `tests/rendering/occlusion-culling.test.mjs` 存在（34 行，4 类断言）；真实缺口是无集成测试，`ARCHITECTURE.md:322` 需更新 |

## 建议的验证顺序（按性价比）

1. 阴影 key 去抖动 → 用 `postRender` + `frameNumber` 增量核对阴影重画次数（可量化，改动小）。
2. `scopeReason()` 结果接入诊断（成本最低的可观测性收益）。
3. 资源池 `allocated/reused` 采样 300 帧（回答 A2 的分配/释放问题）。
4. TAA 远景阈值（需要可视化对照，最后做）。
