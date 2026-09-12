# 渲染诊断（Cesium 1.143）

这些工具显式启用，不由 VisualPipeline 默认安装。用于 `1.txt` 阶段 0 的性能定位，不代表延迟渲染、UBO 或遮挡剔除已经实现。

## 异步 GPU 与绘制量

```js
import RenderProfiler143 from './RenderProfiler143.js'
const profiler = new RenderProfiler143(Cesium, pipeline)
// 让场景运行若干帧后读取；正式帧间隔基准必须在不启用 profiler 时单独运行。
const report = profiler.getReport()
profiler.destroy()
```

- `gpu` 使用 `EXT_disjoint_timer_query_webgl2`，毫秒单位；只在查询可用时读取，不调用 finish 或同步等待。
- 整帧、阴影、HDR 环境与 SMAA 在不同帧轮流采样，避免 TIME_ELAPSED 嵌套。不能把各项 P95 相加为整帧 P95。
- 在创建profiler之前已创建材质通道时，会同时记录 `materials` 的MRT重放时间及四个自有纹理的字节；仍与整帧在不同帧采样。
- 已创建Hi-Z时另记录 `hiz` 和各归约纹理。Hi-Z在materials内部执行，所以启用时materials总时间包含Hi-Z，不能把两者相加。
- 已创建屏幕AO时另记录 `ao` 及去重后的AO目标纹理；该阶段在HDR协调器中、体积环境之前执行，其计时不含上游材质/Hi-Z成本。
- `cpu` 是 JavaScript 调用的提交时间；`frame` 包含子调用。它不是 GPU 执行时间。
- `frames.drawCalls` 是 Cesium Context.draw 的实际调用次数；`submittedCommands` 是 frameState.commandList 长度。二者不是可见对象数，也不等同三角形数。
- 查询未就绪时最多持有 32 个；GPU disjoint、context lost、调用抛错时丢弃受影响数据。到 4096 帧自动停止。禁用/销毁恢复自有 hooks，保留后来安装的其他 wrappers。
- `textures` 按纹理对象去重，记录已知管线纹理字节及观察到的峰值；不包含原生 MSAA renderbuffer、模型纹理、驱动开销及瞬态分配。**不是整卡或整个场景的显存峰值**。
- 无扩展时继续记录 CPU/绘制统计，GPU 支持标记为 false，不能用 CPU 数据冒充 GPU 时间。

扩展语义依据：[Khronos EXT_disjoint_timer_query_webgl2](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)。

## 可复现运行

在项目根目录启动静态服务，准备交接中的 `plan/evidence/campus-assets/` 校园资产。复用已安装的 Playwright，不自动安装依赖。

```powershell
python -m http.server 8766 --bind 127.0.0.1
# 在另一个终端；若环境已有可解析的 playwright 则不用设置这个变量。
$env:CESIUM_PLAYWRIGHT = '<已安装的 playwright 模块绝对路径>'
node tests/rendering/run-performance.cjs profile
node tests/rendering/run-performance.cjs dynamic
node tests/rendering/run-performance.cjs governor
node tests/rendering/run-performance.cjs baseline
```

每次新建 `plan/evidence/15-<mode>-<unique>/`，不覆盖历史结果。

- profile：无桌面窗口的 GPU/CPU/纹理诊断，保存浏览器版本和 GPU 信息。
- dynamic：无桌面窗口的 300 帧校园环绕、SMAA/HDR 状态、API/UI 部分更新回归。不是登录后完整业务验收。
- governor：无桌面窗口的 600 帧校园环绕，启用 `PerformanceGovernor143` 后关闭，检查启用/恢复与无渲染错误。软件光栅化下必然远低于30FPS，因此它只验证降级/恢复行为，**不是性能验收数字**。
- baseline：独立可见 Chrome，1920×1080、DPR1、固定校园全景/时间/环境动画，依次 `default-smaa1`（出厂默认）、`combined-smaa4`（显式组合）、`fxaa1`，各 60 秒。只有连续前台检查通过才开始；无法获得前台则拒绝。运行时保持该窗口前台，停止其他构建和 GPU 工作。

调优器的采样、滞回与降级/恢复规则见 [performance/README](../performance/README.md)。基准采样必须在调速器关闭时进行，否则它改变分辨率会让测量判为配置变化。

预览测量每帧比较相机、配置、buffer、时钟和暂停状态，并持续检查资源就绪、SMAA/HDR 状态和页面焦点。变化后恢复原值仍判无效。保留有序原始帧间隔及起止时间；90 秒无足够渲染会超时返回失败。

基准 JSON 的 `comparable`/`passed` **仅覆盖页面及系统前台门禁**，还需独立排除并行构建/GPU 任务、确认资产/硬件/相机一致后验收。不能依据页面 valid=true、单次截图或诊断模式的 GPU 时间宣布 30FPS 达标。阈值为帧间隔 P95≤33.3ms。
