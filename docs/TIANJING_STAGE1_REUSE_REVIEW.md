# TianjingMap3D 源码对阶段一的参考与复用审查

日期：2026-09-14。范围：阶段一基础渲染管线；植被暂缓，多光源只审查，不恢复开发。

参考工程：`G:/_JavaScript/新版cesium示例/tianjingmap-3d`，Git HEAD `158a423`。
目标工程：`G:/_JavaScript/_IAsCesiumLib/cesium customRenderer`，本次读取的 CCR 基线为 `b2b182e`。
目标依据：原宿主 `plan/阶段1：基础渲染管线.md`。文档中的勾选及宣传描述只作为目标，不等于源码已实现或已验收。

## 结论

有实质复用价值。优先提取 HBAO 地平线搜索、HDR Bloom 多尺度滤波、球壳云层求交/步进和小型后处理 shader；保留 CCR 的材质数据契约、资源所有权、HDR 调度与 1.143 适配。

不建议整体替换成 TianjingMap3D。其插件和修改后的 Cesium 1.118 构建紧密配合；部分关键补丁仅在 Build 文件存在。现有“延迟光照”不是完整的 PBR 延迟渲染，“遮挡剔除”和“5000+ 光源高性能”也不能由当前源码直接证实。

本轮只阅读、静态核对和编写本报告，没有迁移运行时代码，没有更改参考工程，没有运行其业务示例进行画质或性能验收。

## 1. 源码与引擎完整性

对 `src` 全部 62 个 JavaScript 文件做 Babel 语法解析及相对导入检查：解析错误 0，114 条 import 中缺失的相对依赖 0。此结果不验证 shader 编译、运行时全局依赖、网络资产或视觉正确性。

`src/index.js` 导出的是插件模块对象。主要阶段一实现位于 `src/tianjingmap3d/CesiumEffectPipeline/`；环境贴图与天空盒还位于 `PluginBase/`。`package.json` 未配置有效自动测试；README 示例不能替代实际调用链。

示例引用 `Cesium-1.118/Build/CesiumUnminified/Cesium.js`，该文件版本头和 VERSION 都为 1.118。本次全文核对发现：

| 定制点 | Build 中位置 | 对应 engine/Source 检索 | 含义 |
| --- | --- | --- | --- |
| ShaderProgram UBO 接口 `initUniformBufferBindPoint` | 74391 附近 | 无同名实现 | 插件的 UBO 绑定依赖定制引擎 |
| `_worldENU` | 186588、187721 附近 | 无同名实现 | 若干环境/材质方向计算依赖新增 uniform 状态 |
| `customShadowShaderVS/FS` | 212928 附近 | 无同名实现 | 自定义物体阴影回调不是原生通用契约 |
| `_czmRenderGBufferPass` | 227068 | 无同名实现 | G-buffer 默认 pass 配置来自引擎扩展 |
| `taa.resetProjection(uniformState)` | 228525 | 无对应调用 | TAA 抖动插入到引擎的视锥绘制循环 |

这些补丁可读、可研究，但不能仅复制插件 `src` 或从随包 engine/Source 重建就认为获得了相同功能。当前 CCR 的 Cesium 1.143 不应被整份旧 Build 覆盖。

## 2. 阶段一能力映射与取舍

表内路径均相对参考工程 `src/tianjingmap3d/`；“复用”表示候选，尚未经过 CCR GPU 验证。

