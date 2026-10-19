# 图像质量接口与空间抗锯齿（Cesium 1.143）

> 本分支以固定 Three.js r186 TRAA 为上游，包含经授权的 CCR 采样与历史接受适配。默认 SMAA、已有 FXAA 保留；TAA 默认8相位。来源、偏离和实测边界见 [移植说明](./reference/three-r186/PORTING.md) 与 [当前验收状态](../../docs/verification/rendering-performance/traa-r186-2026-10-16/STATUS.md)。

空间AA沿用2026-09-15的默认SMAA均衡档、MSAA请求1、设备原生像素。FXAA/SMAA位于最终显示颜色阶段；当前TAA见下文。完整配置、校园图像对比与计时口径见 [校园抗锯齿说明](../../docs/04-integration/CAMPUS_ANTIALIASING.md)。

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
pipeline.setTaa({ enabled: true, jitterSamples: 8 })
pipeline.setTaa({ depthThreshold: 0.0005, edgeDepthDiff: 0.001,
  maxVelocityLength: 128, useSubpixelCorrection: true })
pipeline.getTaaDiagnostics()
pipeline.resetTaaHistory()
pipeline.setTaa({ enabled: false }) // 返回SMAA
```

TAA在环境/HDR Bloom之后、色调映射之前运行。Halton(2,3)抖动经现有主相机bridge发布到实际draw frustum；颜色重建到稳定显示网格，历史用同核重建，3×3 RGB统计与当前颜色共享网格。R32F眼深按同一显示网格保存，读取时使用前帧jitter和actual inverse projection还原。官方阈值另转到ROOT相机perspective深度域，避免与draw子视锥的log-depth域混淆。

保留r186最近表面运动、RGB方差盒/clipAABB、亚像素响应及HDR亮度加权。CCR明确偏离：深度dilation覆盖4×4实际重建范围；增加前帧眼空间米制遮挡拒绝；RGBA32F历史；固定基础当前权重0.003及短期EMA初始化；相机/表面运动和天空覆盖使用不同方差范围。未恢复旧5×5统计、高对比度静止分支或撤回候选。

局部有限表面显露/新出现时重新取得最多32个初始化样本。计数存于私有颜色历史alpha；纯天空拒绝旧RGB时保留采样年龄，避免亚像素细线偶发漏采导致重复单样本闪点。正常管线使用一个RHI显示颜色目标恢复场景alpha；Graph直接绑定native颜色/深度历史，不再复制深度。无RHI的直接pass使用一个自有display stage。

性能优化：先复用显示目标完成一次当前颜色4×4重建，resolve直接读取重建后的3×3邻域；resolve结束后复用该目标恢复场景alpha。新增一次绘制但不新增纹理，当前颜色采样由每像素144次改为重建16次加resolve 9次。运动目标只在本帧首次实际写入时清理，无写入时resolve跳过运动纹理；primitive快照复用两份独立矩阵。FP32历史、重建核和接受公式保持不变。

符合shader契约的独立opaque刚体GLTF通过实际draw记录前后primitive矩阵，产生RGBA32F速度与前后眼深。静态模型无需额外motion draw；遮挡/MASK需按实际最近表面核对有效速度。蒙皮、morph、实例和自定义位移未具备完整物体速度，观察到的opaque不兼容项计入unsupported。透明pass在入口跳过，不计入该计数，不能从unsupported=0推断透明已支持。

运行时可选4/8/16/32相位，改变数量重启历史；32不保证比8稳定。旧historyBlend/motionBlend/velocityThreshold/depthTolerance/Gamma字段仅作解析兼容，诊断legacyIgnored列出，不改变新resolve。

仅支持Cesium1.143、WebGL2、HDR、单视锥透视、MSAA=1和FP32 render/linear能力；不兼容时回退原生FXAA。Label/Billboard/PointPrimitive继续在TAA后合成，原生ID/轮廓使用稳定投影，抖动只在render时持有。reset/resize/开关/销毁释放自有资源，其他AA模式保持原有行为。

诊断分别记录stageBytes、rhiHistoryBytes、motion.bytes、overlay.bytes和总bytes；旧版bytes遗漏RHI历史，不能直接相减当显存增量。验证命令：`node scripts/performance/validate-traa-r186.cjs --baseline`对批准基线，`--bundle --samples 8`验证构建，`--performance`独立执行300×3计时，`--campus --bundle`验证真实校园负载。图像读回与GPU计时分离；运动细线以重投影后的剖面宽度/对比度核验，不能只用未补偿画面移动的时间方差判断模糊。
