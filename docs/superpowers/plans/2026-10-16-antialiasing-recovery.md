# 抗锯齿优化：采用 Three.js r186 官方 TRAA

> **For agentic workers:** 使用 executing-plans 按检查点执行。本文件记录定版目标；当前实现与验收状态见下面检查点。

> 执行检查点：本地`codex/antialiasing-recovery-r186`已完成开发及Task4自动化实机检查。原样r186失败后，用户后续明确授权“允许小范围适配，继续达到原画质目标”，据此完成固定网格/历史重建、FP32、局部初始化及深度足迹约束；原样公式仍保留为参考，不伪称当前版本逐公式不变。当前SDK为`6c7c356d...`，未提交或发布，用户最终视觉验收待记录。见[当前状态](../../verification/rendering-performance/traa-r186-2026-10-16/STATUS.md)与[完整适配证据](../../verification/rendering-performance/traa-r186-2026-10-16/ADAPTATION.md)。下文保留最初方案作为目标和沿革，采样/历史接受的偏离以本次后续授权及PORTING说明为准。

**Goal:** 从当前回退版本出发，按 Three.js 官方已发布 TRAA 的完整数据链路改进 TAA，降低车辆与遮挡变化的残影，同时保住窗格稳定性和运动清晰度。

**Architecture:** 唯一算法上游为 Three.js r186 的 TRAANode、TAAUtils 和 VelocityNode。将 TSL 算法适配为 Cesium 1.143 的 GLSL ES 3，复用现有 HDR 接入、jitter bridge、资源管理、UI/selection 隔离和 draw executor；不引入第二个渲染器。

**Tech Stack:** JavaScript、GLSL ES 3、Cesium 1.143、WebGL2、现有 RenderItemExecutor/dispatcher/RHI、Node test、Chrome。

**执行约束：** 直接以当前回退版本为基线，不恢复、不运行撤回版本，不要求复现上次失败。旧文档用于吸取教训；旧代码只选择性复用必要的 Cesium 接入。既有 SMAA/FXAA 保留，本轮集中完成 TAA。

**Lean-mode 执行约束：**
- 直接修改现有 AA 模块、复用现有 motion 接入；不新增通用 AA 框架、策略工厂或独立验收子系统。
- 校验集中在公开配置与 GPU/资源边界；不重复校验已确定的内部数据，不通过宽泛 catch 隐藏 shader 或接入错误。
- 开发中先做相关 JS/GLSL 编译检查，再跑受影响的 AA 用例与必要的实际画面检查；全量验证集中在最终候选，正常一轮一次。
- 保留构建缓存和现有服务；只在页面需要更新 SDK 时构建，不用哈希变化代替运行验证，不反复重读刚修改的文件。
- 若预计新增超过 50 行，先说明预计行数、校验/兜底占比及必要性；每个改动直接对应这次 TAA 移植。
- 质量检查沿用既有工具，覆盖窗格稳定性、运动清晰度和拖影；不扩展为通用基准平台。

## 选型结论与固定版本