| 能力 | 已读到的实质实现 | 与 CCR 对比 | 建议 |
| --- | --- | --- | --- |
| HBAO | `CesiumEffectPipeline/Library/hbao/ambientOcclusionGenerate.js` 的方向步进、最大地平线更新；`shader.js` 的法线重建和交叉双边滤波 | CCR 当前为方向采样 SSAO，有半分辨率、有效性和透明覆盖处理 | **优先迁移算法核**，继续使用 CCR 数据与滤波契约 |
| HDR Bloom | `HDRBloomEffectPass.js`：13-tap 降采样、逐级上采样、HDR 截断与合成 | CCR 使用原生 bloom，没有同类自有多尺度 Bloom 链 | **优先适配滤波链**，接入现有 HDR coordinator |
| 全球云层 | `mergeShader/common.js` + `volumetricClouds.js`：球壳求交、云内外分支、粗细步进、透射率早退 | CCR 是校园局部 ENU 云层 | **高价值扩展参考**，先验证球壳边界，不整体搬环境管理器 |
| 高度雾 | `mergeShader/heightFog.js`：指数密度解析线积分及近零 Taylor 分支 | CCR 已有受阴影影响的局部体积雾积分 | 作为无噪声/无体积阴影的低成本质量档候选，不替代现有完整路径 |
| 光斑、光柱 | `mergeShader/lensFlare*.js`、`volumetricLights.js`：光斑图案、太阳屏幕位置及径向采样 | CCR 有雾中阴影可见性，缺少同类独立镜头装饰效果 | 可提取小 pass；明确屏幕空间光柱与体积散射的区别 |
| 移轴 | `TiltShiftEffectPass.js`：横/纵两次焦带高斯模糊 | CCR 尚无该效果 | **最容易隔离的小型复用项**，优先级低于 AO/HDR 质量 |
| SSR | `SSREffectPass.js`：屏幕射线遍历、厚度、粗糙度扰动、过滤、CubeMap 分支；`SSR2EffectPass.js`：较简化的 64 步追踪 | CCR 已有 Hi-Z、PBR 反射响应、未知遮挡拒绝、透明 SSR | 借鉴反射过滤与环境回退，保留 CCR 的 trace/resolve 基线 |
| TAA | `TAAEffectPass.js`：Catmull-Rom 历史采样、YCoCg 包围盒裁剪、深度/亮度判定、抖动滤波权重 | CCR 已有稳定网格、Catmull-Rom 当前样本重建、深度拒绝、受控抖动桥 | 做 resolve 算法对照试验，不替换相机桥和历史所有权 |
| SMAA/FXAA/MSAA | `SMAAEffectPass.js` 与原生后处理/多采样使用 | CCR 已有对应路径和构建资源处理 | 增量较小，保留现有实现；只拿示例作对照 |
| MRT/G-buffer | `RenderGbufferPass.js`：重放派生命令，输出位置/法线/反射率 | CCR 已有语义更明确的材质通道与 R32F 眼空间深度 | 借鉴 custom primitive shader 接入形态，不替换当前数据布局 |
| UBO/FBO | `Cesium-UniformBuffer.js`、`UniformBufferManager.js`、`PostProcessStageTextureCache.js` | CCR 已有差量上传、绑定恢复与 FBO 生命周期 | FBO 依赖/寿命分析可参考；不引入旧 UBO 管理体系 |
| 多光源 | `DeferredDynamicLightPass.js`：按数量分 UBO 的点光源、聚光灯、方向光、LTC 矩形光 | CCR 有有限容量光源数据缓冲，但没有完整大规模光照消费者 | 记录模型、衰减与 LTC 候选；维持暂缓 |
| 遮挡剔除 | 所读 src 没有对象遮挡查询反馈闭环；时间分片是后处理 scissor 更新，光斑射线检测是另一用途 | CCR Hi-Z 存在，但未构成对象遮挡反馈 | **仍是阶段一缺口**，不能用分片或 AO 代替 |

## 3. 最值得先做的两项

### HBAO：换采样算法，不重新建设数据生产链

参考 `hbao/ambientOcclusionGenerate.js:52`：沿每个屏幕方向逐步更新地平线，只累加新增遮蔽角度，并按半径衰减。这与 CCR `src/ao/aoShaders143.js:99` 当前对方向/半径样本直接累计遮挡贡献的方式不同，确有算法增量。

建议作为现有 AO 的可选算法，复用 MaterialChannels143 的 R32F 深度、法线、透明覆盖、未知值处理、半分辨率输出和恢复机制。半径继续使用米制，像素尺度取实际纹理和投影矩阵。

不能直接使用的细节：默认 16 方向 ×12 步意味着每像素 192 次主搜索采样，另有重建/滤波成本；固定 frustumLength、depthTexture/Globe packed depth 混用、像素比和投影参数必须适配。本地包装类的 hbaoEffect 为模块变量，多 Viewer 会共享状态。

验收以墙角、建筑落地、台阶和平面为主要夹具：平面不能自黑，轮廓不能形成跨物体黑边，透明物体和未知材质不能错误染黑。固定相机/分辨率比较 SSAO 与 HBAO 的画质和 GPU 增量，不能只比默认参数下谁更黑。

