# Cesium 可视化渲染管线交接

> 生成 2026-09-09 · 精简 2026-09-15 · 本会话的续接入口。
> **本文只保留结论与指引，完整细节在各轮链接的 `evidence/` 文件中。**
> `plan/` 未纳入 git；开发期临时产物的清理范围见 [CLEANUP_LOG](CLEANUP_LOG_2026-09-15.md)。

**读前必知（下文各轮不再重复）**

1. **路径口径**：各轮沿用当时宿主工程的命令与路径（`ruoyi-ui`、`public/Cesium/`、`src/rendering/cesium/`、`npm run check:cesium`/`build:prod`、`MainMapView.vue`），在本工程**不成立**——见 [抽取说明](../docs/EXTRACTION_HISTORY.md)，命令以 [根 README](../README.md) 为准。
2. **每轮改动均未提交**，全部在 `codex/cesium-visual-pipeline` 的未提交工作区；接手必须携带当前 working tree。
3. **自第 16 轮起，登录业务验收不再作为开发门禁**（用户明确要求）。
4. **30 FPS / P95 ≤ 33.3 ms 门槛除注明外均未通过**；单帧 FPS 或截图不构成性能验收。
5. 未在此列出「已完成」的目标（延迟光照、5000+ 光源、遮挡剔除、完整 GBuffer 等）一律视为**未完成**，逐项判定见 [完成条件审核表](STAGE1_COMPLETION_AUDIT.md)。

## 一、现状速览

| 项 | 状态 |
| --- | --- |
| 工程性质 | 从宿主抽取的独立工程：`src/` 全量算法源码 + UMD `CCR.min.js` |
| Cesium | 仅 `1.143.0`，来自 npm 依赖（宿主原为 `public/Cesium/` 静态发行包） |
| 分支 / HEAD | `codex/cesium-visual-pipeline`，`71098ff`；阶段快照提交 `16b0b8d` |
| 阶段 | **阶段 1 仍 active，主目标未完成** |
| 已具备 | 自定义单方向光阴影（3×3 tent PCF）、PBR 天空/环境/体积雾、调色 API、SMAA+MSAA 策略、共享几何通道、材质 MRT、共享 Hi-Z、SSAO、不透明 SSR、透明逐层反射、UBO、TAA（**仅部分**） |
| 未完成 | 延迟光照与 5000+ 光源/分块剔除、完整 GBuffer（缺 albedo 独立附件与运动矢量）、Globe 原生地形接收阴影、PCSS、云影投地、GI/自动曝光、原生 Water 等材质适配、上下文丢失恢复 |

## 二、轮次明细（新 → 旧）

### 34 · 阶段 1 进度与 SDK 交付
完成条件表已更新、修正过时的 TAA 条目；统一 UMD 阶段 SDK 已构建并验证（SMAA 内嵌、Cesium 外置）。**能力可独立集成 ≠ 延迟照明/5000 光源/遮挡剔除已完成。**
文档：[进度与 SDK](STAGE1_PROGRESS_AND_SDK.md) · [完成条件审核表](STAGE1_COMPLETION_AUDIT.md) · 产物：[SDK 说明](../build/0.1.0/README.md) · [CCR.min.js](../build/0.1.0/CCR.min.js) · [manifest](../build/0.1.0/manifest.json) · [示例页](../build/0.1.0/example.html)

### 33 · TAA 边缘修复
保留受约束的静止轮廓覆盖历史，完善颜色验证足迹与静止积累，加入独立边缘峰值验收。**约 7 万个边缘像素的 A/B：峰值 184 → 22，99 分位 5 → 2**；严格 GPU 回归、384 项 Node、构建通过。不宣称所有场景零闪动。
文档：[TAA 边缘修复交接](evidence/33-taa-edge-handover.md) · 证据：[33-final-files.json](evidence/33-final-files.json) · [33-edge-input.json](evidence/33-edge-input.json) · [33-edge-input-globe.json](evidence/33-edge-input-globe.json) · [33-edge-input-before-environment.json](evidence/33-edge-input-before-environment.json)

### 32 · TAA 模糊与抖动修复（2026-09-12）
正确上传混合 vec4，统一稳定显示网格，加入清晰重建、R32F/Globe 深度与桥所有权修复。384 项 Node、392 哈希、生产构建通过；**同裁剪静态帧差 10.21 → 0.40（降约 96%）**。
文档：[TAA 修复交接](evidence/32-taa-repair-handover.md) · 证据：[32-final-files.json](evidence/32-final-files.json) · [32-taa-failure.json](evidence/32-taa-failure.json)

