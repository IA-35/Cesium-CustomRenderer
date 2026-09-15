# 阶段一源码参考与复用索引

核对日期：2026-09-15。配套[完整开发计划](./STAGE1_COMPLETION_PLAN.md)。以下链接指向本机现有文件；新增文件及未来API在主计划中单独标记。本文只做源码/调用链核对，不表示已完成移植或运行验收。

## 使用规则与结论

优先级：**CCR已验证实现 → 本地Cesium 1.143官方源码 → Tianjing算法核/行为对照 → 有明确证据后自行补齐缺口**。

| 分类 | 含义 | 执行方式 |
| --- | --- | --- |
| 直接复用 | 当前CCR已有模块或官方兼容入口 | 调用/扩展现有模块与测试，避免另写同功能类 |
| 适配复用 | 算法可用，但输入、版本、所有权不同 | 抽取必要数学/采样函数，保持来源，独立数值验证 |
| 仅参考 | 结构/参数/场景可参考，不能直接接入 | 形成契约或对照夹具，不把旧封装复制入项目 |
| 缺口 | 当前与参考均无完整闭环 | 明确新增任务，不能把相似名词算作复用成功 |

Tianjing包以Cesium 1.118定制Build为运行基础；当前CCR锁定1.143。前期审查中的“建议先迁移HBAO/Bloom/球壳云”已经实施，现在应直接复用CCR结果。旧报告的当时状态不是当前待办。

## R01 — 管线入口、HDR顺序与所有权

**直接复用**

- [VisualPipeline.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js>)：已有setters、按需消费者、启停/暂停/恢复和preset组织；新模块继续接入此入口，不建立CCR2。
- [HdrCoordinator143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/HdrCoordinator143.js>)：`registerHdrEffect(scene, priority, process)`、实例级WeakMap、外部wrapper保留、幂等注销。
- [HdrEnvironmentPass143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/HdrEnvironmentPass143.js>)：独立HDR collection、投影/viewport恢复、失败旁路。
- [presets.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/presets.js>)：现有默认策略。
- [hdr-coordinator.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/hdr-coordinator.test.mjs>)、[hdr-environment.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/hdr-environment.test.mjs>)：所有权/顺序回归。

**本地官方参考**

- [Cesium Scene.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/Scene.js>)：`executeCommands`、`performTranslucentPass`、`Scene.prototype.resolveFramebuffers`。后者先OIT再postProcess，证明当前HDR hook不能自动承担透明前lighting。
- [Cesium OIT.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/OIT.js>)：opaque输入、MRT/multipass透明累积与最后合成。

**限制：** HDR coordinator的安全包装机制可复用，其执行位置不能照搬为新主照明接点。Scene内部闭包不是可直接覆写的公开方法。B01必须以运行小样确认接点。

## R02 — 材质求值、G-buffer与深度

**直接复用**

- [MaterialChannels143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialChannels143.js>)：命令重放、每帧有效性、按需reflection/albedo消费者、视锥及失效管理。
- [materialShader143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/materialShader143.js>)：从真实MaterialStage提取材质、flags、MASK/discard、未知不透明保护；优先共享这一段，不复制另一套GLTF求值。
- [MaterialTarget143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialTarget143.js>)：能力检查、纹理/FBO分配与失败清理；按B02扩展精简布局。
- [geometryEncoding.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/geometryEncoding.js>)：编码与标志定义。
- [MATERIAL_CHANNELS.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MATERIAL_CHANNELS.md>)：albedo、深度、STANDARD_PBR_VALID和旧布局契约。
- [material-shader.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/material-shader.test.mjs>)、[material-replay.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/material-replay.test.mjs>)、[material-target.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/material-target.test.mjs>)。

**仅参考**

- [RenderGbufferPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/RenderGbufferPass.js>)：派生命令重放、多个输出、custom primitive接入。
- 不复制RGBA16F完整眼空间位置、固定一秒更新节奏、模块共享depthCommand；不以旧reflection参数替代CCR标准PBR材质。

**用于：** B01/B02/B03/B06。精简四附件需要新布局选项与测试，现有八附件全开不是免费扩展点。

## R03 — 透明覆盖、OIT与透明反射

**直接复用**