采用 [Three.js r186](https://github.com/mrdoob/three.js/releases/tag/r186)，2026-09-24 发布，固定提交：

`9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8`

Playdead 降为算法历史来源，不再整套移植其 2017 示例。Babylon.js、Diligent 的本轮调查用于判断选择，不成为额外算法模块来源。

这里选择的是官方 TRAA，不是 webgl_postprocessing_taa.html 的 TAARenderPass：

| 官方入口 | 核实的行为 | 决策 |
|---|---|---|
| [webgl_postprocessing_taa.html](https://github.com/mrdoob/three.js/blob/r186/examples/webgl_postprocessing_taa.html) / [TAARenderPass.js](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/postprocessing/TAARenderPass.js) | 静止时累积 jitter 样本；源码明确没有重投影，继承 SSAA pass，可按 sampleLevel 多次绘制场景 | 不作为动态校园 TAA 上游 |
| [webgpu_postprocessing_traa.html](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_postprocessing_traa.html) / TRAANode | 颜色、深度、速度输入；历史重投影、有效性、裁剪和加权 | 本轮唯一实现主线；示例名字含 WebGPU，算法 TSL 需转换，不能直接导入 Cesium |

选择理由是已发布代码包含动态重投影、遮挡处理及持续改进的完整链路，且输入输出可与现有管线对应。官方合并记录并不等于在本校园中已经验收。

## 两个 PR 的实际含义

- [#31895](https://github.com/mrdoob/three.js/pull/31895)，2025-09-13 合并：对新显露区域重置累积。作者明确区分了前景污染背景的 smearing 与新显露区域重新积累的 ghosting；前者大幅改善，后者未被该 PR 完全解决。原实现涉及帧间世界位置和深度，不能简化为全屏一动就 reset。
- [#32139](https://github.com/mrdoob/three.js/pull/32139)，2025-10-30 合并：自适应当前帧权重，作者只报告拖影有所减轻，并指出同批其他建议有的无效、有的降低稳定性。
- r186 已继续演进：历史深度转换到当前视图、邻域深度边缘处理、像素速度权重、亚像素相位修正、动态 variance gamma、亮度加权抗闪烁。移植固定 r186 完整实现，不把两个旧 PR 的补丁再叠加一遍。
- 旧撤回报告引用过 Three.js 链接，但旧候选实际采用了自有 5×5/HDR 压缩/YCoCg/reactivity 混合逻辑；“引用过 Three.js”不等于已经按当前官方 TRAA 完整移植。这一点以已检查的旧 shader 内容为依据，无需重新运行它。

## 唯一上游的文件映射

| 固定上游 | 要移植的职责 | CCR 位置 |
|---|---|---|
| [TRAANode.js](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/examples/jsm/tsl/display/TRAANode.js) | resolve、jitter、历史资源与尺寸变化处理 | `src/antialiasing/taaShaders143.js`、`TaaPass143.js` |
| [TAAUtils.js](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/examples/jsm/tsl/utils/TAAUtils.js) | 当前邻域深度、历史深度变换、clipAABB、flickerReduction、Halton | AA shader 及 jitter 适配 |
| [VelocityNode.js](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/nodes/accessors/VelocityNode.js) | 前后模型/相机/投影以及 positionPrevious 的 NDC 速度 | 复用本地 motion 接入，按上游契约生成输入 |

保留 Three.js MIT 许可与具体来源。项目现有 three 依赖是 0.169.0；本轮移植固定上游算法，不以安装/升级 Three 渲染器替换 Cesium。

## 参考代码摘要

以下是 r186 TSL 的 GLSL 概念摘要，不是已编译代码。所有深度必须按上游定义转到可比较的域；不能将 Cesium 眼空间米值与归一化深度阈值混用。

```glsl
// 取当前 3x3 邻域的最近/最远深度；速度来自最近深度对应 texel。
vec2 historyUV = uv - velocityUV;
bool inBounds = all(greaterThanEqual(historyUV, vec2(0.0)))
             && all(lessThanEqual(historyUV, vec2(1.0)));
bool edge = farthestDepth - closestDepth > edgeDepthDiff;
bool disoccluded = closestDepth - previousDepthInCurrentView > depthThreshold;
bool historyValid = inBounds && (edge || !disoccluded);

float motionFactor = clamp(length((uv - historyUV) * resolution)
                           / maxVelocityLength, 0.0, 1.0);
vec2 phase = abs(fract(velocityUV * resolution));
vec2 axisWeight = max(phase, 1.0 - phase);
float subpixel = (1.0 - axisWeight.x * axisWeight.y) / 0.75;
float currentWeight = historyValid
    ? clamp(0.05 + 0.25 * subpixel + motionFactor, 0.0, 1.0)
    : 1.0;
float varianceGamma = mix(0.5, 1.0, (1.0 - motionFactor) * (1.0 - motionFactor));
```

此处 subpixel 对应上游启用 useSubpixelCorrection 的分支。historyValid 中保留深度边缘例外是上游真实逻辑，不得描述成“所有遮挡变化都严格拒绝”；需要检查它在薄窗框和移动轮廓上的实际行为。已知不支持/新出现/全局历史无效还需受 CCR 生命周期门禁约束。

接着按上游对当前 3×3 颜色计算 mean/stddev，形成 mean±gamma*stddev 的盒，用 clipAABB 处理历史；不叠加旧的 5×5 reactivity/长静态历史规则。

最后按 TAAUtils 做亮度加权：

```glsl
vec3 compressedCurrent = current / (1.0 + max(current.r, max(current.g, current.b)));
vec3 compressedHistory = history / (1.0 + max(history.r, max(history.g, history.b)));
float wc = currentWeight / (1.0 + luminance(compressedCurrent));
float wh = (1.0 - currentWeight) / (1.0 + luminance(compressedHistory));
vec3 resolved = (current * wc + history * wh) / max(wc + wh, 1e-5);
```

其中 history 是已裁剪历史。压缩颜色只用于计算权重，输出仍混合原 HDR 颜色；不是先把最终画面 tone map 再做 TAA。亮度函数按固定上游定义展开。

## 本轮必须做的 Cesium 适配

1. **TSL → GLSL ES 3：** 按上游函数逐项转换，记录一致部分与必要偏离。不复制其渲染器、节点构建器和整个 MRT 场景流程。
2. **速度契约：** Three 的 VelocityNode 输出 currentNDC-previousNDC，TRAA 用 (0.5,-0.5) 转 UV 后从当前 UV 减去。CCR 旧候选为 previousStableUV-currentStableUV，不能照搬符号或再翻一次 Y。去除 jitter 对速度的污染。
3. **深度与精度：** 保留 Cesium log-depth 解码。Three 将历史深度经前帧投影/相机变换映射到当前视图；CCR 可用双精度 CPU 计算的相机相对矩阵完成等价变换，避免 shader 在 ECEF 大坐标中损失精度。阈值按相同深度定义处理。
4. **物体运动：** 按前后位置产生速度，先覆盖实际刚体车辆。已有候选的矩阵快照、有效标记、遮挡核对和生命周期可复用；透明/蒙皮/实例化/自定义位移逐类确认，不宣称普通刚体 motion 自动覆盖它们。
5. **采样契约：** 上游当前色和历史色均走其 texture sample 路径；按其 jitter、历史位置和采样器整体接入。不能保持旧坐标算法又只换当前 raw 采样。固定历史网格须经过坐标等价验证。
6. **HDR 接入：** 当前 CCR 的 TAA 已在 tone map 前，因此“改成线性输入”不是新增修复。当前优先级为环境20→Bloom22→TAA25→镜头效果30；Diligent 文档的顺序是 TAA 在 Bloom/DOF 前，不能据此直接认定 CCR 当前错误或贸然重排。主移植阶段保留当前顺序，单独核对 Bloom 开关下输入一致性和效果，只有实际问题才扩大改动。
7. **资源/接口：** 使用现有 ping-pong、HDR coordinator、executor/dispatcher；原生颜色 draw 一次。明确旧 TAA 参数到新实现的映射，不让诊断谎报无效参数。保留 selection/UI 隔离与单一 AA 所有者。

## Task 1：固定上游并对齐数据

**Files:** `src/antialiasing/taaShaders143.js`、`TaaPass143.js`、现有 `taa-jitter.test.mjs` / `taa-reprojection.test.mjs`，AA 文档和第三方许可。

- [x] 保存固定提交、上述三个文件的来源及 MIT 版权。
- [x] 对齐 jitter、NDC/UV、Y 方向、当前/历史深度；用 GPU 实际采样验证每个 jitter 相位、不同深度和相机运动。
- [x] 以当前回退版本为质量对照，不运行撤回候选；验证随着实现推进，不单独恢复旧故障。

## Task 2：接入实际运动输入

**Files:** 选择性复用 `TaaMotion143.js` / `motionShaders143.js` / `taa-motion.test.mjs`，接入 `TaaPass143.js`。

- [x] 校核刚体车辆平移、旋转、纯 Z、启停、出现和遮挡的速度及前后深度；采样多个表面点。
- [x] 对最近深度运动选择，核对选中表面、颜色覆盖和历史深度一致性，防止前景速度污染背景。
- [x] 记录实际支持的 primitive 类型、额外 draw 和显存，保留颜色 draw 恰好一次。

## Task 3：完整移植官方 resolve

**Files:** `taaShaders143.js`、`TaaPass143.js`、`taa-pass.test.mjs`、必要的质量行为测试。

- [x] 按固定 r186 实现历史深度有效性、边缘规则、速度/亚像素权重、variance clipping、flickerReduction。
- [x] 替换旧 resolve 的颜色接受和积累规则，不同时保留旧自定义 reactivity 或相机静止=99.5%历史的规则。
- [x] 测历史失效、遮挡显露、边缘例外、亚像素速度、gamma 端点、HDR 能量、初始化和 resize。
- [x] 不引入其他仓库的滤波/裁剪/锐化候选；任何为 Cesium 必须作的偏离，逐项记录来源和原因。

## Task 4：实际页面验收

- [x] 直接比较当前回退版本与新实现。连续记录窗格、栏杆、屋檐，覆盖完整 jitter 周期、慢转、平移、停止；局部时间序列与细线对比同时检查。
- [x] 检查真实车辆轮廓、显露背景、残影持续时间，相机与物体分别及同时移动；不能仅统计排除边缘后的平坦区域。
- [x] 最终使用实际业务负载，包括已启用的植被、水、云；云独立历史与场景 TAA 分别归因。
- [x] 检查 hover/pick/selection/Label/Billboard、开关/resize/暂停恢复、多视锥 fallback 和资源释放。
- [x] 同硬件同目标分辨率测 AA/motion/整帧 GPU、CPU 提交与显存，图像 readPixels 与性能采样分离。
- [x] 专项和全量 Node 测试、GLSL 检查、构建完成后，在最终 UMD 的实际页面验证，不能只验源码夹具。

预期：保住当前静止窗格稳定性、减少车辆/遮挡变化残影、相机运动不更糊，并使成本可解释。本轮自动化对照数据已见上方报告；停止后的细节恢复并非所有整段时间方差都低于旧版，不承诺全场景零拖影或性能全面提升；官方 PR 的改善也不替代校园验收。

- [ ] 用户在实际使用项目中的最终视觉验收（开发和自动化检查已完成，等待用户体验反馈）。

## 对另外两个引擎的核实（仅作选型说明）

### Babylon.js

固定调查提交 `ac0601c633650d4802c60913a28c854529a259d5`。

[ThinTAAPostProcess](https://github.com/BabylonJS/Babylon.js/blob/ac0601c633650d4802c60913a28c854529a259d5/packages/dev/core/src/PostProcesses/thinTAAPostProcess.ts) 支持可选 per-pixel velocity 重投影和 3×3 clamp；默认 disableOnCameraMove=true、reprojectHistory=false、clampHistory=false。相机移动默认 factor=1，直接偏向当前帧。不能把它概括为“完全没有重投影”，也不能将其默认策略当作持续动态高质量 TAA。

[taa.fragment.fx](https://github.com/BabylonJS/Babylon.js/blob/ac0601c633650d4802c60913a28c854529a259d5/packages/dev/core/src/Shaders/taa.fragment.fx) 核心是可选速度重投影、min/max clamp、factor 混合，没有这个 shader 自身的历史深度拒绝链路。对本项目的完整动态目标，选择 Three TRAA 更直接。

### DiligentFX

固定调查提交 `d27c095aed0942e91b440949e497b08a469e274a`。

[官方 TAA 文档](https://github.com/DiligentGraphics/DiligentFX/blob/d27c095aed0942e91b440949e497b08a469e274a/PostProcess/TemporalAntiAliasing/README.md) 明确面向 WebGL、基于 Emilio López 2022 技术文章，要求当前/历史深度、NDC motion 与线性颜色；建议在 tone map、Bloom、DOF 前执行。

[计算 shader](https://github.com/DiligentGraphics/DiligentFX/blob/d27c095aed0942e91b440949e497b08a469e274a/Shaders/PostProcess/TemporalAntiAliasing/private/TAA_ComputeTemporalAccumulation.fx) 使用逐像素积累权重、YCoCg 方差裁剪、速度驱动 gamma、可选 Catmull 历史采样，内部还会做 HDR/SDR 变换。线性输入不代表所有统计和混合运算都必须在线性域，亦不能单凭这个要求宣称性能提升。

它是完整的现代参考，但移植还涉及 PostFXContext 预处理与历史数据约定。本轮采用 Three 一套实现，不将 Diligent 的权重/裁剪拆出来叠加。

## 技术沿革

Three 的 TAAUtils.clipAABB 直接注明 Playdead 来源；其 variance clipping 引用 Salvi，TRAA 引用 Tardif/Emilio。Diligent 还引用 Karis、Salvi、ReBLUR、Jimenez。现代 TAA 共享这些研究与工程积累，不能从几个实例推断“多数都是 Playdead 的直接改版”。对于本任务，应使用现代引擎集成后的完整实现，而非只退回某个早期示例。
