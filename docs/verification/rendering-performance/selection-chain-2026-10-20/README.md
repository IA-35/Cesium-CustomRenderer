# 拾取 → 染色 → 选中列表 → 外轮廓链路检查

2026-10-20。页面 `http://127.0.0.1:81/#/campus`，70 个建筑，当前 AA=TAA、shadowStatic=true、shadowSize=2048。不能把此前 SMAA 的鼠标实验直接当作 TAA 外轮廓的结论。

## 调用链与控制实验

业务 HoverHighlight 的正常悬停链路为异步 pick → feature/model 颜色更新 → 保存悬停目标。MainMapView 当前没有给悬停设置 onTargetChange 轮廓回调；updateSilhouetteSelection 只使用点击/业务选中的 curPick，不使用 hoverHighlight。因此当前悬停染色和点击外轮廓必须分开检查。

所有对照使用同一 Viewer/context `814e7d05-3c5f-4f3a-b02e-319d65f81c35`。测试临时停用原悬停控制器，使用同一份生产 HoverHighlight 源码，分别屏蔽拾取结果的下游、注入固定模型进行纯染色、以及通过业务方法切换选中对象；结束后恢复原控制器并调用已有 clearSelection。

目标为可见的“南湖在建建筑”（1 个 pick ID）与“图书馆”（39 个 pick ID）。GL draw 直接计数，单独识别 ID framebuffer；同时记录 Model.resetDrawCommands、冷 shader bind、选中纹理身份和轮廓 program 变化。没有使用 CPU Profiler。

| 修复前控制组 | 帧数 | 每帧绘制中位数 | ID 绘制中位数 | 模型命令重建 | 选中纹理重建 | 帧间隔 P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 无交互 | 238 | 869 | 0 | 0 | 0 | 19.6 ms |
| 仅异步拾取、不应用高亮 | 384 | 869 | 0 | 0 | 0 | 19.6 ms |
| 仅颜色高亮、不拾取 | 369 | 869 | 0 | 0 | 0 | 18.3 ms |
| 正常悬停 | 386 | 869 | 0 | 0 | 0 | 19.7 ms |
| 固定外轮廓、不拾取 | 207 | 1721 | 850 | 0 | 414 | 24.0 ms |
| 切换外轮廓、不拾取 | 206 | 1721 | 850 | 0 | 412 | 25.6 ms |
| 清空选择 | 242 | 869 | 0 | 0 | 2（关闭阶段） | 17.7 ms |

首次轮廓启动还会首次编译全场景 ID shaders。初轮改变选中对象时捕获轮廓 shader 冷初始化约 154.6 ms；后续热缓存对照不能用来否认这一首次开销。

## 明确发现

1. **当前 TAA 的外轮廓通道约增加 850 次绘制。** VisualPipeline 对 TAA 禁用了复制主深度的 SelectedIdPass 快捷路径；FrustumJitterBridge 为原生 ID pass 去除抖动，TAA 主颜色深度却带抖动，直接放开深度复制条件会破坏遮挡一致性。额外绘制是一个明确的持续开销，本轮没有简单移除该保护。
2. **选中 ID 纹理每帧重建是缺陷。** 当前 Cesium PostProcessStage.isSelectedTextureDirty 中 parentLength 取到了父级数组本身，之后却与缓存的数值长度比较。即使选择未变，子阶段仍被判脏。
3. **绘制命令替换未释放旧 shader 缓存引用。** createDrawCommand 每次建立新 quad，但旧 command 的 shader 引用没有释放。相同源码通常会命中 shader cache，所以不能称为“每帧重新编译 GPU shader”；实际是反复建命令/纹理、引用计数持续增加，最终释放不完整。修复前一个轮廓 shader 的 count 已达到 12297，选择循环后继续增加。
4. **颜色高亮没有出现相同问题。** 当前白色基态预置了 Model 颜色路径，MIX/HIGHLIGHT 与 RGB 调整使用 uniform；本轮纯染色与悬停组 Model.resetDrawCommands=0，没有 ID 绘制。

此前同步 pick 的 readPixels 阻塞仍是已观察事实，但它只指出主线程的等待位置。它既不能排除上游 GPU 工作造成的压力，也不能替代当前外轮廓链路的检查。

## 已落地的修复

`src/selection/SelectedIdPass143.js` 增加场景实例级兼容处理：

- 仅在已上传的父级选中列表确实不变时，修正 native dirty 比较输入；替换列表、原地改元素、长度变化、异步内容追加/替换 pick IDs、重新启用仍正常更新。
- 每次 native quad command 被替换后，释放旧 command 的 shader cache 引用；禁用阶段沿用 native 释放，避免重复释放。
- 处理 collection.remove 到下一次 native update 之间的空槽，支持动态添加/移除阶段；卸载恢复自己的包装，不覆盖后来安装的第三方包装。

`VisualPipeline.destroy()` 补充销毁 SelectedIdPass，使新的阶段包装和既有绘制观察器随管线释放。

没有修改业务的拾取/染色/轮廓交互方式，没有更改 TAA 抖动或深度语义。

## 修复后验证

同一实例临时应用生产兼容代码：固定轮廓 217 帧只创建 2 个选中纹理（初始化），不再每帧重建；切换轮廓 210 帧创建 18 个纹理，只在选择变化时更新。原已有的 shader 引用泄漏不会被强行清零，但新计数停止增长。绘制次数仍为 1721/850，缓存修复并未消除原生全场景 ID pass。

重建并加载新版 SDK 后又做了独立生命周期验证：图书馆 39 IDs，等待 90 帧后继续 180 帧，两个轮廓子阶段的纹理、command 身份均不变，shader 引用计数均为 1；切换中心食堂 5 IDs 后计数仍为 1，等待 Cesium 原生每 121 帧执行的 shader 清理周期后，旧程序均 isDestroyed=true；清空后 usePostProcessSelected=false、轮廓 disabled、两个子阶段的 command 和选中纹理都释放。页面仍有 70 个就绪建筑，未捕获 pageerror。

46 项定向测试通过，覆盖稳定列表、原地修改、禁用重启、空槽、第三方包装、管线生命周期和 TAA 轮廓深度。构建成功并同步业务 public/js/CCR.min.js。最终 SHA-256：`f573d5b640361477362fee2f515804d7860a37a5cb9fccf3b840cb565b3ef46e`。

## 证据与限制

- before.json / after.json：同实例分离控制实验；deployed.json：重新加载后的引用与资源验证。
- tests.txt：46 项测试；probe.cjs：控制实验脚本；verify-deployed.cjs：运行时复用与释放断言。
- 最初一次探针误用 highlightBuildingsByName('') 清空选择，该业务方法会直接返回；因此初轮 idle-repeat 实际没有关闭轮廓，已弃用该组，改用现有 clearSelection 重测。表格只使用纠正后的完整控制实验。
- 本轮修复缓存缺陷，**尚未消除 TAA 原生 ID pass 的约 850 次额外绘制**，不宣称全部长帧或首次 shader 编译峰值消失。CPU 时间线和 GPU 工作链路需分别归因。