- [TRANSPARENCY.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/TRANSPARENCY.md>)：R8覆盖的保守语义。
- [OitCompatibility143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/reflections/OitCompatibility143.js>)：1.143 multipass shader输出修复、引用计数与原始wrapper恢复；这只是兼容修复，不是独立透明前向管线。
- [TransparentReflection143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/reflections/TransparentReflection143.js>)、[transparentReflectionShader143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/reflections/transparentReflectionShader143.js>)：透明PBR反射求值/差值及状态恢复。
- [transparent-reflection.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/transparent-reflection.test.mjs>)、[oit-compatibility.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/oit-compatibility.test.mjs>)。

**用于：** B03/B07/B08。原生透明颜色与新的opaque背景必须在正确位置合成，不能把旧“最终色修正”直接当作完整新架构。

## R04 — 标准PBR与环境光

**直接复用/本地官方来源**

- [EnvironmentLighting143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/EnvironmentLighting143.js>)：环境光/反射输入与对象参数所有权；保留用户原值、恢复策略。
- [LightingStageFS.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/Model/LightingStageFS.glsl>)：`computePbrLighting`、太阳、emissive/IBL组织。
- [ImageBasedLightingStageFS.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/Model/ImageBasedLightingStageFS.glsl>)：环境SH/预滤镜面与参考坐标。
- [pbrLighting.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/Builtin/Functions/pbrLighting.glsl>)：BRDF函数来源。
- [reflectionShader143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/reflectionShader143.js>)：现有原生镜面捕获、材质反射响应和中性feature ID判定。

**仅参考**

- [DeferredDynamicLightPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/DeferredDynamicLightPass.js>)：灯光参数、衰减、类型处理。
- 该文件实际有 `out_FragColor *= computeLightColor(...)`，不得复用为“从G-buffer重建主PBR”的实现。
- [Cesium-EnvMapLoader.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/PluginBase/Cesium-EnvMapLoader.js>)：环境资源加载入口，仅对照资源格式/方向，不再引入全局scene状态。

**用于：** B02/B03/B13。官方shader引用或抽取时继续保留Cesium原有许可；不能把其编译时宏依赖当作独立零依赖函数。

## R05 — UBO与相机数据

**直接复用**

- [UniformBuffer143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/buffers/UniformBuffer143.js>)：std140数据容量、dirty范围、绑定恢复与销毁。
- [CameraUniforms143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/buffers/CameraUniforms143.js>)：`acquireCameraUniforms`、160字节布局、scene引用计数、实时投影读取。
- [LightUniforms143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/buffers/LightUniforms143.js>)：光源数据校验、128条分页；可复用序列化规则，不代表已有灯光渲染。
- [uniform-buffer.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/uniform-buffer.test.mjs>)、[camera-uniforms.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/camera-uniforms.test.mjs>)、[light-uniforms.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/light-uniforms.test.mjs>)。

**仅参考**

- [Cesium-UniformBuffer.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/Cesium-UniformBuffer.js>)、[UniformBufferManager.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/UniformBufferManager.js>)。
- 不复用其旧引擎绑定接口、更新后直接bind null的行为；也不按参考硬编码UBO可容纳1000盏灯。

**用于：** B02/B05/B06/B13。

## R06 — SSR主体与白模经验

**直接复用**

- [ScreenSpaceReflection143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/reflections/ScreenSpaceReflection143.js>)：消费者、Hi-Z、trace/resolve管理与HDR注册。
- [ssrShaders143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/reflections/ssrShaders143.js>)：边缘/角度/长度/步数/roughness置信度，中心与邻域约束，环境镜面替换。
- [ssr-numeric-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/ssr-numeric-fixture.js>)、[ssr-transition-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/ssr-transition-fixture.js>)：有效命中与渐隐测试。
- [white-tiles-material.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/examples/white-tiles-material.js>)：现有无纹理白模PBR适配经验，保留几何/feature ID。它是示例辅助，不应扩成自动改写所有业务材质的核心默认。
- [check-white-tiles.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-white-tiles.cjs>)、[check-white-city.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-white-city.cjs>)：真实白模材质/绕行检查入口。

**适配参考**

- [SSREffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/SSREffectPass.js>)：过滤、粗糙度扰动和CubeMap分支。
- [SSR2EffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/SSR2EffectPass.js>)仅用于反例对照：miss返回末次颜色和空间混用不能迁入。

**用于：** B03/B07。最关键的是新延迟照明下specular基线来源转换，不是再加一个“更强反射”系数。

## R07 — 自定义阴影、稳定与caster选择

**直接复用**