### 31 · TAA 画质复审（2026-09-12）
复审发现阶段 30 的修复仍存在静止模糊与持续抖动：GPU 读回确认混合 vec4 未上传（两个 shader 全零），固定输出网格缺失。**现有 GPU 通过条件不代表画质通过。**
文档：[TAA 画质复审](evidence/31-taa-quality-review.md) · 证据：[31-taa-bridge-review.json](evidence/31-taa-bridge-review.json) · [31-taa-uniform-read.json](evidence/31-taa-uniform-read.json)

### 30 · TAA 四项审核缺陷修复（2026-09-12）
更正上轮「抖动被 HDR 环境阶段抵消」的错误归因——环境模块从未写入 `xOffset/yOffset`。拆出并修复四项独立缺陷：

1. **抖动未进入实际绘制视锥**：`PerspectiveFrustum.clone()` 在 1.143 不复制 `xOffset/yOffset`，而场景用相机视锥的**克隆**出图。新增 `antialiasing/FrustumJitterBridge143.js` 包装 `uniformState.updateFrustum` 与视锥 `clone`，按每个绘制视锥自身 near/fovy/aspect 重算米制偏移；无法接入时宁可不启用。
2. **`czm_readDepth` 窗口深度被当 clip 深度用**：新增 `taaClipDepth()` 做 [0,1]→NDC[-1,1] 重映射，背景用 `0.999999` 规避 `w=0`。
3. **历史深度混用前后两帧眼空间**：改为与变换后的 `previousEye.z` 比较。
4. **历史颜色实际是 NEAREST**：`PostProcessStage.sampleMode` 改不到 stage 自身输出，改为显式 `Sampler(LINEAR)` 并每帧断言；历史深度保持 NEAREST。

另修掉视锥交还不干净（`detach()` 记录的是已被拷贝抖动值的「前值」，残留约 0.17 像素）。
验证：22/22 Node；`run-performance.cjs taa` 真实 GPU 通过、退出码 0；8 个 Halton 样本逐帧精确命中请求像素（`worstError 5.48e-14`）；**仅扣留亚像素偏移时合成图逐帧比特相同**，开启时均值差 `8.16`。诚实边界：**近平面重归一化路径未在真实场景触发**，仅 Node 单测覆盖；无速度缓冲/Reactive Mask 与动态物体 ghosting 测试。
文档：[阶段 30 交接](evidence/30-taa-fix-handover.md)

### 29 · TAA 审查与白模回退
白模材质/SSR 接入已撤回，TAA 保留并完成审查。审查出工作视锥抖动丢失及 near 缩放、错误深度重建、跨帧眼空间深度比较、历史纹理采样四类问题，**尚不能作为有效抗锯齿验收**。回退后 371 项 Node 及生产构建通过。
文档：[TAA 审查与白模回退](evidence/29-taa-review.md) · 证据：[29-taa-math-review.json](evidence/29-taa-math-review.json)

### 28 · TAA 时间抗锯齿（2026-09-11，结论已被 30 取代）
实现**深度重投影 TAA**（明确不是 UE TSR：不上采样、无速度缓冲/Reactive Mask、不需 compute/subgroup/stencil）。着色、历史缓冲与还原纪律在真实 GPU 跑通，但当时不能让画面抗锯齿，审核表 TAA 仅从「未实现」改为「部分」。

GPU 回归暴露两个 Node 单测看不到的缺陷：①分辨着色器用了 GLSL ES 3.00 保留字 `sample`，真实 WebGL2 编译失败后 pass 静默旁路（已改名 `neighbour` 并补保留字单测）；②亚像素抖动没有进入光栅。**该轮「抖动被 HDR 环境阶段抵消」的结论已在第 30 轮更正，此处仅作追溯。**
文档：[阶段 28 交接](evidence/28-taa-handover.md)

### 27 · 默认配置性能修复与运行时调速器（2026-09-11 18:00）
分支 `perf/stable-30fps`。**出厂默认的性能灾难已定位并修复**：默认 `antialiasing:'smaa'` 且 `msaaSamples:4`，后处理 AA 与硬件多重采样在解决同一个边缘覆盖问题。1920×1080 固定校园全景 60 秒实测：SMAA+MSAA4 的 P95 为 **73.0 ms**，SMAA+MSAA1 为 **20.5 ms**——4×MSAA 在 33.3 ms 预算里吃掉约 40 ms；而阴影仅 3.0 ms、环境 0.37 ms、SMAA 0.19 ms。

修复：新增 `resolveMsaaPolicy` 作为 MSAA 唯一裁决点（后处理 AA 开启时有效多重采样降为 1，仅显式 `msaaCombine:true` 时兑现冗余请求），`antiAliasingDefaults.msaaSamples` 由 4 改为 1。新增 `performance/PerformanceGovernor143.js`：逐帧采样 P95，先降分辨率（-10/-20/-30/-40%）再压阴影（2048→1024），只降不升、禁用精确还原、按需渲染/挂起时不行动。

