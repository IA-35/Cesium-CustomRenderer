# 长帧追查：2026-10-20

目标仍为 81 端口校园业务页面。本轮仅诊断，未修改生产源码、发布包或画质配置。

## 数据必须分开解释

1. 第一轮使用全 GL 方法计时和浏览器 GPU trace，插桩开销明显，不能将该轮的 30–50 ms 帧时间当作原生性能。采样结束、导出过程中 Viewer 被重建；用户确认修改了初始 Viewer 配置。其后观察到 ShaderProgram._bind 219–636 ms，属于重建加载阶段，不能作为正常运行频繁卡顿的证据。旧 Viewer 的相机恢复报错，已回收诊断数据、移除方法包装，没有向新 Viewer 应用旧相机或配置。
2. 第二轮仅计时少数 GL 查询/上传和渲染阶段，并开启 V8 CPU sampling，约 45 秒、2210 帧，Viewer 未重建。没有冷 shader bind，也没有大于 5 ms 的被监测 GL 调用。
3. 第三轮去掉 CPU sampling 和 GL 调用包装，记录 Scene.render、独立 requestAnimationFrame 心跳、20 ms 定时器及浏览器 timeline。约 30 秒、1772 帧，Viewer 未重建、页面可见且获得焦点，没有超过 50 ms 的帧间隔，也没有 Long Task。该轮仍有 timeline 记录开销，并非零开销基准。

## 已证实：93.5 ms 的单帧含较长垃圾回收

第二轮 frame 509：Scene.render 93.5 ms，submit 91.7 ms，shadow 9.7 ms。

使用第三轮 user timing 的 `startTime` 和 trace 单调时钟 ts 对齐同一页面的 V8 profile；该帧时间窗口内约 57.6 ms 的采样落在 `(garbage collector)`。随后帧起始处记录的 JS 堆由 1,521,796,646 bytes 降至 1,073,641,625 bytes（约释放 427 MiB）。采样时间不是精确 GC event 持续时间，但足以将该帧的大部分阻塞归于回收。

这是 Viewer 重建之后出现的一次较大回收，不能据此宣称存在持续泄漏，也不能把它归因于某一模块的分配。应验证旧 Viewer/模型/事件和缓存的生命周期，并减少稳态每帧临时对象，不应手动强制 GC。

## 已证实：周期性阴影增加主线程负载

第二轮 CPU >33.3 ms 共 15 帧，全部发生在阴影重绘帧；全局没有冷 shader bind。第三轮：

| 指标 | 数值 |
| --- | ---: |
| 总帧数 | 1772 |
| 阴影重绘帧数 | 591 |
| 整体 CPU P50 / P95 / max | 14.2 / 21.9 / 33.0 ms |
| 阴影重帧 CPU P95 | 24.5 ms |
| 非阴影重帧 CPU P95 | 18.2 ms |
| 帧间隔 P95 | 22.5 ms |
| >50 ms 帧间隔 | 0 |

配合此前零风力树木稳定时间的 A/B/A 结果，第一项生产优化应是修复该时间参数、正确使用现有静态阴影缓存；不是增加更新间隔把同样重的工作移到更少的帧。

## 尚未归因：带采样器时出现的帧间空档

第二轮观察到 28 个 >50 ms 帧间隔，其中多数是上一帧已在 12–23 ms 内完成、之后出现较长空档。同期仅有上述 94 ms Long Task，没有其他相应 JS 长任务。最长的约 575 ms 空档出现在 Profiler 启动附近；其余空档也未在去掉采样器后的第三轮复现。

运行时确认：requestRenderMode=false、targetFrameRate=undefined、useDefaultRenderLoop=true、文档 visible 且有焦点。没有证据支持 Cesium 配置主动限帧，也不能确定是浏览器调度、GPU/系统竞争或诊断扰动。28 次不能当作无插桩时的真实卡顿频率。

## 优化顺序与验收

1. 修树木无风状态时间参数，启用符合静态契约的阴影复用。保留光源、对象变动和风动画失效语义。验收常态阴影重绘次数、帧间隔 P95/P99、动态阴影正确性。
2. 减少重复绘制和每次提交的临时对象。CPU sampling 的热点含 dispatcher、uniform、裁剪、纹理/VAO 绑定；这支持降低提交量，但不证明所有 GC 对象来自 dispatcher。先减少重复阴影，再测稳定场景分配率，避免直接建立大对象池或重写整个管线。
3. 场景重建独立验收：确认旧资源释放、避免不必要的 Viewer 重建；按预算处理新 shader/纹理首次使用。当前证据仅支持重建阶段有冷绑定长停顿，稳态样本不支持反复编译假设。
4. 继续处理报告列明的大纹理，以降低显存压力；本轮仍未抓到显存驱逐，不能将其作为已证实长帧根因。

后续真实业务验收应关闭 CPU sampling / 全 GL 插桩，分别进行静止、鼠标悬停、相机移动和场景切换，并记录超过 33.3/50/100 ms 的间隔次数。当前静止短测不能覆盖所有交互。

证据：longframes-light.json、longframes-light.cpuprofile、scheduling-frames.json、longframes-evidence.json。原始完整 trace 留在系统临时目录 ccr-longframes-20261020 和 ccr-scheduling-20261020，避免将数百 MB 的诊断记录加入项目。
