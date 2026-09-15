# 校园空间抗锯齿改进

依据用户请求，在examples/campus.html基准场景改进非TAA路径。TAA shader、历史和相机抖动代码不修改。

1. 保存1280×720校园固定镜头、固定时间/云动画的off、原FXAA、原SMAA、4×MSAA及组合基线。
2. 抽取既有SMAA的最终颜色执行/资源恢复代码为共享SpatialAaPass143；SmaaPass143保持原公共类与接口，新增单pass FxaaPass143复用同一生命周期与Cesium原有FXAA 3.11 shader。
3. 空间质量档sharp/balanced/smooth：SMAA阈值0.1/0.05/0.035，搜索8/8/16；FXAA subpix与阈值配置控制细线保护和亚像素平滑。不增加新图像处理依赖。
4. 仅MSAA模式从1样本切入时默认请求4，显式1仍保留；组合按显式选项启用。面板显示请求、实际分配与说明，并添加快捷配置。
5. Node/GPU回归、同校园静态和移动镜头截图/计时、分辨率/切换/释放，更新使用说明及构建。headless诊断计时不作为正式前台性能验收。
