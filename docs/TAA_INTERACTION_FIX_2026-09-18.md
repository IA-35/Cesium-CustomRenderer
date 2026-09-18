# TAA 与业务交互修补

本轮修复：TAA 下悬停高亮失效、点击轮廓随采样抖动、移动镜头时 POI 拖影。没有修改混合权重、模型、植被分支或业务默认 AA 配置。未提交或推送 Git。

## 原因和修改

1. **悬停失效**：原来在 `preUpdate` 写入主相机采样偏移，随后的 Cesium `View.checkForCameraUpdates()` 连同 frustum 比较相机，每帧采样被当作持续运动，业务 hover 长期暂停。现在偏移仅在 `preRender` 到 `postRender` 的绘制区间存在；导航和绘制外的公共拾取看到稳定相机。后续按用户要求，已在业务端取消拖动／移动期间暂停 hover 以及移动开始时清除悬停的限制；TAA 的相机时序修补继续保留。
2. **轮廓抖动**：TAA 颜色已经重建到稳定显示网格，但 silhouette 读取的 ID 图仍逐帧抖动。现在 ID framebuffer 使用不含 Halton 偏移的视锥；进入 TAA 时恢复颜色采样投影。TAA 下不再复制抖动主深度到稳定 ID 缓冲，使用原生 ID 遮挡绘制；其他 AA 的深度复用优化不变。
3. **POI 拖影**：Billboard/Label 没有适用于场景 TAA 的表面运动/深度，混入历史会错误重投影。新增 `TaaOverlay143`，延后原生 Billboard/Label/PointPrimitive 主颜色命令，TAA 后、色调映射前，在独立目标中以稳定投影合成。历史颜色/深度不含 POI；原生拾取、ID 绘制和深度遮挡保留。业务 POI 无需逐个改配置。

## 修改范围

- `src/antialiasing/TaaPass143.js`：采样时序、POI 合成与销毁、诊断内存统计。
- `src/antialiasing/FrustumJitterBridge143.js`：稳定 ID 投影与颜色投影恢复。
- `src/antialiasing/TaaOverlay143.js`：按原生集合类型延后 UI 绘制，复用原生着色器和场景深度。
- `src/VisualPipeline.js`：TAA 下选择 ID 快捷路径的回退条件（一处修改，其他既有改动保留）。
- TAA 时序/ID 回归测试，以及业务项目 `tests/taa-business-interaction.cjs`、`tests/taa-poi-motion.cjs`。
- 重建 SDK 并同步业务 `ruoyi-ui/public/js/CCR.min.js`；本轮未改业务 hover、ViewerUtils 或 Cesium 核心补丁。

## 验证

修复前先复现失败，再验证候选包与业务服务实际交付包：

- 原版静止相机仍处于 moving 状态、frustum 偏移非零；修复后 moving=false、偏移 `[0,0]`，拾取恢复。
- 真实 MainMap、真实模型和鼠标移动：hover feature 恢复 `#B5FFFF` 高亮，外轮廓启用。真实点击后轮廓仍启用；1280×720 ID 图跨 16 个 TAA 帧的字节差 **0**，非空像素约 54 万，排除空图假阳性。
- 640×360 运动/静止同姿态对照：旧版图标残影 **41px**、文字残影 **247px**、文字缺失 **36px**；修复后均为 **0**。使用同一 TAA 路径对照，避免将原生 OIT 与单独 alpha 合成在图集半透明边缘的覆盖差异误判为历史残影。
- OIT、排序透明两条路径均验证图标、文字和遮挡：背景箱体后的图标像素 **0**；设置 `disableDepthTestDistance` 的图标/标签仍正常。
- 3 轮 TAA/FXAA 切换：旧 UI 目标销毁、借用的原生深度未销毁；640×360 → 480×270 → 640×360 正常；Viewer 销毁正常。
- 33 项 TAA/选择相关单测通过。全套 680 项中 **678 通过、2 项失败**：均位于未修改的 `campus-business-assets.test.mjs`，硬编码 `localhost:9528` 和 `maximumScreenSpaceError:128`，与既有校园示例配置不符。未修改这些断言或示例。
- SDK 构建通过，业务服务交付字节与磁盘/构建包一致。补丁 SHA-256：`4e37f3fb729b82e00e67b4233ce149c96ec5e5d36754bf32720f5354ef72e6ec`。

日志、JSON 和截图保存在业务项目 `plan/evidence/taa-interaction/`（既有忽略目录）。`before.json` 记录相机误判，`poi-before.json` 记录旧版残影；`deployed.json`、`poi-deployed.json`、`poi-deployed-sorted.json` 是实际交付包结果。`CCR.pre-deploy.js` 保留部署前业务包。

## 性能和边界

- 有 POI 时增加一次全屏颜色复制和一个 UI 目标；POI 原主颜色命令被延后，并非再重画一次三维场景。无 POI 绘制时不分配目标、不复制。
- 通常 RGBA16F 下额外占用：1280×720 **7.03MiB**，1920×1080 **15.82MiB**。FLOAT 回退用量翻倍；诊断 `taa.overlay.bytes` 和 `taa.bytes` 已计入。
- **TAA 有选择轮廓时，原生稳定 ID 遮挡绘制比旧深度复制快捷路径开销更高。** 这是保证轮廓遮挡和稳定性的取舍，未宣称全量场景 60fps；其他 AA 仍使用原快捷路径。
- 独立 UI 合成范围为单视锥透视 HDR、MSAA=1。没有宣称解决所有动态蒙皮、粒子和水面的 TAA 拖影，既有不支持路径继续回退。
- 基于 Cesium 1.143 私有接口，升级引擎需要重验。
