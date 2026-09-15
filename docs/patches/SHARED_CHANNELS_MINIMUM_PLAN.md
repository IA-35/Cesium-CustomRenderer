# 最小共享几何通道：设计与执行计划

日期：2026-09-09。承接 `CESIUM_RENDERING_PIPELINE_HANDOVER.md` 第 2 步。本轮目标是可复现的 AO/反射前置数据验证，不把调试通道称为 AO 或完整 GBuffer。

## 选择与范围

采用 Cesium 1.143 原生后处理深度，增加独立实验模块；默认业务管线不启用。相较额外几何 Pass，不重复绘制校园资产；相较直接改造 MRT，不触及所有材质、MASK、蒙皮和 OIT。代价是只能得到当前可用深度的几何法线，无法得到材质法线、粗糙度、金属度或透明表面分类。后两条路径留待本阶段证据支持后决定。

普通用户 stage 位于原生 Tone Mapping 之后，输入颜色是显示颜色，不作为 HDR。输入深度为原始 depth-stencil texture 的 R 通道，借助 `czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth)` 处理当前投影与 LOG_DEPTH，转换为正米制 `-positionEC.z`。浏览器实测发现直接调用 screen 入口不会触发此版本的函数依赖注入，已用生成后 ShaderSource 回归验证 window 入口。

单个全分辨率 RGBA32F 纹理：RGB 为编码到 [0,1] 的视空间几何单位法线；A 为正米制视深度；A=0 表示无效（天空、边界邻域不足、退化法线或不支持的场景）。五点采样选取较短左右/上下差分，减少轮廓跨面污染。无时间缓存，无降采样，无模糊，不称为材质法线。

Composite 包含数据生成与显示/透传两个 stage，`inputPreviousStageTexture:false` 使末级仍能访问原场景颜色，按名称引用数据纹理。不复制额外 HDR，不使用 CPU 每帧读回。数据只在当前帧、启用期间有效；resize、禁用、销毁交给 Cesium stage texture cache。RGBA32F 本体在 1080p 约 31.64 MiB；末级 RGBA8 约 7.91 MiB，另行报告实际资源。

门禁：Cesium 1.143、depthTexture、floatingPointTexture、colorBufferFloat。仅单视锥、3D 场景有效；多视锥时输出无效并保留场景颜色。不能把最近视锥深度称为跨视锥共享深度。BLEND/OIT 颜色可能与不透明深度不匹配；水、玻璃反射材质遮罩尚缺失，不进入反射合成。

## 执行与验收

- [x] 重跑 `npm run check:cesium`、`npm run test:rendering`、`npm run build:prod`：392 哈希、30 测试、构建均通过。
- [x] 重跑现有 shadow-fixture 浏览器检查：11 项通过，无 renderError。
- [x] 新建 `src/rendering/cesium/channels/ScreenSpaceGeometry143.js`，以独立类管理 stage、开关、调试模式和诊断；新增 12 项 Node 生命周期/门禁/ShaderSource 测试，已先红后绿。
- [x] 复用阴影 fixture 的模型生成、帧等待与已知坐标，新增 geometry 检查页。16 项 GPU 检查通过，覆盖已知平面的米制深度/法线、天空（MASK 孔洞背景）、相机移动、LOG_DEPTH 开关、多视锥拒绝、resize、十轮创建/销毁及原色透传。
- [x] 校园 preview 增加实验开关/调试模式和测量配置，确保采样中不可改配置；同一 1080p 相机分别测关闭/开启 60 秒并保留 P95、drawing buffer、窗口审计和资源信息。**仅参考采样：操作系统前台条件未满足，正式性能验收仍未完成。**
- [x] 记录可比较画面与实际限制，更新交接入口和模块 README；独立审查发现的全过程 tilesLoaded 校验遗漏已修复并复查；42 项渲染回归、资源哈希和生产构建通过。

验收通过只代表最小几何通道可行；下一阶段仍需 AO 边缘保护降噪、材质遮罩、HDR 接入时机及真实水面/玻璃样本，不默认开启效果。
