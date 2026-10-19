# Three.js r186 TRAA → Cesium 1.143 contract

唯一算法上游：`9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8`。三个原始文件和 MIT 许可未修改，SHA256见manifest.json。项目three@0.169依赖不升级，不引入第二个运行时渲染器。独立官方renderer仅由验证脚本在TEMP运行，供诊断移植差异。

2026-10-16：原样移植未通过细窗格验收，用户明确授权对采样与历史接受做小范围适配。以下区分保留的r186核心与CCR偏离；当前版本不能再称为逐公式不变的官方实现。

| 上游 | CCR实现 | 等价点 |
|---|---|---|
| TRAANode current depth / history | taaShaders143.js | 保留最近/最远、最近点速度、edge例外、单侧disocclusion；CCR补充下述米制拒绝 |
| TRAANode varianceClipping | taaVarianceClipping | 保留3×3 RGB mean/stddev与clipAABB；输入改为重建后的邻域 |
| TRAANode currentWeight | shader main | 保留0.25×subpixel+motionFactor及饱和；CCR修改零运动基础权重和初始化 |
| TRAANode varianceGamma | shader main | 保留平方速度曲线；CCR静止/天空覆盖上限2，有限运动表面上限1，运动端0.5 |
| TAAUtils flickerReduction | taaFlickerReduction | 压缩最大RGB仅算亮度权重，混合原HDR颜色 |
| TAAUtils Halton | jitter143.js | 相同Halton(2,3)；CCR默认8相位，保留4/16/32选项 |
| VelocityNode | motionShaders143.js | 去jitter的currentNDC-previousNDC，普通刚体primitive前后矩阵 |

## 坐标与深度

- Cesium UV原点在下，UV=(NDC+1)/2；因此两轴的NDC速度都乘+0.5。Three顶左UV的负Y不能直接照搬。
- 当前色在`uv+currentJitterUv`重建到固定显示网格，3×3统计使用相同重建核。历史色使用同核，避免反复双线性采样使运动细线变宽。三次核复用本仓已验收基线的Catmull-Rom定义，不引入其他引擎的裁剪/锐化算法。
- 颜色历史改为RGBA32F，深度仍为最近过滤R32F。低权重下实测RGBA16F出现均值收敛偏差；实际GL float-linear能力不足时回退。默认相位恢复8，32不保证优于8。
- Cesium原生log深度必须使用实际draw frustum的builtin解码和inverse raster projection，得到眼空间米值。
- **官方深度阈值域使用ROOT主相机near/far**：眼空间米转换为主相机定义的perspective[0,1]后，才与0.0005/0.001比较。不能将actual draw子视锥near/far用于这一步，因为其范围会改变阈值含义。
- 历史眼深按稳定网格写入，对4×4颜色重建足迹取最近有效眼深；三次历史色重建逐tap检查这个深度标签，防止旧前景色绕过中心深度拒绝。读取后加回前帧jitter，再用前帧actual raster inverse还原眼空间点。CPU双精度生成currentView×inverse(previousView)，shader不往返ECEF。
- 无限天空使用眼深0和齐次方向w=0；相机平移不应拖动无限背景。

## 速度输入与生命周期适配

- 只观察真正到达原生颜色提交的命令，原颜色一次；移动刚体使用独立aux draw，executor bypass防递归。
- 快照键优先使用稳定ModelRuntimePrimitive，避免HDR/log-depth shader wrapper重建被误认成新表面；矩阵必须深克隆，不能保存Cesium原地更新的引用。
- RGBA32F=(NDC速度xy,currentEyeDepth,previousEyeDepth)。z=0表示没有物体速度，回退相机速度；z>0/w<0表示新出现/断帧表面，本地丢弃历史。
- 深度最近/最远范围改为当前颜色重建真正使用的4×4 raster footprint；检查aux眼深与最终scene眼深一致后再消费物体速度。float量化容差与历史阈值不同。raw aux可以残留后景数据，验收读有效速度。
- 除官方归一化拒绝外，补充前帧眼空间米制拒绝：预期深度比存储深度远`max(0.1m,2%×预期深度)`时拒绝。相机路径使用相对变换；刚体路径用motion.w的真实前帧深度，避免把Z运动当遮挡。当前为空天空而历史有限时也立即丢弃历史RGB。
- 支持符合shader契约的独立opaque刚体GLTF primitive。观察到的opaque不兼容shader/skin/morph/实例等计入unsupported；透明pass在观察入口跳过，不计入该计数。诊断scope明确这些边界，不能从unsupported=0推断全场景运动支持。
- 复用HDR20→Bloom22→TAA25→镜头30顺序、jitter bridge、RHI和selection/UI隔离。TRAA强制MSAA=1；多视锥等现有边界保留回退。

## CCR采样接受与资源代价

- 固定基础当前权重0.003，独立于相机静止和对比度；叠加r186亚像素与运动项。没有恢复旧的静止高对比度像素分支、5×5统计或旧blend/Gamma控制。
- 开始/相机停止及局部有限表面显露时，在前`max(32,phaseCount)`个样本做EMA启动偏差校正：`base/(1-(1-base)^(age+1))`，随后基础权重固定。局部年龄存于私有颜色历史alpha，防止显露薄窗线立即进入低权重长历史。
- 纯天空拒绝旧RGB时保留采样年龄；这是对亚像素线段在某个Halton相位完全漏采的处理，避免反复单样本初始化产生亮点。有限背景与新出现表面仍重新初始化。
- 正常管线保留一个RHI colour copy目标恢复输入场景alpha；移除了未被resolve读取的两张RHI深度及第二张显示颜色。Graph直接绑定native历史。直接使用TaaPass且没有RHI时用一个自有display stage完成相同操作。
- 显示目标在resolve前先存放一次4×4重建后的当前颜色，resolve直接读取它的3×3邻域；随后同一目标恢复输出alpha。增加一次全屏draw、不新增纹理，每像素当前颜色读取从144次降为16+9次。历史重建及深度范围不变。直接在单shader内缓存6×6的方案因实测变慢已撤回。浮点编译优化仍可能产生微小差异，需结合GPU同帧比较与最终显示验证。
- Motion按首个实际辅助draw清理，无写入时不向resolve暴露纹理；快照复用前后两份独立矩阵，避免静态primitive每帧分配。`rhiHistoryBytes`保留诊断字段名，现只统计单个RHI显示颜色目标。1080p相比优化前减少47.46MiB逻辑分配。

## API

有效控制：`taaJitterSamples`、`taaDepthThreshold`、`taaEdgeDepthDiff`、`taaMaxVelocityLength`、`taaUseSubpixelCorrection`。

旧`taaHistoryBlend/taaMotionBlend/taaVelocityThreshold/taaDepthTolerance/taaVarianceGammaStill/taaVarianceGammaMoving`保留解析与源模块helper兼容，但不再影响resolve，诊断`legacyIgnored`明确列出。不得继续把这些旧字段显示为当前算法生效权重。

## 验收状态

本轮开发与自动检查完成，原样移植失败保留作历史证据。最终适配版的静止窗格、遮挡显露、真实负载、交互和性能结果见[当前状态](../../../../docs/verification/rendering-performance/traa-r186-2026-10-16/STATUS.md)。用户最终业务视觉验收仍待记录；不把个别用例通过说成全场景无闪烁/零拖影或性能全面提升。