- [DirectionalShadowPass.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/DirectionalShadowPass.js>)：自定义太阳阴影主流程。
- [CameraShadowCoverage.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/CameraShadowCoverage.js>)：相机自动中心、覆盖档位/滞回。
- [LightFrustum.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/LightFrustum.js>)：光空间变换和texel稳定。
- [CasterCommands143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/CasterCommands143.js>)：相机外瓦片投影物补选。
- [ShadowCache.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/ShadowCache.js>)、[ShadowTarget.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/ShadowTarget.js>)：缓存、目标所有权。
- [shaderAdapter143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/shadows/shaderAdapter143.js>)：PBR与Globe接收、bias/PCF相关适配。
- [shadow-coverage.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/shadow-coverage.test.mjs>)、[check-camera-shadows.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-camera-shadows.cjs>)。

**官方参考**

- [Cesium ShadowMap.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/ShadowMap.js>)、[ShadowMapShader.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/ShadowMapShader.js>)：级联分区、拟合、receiver选择与过滤组织。
- 只抽取适用算法与公式，运行仍由CCR的shadow对象管理；不恢复原生阴影作为默认路径。
- Tianjing旧Build里的bias/customShadowShader回调并不构成可直接复用的完整CSM。

**用于：** B04/B06/B08。当前已有成功的自动跟随必须保留。

## R08 — HDR资源调度与生命周期

**直接复用**

- [HdrCoordinator143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/HdrCoordinator143.js>)、[HdrBloom143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/bloom/HdrBloom143.js>)：stage注册/释放与多级目标实际使用位置。
- [MaterialTarget143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialTarget143.js>)：附件分配失败清理与GL状态恢复。
- [RenderProfiler143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/diagnostics/RenderProfiler143.js>)：资源/pass成本观测。

**优先官方、其次Tianjing**

- [Cesium PostProcessStageTextureCache.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/PostProcessStageTextureCache.js>)。
- [Tianjing PostProcessStageTextureCache.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/PostProcessStageTextureCache.js>)：`getStageDependencies`、按依赖识别可复用framebuffer的结构。
- 参考已有生命周期分析，不复制整个collection管理器；单collection内的缓存不是跨SSR/AO/云/TAA资源池。
- 主计划B05只扩展实际CCR自有目标，历史纹理和同时活跃的不同语义输出不可别名。

**用于：** B02/B05/B11/B13。

## R09 — HBAO、Bloom：已有实现直接沿用

**直接复用**

- [hbaoShader143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/ao/hbaoShader143.js>)、[aoShaders143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/ao/aoShaders143.js>)、[ScreenSpaceAo143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/ao/ScreenSpaceAo143.js>)：方向地平线、米制深度、过滤/透明保守性。
- [bloomShaders143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/bloom/bloomShaders143.js>)、[HdrBloom143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/bloom/HdrBloom143.js>)：显式双线性、13-tap、软阈值、归一化tent、alpha保留。
- [ao-numeric-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/ao-numeric-fixture.js>)、[bloom-numeric-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/bloom-numeric-fixture.js>)。

**算法出处与参考**

- [HBAO采样核](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/hbao/ambientOcclusionGenerate.js>)与[HBAO辅助shader](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/hbao/shader.js>)；源内指向NVIDIA。
- [HDRBloomEffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/HDRBloomEffectPass.js>)：多尺度结构。不要搬构造器gamma=1.2、模块共享stage或实际未接通的softKnee逻辑。
- [ALGORITHM_REFERENCES.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/ALGORITHM_REFERENCES.md>)已登记当前算法来源。

**用于：** B02/B05/B09。新任务是适配“AO只调间接光”和新的顺序/资源，不重复开发AO/Bloom算法。

## R10 — Hi-Z、对象反馈与测量

**直接复用**

- [DepthPyramid143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/DepthPyramid143.js>)：`pyramidDimensions`、min/max、完整覆盖与未知/透明mask，奇数尺寸处理。
- [DEPTH_PYRAMID.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/DEPTH_PYRAMID.md>)、[depth-pyramid.test.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/depth-pyramid.test.mjs>)。
- [GpuTimer.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/diagnostics/GpuTimer.js>)可参考异步query生命周期，但其TIME_ELAPSED结果不是可见性结果。
- [SampleGuard.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/diagnostics/SampleGuard.js>)：无效采样拒绝规则。
- [PerformanceGovernor143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/performance/PerformanceGovernor143.js>)：性能回退已有策略，不必再造一个自动调档器。

