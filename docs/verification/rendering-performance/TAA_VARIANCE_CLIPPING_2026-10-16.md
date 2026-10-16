# TAA 抗锯齿改进：Variance Clipping

> **日期**：2026-10-16
> **问题**：用户报告 TAA 效果好但**动态拖影**、**转动视角模糊**
> **改动**：以 Intel 的 Variance Clipping 替换原 min/max 单钳制，并引入双 Gamma
> **状态**：代码已落地、测试通过，**但用户实测后认为效果不达标**
>
> ⚠️ **结论修正（重要）**：本文最初把「测试通过 + 截图目视尚可」记为验证通过，这是**错误的判据**。
> 用户在实际使用后反馈**拖影仍不可接受**。本文 §4 的"视觉已验证"因此降级为**"仅在固定观察角度下未发现明显退化"**，
> 不代表问题已解决。后续接手时不要以本文的乐观表述为依据。

---

## 0. 交接摘要（给下一位处理者）

**已经做过的**：

1. 用 μ±γσ 方差 AABB 与邻域 min/max **取交集**替代原来的单 min/max 钳制
2. 双 Gamma：静止 `taaVarianceGammaStill` 1.5、运动 `taaVarianceGammaMoving` 0.75
3. 钳制距离驱动 blend，历史被拉回越远越偏向当前帧

**结论**：方向符合 Intel 文档（其明确称 variance clipping 是"移除拖影的主要算法"），
但**实测不足以解决用户报告的问题**。

**还没做、且更可能是真正瓶颈的**：

- **没有 velocity buffer**。`motion` 来自深度重投影（`taaShaders143.js` 的 `taaEyePosition` + 前一帧矩阵），
  **只对静态几何精确**。动态物体（车流、树木动画）与转动视角时的 disocclusion 拿不到真实运动矢量，
  因此拖影**原理上无法靠调钳制消除**。
- 转动视角模糊的另一半原因是 blend 阈值：`taaVelocityThreshold = 12` 像素偏高，
  整屏移动时单像素 motion 常常低于它，历史权重仍保持在 0.97。