358/358 Node、392 静态哈希、headless GPU 三模式通过；**同场景同绘制量整帧 GPU 中位由 51.22 ms 降至 8.26 ms**（诊断值）。**无新的正式前台帧率验收。**
文档：[阶段 27 交接](evidence/27-stable-30fps-handover.md) · [性能调速器说明](../src/performance/README.md)

### 26 · 天空曝光与太阳阴影（SCENE-01）
暂停 25B 与多光源。修正天空大气 HDR 亮度、指定树木资产 alpha 裁剪、固定校园阴影锚点的绝对坐标量化。天空恢复蓝色、树冠/树影恢复；**60 帧太阳运动对照中额外中心跳动由最大 0.868 米降至 0，阴影诊断图逐帧差降约 79%**。云形仍与参考图有差距。

核心场景 8 项、旧坡面/阴影/蒙皮、校园联合 15 项、358 项 Node、生产构建、392 静态哈希通过。旧环境 runner 的 1080p 冻结雾检查仍偶发失败（22 像素，最大透射率差 0.00008169），旧锚点也能复现，**根因未定**。
文档：[SCENE-01 交接](evidence/26-scene-handover.md) · [场景/天空/阴影修复记录](SCENE_SKY_SHADOW_REPAIR.md) · 证据：[26-final-files.json](evidence/26-final-files.json) · [26-shadow-regression.json](evidence/26-shadow-regression.json)

### 25A · 基础颜色 / 遮蔽通道验收
核对提交方 15 文件哈希、实际 diff 和 GPU 参考，发现并修正两项标记遗漏：仅在顶点 defines 中的自定义 shader 未被排除、点云改色路径误标标准 PBR。修正后 336/336 Node、albedo GPU 41 项、校园组合 13 项、392 静态引擎哈希、生产构建通过。5/7/8 附件、标准 PBR 参数重建、特殊材质有效性、近远遮挡与生命周期完成本批验收。接口 `setAlbedo({enabled:true})` / `getAlbedoDiagnostics()`，**默认关闭**；原执行回执保留但不替代修正后结论。
文档：[验收结论](evidence/25A/acceptance.md) · [原执行回执](evidence/25A/RESULT.md) · [执行计划](dispatch/25A_ALBEDO_EXECUTION_PLAN.md) · 证据：[25A.diff](evidence/25A/25A.diff) · [validation.json](evidence/25A/validation.json) · [review-validation.json](evidence/25A/review-validation.json) · [initial-source-hashes.json](evidence/25A/initial-source-hashes.json) · [source-hashes.json](evidence/25A/source-hashes.json) · [review-source-hashes.json](evidence/25A/review-source-hashes.json) · 目录：[gpu-final/](evidence/25A/gpu-final) · [original/](evidence/25A/original) · [regression-reflections-final/](evidence/25A/regression-reflections-final) · [regression-transparent-final/](evidence/25A/regression-transparent-final)

### 24 · UBO 实际接入与灯光数据分页基础（2026-09-11 14:14）
相机与反射参数已通过真实 WebGL2 UBO 供 SSR/透明 SSR 使用，两个消费者共享 camera，**合计 192 字节**；未变时不重复上传，单参数更新只传 4 字节。`LightUniforms143` 完成 128 灯/页的布局、世界到眼空间转换、校验和复用，**5000 条点/聚光记录分 40 页 GPU 读回全部匹配**。

**这仍不是 5000 灯延迟渲染完成**：尚无实际分块光源列表、光源管理 API 和延迟照明消费者。322/322 Node、392 静态哈希、UBO GPU 16 项、校园联合 15 项通过；本轮为状态核验与文档补齐，未重跑整套 GPU。
文档：[阶段 24 交接](evidence/24-uniform-buffers-handover.md) · [UBO 计划](UNIFORM_BUFFER_PLAN.md) · [统一缓冲说明](../src/buffers/README.md) · 证据：[24-current-state.json](evidence/24-current-state.json)

### 23 · 透明 PBR 逐层反射与前向混合（2026-09-11）
新增按需第七个不透明颜色附件及透明 signed-delta 通道，保留排序透明与 OIT MRT/multipass 的原生 alpha/层次混合；Hi-Z 未知/透明位分离，防止玻璃层显隐改变其他层反射；补齐 1.143 原生 WebGL2 multipass 缺少输出声明的问题。接口 `setScreenSpaceReflections({enabled:true,transparent:true})`，**默认关闭**。297/297 Node、84 项玻璃场景、校园联合 12 项通过。
文档：[阶段 23 交接](evidence/23-transparent-reflections-handover.md) · [透明反射计划](TRANSPARENT_REFLECTION_PLAN.md) · 证据：[玻璃前后对照图](evidence/23-glass-comparison.png) · [23-source-hashes.json](evidence/23-source-hashes.json)