**缺口：** Tianjing源码没有已确认的“对象查询→反馈→跳过draw→缓存失效”闭环。后处理scissor/时间分片/太阳射线检测不能替代。

**实现依据：** [Khronos WebGL2 query规范](https://registry.khronos.org/webgl/specs/2.0/)。B06使用保守query与异步结果；不在当前帧等待完成，不据过期相机结果隐藏对象。

## R11 — 水面材质与反射参考

**适配参考**

- [WaterPrimitive.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/WaterPipeline/WaterPrimitive.js>)：水面法线/反射资源接入和材质组织。
- [ReflectTexture.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/WaterPipeline/Library/ReflectTexture.js>)、[RefractTexture.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/WaterPipeline/Library/RefractTexture.js>)：可用来理解反射/折射额外场景渲染成本，不属于SSR直接替代品。
- [WaterRenderEffect.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/WaterPipeline/WaterEffect/WaterRenderEffect.js>)：效果组合入口。
- 当前SSR模块、透明PBR求值和B03背景输入应直接复用。

**不可直接搬入：** scene._reflectTexture等共享字段、反射/折射相机全场景重绘、私有材质对象写入。B07只取必要材质输入和变换，水体系统整体不迁移。

## R12 — 云层、雾、太阳遮挡与体积光

**直接复用**

- [cloudShell143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/cloudShell143.js>)：CPU/GPU稳定区间、椭球归一化、固定12–50km淡出。
- [environmentStages.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/environmentStages.js>)：云密度/透射率、噪声采样、局部雾/光照/合成。
- [EnvironmentRenderer.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/EnvironmentRenderer.js>)、[environmentState.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/environmentState.js>)：状态与参数。
- [noiseAtlas.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/environment/noiseAtlas.js>)：现有自生成噪声，不新增外部纹理依赖。
- [cloud-fade-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/cloud-fade-fixture.js>)、[cloud-shell-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/cloud-shell-fixture.js>)、[noise-numeric-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/noise-numeric-fixture.js>)。

**适配参考**

- [heightFog.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/heightFog.js>)：`CalculateLineIntegralShared`和近零Taylor分支；将Y高度假设改为一致地理高度。
- [volumetricClouds.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/volumetricClouds.js>)、[common.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/common.js>)：球壳/粗细步进已吸收，后续直接用CCR版本。
- [volumetricLights.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/volumetricLights.js>)：`godRayLight`径向累积；它是屏幕光柱，不能宣传为完整三维散射。
- [MergeEffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/MergeEffectPass.js>)：太阳屏幕位置/遮挡组织，仅参考局部流程。

**用于：** B08/B09。Tianjing云alpha语义与早退需要核对，不能拿来覆盖已验证的CCR“空区间无云”契约。

## R13 — Tonemap、模糊、色差与光斑

**直接复用/官方参考**

- [colorGrading.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/stages/colorGrading.js>)：现有显示调色，不是色差滤镜。
- [PostProcessStageLibrary.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Scene/PostProcessStageLibrary.js>)：`createBlurStage`、`createDepthOfFieldStage`，优先验证可直接使用。
- [DepthOfField.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/PostProcessStages/DepthOfField.glsl>)：焦平面与深度混合参考。
- [AcesTonemappingStage.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/PostProcessStages/AcesTonemappingStage.glsl>)、[ReinhardTonemapping.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/PostProcessStages/ReinhardTonemapping.glsl>)、[FilmicTonemapping.glsl](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Shaders/PostProcessStages/FilmicTonemapping.glsl>)。
- 本地Filmic明确引用Uncharted 2；不是Unreal Filmic。Epic的[官方说明](https://dev.epicgames.com/documentation/unreal-engine/color-grading-and-the-filmic-tonemapper-in-unreal-engine)将现代UE Filmic描述为ACES体系；B09近似分支需如实命名，不复制一个旧Filmic参数就宣称UE一致。

**适配参考**

- [TiltShiftEffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/TiltShiftEffectPass.js>)：横/纵9-tap焦带采样；复用核时归一化，以真实纹理像素控制半径，去除模块全局stage。
- [gaussianBlur.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/gaussianBlur.js>)：普通模糊核，优先与官方现成blur去重。
- [lensFlare.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/lensFlare.js>)、[lensFlare2.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/mergeShader/lensFlare2.js>)：太阳位置、背向退出、光斑图案；择一个最小实现，不同时搬两套。
- 色彩通道空间偏移没有已确认可直接用的CCR实现，B09新增小shader；不能拿hue调节充数。

## R14 — 抗锯齿与稳定性证据

**直接复用**

- [SpatialAaPass143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/SpatialAaPass143.js>)、[FxaaPass143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/FxaaPass143.js>)、[SmaaPass143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/SmaaPass143.js>)、[settings143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/settings143.js>)。
- [TaaPass143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/TaaPass143.js>)、[taaShaders143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/taaShaders143.js>)、[FrustumJitterBridge143.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/antialiasing/FrustumJitterBridge143.js>)：现有受控抖动/历史重建。
- [spatial-aa-fixture.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/spatial-aa-fixture.js>)、[check-campus-aa.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-campus-aa.cjs>)、[check-campus-aa-lifecycle.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-campus-aa-lifecycle.cjs>)。
- [CAMPUS_ANTIALIASING.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/CAMPUS_ANTIALIASING.md>)：三质量档、实际MSAA与既有校园证据说明。

**仅参考**

- [SMAAEffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/SMAAEffectPass.js>)的均衡阈值0.05已经吸收。
- [TAAEffectPass.js](<G:/_JavaScript/新版cesium示例/tianjingmap-3d/src/tianjingmap3d/CesiumEffectPipeline/Library/TAAEffectPass.js>)的YCoCg/Catmull-Rom可作算法对照；不迁入CSS尺寸归一化和旧引擎resetProjection hook。
- 已有测试不证明当前新架构运动稳定，B10必须在B03/B08完成后的真实顺序重新验收。

## R15 — 原宿主夹具迁移、SDK与旧证据

**旧宿主现存可迁移文件**

- [run-materials.cjs](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/run-materials.cjs>)、[material-fixture.js](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/material-fixture.js>)。
- [run-albedo.cjs](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/run-albedo.cjs>)、[albedo-fixture.js](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/albedo-fixture.js>)。
- [run-transparent-reflections.cjs](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/run-transparent-reflections.cjs>)、[transparent-reflection-fixture.js](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/transparent-reflection-fixture.js>)。
- [run-taa-quality.cjs](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/run-taa-quality.cjs>)、[taa-quality-fixture.js](<C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui/tests/rendering/taa-quality-fixture.js>)。
- 迁移前审查其资产/import/URL与测试假设；复制后适配到CCR，不用符号链接让独立SDK暗中依赖旧宿主。保留原文件。

**当前SDK直接复用**

- [build-rendering-sdk.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/build-rendering-sdk.cjs>)、[rendering-sdk-README.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/rendering-sdk-README.md>)、[check-browser-sdk.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-browser-sdk.cjs>)：UMD、manifest、外置引擎与产物验证。
- [check-stage1.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1.cjs>)、[stage1-fixture.html](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/stage1-fixture.html>)、[stage1-scene.js](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/stage1-scene.js>)：统一GPU数值/场景验证框架。
- [阶段一开发进度核查_0915](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/阶段一开发进度核查_0915.md>)：现有证据边界。

**限制：** 原宿主无效AA前台/相机/P95样本不能作为新性能起点；当前headless短样本也仅用于诊断。B12重新固定前台窗口、资产、时间、配置和真实分辨率后才能做性能结论。

## 不迁移清单

1. 整份Tianjing 1.118定制Build及依赖其私有hook的插件包装。
2. `out_FragColor *= computeLightColor`当作完整延迟PBR。
3. 1000/1000/剩余光源全像素遍历当作5000灯高性能方案。
4. 模块顶层共享stage、scene全局反射对象和直接替换postProcessStages。
5. 眼空间位置半精度大范围存储、未知深度当背景、miss返回最后采样颜色。
6. CSS尺寸驱动的TAA抖动、通过提高模糊核压制抖动。
7. 为“全球云”重新扩大高空可见距离、恢复灰幕或全地球密集采样。
8. 普通shader/资源版本与自身许可证未核对就随SDK复制分发。

提取实际代码时更新[ALGORITHM_REFERENCES.md](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/ALGORITHM_REFERENCES.md>)，记录来源文件/版本/函数、CCR适配差异和相应测试。优先使用CCR已有自生成噪声与已有SMAA资源，避免新增不必要外部依赖。

