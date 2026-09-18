# CCR 整体渲染管线审查 · 2026-09-18

## 范围和结论

仅审查 `cesium customRenderer` 项目：当前工作区源码、项目内测试/示例、vendor 运行时、构建包和阶段文档。**不包含 ruoyi-ui、业务接入代码或业务 Cesium 核心补丁。** 基准提交 `e09bbc277f91240507ad694cf96a79d8fd820633`，分支 `codex/stage1-b07-b12`；结论针对含未提交修改的工作区，不等于该提交自身的结论。

**结论：确认 7 项问题，2 项 P1、5 项 P2；不能签署整体审查通过。** 基础效果、帧桥和多项资源生命周期检查通过，主要缺陷集中在效果组合的回退、TAA 的对象分类、诊断真实性及实例集合的加载/预算语义。

本轮没有修复生产源码、没有更新 golden、没有提交或推送。新增审查报告和本地审查探针。审查期间并行植被工作修改了草地和 vendor 文件，末轮重新核对了这些文件、实例探针和测试；未将初次发现的过期产物继续列为最终未修缺陷。

## R1 · P1：景深缺失深度会连带跳过自定义色调映射

位置：`src/stages/LensEffectPipeline143.js:54`、`:136`、`:301`。

选择 `toneMappingCurve: 'unrealFilmicApprox'` 并开启景深后，管理器持续关闭 Cesium 原生 tonemapping。但 `scopeReason()` 一旦发现景深没有米制深度，会让整个 `_execute()` 直接返回，包括不依赖深度的自定义 tone stage。

**真实 GPU 复现**：四个 PBR 模型，正常 3D 下连续十帧原生 tone 执行 0 次、自定义执行 10 次；随后调用 Cesium `morphTo2D(0)`，材质深度因不支持此模式退出。稳定后的十帧两种 tone 均执行 **0 次**，原生仍 `enabled:false`，原因是 `Metric depth unavailable`，没有页面异常。HDR 颜色失去应有的映射/显示编码，造成突变与曝光错误。

建议：色调映射与景深的可用性拆开判断。景深失败只跳过景深；自定义 tone 当帧未执行时必须保持有效的原生回退。验收应覆盖深度暂未就绪、2D/正交、材质通道失败，以及整个链路恰好执行一次 tone，而不只测试正常 3D。

## R2 · P1：TAA 的 UI 分层误接管真实粒子

位置：`src/antialiasing/TaaOverlay143.js:24`、`:60`。

`isOverlay()` 把所有 BillboardCollection 都当成屏幕 UI。Cesium ParticleSystem 内部也使用 BillboardCollection，因此火焰、烟雾等世界空间粒子被一并从原主颜色路径移走，直到 TAA 之后才绘制。环境、雾和 HDR Bloom 都在 TAA 之前运行，粒子因此失去这些处理。

**真实 GPU 复现**：创建 ParticleSystem，100 个粒子、2 条命令均被判为 UI；开启 HDR Bloom 后，整帧 RGB 总和为 **109944**。只对该 ParticleSystem 排除 UI 分类、保持 TAA/相机/时间/效果参数不变，恢复正常 HDR 处理后总和为 **316479**。两个路径均无渲染异常。此数据证明分类改变了可见效果，不是以“画面变化”作为 AA 通过标准。

建议：复用已有 `TransparentForward143.family()` 的粒子识别思路，区分 POI 与世界空间 billboard/粒子；必要时提供明确的 UI 标记。粒子继续参与原 HDR 链，UI 才后置。补充“POI 不拖影”和“粒子仍有 Bloom/雾”组合回归。本项属于上一轮 TAA 修补的新覆盖范围问题。

## R3 · P2：环境 pass 退出后，旧介质纹理仍报告为本帧有效

位置：`src/environment/HdrEnvironmentPass143.js:93`、`src/environment/EnvironmentRenderer.js:244`。

环境 pass 在不支持的视图中将 `_valid` 清零并旁路，但介质 getter 只检查 stage/纹理存活及 `occlusionReason`，没有检查当帧是否真的执行、HDR pass 是否有效。镜头光柱/光斑随后继续消费旧纹理。

**真实 GPU 复现**：第 64 帧环境和介质均有效；改用正交相机并渲染十帧，第 74 帧 HDR 已明确返回 `requires perspective camera`、`valid:false`，介质仍 `valid:true` 且返回完全相同的旧纹理，镜头效果也报告有效。切换视角时可能读到旧遮挡和透射率。

建议：记录介质的 `outputFrame/generation`，每帧执行前失效，旁路/未就绪/失败时返回无效；消费者按同帧契约取数据。补充透视→正交、多视锥、地下相机和再恢复测试。

