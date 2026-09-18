# 图像质量接口与空间抗锯齿（Cesium 1.143）

2026-09-15：默认SMAA均衡档，MSAA请求1，设备原生像素。FXAA/SMAA位于最终显示颜色阶段，TAA实现不变。完整配置、校园图像对比与计时口径见 [校园抗锯齿说明](../../docs/CAMPUS_ANTIALIASING.md)。

```js
pipeline.setAntiAliasing({ mode: 'smaa', quality: 'balanced', msaaSamples: 1, msaaCombine: false });
pipeline.setAntiAliasing({ mode: 'smaa', quality: 'balanced', msaaSamples: 4, msaaCombine: true });
pipeline.setAntiAliasing({ mode: 'fxaa', quality: 'sharp', msaaSamples: 1, msaaCombine: false });
pipeline.setAntiAliasing({ mode: 'msaa' }); // 原请求1且未显式指定时自动请求4
pipeline.getRenderDiagnostics().antiAliasing;
```

空间quality可选sharp/balanced/smooth；不影响TAA。SMAA阈值分别0.1/0.05/0.035，搜索8/8/16。FXAA复用Cesium提供的3.11实现，按档位设置亚像素混合及阈值。SMAA LUT配对与原shader坐标约定保留；FXAA单pass不加载LUT。均保留原alpha，不引入时间历史。

MSAA处理几何覆盖，后处理AA还处理着色/纹理边缘；组合可能改善画质并增加成本，需按目标场景实测。仅MSAA或显式msaaCombine兑现请求，实际值取HDR颜色/深度共同支持的样本数。诊断报告请求、选择和已分配renderbuffer，不仅报告设置值。

SpatialAaPass143共享已有最终颜色执行、copy、viewport恢复、原生FXAA回退与代际取消机制；SmaaPass143公开类保持兼容，新增FxaaPass143。启停/质量变化释放自有资源，不改原生FXAA shader、业务后处理或场景材质。

旧说明中关于SMAA与MSAA组合必然无收益以及旧P95数据的结论已撤下；当前校园对比以CAMPUS_ANTIALIASING.md为准。getAntiAliasing保留原四字段结构，quality从getOptions().spatialAaQuality或诊断读取。

## TAA时间抗锯齿

```js
pipeline.setTaa({ enabled: true })
pipeline.setTaa({ historyBlend: 0.03, motionBlend: 0.5, jitterSamples: 8 })
pipeline.getTaaDiagnostics()
pipeline.resetTaaHistory()
pipeline.setTaa({ enabled: false }) // 返回SMAA
```

主场景面板及独立预览可以选择TAA，默认仍为SMAA。TAA在HDR效果之后、色调映射之前运行。当前颜色、历史颜色/深度和输出都对齐到固定显示网格；原始场景继续使用Halton亚像素采样。当前与历史使用Catmull-Rom重建、局部颜色夹取和深度反遮挡，不通过反复模糊显示结果来隐藏抖动。

混合vec4通过Cartesian4上传，诊断中的blend为本帧权重。默认静态当前帧权重0.03，初始化时按样本数快速积累；运动按像素位移增加当前帧权重。明显相机跳转丢弃历史。历史深度为R32F，使用当前分视锥的Cesium深度解码，并在可用时合并本帧Globe表面深度。

边缘稳定性：静止相机下，轮廓的采样深度可能在前景/背景间切换。仅在3×3深度邻域确有不连续时保留经过颜色约束的覆盖历史，避免每次切换都清空历史。5×5颜色验证范围覆盖整个三次重建足迹，并复用采样值进行重建，不对最终画面加模糊。静止的高对比像素逐步加强积累，最低当前帧权重为基础权重的1/6；`blend`报告基础权重，`staticFrames`报告静止积累时长。相机移动立即撤销静止记录，显露背景仍通过深度和颜色约束排除旧颜色。

抖动桥限定主相机派生视锥，按其near重新计算偏移；相机替换、外部包装和原偏移在释放时保留。该桥是静态1.143的内部适配，并非跨版本公共API。样本数运行时改变会重启历史。

2026-09-18 交互修补：偏移只在 preRender/postRender 之间存在，避免被误判为相机移动而阻断 hover；轮廓 ID 使用稳定投影。单视锥 HDR、MSAA=1 下，Billboard/Label/PointPrimitive 在 TAA 后单独合成，不进入历史。额外 UI 目标和 ID 绘制的性能边界、验证结果见 `docs/TAA_INTERACTION_FIX_2026-09-18.md`；诊断 `overlay` 报告本帧延后/重绘命令和额外内存。

当前TAA只接受单视锥透视HDR深度，多视锥时丢弃历史并回退FXAA；不把不可靠深度用于混合。1080p两张RGBA16F历史颜色与一张R32F历史深度约39.55MiB，不含上游场景/环境/反射资源。没有速度缓冲或透明Reactive Mask，复杂透明/变形物体仍有边界；不等同于TSR或上采样。

运行`node tests/rendering/run-taa-quality.cjs`（CESIUM_PLAYWRIGHT指向已安装模块），验证已知边缘覆盖、细条纹对比度、静态收敛、真实模型移动、GPU参数、相机硬切/慢速移动、启停和缩放。校园数据需配置或准备本地副本。回归判据针对最终输出稳定性，不能用“抖动使画面变化”代替抗锯齿验收。

复现：`npm run test:rendering`；静态服务器下打开`tests/rendering/image-quality-fixture.html`，执行`imageQualityFixture.runChecks()`。校园预览右上角可调色、选AA/MSAA和分辨率。当前GPU图像检查30项通过；最新103项Node回归通过。当前性能比较因前台/相机条件失败而未验收，完整结论见本地`plan/evidence/14-image-quality-handover.md`。
