# 环境渲染与偏暗修复：2026-09-09

目标：用户已将下一阶段优先级调整为天空光照、高度雾/太阳散射/体积雾、体积云与大气效果。新增详细文章纳入参考，但不把文章描述当成本项目实现证据。

## 方案

选择“原生大气与 PBR 天空环境光 + 自有 HDR 体积通道”。单纯提高曝光无法补全环境光；普通显示空间后处理不能正确表达 HDR 散射；全量改写延迟管线改动过大，不是本阶段所需。

1. 环境光控制器复用 Model/Tileset 的 environmentMapManager，保留材质、IBL因子和自发光。天空、大气、直射光与云雾共用真实太阳方向，太阳落山时衰减直射强度。配置变化时才失效环境图，避免逐帧重建。
2. 自有 PostProcessStageCollection 在原生 execute 之前处理线性 HDR；副管线不做 AO/Bloom/Tonemap/FXAA。最终仍由原生 ACES 处理唯一曝光。不修改静态 Cesium 发行包。
3. 半分辨率光线步进：高度指数密度 + 随风运动的空间噪声 + Beer-Lambert 透射 + HG 太阳相函数。有效自定义阴影范围内采样已有方向光深度，使雾中直射散射受遮挡控制。
4. 体积云使用空间密度场、云层高度区间、风偏移与沿太阳方向的次级光线采样，支持积云/层云两种密度形态；不把原生 CloudCollection 广告牌称为体积云。
5. 深度约束重建半分辨率效果，避免远处云雾泄漏到近景建筑；纯天空保持原生大气背景。大气基于原生 Rayleigh/Mie，提供晴天、霾、夕照对应的散射参数，不称为多个独立大气算法。
6. 通过 VisualPipeline 统一环境开关、质量与预设。沿用 suspend/resume，禁用与销毁恢复自有状态和hook，移除旧简化雾与广告牌云的重复叠加。天气入口在启用新环境时传递天气预设，不再强改时间到固定正午。

## 已核实的依据

- 当前曝光已为1.6，AO关闭；默认 atmosphere.dynamicLighting=NONE，环境图散射系数2。IBL因子已为(1,1)，API仅允许0..1，不通过设置>1伪造增亮。
- 校园多视锥的无boundingVolume透明command经浏览器核实正是旧 CloudCollection。替换为体积通道后应重测默认相机，不需先缩短远裁面或放宽门禁。
- 副collection.update(context,useLogDepth,false)、clear(context)、execute(context,color,depth,id)可实现pre-tonemap合成。两个效果stage采用FLOAT，源码明确保持线性，不重复Gamma。
- 深度使用raw .r和windowToEyeCoordinates；真正多视锥时旁路体积通道并报告，避免云层盖住远景实体。

## 验收

- [x] 固定校园相机/时间/曝光，保存对照与亮度分布。晴天默认选定天空3.2/太阳2.2，曝光保持1.6；近景平均135.82→144.93、P10 93→100。
- [x] 预设/数值门禁、日夜太阳、HDR执行顺序、禁用/外部hook/资源恢复等自动测试，先红后绿；最终75项通过。
- [x] 真实1920×1080 GPU验证33项通过，包含零密度透传、高度、遮挡/散射、风场、日夜、区域退化、resize与10轮生命周期。冻结密度数值预算及排查见验证报告。
- [x] 晴天/晨雾/夕照/层云真实校园对照；旧广告牌云移除。云影投地、全球球壳云、反射反馈和多次散射未实现。
- [x] 三轮1080p/60秒采样均有完整前台审计；P95分别39.9/42.9/42.6ms。**性能门槛仍未通过**，保持30FPS目标。
- [x] 392个哈希、75项测试、生产构建通过；独立审查问题修复并复查，目标与交接已更新。

代码职责：environment/HdrEnvironmentPass143.js（HDR适配）、environment/EnvironmentLighting143.js（场景/IBL所有权）、environment/environmentState.js（预设与太阳状态）、environment/environmentStages.js（体积Shader）、environment/EnvironmentRenderer.js（生命周期整合）；VisualPipeline只负责连接。