## R4 · P2：能力矩阵的 effectiveMode 与实际延迟渲染相矛盾

位置：`src/diagnostics/capabilityMatrix143.js:164`、`:176`；调用方 `src/VisualPipeline.js:716`。

诊断把“可作为候选默认模式的覆盖门槛”当作“当前实际运行模式”。只要 SSR 没开，`coverage.ssr=false` 就令它报告 enhanced，但实际显式启用的延迟路径可以正常执行。

**真实 GPU 复现**：`lightingMode:'deferred'`、SSR 关闭，延迟模块 `valid:true / activeMode:'deferred'`，58 帧共执行 232 次光照绘制，原生受支持颜色绘制为 0；同时能力策略却报告 `active:false / effectiveMode:'enhanced'`，原因是 SSR 覆盖不足。

建议：将候选默认资格与实际模式拆成不同字段，实际模式来自当帧生产者诊断及真实回退原因。不能用必需手动开启的独立效果来否定已执行的延迟模式。

## R5 · P2：树集合把“进入可见范围”错误地作为资源加载完成条件

位置：`src/instances/FixedTreeCollection.js:123`、`:131`。

`_waitForAssets()` 要求 `cachedCommandCount > 0`。上游运行时只为可见或预加载范围内的记录构建命令，所以模型/纹理已完成但镜头没朝向树林时，readyPromise 仍不结束，90 秒后还会按加载错误清理集合。草地集合已移除此条件，树集合仍保留。

**实际方法控制探针**：`gltfRecordsBuilt:true`、`pendingTextureCount:0`、`cachedCommandCount:0`，触发 postRender 后 promise 保持未解决。源码交叉核对：EzTreePrimitive 的 `processVisibleRecord()` 在范围外直接返回，不调用命令构建。

建议：ready 只依赖资产完成/失败；可见命令数单独用于呈现诊断。补测离屏加载、隐藏加载、远景开始加载，以及资产完成后转入视野。该项没有伪称已跑满 90 秒或在目标设备做过完整树林验收。

## R6 · P2：草地 maxInstances 不构成上限

位置：`src/instances/GrassCollection.js:148`、`:155`。

总预算先取 min，但每个面独立四舍五入，并强制至少生成一簇；没有扣减剩余预算或最终上限检查。小面多时总数会突破配置，density=0 也会生成草。

**实际方法＋确定性采样器探针**：25 个等面积面、`maxInstances=10`，方法请求并收集 **25** 个实例；density 改成 0 后仍为 **25**。这是预算分配逻辑证明，不是 GPU 负载测量。

建议：用总量受限的整数份额分配或剩余预算；总预算为 0 时提前返回。若希望小面保底，必须在总预算内重分配。验收覆盖面数量超过实例预算、舍入误差、零密度和不同面积比例。

## R7 · P2：合法的无 Globe Viewer 无法创建管线

位置：`src/VisualPipeline.js:122`。

Cesium 支持 `new Viewer(...,{globe:false})`，可用于纯模型场景。但管线初始化无条件写入 `scene.globe.enableLighting`，没有能力分支。

**真实浏览器复现**：合法无 Globe Viewer 调用 `createVisualPipeline()`，直接抛出 `Cannot read properties of undefined (reading 'enableLighting')`。这不只是关闭一个 Globe 效果，而是无法创建整个管线。

建议：所有 Globe 依赖效果明确检查对象，纯模型场景继续启用可支持的 HDR/AA/模型效果；如确有不可支持的路径，报告具体能力原因。补测 `globe:false` 与 `globe.show=false`，两者不能互相替代。

## 已通过的检查及审查覆盖