### 22 · 不透明 SSR 与原生 CubeMap 回退（2026-09-11）
共享材质 MRT 按需增加原生 IBL 镜面/BRDF 响应附件，Hi-Z 透视追踪与边缘约束合成，**未命中保留原生 CubeMap**；SSR→AO→雾云统一 HDR 顺序。接口 `setScreenSpaceReflections({enabled:true,distance:150,thickness:0.5,strength:1})`。259/259 Node、15 项数值 + 23 项反射材质 + 16 项真实镜面场景 + 10 项校园联合检查通过。
文档：[阶段 22 交接](evidence/22-reflections-handover.md) · [SSR 计划](SCREEN_SPACE_REFLECTION_PLAN.md) · 证据：[反射前后对照图](evidence/22-reflection-comparison.png) · [22-source-hashes.json](evidence/22-source-hashes.json)

### 21 · 高空影像灰屏与悬空阴影修复（2026-09-10）
根因：关闭地形深度测试时 Cesium 会清除主纹理中的 Globe 表面深度，体积雾错用地平线平面/背景距离，积分进入地下并产生虚假阴影暗带。现合并本帧 packed Globe 深度与主深度，雾和上采样均在最近有效表面停止；地下/透明 Globe 旁路。**模型高度、影像、云雾参数和建筑阴影算法保持原状。** 218/218 Node、6 组 Globe 深度对照、两种分辨率各 33 项环境检查、11 项阴影检查通过。
文档：[阶段 21 交接](evidence/21-globe-handover.md) · 证据：[前后对照图](evidence/21-globe-comparison.png) · [修复前](evidence/21-globe-before) · [修复后](evidence/21-globe-after) · [21-source-hashes.json](evidence/21-source-hashes.json) · [depth](evidence/21-depth-default-stability.json) · [legacy](evidence/21-legacy-stability.json) · [shadow](evidence/21-shadow-default-stability.json)

### 20 · 透明覆盖与屏幕效果边界
材质布局 V2 增加 R8 覆盖附件和共享 depth/stencil 的覆盖 FBO；透明颜色仍走原生前向/OIT。普通透明模型只让覆盖像素及采样区域旁路 AO，**不再关闭整帧 AO**；复杂原生深度依赖/半透明轮廓等保守旁路，移除对象后自动恢复。216/216 Node；新增覆盖约 **1.98 MiB / 1080p**，材质目标合计 **41.53 MiB**，未宣称整体性能提升。接口无需变更。
文档：[阶段 20 交接](evidence/20-transparency-handover.md) · [透明性说明](../src/channels/TRANSPARENCY.md) · 证据：[20-transparency-validation.json](evidence/20-transparency-validation.json) · [20-source-hashes.json](evidence/20-source-hashes.json)

### 19 · 屏幕空间 AO 与边缘保护 HDR 合成（2026-09-10）
AO V1：复用材质/Hi-Z，半分辨率遮蔽估计、深度/法线双边滤波、边缘约束上采样、保护自发光与 alpha 的 HDR 合成；新 HDR 协调器确保 AO→体积环境→原生 ACES 顺序。接口 `pipeline.setScreenSpaceAO({enabled:true,radius:3,strength:1,bias:0.08})`，默认关闭。208/208 Node、15 项 GPU 数值 + 14 项真实场景检查、21 视锥、10 轮联合生命周期通过。AO 自有约 **37.57 MiB**；短 GPU 诊断 P50 约 **0.66 ms**。**尚未隔离 IBL**；MASK/unlit/custom 跳过，可见透明命令整帧旁路，无时域滤波。
文档：[阶段 19 交接](evidence/19-ao-handover.md) · [AO 说明](../src/ao/README.md) · 证据：[19-ao-validation.json](evidence/19-ao-validation.json) · [19-source-hashes.json](evidence/19-source-hashes.json)

### 18 · 深度契约 V2 与共享 Hi-Z（2026-09-10）
共享深度金字塔，逐层汇总已知深度 min/max、完整覆盖和未知遮挡。材质 eyeDepth 契约升级为**正数=已知距离、0=背景、-1=未知遮挡**，避免未知物体和天空混淆。`pipeline.setDepthPyramid({enabled:true})` 自动请求材质依赖。177/177 Node、42 组 GPU 数值用例逐层逐像素一致、fixture/校园各 2073600 像素深度 CPU 扫描与 GPU 根层一致。1080p 共 **11 层**，新增约 **10.55 MiB**；Hi-Z 短 GPU 诊断 P50 约 **0.12 ms**。未知表面仍无真实距离，下游必须保留负值标记。
文档：[阶段 18 交接](evidence/18-hiz-handover.md) · [深度金字塔说明](../src/channels/DEPTH_PYRAMID.md) · 证据：[18-hiz-validation.json](evidence/18-hiz-validation.json) · [18-source-hashes.json](evidence/18-source-hashes.json)

