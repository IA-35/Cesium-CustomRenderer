# 悬停同步 GPU 回读长帧修复

日期：2026-10-20。实际页面：`http://127.0.0.1:81/#/campus`，70 个建筑 Model ready，1264×805，Cesium 1.143 / WebGL2 / SMAA。用户重新登录后采集，不是独立空场景。

## 已确认的阻塞点

旧 HoverHighlight 每约 50 ms 调用一次同步 `scene.pick()`。相同鼠标路径中捕获一次 pick=4133.3 ms，其中 `gl.readPixels`=4130.7 ms；开启静态阴影缓存后重复旧悬停逻辑，仍捕获 readPixels=2841.7 ms。这是直接的同步 GPU 回读阻塞证据，不能用普通颜色渲染帧的约 20 ms CPU 耗时解释，也不能靠体积云降精度消除。

静态阴影未启用时仍每 3 帧重复绘制约 521 个 caster；树木已关闭投影，静态缓存能够命中。

## 修改

业务仓库 `src/views/IAsCesiumLib/hoverHighlight.js`：

- 使用 Cesium 自带 `Scene.pickAsync`。本机固定 WebGL2 路径调用 `PickFramebuffer.endAsync` / `Context.readPixelsToPBO` / `Sync.waitForSignal`，通过 PBO 和 GPU fence 异步取回结果；没有自建拾取渲染器或同步回退。
- 最多一个拾取请求在途，移动期间合并为最新位置，保留原 50 ms 最小发起间隔，不积压请求。
- 请求序号和身份检查丢弃过期结果；移出、停止、重新绑定后旧请求不能重新高亮或清除新请求。
- 原 feature table 未就绪异常仍受原窄条件处理；有效请求失败会报告并释放槽位，不用同步 pick 兜底。
- 停止后释放控制器的 Viewer 引用。

业务 `src/views/IAsCesiumLib/lib/ViewerUtils.js`：开启 `shadowStatic:true`。复用已有完整缓存校验，保留相机、光源、模型矩阵、材质与新增资源的失效路径；车流已有 invalidateShadows 调用。本轮没有修改 Cesium、CCR shader 或重打包 SDK/业务 dist。

## 实际复测

计时只包围 Scene.render、阴影阶段和相关 GL 调用，没有开启 V8 CPU Profiler。连续移动同一鼠标路径，检查同步 pick、异步 pick 和 PBO 回读；运行结束还原插桩和临时配置。

| 场景 | 帧数 | 帧间隔 P95 | P99 | >50 ms 帧间隔 |
| --- | ---: | ---: | ---: | ---: |
| 修改前悬停，原阴影配置 | 650 | 150.5 ms | 1669.3 ms | 87 |
| 修改前悬停，仅临时开启静态阴影 | 622 | 202.8 ms | 422.3 ms | 77 |
| 修改后固定视角 | 415 | 20.9 ms | 25.1 ms | 0 |
| 修改后悬停第一轮 | 635 | 23.3 ms | 30.6 ms | 0 |
| 修改后悬停第二轮 | 581 | 22.2 ms | 27.4 ms | 0 |
| 修改后相机回扫，较小角度 | 361 | 24.1 ms | 30.0 ms | 0 |
| 修改后相机回扫，原测试角度 | 601 | 23.2 ms | 28.4 ms | 0 |
| 修改后反方向相机扫描 | 601 | 22.1 ms | 27.6 ms | 0 |

上述中间稳态记录合计 3194 帧，无 >50 ms 间隔，也没有 PerformanceObserver Long Task。异步 PBO 的 getBufferSubData 在两轮悬停中最高约 7.5 / 10.6 ms，未出现秒级等待。固定视角阴影重绘为 0；移动相机时仍按需重绘。

测试期间另有并行配置改动：ViewerUtils 的 shadowSize 从 4096 改为 2048，Tileset 默认 shadows 从 ENABLED 改为 DISABLED。这两处不是本轮提交的修改，已保留；因此跨热更新的数据不能作完全同配置的性能对比。检测到 Viewer/context 重建后，最终增加实例身份校验，在同一个 context `654f139d-5984-4c30-84f5-bdad89dcd955` 连续测量：

| 最终同实例采样 | 帧数 | 帧间隔 P95 / P99 | >50 ms |
| --- | ---: | ---: | ---: |
| 固定视角 | 391 | 19.5 / 22.4 ms | 0 |
| 悬停 | 592 | 21.8 / 27.0 ms | 1 |
| 重复悬停 | 575 | 21.2 / 24.6 ms | 0 |

三组 sameViewer 均为 true，contextId 一致；共 1558 帧仅 1 个 >50 ms 间隔。该次事件明确包含一个冷 shader 的 getProgramParameter=45.1 ms、shaderBind=45.6 ms、pickAsync 同步入口=49.9 ms，属于首次 shader 初始化；重复路径冷 shader 数为 0。没有同步悬停 readPixels 的秒级等待。这证明频繁同步回读问题已修复，不代表所有首次编译峰值均已消除。

视觉/交互检查：鼠标停在中心食堂上正常高亮，alpha=1；移出后恢复。页面仍为单 Viewer、70 个建筑就绪、shadows=true、shadowStatic=true。测试没有触发点击业务操作，点击逻辑未改。

## 不应混入最终稳态结论的数据

- 修改后的第一轮自动采样跨过开发热更新后的加载阶段，捕获了约 1 秒的冷 shader getProgramParameter 等待；原始数据保留在 `after-loading.json`，不作为稳态改善数字。
- 首次未做内层计时的相机扫描记录到 599 帧中 94 个 >50 ms 间隔，最大 2549.3 ms（`interaction-first-scan.json`）。当时没有对应 GL/CPU 内层证据，**无法确定具体原因**。随后给原生调用加计时，重复同范围及反方向扫描均未复现，见上表。不能用复测零长帧抹去首次扫描事实，也不能把它直接定性为编译或上传。
- 在与首次扫描相同的 preUpdate 相机更新方式下补测 601 帧，记录 2 个 >50 ms 间隔。其中一帧明确捕获新 shader getProgramParameter=574.8 ms；此时程序 ID 和后续 context 检查表明测试期间出现了场景重建。该记录保留在 moving-preupdate.json，不混入同实例最终稳态数字。
- 旧同步悬停测试因阻塞持续更长，帧数和时长不完全相同；表中次数是各次实际采样窗口计数，不是固定分钟发生率。

## 检查与边界

`node --test tests/hover-async.test.cjs tests/map-lifecycle.test.cjs`：17 项通过，含在途合并、迟到结果、移出、停止/重新绑定、异常恢复以及已有生命周期/楼层加载测试。业务 dev 页面编译生效，实际功能检查和稳态原生调用计时均完成。

已消除本次稳定复现的同步悬停阻塞并减少静态阴影重复工作。首次进入新视角、资源加载、冷着色器编译以及其他应用争用 GPU 的峰值不在“全部消除”的承诺内；首次扫描异常仍有未完成归因。没有进行长时间全场景验收，也不能宣称所有设备稳定 60 FPS。
