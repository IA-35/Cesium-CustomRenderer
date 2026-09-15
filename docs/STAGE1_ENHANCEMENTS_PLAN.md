# 阶段一 HBAO、HDR Bloom、球壳云层实施计划

2026-09-14，用户已确认顺序。在 CCR 独立项目内执行，保留已有 assets、编辑器配置和示例修改。沿用既有 Cesium 1.143 数据与资源契约，不迁入旧版引擎。

- [x] HBAO：`src/ao/hbaoShader143.js` 使用现有 AO 深度/法线/透明覆盖函数，按方向记录最大地平线；`ScreenSpaceAo143` 选择算法；`presets.js` 和 `VisualPipeline.js` 提供 `setScreenSpaceAO({algorithm:'hbao'})`。保留 SSAO 默认与 A/B。Node 验证选项、切换/销毁；复用原宿主 AO 合成 GPU 夹具验证平面、斜面、接触、未知遮挡、透明边界。
- [x] HDR Bloom：新增 `src/bloom/` 的滤波 shader 和独立 HDR pass。软阈值→多级降采样→上采样→线性合成，使用现有 HdrCoordinator，位于环境之后、TAA 之前。`setHdrBloom` 提供 enabled/strength/threshold/knee/levels，默认关闭；互斥原生 Bloom，按所有权恢复。GPU 验证阈下中性、亮点扩散、HDR/alpha、零强度与 resize，Node 验证独立场景和销毁。
- [x] 球壳云：新增 `src/environment/cloudShell143.js` 的射线区间数学与 GLSL，复用环境噪声/积分/合成；新增 `cloudGeometry:'local'|'shell'`，保留局部默认。CPU 双精度准备相机相对球心，GLSL 使用稳定求交；云层高度按参考球半径定义。地球遮挡、云内外、背向、深度截断测试；远离校园时禁止局部雾污染。保留多视锥安全回退并明确诊断。
- [x] 联合验收：无 token 合成测试页使用真实 Cesium WebGL2；源码/UMD 编译和启停验证；测试三项同时启用、SMAA/TAA、resize/恢复。运行 `npm test`、`npm run build`，记录自动验证与尚未业务验收的边界。新增使用说明及交接记录。

参考算法只迁移必要数学/滤波形式，来源写入相邻注释与文档。禁止把未经测量的帧率或完整全球气象能力写成已完成结果。