### 17 · 材质通道 V1 与模型多视锥重放（2026-09-09）
三附件 MRT：**RGBA8 材质法线/粗糙度/金属度、RGBA16F 线性自发光/flags、R32F 米制视深度**，按实际视锥由远到近重放；未知不透明遮挡物将材质写零。接口 `pipeline.setMaterialChannels({enabled:true})` / `pipeline.getMaterialDiagnostics()`。157/157 Node、26 项 GPU 检查、21 个真实视锥、跨视锥未知遮挡及校园 10 轮联动通过；**校园每帧 337 次重放（279 条材质命令、58 条遮挡失效命令）**。1080p 自有目标约 **39.55 MiB**。缺失 albedo 独立附件/运动矢量，**不能宣称完整通用 GBuffer 或延迟照明**。
文档：[材质通道 V1 计划](MATERIAL_CHANNELS_V1_PLAN.md) · [材质通道说明](../src/channels/MATERIAL_CHANNELS.md) · [阶段 17 交接](evidence/17-material-channels-handover.md) · 证据：[17-material-validation.json](evidence/17-material-validation.json) · [17-source-hashes.json](evidence/17-source-hashes.json)

### 16 · 共享几何通道接入与压缩（2026-09-09）
共享几何通道纳入 VisualPipeline：默认关闭、首次启用才创建、专用 set/get 接口、暂停/恢复/销毁联动。首选 RGBA16F 八面体法线 + 双分量深度，保留 RGBA32F 旧布局回退。127/127 Node、100 个 GPU 编码样本、16 项几何 fixture、校园 60 动态帧及 10 轮 HDR/SMAA 联动通过；**最大已测深度误差 0.01171875 米，最小法线点积 0.999995815**；1080p 活动逻辑目标由 39.55 MiB 降到 **23.73 MiB**（减 40%，非整场景显存/帧率结论）。接口 `pipeline.setGeometry({enabled:true,debugMode:'off'})` / `pipeline.getGeometryDiagnostics()`；仍只支持透视 3D 单视锥。

同轮：低角色差定位为天空镜面反射洗白，仅对已核实的 `SM_NH_Terr` / `SM_NH_Building` 默认 IBL 执行 (1,1)→(1,0)，保留天空漫反射。
文档：[共享通道交接](evidence/16-shared-geometry-handover.md) · [视角色差验证报告](evidence/16-view-angle-validation.md) · [共享几何说明](../src/channels/README.md) · 证据：[16-geometry-validation.json](evidence/16-geometry-validation.json) · [16-view-angle-results.json](evidence/16-view-angle-results.json) · [16-source-hashes.json](evidence/16-source-hashes.json)

### 15 · 阶段 0 诊断与性能核验（2026-09-09）
新增显式启用的异步 GPU 计时、CPU 提交/DrawCommand 统计、已知管线纹理去重统计，及逐帧不可逆采样条件门禁；默认画质不变。111/111 Node、GPU 诊断 360 帧/356 查询、钩子恢复与查询释放通过。

**唯一的有效性能样本**：固定南湖全景、1920×1080、SMAA+MSAA1、60 秒、3474 个帧间隔 → **P50 = 16.6 ms、P95 = 20.5 ms**，系统前台 203/203。仅该配置满足 33.3 ms 门槛；FXAA4 前台中断、SMAA4 与构建重叠均拒绝，**不宣布提速比例**。
文档：[阶段 15 交接](evidence/15-performance-handover.md) · [横向增亮验证](evidence/15-horizontal-whitening-validation.md) · [性能诊断说明](../src/diagnostics/README.md) · 证据：[性能审计](evidence/15-performance-assessment.json) · [亮度对照](evidence/15-horizontal-lighting-comparison.json) · [15-profile-summary.json](evidence/15-profile-summary.json) · [15-source-hashes.json](evidence/15-source-hashes.json)

### 14 · 图像质量核验（2026-09-09）
阶段定位：**阴影、环境首版、调色接口和空间抗锯齿已落地，性能与完整业务验收未完成**。103/103 Node、392 静态哈希、生产构建、图像 GPU 30 项及十轮生命周期通过。