上游：本地 shader 明确引用 [NVIDIA gl_ssao HBAO](https://github.com/nvpro-samples/gl_ssao/blob/master/hbao.frag.glsl)。可直接沿官方算法核核对，避免继承本地包装问题。

### 多尺度 Bloom：补 HDR 高光扩散能力

参考 `HDRBloomEffectPass.js:185` 的多级降/升采样，以及 `:475` 的 13-tap 核。把这些纯滤波函数接到 `HdrCoordinator143`，输出线性 HDR，交给既有 Cesium tonemapper 做一次映射。新 Bloom 启用时明确互斥原生 Bloom，关闭后恢复原设置。

不能照搬构造器的 `scene.gamma = 1.2`，也不能照搬模块级 hdrBloomEffect/downStagePass 共享状态。源码存在 QuadraticThreshold 函数和 softKnee 参数，但实际 prefilter main 调用的是硬阈值 Prefilter，因此不能宣称已经完整接入软阈值。

验收：HDR 自发光/高亮小物体产生可控光晕，普通白墙和天空不被整体抬亮；阈值变化无严重跳变；resize、关闭恢复和多 Viewer 独立工作。软阈值可对照 [Unity 官方 Bloom 实现](https://github.com/Unity-Technologies/PostProcessing/blob/v2/PostProcessing/Shaders/Builtins/Bloom.shader) 校准，具体采用函数需保留来源。

## 4. 天空、云、雾的具体收益与边界

`volumetricClouds.js:24` 已实现射线与云底/云顶球面的区间选择，覆盖相机在云上、云下、云中三种情况；`:62` 起用长步寻找密度、短步穿过云体，透射率足够低时终止。这里比 CCR 局部平面云层更接近“全球低分辨体积云”的目标。

迁移应从 raySphereIntersect 与云区间选择开始，验证地平线、背向射线、地球遮挡、近远裁剪和相机穿云；再接现有低分辨率积分/深度引导合成。球形近似与 WGS84 椭球的高度误差要明确，不能直接叫精确全球气象系统。原源码的噪声、星球/大气常量、颜色合成和 texture 路径有依赖，不能只拷贝 get_clouds 就认为完整。

原 shader 同时存在 rgba.a 作为透射率和早退 vec4(0.0) 的分支，抽取时需统一“无云 = 透射率 1”的输出语义，结合原调用方逐支核对，避免黑色/灰色蒙层。当前尚未 GPU 复现此分支问题。

`heightFog.js:47` 的解析积分可以服务简单指数雾，但原实现以 y 作为高度轴，并出现 `czm_viewerPositionWC.y`。CCR 必须用一致的地理高度/局部 ENU 轴，不能把 ECEF 的某一分量直接当离地高度。

`volumetricLights.js:31` 的 godRayLight 是围绕屏幕太阳位置径向累加，能用于艺术效果或低成本光柱档，不等于沿三维体积积分的阴影光束。`MergeEffectPass.js:264` 附近的射线检测用于太阳光斑遮挡，不是场景对象遮挡剔除。

## 5. 不应回退的现有能力

### 材质通道与 SSR

Tianjing G-buffer 的位置为 RGBA16F、法线为 RGBA16F、反射率为 RGBA8（RenderGbufferPass.js:1081 起）。半浮点直接存眼空间位置在远处存在精度限制；它的反射率语义与 CCR 的法线/粗糙度/金属度、反射响应、albedo 和有效位不一致。

该 G-buffer 默认根据相机和至少一秒的场景时间间隔决定更新（:142），没有覆盖所有几何/材质变更的显式 revision 契约；静止时间和相机下异步加载模型可能仍需要 dynamicUpdate。CCR 同帧有效性与保守未知遮挡规则应保留。

SSR 可以参考 SSREffectPass 的过滤/CubeMap 分支。CCR 已有反射材质响应和 Hi-Z，不能为了视觉上更强的倒影退回单纯整幅场景颜色插值。SSR2 的 miss 路径返回最后采样颜色（SSR2EffectPass.js:208 左右），未命中也可能贡献反射；其平滑函数和普通追踪对位置空间的处理不同，必须单测，不能当作高可靠基线。

### TAA 与阴影

Tianjing TAA 用引擎内 resetProjection hook，按 canvas.clientWidth/clientHeight 归一化抖动（TAAEffectPass.js:641），与实际 drawing buffer 不一定一致；不能替换 CCR 现有 1.143 视锥桥。可独立对照 YCoCg 历史裁剪和亮度自适应，但本轮没有证据说明它比 CCR 当前 TAA 更稳定。

阴影改造位于 Build 文件 211655 和 212928 附近。前者是额外深度 bias，后者是自定义 caster shader 回调；它们不是已经实现的完整稳定 PCF/CSM 升级。CCR 的太阳阴影范围、过滤、缓存和相机外投影选择保留；只有具体 caster 类型确有适配需要才借鉴回调结构。

### HDR、UBO 与生命周期

旧 RenderEffectPipeline 重建整套后处理集合；CCR 则挂接受控 HDR 阶段并恢复仍由自身持有的设置。避免替换 scene.postProcessStages 造成宿主效果、拾取或其他插件链路丢失。

旧 UniformBufferManager 的底层更新后直接 bindBuffer(..., null)，不恢复调用前绑定；CCR UniformBuffer143 已有差量上传、绑定点检查和恢复，不需要换成更大的旧封装。

旧 HBAO、Bloom、SSR2、移轴的 stage 使用模块变量，G-buffer 的 depthCommand/相机状态也有模块变量。迁移时必须改为每 scene/实例所有权。G-buffer releaseResources 中 framebuffer 的 destroyAttachments=false，深度附件需要单独核对释放；当前读取未找到对应深度附件销毁，列为静态风险，尚未做显存泄漏复现。

## 6. 三个目标不能因发现源码就标为完成

1. **完整延迟 PBR。** DeferredDynamicLightPass.js:1343 读取 colorTexture，随后 `out_FragColor *= computeLightColor(...)`。这是基于现有颜色追加光照的路径，不等价于用 albedo/normal/roughness/metallic 独立重建不透明 PBR 照明。需继续明确不透明照明与透明前向合成的顺序。
2. **5000+ 光源性能。** 代码按前 1000、第二组 1000、剩余光源组织 UBO；shader 中按这些光源遍历，所读路径没有 tile/cluster 光源列表。不能仅凭 UBO 数组证明 5000 光源达标；数组长度需按真实 MAX_UNIFORM_BLOCK_SIZE 计算。多光源本轮只记录，不开发。
3. **对象遮挡剔除。** 对插件 src 与随包 Build 的检索未找到对象可见性查询反馈闭环；出现的 Query 调用用于 stats GPU 计时，后处理时间分片用于 scissor。未来还需设计保守可见性、异步反馈、相机移动失效和遮挡对象缓存。CCR 已有 Hi-Z 也不代表此项已经完成。

## 7. 更新后的阶段一推进顺序

| 顺序 | 工作 | 具体交付/通过条件 |
| --- | --- | --- |
| 1 | HBAO 算法小样 | 基于 CCR 材质/深度输入实现可切换算法；平面、墙角、透明边界、远景同配置画质/GPU 对照 |
| 2 | 多尺度 HDR Bloom | 纯滤波链接入现有 HDR coordinator；天空/白墙不漂白，HDR 高光能扩散，启停/resize/释放正确 |
| 3 | 全球云层几何边界验证 | 球壳求交与现有合成结合；地面、地平线、云中、云上、高空相机均无错误蒙层；按采样预算记录 GPU 时间 |
| 4 | 独立镜头效果 | 按需加入移轴、光斑；所有效果默认关闭，效果参数不改全局曝光；太阳被遮挡/在镜头后时正确退出 |
| 5 | SSR/TAA 有证据的专项优化 | 仅对当前夹具可复现的问题试验新过滤/历史裁剪；不得以更强模糊掩盖抖动，不因源码存在就重写 |
| 保留缺口 | 完整延迟照明、对象遮挡反馈、大规模光源 | 单独制定数据与性能契约；多光源按既有决定暂缓 |

每次只迁移一个算法核心，保留原实现作 A/B。固定真实 drawing buffer、相机、场景时间、资产、前台窗口与效果配置；分别记录画质和 GPU 成本。新 pass 还需原生恢复、多 Viewer、resize、上下文异常和源/UMD 两条路径验证。

不用移轴等容易完成的小效果代替尚未达成的架构目标，也不用整套旧管线替换已经验证的 CCR 基础设施。

## 8. 直接复用前的来源记录

参考工程 package 标记 ISC，但 shader/工具注释分别指向 NVIDIA、Three.js、Babylon.js、Ashima、Shadertoy 等来源。代码提取时按实际来源保留版权和许可信息；shader 与纹理资源分别登记。本报告未复制其算法实现，也不对这些第三方素材作统一授权判断。

当前可直接使用的成果是：可读算法、调用链、参数与示例布局参考。整体浏览器运行、与 CCR 接入后的 GPU 正确性、画质优劣和性能增益都还需要下一步验证。
