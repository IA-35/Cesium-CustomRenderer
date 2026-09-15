# 画面接口与空间抗锯齿：2026-09-09

本轮直接处理用户指出的偏暗/低对比度、缺少易用代码接口和严重锯齿。完整延迟渲染、HDR/Bloom/自动曝光、SSR、多光源、TAA和镜头效果继续是统一管线路线，不把本轮SMAA当成TAA或完整延迟渲染。

## 设计与依据

- 复用现有colorGrading shader，提供 `getColorGrading/setColorGrading/resetColorGrading` 与预设、参数范围。部分参数修改保留其他值，业务action与现有画面面板共用接口和存储；预览页增加即时滑杆。
- 接入已经安装的three.js r158 SMAA 1x Medium（三阶段、标准Area/Search查找纹理），保留许可与来源，不引入three运行时或第二个引擎。
- SMAA位于原生HDR/Tone Mapping、调色和业务stages之后。自己的collection由native execute/copy实例hook调度；加载失败/未就绪回退FXAA。禁用、异步取消、外部hook和同帧输出有效性需验证。
- 当前管线强制CSS分辨率；DPR2时只有原生四分之一像素，Cesium canvas pixelated放大可能加重锯齿。默认使用native DPR，CSS模式作为明确低成本选项；暴露resolutionScale并报告真实buffer，不能靠悄悄降分辨率测性能。
- 使用当前context的RGBA16F/RGBA32F与depth24样本支持集合选择MSAA档位，不能把配置4误当作实际4。MSAA针对几何轮廓，MASK纹理边缘与透明/OIT仍需要后处理和后续时域验证。

## 执行检查

- [x] 调色API、部分修改、重置、旧默认迁移、业务入口与预览滑杆完成；API/UI交错回归已修复旧快照覆盖问题。
- [x] SMAA1x GPU30项通过；HDR/环境/SMAA联动10轮资源与hook恢复通过。
- [x] native DPR、auto image-rendering、MSAA格式支持及实际附件验证完成；四种模式可对照。
- [x] 固定校园画面与调色/AA/DPR对比已保存于12系列证据。
- [x] 本次核验103项Node、392个哈希、生产构建通过；独立审查问题已修复，交接已更新。
- [ ] 有效当前版本60秒性能基准及完整业务/动态镜头验收：已取得的两组采样因前台/相机变化未通过条件，仍须重测，见14系列当前交接。

后续底层阶段：共享HDR/深度/法线/材质通道与生命周期 → AO/SSR及环境回退 → 局部光源空间剔除/延迟光照 → 运动信息、历史拒绝与TAA。UBO、Transform Feedback和Pass合并按真实更新模式/瓶颈选用，不能仅添加名词或把FXAA改名。