新出厂调色：`brightness 1.08`、`contrast 1.1`、`saturation 1.05`、`hue 0`、`exposure 1.6`；固定校园采样平均显示亮度 145.8 → 159.4，标准差 31.4 → 37.3，近满白比例仍为 0；只迁移已知旧默认签名。**性能核验失败**：SMAA `configurationUnchanged=false`（相机由全景变近景），P95 原始值 43.0/42.5 ms 只能排查、不能比较，独立核验 `accepted=false`。
直接入口：`pipeline.getColorGrading()` / `setColorGrading({...})` / `resetColorGrading()` / `setAntiAliasing({mode:'smaa',msaaSamples:4,resolutionMode:'native',resolutionScale:1})` / `getRenderDiagnostics()`。
文档：[图像质量交接](evidence/14-image-quality-handover.md) · [图像控制与 AA 计划](IMAGE_CONTROLS_ANTIALIASING_PLAN.md) · [AA 接口说明](../src/antialiasing/README.md) · 证据：[独立核验结论](evidence/14-performance-assessment.json) · [14-current-state.json](evidence/14-current-state.json) · [14-main-shadow-integration.json](evidence/14-main-shadow-integration.json) · [12-campus-results.json](evidence/12-campus-results.json) · [12-benchmark-results.json](evidence/12-benchmark-results.json) · [12-image-quality-gpu.json](evidence/12-image-quality-gpu.json) · [12-combined-lifecycle.json](evidence/12-combined-lifecycle.json) · 对照图：[AA 关闭](evidence/12-campus-off.png) / [SMAA](evidence/12-campus-smaa.png) / [MSAA](evidence/12-campus-msaa.png) / [FXAA](evidence/12-campus-fxaa.png) · [DPR2 原生](evidence/12-dpr2-native.png) / [CSS](evidence/12-dpr2-css.png) · [调色中性](evidence/12-grading-neutral.png) / [明亮清晰](evidence/12-grading-clear.png)

### 13 · 阴影修复纳入主开发（2026-09-09）
两个会话共享同一工作目录与分支，修复已合入主开发：白墙三角自阴影修复（按接收面深度梯度和实际纹素中心修正 PCF 深度比较）+ 边缘锯齿修复（带纹素内双线性插值的 3×3 tent PCF，4×4 共 16 个唯一纹素采样）；默认 custom 路径直接生效，无需仅在诊断页启用。采样由 9 次增至 16 次，**未重测 60 秒正式性能**，未宣称 PCSS 通过。
文档：[阴影合入清单](SHADOW_FIX_INTEGRATION.md) · [阴影边缘验证](evidence/13-shadow-edge-validation.md) · [阴影 acne 验证](evidence/12-shadow-acne-validation.md) · [阴影说明](../src/shadows/README.md) · 证据：[13-shadow-edge-gpu-results.json](evidence/13-shadow-edge-gpu-results.json) · [12-shadow-gpu-results.json](evidence/12-shadow-gpu-results.json) · [边缘对照](evidence/12-edge-4-before.png)

### 11 · 环境渲染优先阶段（2026-09-09）
用户将优先级调整为环境渲染与偏暗修复，新增《基于 CesiumJS 的高渲染场景方案》为目标参考。环境首版已接入 VisualPipeline/天气入口。

- 实现：真实太阳/PBR 天空光、Rayleigh/Mie 大气、HDR 高度/体积雾、太阳/方向光阴影散射、积云/层云体积步进及云内自遮挡；晴天/晨雾/夕照/层云/霾预设。
- 默认：天空环境图散射 3.2、日间太阳 2.2，曝光仍 1.6；太阳落山后直射为 0。
- 固定校园近景：平均显示亮度 135.82 → 144.93、P10 暗部 93 → 100。正确性：75 项自动测试、33 项 GPU 检查、392 资源哈希、生产构建通过。
- 默认校园多视锥根因是旧 `CloudCollection` 无包围体透明命令；替换后默认 `far=1e10` 恢复单视锥，**并非放宽门禁**。
- 三轮各 60 秒前台采样：全景环境关闭 P95 39.9 ms、均衡开启 42.9 ms、高档天空视角 42.6 ms。**30 FPS 门槛仍未通过**。

文档：[环境验证报告](evidence/11-environment-validation.md) · [环境实施计划](ENVIRONMENT_RENDERING_PLAN.md) · [高渲染参考](evidence/10-cesium-high-rendering-reference.md) · [参考范围补充](evidence/10-high-rendering-target-addendum.md) · [环境说明](../src/environment/README.md) · 证据：[11-environment-gpu-verified.json](evidence/11-environment-gpu-verified.json) · [11-final-captures.json](evidence/11-final-captures.json) · [11-environment-performance.json](evidence/11-environment-performance.json) · [11-environment-high-sky-performance.json](evidence/11-environment-high-sky-performance.json) · [11-artifact-hashes.json](evidence/11-artifact-hashes.json) · [亮度对比图](evidence/11-final-brightness-comparison.jpg) · [最终预设图](evidence/11-final-environment-presets.jpg) · [预设图](evidence/11-environment-presets.jpg)