| 模块 | 本轮证据 / 当前判断 |
| --- | --- |
| 帧桥、透明合成接点 | 现有 B01 GPU 脚本七种情况通过：MRT、MSAA4、multipass、多视锥、排序透明、无玻璃、UMD。桥支持不等于所有延迟消费者也支持这些模式。 |
| 材质 MRT / Hi-Z / 延迟光照 | 核对生产/消费及回退链；四 PBR 模型延迟实际执行有效。诊断矛盾见 R4；TAA/MSAA/排序模式仍有明确 enhanced 回退。 |
| SSR / Primitive / 水面适配 | 现有表面 GPU 检查通过：10800 像素表面标记、0 像素误标 STANDARD_PBR、0 无效深度、SSR 有效。未据此推断所有动态水法线组合已验证。 |
| SSAO / HBAO / HDR Bloom | 合成数值检查分别 17 / 17 / 8 项通过。 |
| 天空、云、噪声、雾 | 场景检查及缩放通过；噪声 12288 样本最大误差约 1.27e-6。介质同帧契约存在 R3；多视锥透明分段介质仍是既有缺口。 |
| 阴影 / UBO / 资源池 / 遮挡剔除 | 检查提交、所有权、缓存和资源传递的关键实现；本轮单测覆盖相关模块。未重新认证太阳全时段稳定性或任意大型场景性能。 |
| AA / UI / 镜头效果 | 核对 TAA 采样时序、UI 合成、ID 绘制、空间 AA 与镜头处理；确认 R1/R2。 |
| 生命周期 / context loss | 20 轮启停资源两半峰值均 2046080 字节；嵌套暂停通过。浏览器恢复事件出现，但旧 Viewer 不自动恢复；显式重建后模型颜色与 picking 恢复。 |
| 实例化树草 | 复核加载就绪、预算与 vendor 产物；确认 R5/R6。没有修改或接管并行植被开发。 |
| 版本与文档 | 末轮构建 manifest 的已有 sourceHashes 与文件一致；当前验收主文档仍有旧状态，见下文。 |

`check-stage1` 的场景/UMD 各 29 项检查通过，801×603 和 1280×720 重建正常，0 页面异常、0 HTTP 错误。该小型夹具的 GPU 采样不是整场景性能认证。

## 测试和产物状态

- 末轮直接执行全部 Node 测试：**683 项，681 通过、2 失败**。失败均在 `campus-business-assets.test.mjs`，硬编码旧端口 `localhost:9528` 与 SSE=128，与当前示例不符；应单独修整测试，不把它们悄悄改成通过。
- 初轮第三项失败 `groupGrassAssets is not a function` 来自未同步的生成运行时。在审查目录隔离重建 vendor 后，相关 5 项测试通过，证明该次失败是预构建产物问题。随后并行开发重建了真实产物，末轮该失败也已消失。审查没有覆盖或回写生产 vendor。
- 初轮 UMD 哈希 `4e37f3fb...` 与草地源码不一致；末轮 UMD 已由并行开发更新为 `7e1272161f8a3720c145b2ef3e034d9ed1e1cc6346caa12e641af70b8080696f`，manifest 现有 sourceHashes 检查无差异。历史不一致保留在证据，不作为最终未关闭缺陷。
- `docs/STAGE1_ACCEPTANCE.md` 仍称 B10 整批未实现、仍写恢复事件不触发，并保留旧 SDK 大小/哈希；这些不能代表当前状态。`docs/API.md:342` 的三级阴影 24MiB 示例也未说明必须同时将 shadowSize 设为 2048；只切 cascades=3 且保留默认 4096 时实际为 4096²+2048²+2048²，即 **96MiB**。需要统一维护当前状态与历史证据。

## 整体成熟度与修复顺序

当前是可运行的增强渲染 SDK，并已有可用的标准 PBR 延迟闭环，不是原始阶段一全部目标都已完成的统一默认延迟渲染器。默认仍为 enhanced；MSAA/TAA/排序透明的完整延迟接管、多视锥透明介质、部分画质矩阵与正式性能对照仍未闭环。B13 多光源仍按既有指示暂缓。context loss 的已验证出口是显式重建，不能称自动恢复。

建议先修 **R1/R2** 的画面正确性，再修 **R3/R4** 的同帧数据和诊断，再处理 **R5/R6/R7** 的生命周期、预算和场景通用性；最后统一文档/构建状态并复跑组合矩阵。当前证据不足以承诺任意设备、任意场景稳定 60fps，不能把增加更多效果当作收口。

## 复现资料

项目内本地目录：`docs/verification/pipeline-review-2026-09-18/`。

- `snapshot.json`：初始源码指纹。
- `probes.cjs` / `probes.json`：真实浏览器负例（独立 stock Cesium 1.143，无业务项目）。
- `cpu-probes.mjs` / `cpu-probes.json`：实例集合控制探针。
- `run-existing.cjs`：只重定向已有检查的证据目录，检查逻辑不变。
- `stage1.log`、`bridge.log`、`ssr.log`、`lifecycle.log`、`unit-final.log`：本轮执行日志。
- `check-vendor-build.cjs`：在审查目录重建运行时并复测，不覆写生产 vendor。

运行探针前，在本项目启动 `node scripts/dev-server.cjs --port 8894`；浏览器工具通过 `CESIUM_PLAYWRIGHT` 指定已安装 Playwright。已有检查设置 `CCR_TEST_PORT=8894`。审查结束关闭了本轮启动的临时服务。
