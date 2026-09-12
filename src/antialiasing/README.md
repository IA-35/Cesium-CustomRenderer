# 图像质量接口与SMAA（Cesium 1.143）

`VisualPipeline` 默认SMAA（后处理）+ 请求**1×MSAA**，使用设备原生像素。原生HDR/ACES、环境与业务后处理完成后才执行SMAA。

MSAA与后处理AA解决同一个覆盖问题。参考机器上固定1080p HDR校园视角的实测：SMAA+MSAA4 的帧间隔 P95 为 **73.0ms**，SMAA+MSAA1 为 **20.5ms**——4×MSAA在107ms/秒的预算里占掉约40ms，却没有额外边缘收益。因此默认请求1个样本；`resolveMsaaPolicy` 是唯一裁决点，只有在 `msaaCombine: true` 时才兑现冗余的多重采样请求。该组合仍可用于对照实验（`pipeline.setAntiAliasing({ mode:'smaa', msaaSamples:4, msaaCombine:true })`），但不再是默认。

```js
import { getVisualPipeline, colorGradingPresets } from '@/rendering/cesium/index.js'
const pipeline = getVisualPipeline(viewer)
pipeline.setColorGrading({ brightness: 1.08, contrast: 1.1, saturation: 1.05, hue: 0, exposure: 1.6 })
pipeline.setColorGrading({ hue: 0.1 }) // +18度；其他控制值保留
pipeline.getColorGrading()
pipeline.setColorGrading(colorGradingPresets.neutral)
pipeline.resetColorGrading()
pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 1, resolutionMode: 'native', resolutionScale: 1 })
pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 4, msaaCombine: true }) // 显式复现旧的组合配置
pipeline.getAntiAliasing()                 // { mode, msaaSamples, resolutionMode, resolutionScale }
pipeline.getRenderDiagnostics().antiAliasing.msaa // { requested, selected, combined, policy, ... }
pipeline.getRenderDiagnostics()
```

调色在显示空间进行；只有exposure作用于原生ACES。`colorGradingControls`导出五项控制范围。默认明亮清晰为brightness1.08/contrast1.1/saturation1.05/hue0/exposure1.6。只迁移已知旧默认签名，其他手动值和neutral预设保留。原始渲染API不写存储，MainMap的`setSceneColorGrading`/`applySceneFilters`负责持久化。

| 控制 | 取值与行为 |
| --- | --- |
| mode | off禁用AA；msaa仅硬件；fxaa或smaa使用对应后处理，并把多重采样请求降为1 |
| msaaSamples | 请求1/2/4/8；仅msaa模式或`msaaCombine:true`时兑现，且不高于当前HDR颜色与深度格式共同支持的值 |
| msaaCombine | 选项级/诊断级开关，默认false。true时后处理AA与MSAA叠加，与历史基线可比 |
| resolutionMode | native使用设备DPR；css使用CSS像素，作为显式性能选项 |
| resolutionScale | 0.5–2，乘以上述像素比例，默认1 |

`msaaCombine` 有意不进入 `getAntiAliasing()` 面板接口，避免改变 `SceneFilterPanel` 的四项设置形状；它通过 `getOptions().msaaCombine` 与诊断读取。

诊断区分请求值、配置值与已分配renderbuffer采样数，同时报告CSS/buffer/DPR。诊断包含GL查询，按需调用。imageRendering设为auto，禁用/销毁时恢复原值。高DPR会增加像素、显存和耗时；MSAA不代表MASK/OIT及后处理边缘都已多采样。

SMAA移植自现有three.js r158，三阶段是颜色边缘、标准查找表权重和邻域混合。Area为160×560，Search为66×33，许可证与来源在`public/rendering/smaa/`；不引入three运行时。保留原WebGL标量offset与Y补偿的配套规则。局部gamma-aware混合不等于再次对整帧做Gamma。

`SmaaPass143`拥有独立collection和lookup纹理，仅包装当前scene的execute/copy。未就绪或失败时回退FXAA，ready后关闭FXAA；异步结果使用代际检查，不能在销毁后重新创建GPU资源。只有当前帧输出可copy。现实现先原copy再覆盖SMAA结果，保留已有副作用/返回值，代价是额外blit。停用时只恢复仍拥有的FXAA/hooks；与环境hook按安装顺序逆序释放。

以上描述的是SMAA空间抗锯齿。TAA另由`TaaPass143`实现，接口与边界如下。

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

当前TAA只接受单视锥透视HDR深度，多视锥时丢弃历史并回退FXAA；不把不可靠深度用于混合。1080p两张RGBA16F历史颜色与一张R32F历史深度约39.55MiB，不含上游场景/环境/反射资源。没有速度缓冲或透明Reactive Mask，复杂透明/变形物体仍有边界；不等同于TSR或上采样。

运行`node tests/rendering/run-taa-quality.cjs`（CESIUM_PLAYWRIGHT指向已安装模块），验证已知边缘覆盖、细条纹对比度、静态收敛、真实模型移动、GPU参数、相机硬切/慢速移动、启停和缩放。校园数据需配置或准备本地副本。回归判据针对最终输出稳定性，不能用“抖动使画面变化”代替抗锯齿验收。

复现：`npm run test:rendering`；静态服务器下打开`tests/rendering/image-quality-fixture.html`，执行`imageQualityFixture.runChecks()`。校园预览右上角可调色、选AA/MSAA和分辨率。当前GPU图像检查30项通过；最新103项Node回归通过。当前性能比较因前台/相机条件失败而未验收，完整结论见本地`plan/evidence/14-image-quality-handover.md`。
