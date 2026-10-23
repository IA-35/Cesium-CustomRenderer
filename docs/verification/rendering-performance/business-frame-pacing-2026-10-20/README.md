# 81 端口校园业务页面帧时间分析

日期：2026-10-20。页面：`http://127.0.0.1:81/#/campus`。本次没有修改生产源码或发布包；临时实验恢复了相机、配置、uniform getter 和插桩方法。

## 环境和测量方法

- 连接正在运行的业务页面，不另开同场景。Cesium 1.143，1264×805，resolutionScale=1。
- 当前实际使用 SMAA；TAA 未启用。自定义阴影 4096、单级、距离 4000、每 3 帧更新，shadowStatic=false。
- 每组预热 120 帧、记录 300 帧；移动组小幅左右转动后恢复相机。
- 直接统计 WebGL 绘制调用；CPU 包围 Scene.render 和主要阶段；GPU 使用项目现有 GpuTimer，轮换查询整帧/阴影/环境/AA。每项 75 个有效查询，排空 pending，未出现 disjoint 丢弃。
- 表中的帧间隔是两次 Scene.render 开始之差，不能等同于显示器实际呈现间隔。P95 表示 95% 样本不超过该值。
- 同机存在其他 GPU 应用，各轮 GPU 时间有漂移；短测不能代表全天负载或保证稳定 60 FPS。

## 已证实的第一优先级：静态阴影被树木时间参数持续打断

业务场景当前采样中，基础绘制约 869 次；阴影重绘额外提交 571 个 caster，使重帧达到 1440 次。每 300 帧有 100 帧重绘阴影。

开启 shadowStatic 单独测试没有收益。运行时比较缓存签名发现：固定树木的 u_time 持续增加，使整个签名变化；并非本次猜测的 SKINNING/MORPH/CUSTOM_VERTEX 拒绝条件。

源码依据：

- `src/instances/FixedTreeCollection.js:258`：固定树木设置 windStrength=0、windFrequency=0。
- `vendor/cesium-ez-tree/src/EzTree/EzTreePrimitive.js:489` 与打包 runtime.js:532：u_time 无条件返回当前时间差。
- `vendor/cesium-ez-tree/runtime.js:6114`：风形变要求 windStrength>0 且 windFrequency>0。
- `src/shadows/ShadowCache.js:24`：缓存签名读取所有活动手动 uniform；任何变化都会阻止整级复用。

临时实验仅对 windStrength=0 的树木稳定时间 getter，并开启静态缓存，保留全部阴影绘制结果。实验后恢复 getter 和原配置。

| 条件 | 帧间隔 P95 | CPU P95 | 每帧绘制峰值 | 阴影重绘/300 帧 |
| --- | ---: | ---: | ---: | ---: |
| 原时间逻辑 + shadowStatic | 23.0 ms | 22.5 ms | 1440 | 100 |
| 零风力树木稳定时间 + shadowStatic | 19.1 ms | 18.6 ms | 869 | 0 |
| 恢复原时间逻辑 + shadowStatic | 23.1 ms | 22.7 ms | 1440 | 100 |

实现建议：在树木 uniform 的产生位置让关闭风动画时的时间稳定，同步 vendor 源码和 runtime；不要让通用 ShadowCache 忽略所有时间 uniform。然后让符合静态契约的业务场景使用已有缓存。修改纹理/实例内容、光源和动态对象时必须正确失效；若持续存在动态 caster，再考虑静态/动态阴影分离，避免先建第二套缓存系统。

验收：静态视角/光源/资源不变时，预热后无周期性重绘；移动对象、光照变化和实例更新时阴影正常；重新启用风动画仍更新。至少记录固定视角、移动视角、动态对象三类帧时间。

## 其他实测结果

完整基线：帧间隔 P95 22.6 ms，CPU P95 22.2 ms；临时关闭阴影时分别为 16.9 ms 和 13.5 ms。后者是定位对照，不是最终画质配置，也不是缓存优化能必然达到的值。

SMAA GPU P95 约 0.14 ms，环境通道约 0.84 ms。降低分辨率或单纯缩小阴影贴图没有消除 CPU 重帧；当前优先处理阴影提交与主场景提交，不优先替换抗锯齿。树木已分组为约 50 条提交记录，不应把已有树木分组当作尚未完成的主要优化。

## 第二优先级：减少贴图显存占用和同机竞争

RTX 3070 总显存 8192 MiB，采样时整机占用约 7.6 GiB（约 95%）；Windows 进程计数器快照中 Edge 约 3795 MiB、承载业务页的 Chrome GPU 进程约 2800 MiB。没有捕获驱逐/换页证据，不能宣称已证明爆显存导致卡顿。

模型统计按纹理 ID 去重为 1740.28 MiB、358 个纹理；这不包含全部地形、帧缓冲和驱动资源。

- 计算中心模型纹理合计约 296.75 MiB，其中 4096×8192 RGBA 未压缩纹理约 170.67 MiB，4096×4096 约 85.33 MiB。
- 学生第八宿舍约 274.17 MiB，包含两张 4096×4096 未压缩 RGBA 纹理。

实现建议：优先处理上述大纹理，按实际观察距离降分辨率，并使用 Cesium 支持的 KTX2/Basis 压缩路径；保留原资产，验证压缩后的运行时 pixelFormat、sizeInBytes 和近景画质，不能把文件下载体积下降当成显存收益。基准测试应避免多个同类大型 WebGL 页面同时争用显存；本次没有关闭用户程序。

## 第三优先级：主线程提交和首次可见长停顿

移动组捕获两次 Scene.render CPU 阻塞约 349.2 / 447.5 ms。最严重帧的 updateAndExecuteCommands 占 446.4 ms，阴影阶段仅 0.1 ms且未重绘，说明该次长停顿不能解释为阴影重绘或 TAA。

后续 V8/native-call 采样未重现该极端停顿；捕获两次 ShaderProgram._bind 约 7.4 / 5.9 ms，内部 getProgramParameter 约 6.4 / 5.2 ms。能证实首次着色器状态查询存在等待，不能据此把先前 447 ms 全部归因于着色器编译。

CPU profile 的主要自身开销包含 CCR dispatcher、Cesium uniform 提交、可见集构建、裁剪和 GL 状态绑定。已有 direct-submit/batching 选项在本页关闭，但不能仅打开开关就宣布优化完成；需确认该业务路径真正接入、真实 draw count 与 CPU 时间下降，并覆盖透明、拾取、阴影、树木的兼容性。

实施顺序：先消除已证实的周期阴影提交；再复测原生场景的长帧，记录 shader 首次链接、纹理上传和 GC 事件，按归因处理。不要通过每帧 gl.finish/getError 或同步读回诊断，这会引入新的停顿。

## 预期和边界

第一项已在运行时 A/B/A 实验中将帧间隔 P95 从约 23 ms 降至 19.1 ms，绘制峰值降低约 40%；这是临时实验结果，尚未形成生产补丁。60 FPS 的预算为 16.7 ms，仍需降低主场景 CPU 开销并消除长停顿，不能承诺仅修缓存便锁定 60 FPS。

FPS 小窗的 `(0–61)` 是面板创建以来的最小/最大值（examples/js/stats.module.js:144），可能包含加载阶段，不能拿它量化当前波动。验收使用预热后的帧间隔 P50/P95/P99、超过 33.3/50 ms 的次数及实际绘制数。

证据文件：focused-report.json、cache-proof-report.json、cache-textures.json、stalls.json、cpu.cpuprofile；对应临时测量脚本一并保留。脚本连接的是当时的 CDP 端口，重跑前须更新连接并核对当前 Viewer。