### 9 · 最小共享几何通道（2026-09-09）
新增独立 `src/channels/ScreenSpaceGeometry143.js`，输出全分辨率米制视深度及重建几何法线，默认关闭、不进入业务管线。42 项 Node、392 个 Cesium 哈希、生产构建通过；当时仅支持 3D 单视锥（默认校园远裁面 1e10 产生两个视锥，通道正确拒绝）。关闭/开启各 60 秒：P50 37.2/37.3 ms、P95 44.8/42.9 ms，活动逻辑目标约 39.55 MiB；**前台审计不满足要求，不计正式性能通过**。
校园模型已复制到 [evidence/campus-assets/](evidence/campus-assets)（见 [manifest](evidence/campus-assets/manifest.json)），可用 `preview.html?assets=…&singleFrustum=1` 复现。
文档：[共享通道最小方案](SHARED_CHANNELS_MINIMUM_PLAN.md) · [本轮验证与截图](evidence/09-shared-geometry-validation.md) · 证据：[09-geometry-performance-reference.json](evidence/09-geometry-performance-reference.json) · [前台窗口](evidence/09-on-window-focus.json) · [非前台窗口](evidence/09-off-window-focus.json) · [09-resume-artifact-hashes.json](evidence/09-resume-artifact-hashes.json) · [校园源图](evidence/09-campus-source.jpg) · [法线图](evidence/09-campus-geometry-normal.jpg) · [08-geometry-gpu-final.json](evidence/08-geometry-gpu-final.json) · [08-geometry-gpu-checks.json](evidence/08-geometry-gpu-checks.json) · [08-geometry-fixture-normal.png](evidence/08-geometry-fixture-normal.png)

### 基线 · 交接时结论（71098ff）
已交付的是与 Cesium 1.143.0 配套的**自定义单方向光阴影基础**，而不是完整的延迟渲染、GBuffer、AO、SSR、体积效果或多光源系统。默认后端已改为 `custom`，支持标准 PBR 的 `Model` / `Cesium3DTileset` 接收阴影。

性能（RTX 3070、1920×1080、南湖固定全景、曝光 1.6、AO 关闭、每轮 60 秒）：

| 方案 | 帧数 | 约 FPS | P50 | P95 | 深度更新 / 命中 |
| --- | ---: | ---: | ---: | ---: | --- |
| 原生单级联 | 1612 | 26.9 | 36.4 ms | 43.2 ms | 每帧更新 |
| custom 逐帧 | 1610 | 26.8 | 36.5 ms | 43.7 ms | 1611 / 0 |
| custom 静态缓存 | 1787 | 29.8 | 33.0 ms | 35.3 ms | 0 / 1788 |

结论：逐帧 custom 与原生基本持平，**未证明逐帧提速**；静态缓存约提升 11%，但只适用于明确静态的资源契约，且 P95 仍高于 33.3 ms 门槛。
文档：[阴影验证报告](evidence/04-custom-shadow-validation.md) · [参考目标](evidence/03-rendering-reference-target.md) · 证据：[初始性能 05](evidence/05-custom-shadow-performance-initial.json) · [最终性能 06（以此为准）](evidence/06-custom-shadow-performance-final.json)

### 未来目标 · 参考资料
- [01 · Cesium/WebGL 融合参考](evidence/01-cesium-webgl-fusion-reference.md)：三条思路——在 Cesium pass 间插入自定义绘制、把外部引擎对象转为 `DrawCommand`、跨引擎共享深度/GBuffer。**概念参考，不是可运行实现或性能证明**。本项目已选第一条的可控变体：保留 Cesium 作为场景所有者，在其命令/后处理边界增加版本限定适配。
- [02 · 自定义渲染参考](evidence/02-cesium-custom-rendering-reference.md)：最终视觉目标（水面/环境反射、自然投影与树冠细节、低空雾与穿林光束、云层、夜景多光源）。演示使用 Cesium 1.123，未给出可复现硬件/资产量/参数，**只能作能力与视觉参考**。
- 阶段方案：[阶段 1 基础渲染管线](阶段1：基础渲染管线.md) · [阶段 2 动态天空系统](阶段2：动态天空系统.md) · [阶段 3 HDR 渲染管线](阶段3：HDR渲染管线.md)