**建议的下一步方向**（未验证）：为 dynamic primitive 输出 velocity，
或改用 SMAA 的 T2x + reprojection（[dmnsgn/shaders-smaa](https://github.com/dmnsgn/shaders-smaa) 有完整实现与权重控制）。

---

## 1. 问题定位

用户的对比截图显示，同一场景下：

| 模式 | 效果 |
|------|------|
| SMAA | 锯齿明显，几乎无效 |
| FXAA | 锯齿明显 |
| **TAA** | **画质明显更好**，但动态拖影 + 转视角模糊 |

**结论**：用户的场景以**亚像素细节**（密集建筑窗格、屋檐、栏杆）为主。形态学方法（SMAA/FXAA）依赖相邻像素的稳定对比，**对不足 1 像素的结构原理上无效**；只有 TAA 的多帧亚像素累积能解决。

**因此方向不是替换 SMAA，而是修复 TAA 的两个副作用。**

---

## 2. 根因

### 2.1 拖影：min/max 包围盒过宽

原实现（`taaShaders143.js` 改动前）：

```glsl
vec3 lower = vec3(1.0e20), upper = vec3(-1.0e20);
for (...) { lower = min(lower, neighbour); upper = max(upper, neighbour); }
...
mix(clamp(history, lower, upper), current, blend)
```

**问题**：只要邻域内出现**一个亮高光或离群像素**，`upper` 就被撑得很大 → **几乎任何历史值都能通过钳制** → 陈旧历史被保留 → **拖影**。

### 2.2 转视角模糊：blend 只看 motion，无钳制反馈

```glsl
float blend = mix(u_taaBlend.x, u_taaBlend.y, clamp(length(motion)/max(u_taaBlend.z,1.0), 0.0, 1.0));
```

**问题**：`taaVelocityThreshold = 12` 像素。**转动视角时整屏像素都在动，但单像素 motion 常常只有几像素** → `motion/12` 很小 → `blend` 接近 `u_taaBlend.x`（0.03）→ **历史权重 97%** → **画面糊**。

### 2.3 权威依据

[Intel TAA 文档](https://github.com/GameTechDev/TAA/blob/main/README.md)：

> **#USE_VARIANCE_CLIPPING - the main algorithm for removing ghosting artifacts.** It calculates mean/standard deviation to build an AABB of expected colour values in the given pixel neighbourhood and then clamp (cheaper) or intersect (better quality) the history colour against it to remove ghosting/too bright pixels.
>
> AABB min/max is calculated: **mean -/+ Gamma * standard_deviation**. Larger Gamma improves temporally stable results but **may increase ghosting** hence **a confidence factor is used to lerp between stability and anti-ghosting**. The confidence factor is **built from the velocity of the current pixel and its depth difference between frames**.
>
> **The variance clipping should always be enabled** in either option because **this is the main solution for ghosting artifacts**.
>
> **Gamma is controllable using two values: MIN_VARIANCE_GAMMA and MAX_VARIANCE_GAMMA. The former is used during movement and the latter on still image. The ratio between them is calculated using the motion vector.**

---

## 3. 实现

### 3.1 Variance Clipping（替换 min/max 单钳制）

关键点：**取方差 AABB 与邻域 min/max 的交集**，而不是二选一。

```glsl
// 复用 reconstruction 已有的 25 次 fetch，同时累计一阶/二阶矩
for (int y = -2; y <= 2; ++y) for (int x = -2; x <= 2; ++x) {
    vec3 neighbour = texelFetch(colorTexture, ...).rgb;
    lower = min(lower, neighbour); upper = max(upper, neighbour);
    moment1 += neighbour;
    moment2 += neighbour * neighbour;
    ...  // 同时用于 Catmull-Rom 重建
}
const float NEIGHBOURHOOD_TAPS = 25.0;
vec3 mean = moment1 / NEIGHBOURHOOD_TAPS;
vec3 sigma = sqrt(max(moment2 / NEIGHBOURHOOD_TAPS - mean * mean, vec3(0.0)));
```

```glsl
float varianceGamma = mix(u_taaVariance.w, u_taaVariance.z, motionConfidence);
vec3 varianceMin = mean - varianceGamma * sigma;
vec3 varianceMax = mean + varianceGamma * sigma;
vec3 clippedHistory = clamp(history, max(varianceMin, lower), min(varianceMax, upper));
```

**为什么取交集**：
- **sigma 的作用**：拒绝 min/max 会容忍的离群值（治拖影）
- **min/max 的作用**：当 sigma 在均匀邻域上塌缩为 0 时，仍有硬边界兜底

**代价**：`moment1`/`moment2` 复用已有 fetch，**无额外纹理采样**，只增加约 6 次向量运算 + 一个 `sqrt`。

### 3.2 双 Gamma（运动/静止区分）

```javascript
// presets.js
taaVarianceGammaStill: 1.5,     // 静止：宽盒，画面稳定
taaVarianceGammaMoving: 0.75,   // 运动：窄盒，压制拖影
```

```javascript
// TaaPass143.js 导出，供预设校验与诊断
export function taaVarianceGammas(settings = {}) {
  return [0, 0,
    clamp(settings.taaVarianceGammaStill ?? 1.5, 0.25, 4),
    clamp(settings.taaVarianceGammaMoving ?? 0.75, 0.1, 3)]
}
```

**运动值取 0.75（< 1）**：运动像素的历史必须落在当前邻域约 1σ 内。静止值可 > 1，因为静止相机没有拖影需要权衡。

### 3.3 拒绝反馈（钳制距离驱动 blend）

```glsl
float rejection = length(clippedHistory - history);
float rejectionScale = 1.0 / max(length(upper - lower), 1.0e-4);
blend = mix(blend, 1.0, clamp(rejection * rejectionScale, 0.0, 1.0));
```

**含义**：历史被拉回得越远，说明它对这个像素的估计越错（正是 disocclusion / 运动几何的情况）→ **越偏向当前帧**。这是 Intel "confidence factor" 思路的直接应用。

---

## 4. 验证

> **这一节只证明"没有改坏"，不证明"问题已解决"。** 下列截图与数字均由本人在单一测试视角下采集，
> 用户实际使用后判定拖影仍不可接受。请以用户结论为准。

### 4.1 回归检查

| 项 | 结果 |
|---|---|
| 全量测试 | **1005 项，1002 通过 / 3 跳过 / 0 失败** |
| TAA 专项 | 28 项全过（含新增的 variance gamma 断言） |
| 静止画面 | 固定视角下未见退化（`aa-D-taa-variance.png`） |
| 运动画面 | 固定轨迹下未见明显糊化（`aa-E-taa-variance-moving.png`）——**与用户实测结论不一致** |

### 4.2 运行时参数实测

```
variance: [0, 0, 1.5, 0.75]      ← 静止 1.5σ，运动 0.75σ，符合设计
blend:    [0.03, 0.5, 12, 0.1]   ← 未改动的原有参数
historyValid: true
```

### 4.3 构建产物

SDK 重建完成：`CCR.min.js` sha256 `e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`

---

## 5. 未解决

| 项 | 说明 |
|---|---|
| **无 velocity buffer** | `motion` 仍来自深度重投影，**只对静态几何精确**。动态物体（车流、树木）的拖影只能缓解，不能根治。根治需为每个 dynamic primitive 输出运动矢量。 |
| **SMAA/FXAA 未改进** | 按 §1 的分析，亚像素细节超出形态学方法的能力。用户可以继续用 TAA。 |
| **SMAA blend 的 gamma 往返已移除** | 本次同时删掉了 `smaaShaders.js` blend 阶段的三次 `pow(2.2)`。输入已是 tone-mapped gamma 空间，而 `SMAA_THRESHOLD` 也按 gamma 空间标定，原先的线性往返会削弱混合强度。**该改动本身逻辑正确，但在测试视角下未产生可见差异**，不能声称解决了 SMAA 的问题。 |
| **性能未测** | 新增约 6 次向量运算 + 1 次 `sqrt`/像素，`variance` 计算复用了已有 fetch，但**未实测帧时间**。按 MEMORY 约定，性能结论必须给 p90/p99。 |

---

## 6. 复现入口

```bash
node scripts/dev-server.cjs --port 8878
node scripts/build-rendering-sdk.cjs          # 改 src 后必须重建，示例加载的是 CCR.min.js
# http://127.0.0.1:8878/examples/campus.html?traffic=none&grass=none&water=none&imagery=none&singleFrustum=1
```

**关键坑**：`examples/campus.js:11` 加载的是 `build/0.1.0/CCR.min.js`（UMD 产物），**不是 `src/`**。改 `src/` 后不构建，浏览器里运行的仍是旧代码——本次排查中曾因此误判"改动未生效"。

---

## 7. 参考

- [Intel TAA（Variance Clipping 权威说明）](https://github.com/GameTechDev/TAA/blob/main/README.md)
- [Alex Tardif: Temporal Antialiasing Starter Pack](https://alextardif.com/TAA.html)（μ±γσ 公式与 `clip_aabb`）
- [FlaxEngine TAA.shader](https://gitlab.flaxengine.com/Flax/FlaxEngine/src/commit/1bd7210107069270c419a62ab8a4642540f9b367/Source/Shaders/TAA.shader)（`ClipToAABB(history, neighborhoodMin - aabbMargin, neighborhoodMax + aabbMargin)`）
- [The Code Corsair: Temporal AA and the Quest for the Holy Trail](https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/)（blend factor attenuation）
- [PSMAA](https://github.com/RdenBlaauwen/PSMAA)（评估后未采用：ReShade HLSL，治低对比度漏检而非亚像素细节，beta 状态）
