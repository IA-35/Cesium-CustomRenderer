# TAA 选中轮廓抖动修复（2026-09-21）

## 原因与改动

Cesium 1.143 的原生 EdgeDetection 同时使用选中 ID 和深度梯度。CCR 已将 ID 通道稳定在无 jitter 的屏幕网格，但轮廓仍读取带 Halton 偏移的主颜色深度。单测只证明 ID 稳定，无法证明最终轮廓稳定。

`TaaSelectionDepth143.js` 在原生选中边缘阶段执行时，使用同一帧 ID framebuffer 自带的深度纹理。TAA 仍对场景颜色执行全部子像素采样。没有新纹理、额外几何提交或场景重绘，也没有改动轮廓颜色、阈值及 hover/点击逻辑。

仅匹配 Cesium 原生 edge detection 叶节点，要求实际选中对象、当帧成功的 TAA resolve、有效 ID 通道和匹配的 ID 纹理。其他后处理保留原深度。每帧通过 finally 恢复 stage.execute；关闭 TAA/销毁时释放 collection hook，并保留外部包装的所有权。适用范围继承当前 TAA 的 Cesium 1.143、透视相机、单视锥约束。

## 验证

- `node --test tests/rendering/*.test.mjs`：706/706。
- `scripts/check-taa-silhouette.cjs`：无外部资源的真实 GPU 夹具；修复前 ID 差异 0，但轮廓每帧最多变化 646 像素；修复后连续 16 帧轮廓及最终合成的青色描边差异均为 0。移动后停止、FXAA→TAA、取消选中均通过。ESM 与 UMD 分别通过。
- `taa-selection-depth.test.mjs`：无效深度、过期 ID、空选择、关闭 TAA、异常退出、继承方法与第三方 hook 的回归。
- 业务宿主：81 端口对应 `G:/_JavaScript/2026——东北大学/startel_dongda_campus_tour/ruoyi-ui`。真实 MainMapView、70 个 GLB、实际鼠标悬停/点击，业务 API 使用空响应夹具，未执行登录后完整业务验收。
- 业务旧包：点击后连续 16 帧，最多变化 6408 个轮廓像素；镜头转向停止后最多变化 6492 像素，8 帧循环重复。
- 修复包：上述两组均为 0 像素变化；轮廓分别包含 14233 / 13915 个有效像素，hover 生效，TAA valid，0 页面/渲染错误。

本机证据：本仓库 `docs/verification/taa-silhouette/{before,report,umd}.json` 和 `unit-tests.log`；业务仓库 `docs/verification/taa-silhouette/` 的前后报告与截图。旧业务包留存为 `CCR.before.min.js`。

运行 GPU 验证前启动 `node scripts/dev-server.cjs --port 8877`，设置 `CESIUM_PLAYWRIGHT` 为可用 Playwright 模块路径；脚本使用本机 Chrome。可通过 `CCR_TEST_BUNDLE` 指定 UMD 包进行同一套检查。

本次是消除静止时随 Halton 周期跳变的修复。屏幕空间单像素轮廓在真实相机移动时仍会随几何投影改变覆盖，不宣称实现轮廓自身的时间超采样；自定义业务 edge shader 不在自动替换范围内。