### 已归档的中间轮次（结论已并入上下游，仅留痕）
- **12 · 阴影边缘/acne 专项**：tent PCF 与深度比较修正的验证轮，已合入第 13 轮。
- **10 · 高渲染参考补充**：参考文档与目标范围补充，已并入第 11 轮。
- **执行方式变更**：用户取消双会话委派，25A 起由本会话亲自验收、补测和修正 → [协作约定（历史）](EXECUTION_COORDINATION.md) · [批次状态](execution-state.json)
- **阶段存档提交**：`16b0b8d`（`feat(rendering): 保存 Cesium 渲染管线阶段快照`），共 136 文件，仅本地提交未推送 → [能力与限制快照](../src/STAGE_SNAPSHOT.md)

## 三、代码状态与边界

| 项目 | 已验证状态 | 续接时要注意 |
| --- | --- | --- |
| Cesium 版本 | 仅 `1.143.0`（本工程来自 npm 依赖） | 升级版本前必须重跑渲染回归 |
| 阴影路径 | 自有光源相机、深度纹理/FBO、光源视锥选择、深度 DrawCommand、3×3 tent PCF、PBR 直接光接收 | 自定义路径关闭原生 `ShadowMap`；切到 `native` 才恢复原生方案 |
| 投影物与接收端 | 校园地面、建筑、树木三组瓦片；MASK、双面、实例化、平面裁剪、蒙皮 | BLEND 物体仅能作为受支持的接收端，不能作为彩色/半透明投影物 |
| 静态缓存 | 默认关闭；显式 `shadowStatic: true` 才复用深度 | 原地改纹理、实例缓冲或裁剪纹理后必须 `pipeline.invalidateShadows()` |
| 画面预设 | HDR/ACES、曝光 `1.6`、FXAA 开启、AO/Bloom 默认关闭 | 1.143 原生 AO 未降噪，不能为了「有 AO」默认开启 |
| 已知不支持 | Globe 原生地形接收、多光源阴影、级联自定义阴影、PCSS、体积散射、上下文丢失恢复 | 不要把参考文章能力写成当前已实现能力 |

主要入口（**本工程路径**）：

- [src/VisualPipeline.js](../src/VisualPipeline.js)：创建、启停、参数与资源所有权；`invalidateShadows()` 是静态缓存的业务失效入口。
- [src/shadows/DirectionalShadowPass.js](../src/shadows/DirectionalShadowPass.js)：自定义阴影调度、光源视锥选择、资源生命周期。
- [src/shadows/ShadowReceiver143.js](../src/shadows/ShadowReceiver143.js) 与 [shaderAdapter143.js](../src/shadows/shaderAdapter143.js)：Cesium 1.143 命令/Shader 适配的私有兼容层。
- [src/STAGE_SNAPSHOT.md](../src/STAGE_SNAPSHOT.md)：能力与已知限制快照。
- [docs/API.md](../docs/API.md)：完整对外 API 参考（入口、选项表、诊断键、低层契约、能力边界）。

## 四、检查入口（本工程口径）

```powershell
npm test          # Node 回归（宿主为 npm run test:rendering）
npm run build     # 产出 UMD（宿主为 npm run build:prod）
npm run serve     # 静态服务（宿主为 python -m http.server 8766）
```

浏览器页面：`tests/rendering/preview.html`（真实南湖场景对照与 60 秒采样）、`tests/rendering/shadow-fixture.html`（阴影像素与行为回归）。

`preview.html` 不含登录、底图和业务覆盖物，只能做渲染组件对比。采样前必须等瓦片加载完成；检查结果中的 `valid`、`interruptions`、`configurationUnchanged`、`customStats.error`。**单帧 FPS 或截图不构成性能验收。** 若要恢复 GPU 回归能力，宿主侧 `tests/rendering/run-*.cjs` 等 harness 未随抽取带过来，取材路径见 [抽取说明](../docs/EXTRACTION_HISTORY.md)。

## 五、版本与工作区提示

- 提交链：`5459bb7`（独立视觉模块）→ `c26741c`（减少级联重复绘制）→ `5a51593`（调整曝光并关闭噪点 AO）→ `e5410f7`（阴影职责定义）→ `c393113`（参考路线）→ `71098ff`（custom 阴影与验证）→ `16b0b8d`（阶段快照）。
- **仅检出 HEAD 不包含现有环境/AA/材质/SSR/TAA 等代码**，接手必须携带当前 working tree。
- `plan/` 为本地交接资料目录，未纳入 git（`evidence/` 在 `.gitignore`）；原始会话 JSONL 与开发期临时产物已于 2026-09-15 清理，范围见 [CLEANUP_LOG](CLEANUP_LOG_2026-09-15.md)。
- 原文末尾引用的 `evidence/EVIDENCE_MANIFEST.md` 在本工程中**不存在**，已移除该引用。
