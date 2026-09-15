# 阶段1现状与统一SDK交付

核验日期：2026-09-12。功能目标来自《阶段1：基础渲染管线.md》；其中勾选项是目标描述，不是当前代码完成证明。当前分支`codex/cesium-visual-pipeline`，最近阶段提交`16b0b8d`；之后的TAA修复及本轮SDK工作仍在未提交工作区。白模材质已撤回，多光源仍按用户要求暂停。

## 总体判断

当前已经形成可使用的“Cesium渲染增强框架”：有统一入口、共享数据通道、可组合效果、生命周期、诊断和验证，可独立打包并接入其他Viewer。阶段1尚未整体完成，核心缺口仍是真实延迟光照替换、实际多光源管理、遮挡反馈与统一资源调度等。

不能把“材质MRT+Hi-Z+多个后处理”称为完整延迟渲染：当前主颜色仍由Cesium原生前向管线生成；也不能把5000条灯光数据读回称为5000盏灯实时照明。

## 当前完成情况

| 方向 | 已开发、已有相应验证的能力 | 仍缺少的目标 |
|---|---|---|
| 架构与数据 | 共享几何、材质MRT、透明覆盖、可选albedo/occlusion、Hi-Z | 真正接管不透明颜色的延迟照明；运动矢量与通用特殊材质覆盖 |
| 光照与阴影 | 自定义太阳方向光阴影、MASK/斜率PCF修复、固定锚点、缓存与恢复 | 点/聚光源照明、分块/聚簇光源列表与5000光源实际渲染；目前暂停 |
| UBO/FBO | 相机及反射参数共享UBO、分页灯光数据、按需FBO/resize/释放 | 完整分组缓冲、跨效果瞬态池/别名及统一帧图调度 |
| 遮挡 | Hi-Z数据生产、未知遮挡标记 | 将结果反馈到可见性并减少实际DrawCommand |
| AO | SSAO、双边降噪、HDR合成、透明覆盖保护 | 正式HBAO；现SSAO不更名为HBAO |
| 反射 | 不透明与透明PBR SSR、原生CubeMap回退、排序/OIT兼容 | 原生Water、Globe及其他特殊材质，递归反射/折射 |
| 抗锯齿 | SMAA/FXAA/MSAA；TAA权重、稳定网格、重建、深度与边缘历史修复 | TAA复杂透明/变形、速度缓冲/Reactive Mask和更广泛性能证明；多视锥暂回退FXAA |
| 环境 | 区域高度/体积雾、积云/层云、太阳阴影散射、Globe表面深度合成 | 全球球壳云雾、全球相机连续性、独立光斑/多通道Light Shaft |
| HDR与调色 | 原生HDR、ACES曝光、Bloom开关、调色与分辨率接口 | 多映射曲线选择、Unreal Filmic/Reinhard、自定义Bloom控制及电影后期 |
| 后期与治理 | 统一HDR执行顺序、诊断、性能调速器、暂停/恢复/销毁 | 移轴/泛焦/色差等高级后期；统一资源池和正式整帧性能目标 |

当前TAA证据以32/33轮为准：已经修复明显模糊与整幅抖动，并加强局部边缘检查。旧30轮“出现抖动即通过”的指标已废弃，旧“只剩HDR环境抵消偏移”的判断也已纠正。详见`evidence/32-taa-repair-handover.md`和`evidence/33-taa-edge-handover.md`。

最新全量Node为384/384，384个测试不等于384项产品需求全部验收。各GPU检查的范围见对应报告；新效果组合没有正式前台60秒P95≤33.3ms达标结论。登录后完整业务验收按用户指示不作门禁。旧雾冻结检查的偶发差异与隐藏Globe隔离场景的异常HDR输入记录仍保留，不以本轮打包替代它们的后续分析。

## 已构建的统一产物

产物目录：`build/rendering-sdk/0.1.0-stage1/`。

| 文件 | 用途 |
|---|---|
| `CampusRendering.min.js` | 浏览器UMD单文件，全局对象`CampusRendering`；也支持CommonJS/AMD |
| `CampusRendering.min.js.gz` | HTTP预压缩副本 |
| `manifest.json` | SDK版本、引擎依赖、源码哈希、产物SHA256与体积 |
| `README.md` | 接入方式、部署与能力边界 |
| `example.html` | 不依赖Vue和登录的最小场景演示 |
| `THIRD_PARTY_LICENSES.txt` | 内嵌SMAA资源的许可 |

当前JS为283,429字节（约276.8KiB），gzip为96,697字节（约94.4KiB）。两张SMAA查找表已经嵌入，不需要再复制自研rendering/smaa资源目录。**Cesium 1.143.0引擎保持外置**，仍需部署其Workers/Assets/Widgets等资源；模型、影像和业务数据也由宿主提供。

这与`TianjingMap3D.min.js`相似的是交付形态：一次引入一个JS，从一个命名空间创建管线、配置效果。原`public/js/TianjingMap3D.min.js`保留，未覆盖也未复用其实现。当前SDK不提供TianjingMap3D的接口兼容，不包含地图业务UI、POI、漫游或后台API，不能宣称功能对等。

```html
<script>window.CESIUM_BASE_URL = '/Cesium/';</script>
<script src="/Cesium/Cesium.js"></script>
<script src="/sdk/CampusRendering.min.js"></script>
<script>
const pipeline = CampusRendering.createVisualPipeline({ Cesium, viewer });
pipeline.setCampusOrigin(campusOrigin);
pipeline.setTaa({ enabled: true });
// 按需：pipeline.setScreenSpaceReflections({ enabled: true });
// 按需：pipeline.setScreenSpaceAO({ enabled: true });
</script>
```

主应用仍可继续使用源码入口；使用SDK的宿主不应在同一个Viewer上再安装另一份源码管线。SDK沿用版本限定的内部适配点，不是可任意替换Cesium版本的通用引擎。

## 本轮构建与验证

- 新命令：`npm run build:rendering-sdk`。复用项目现有Webpack/Babel，没有安装新的运行依赖，也没有修改原业务构建输出规则。
- 全量384项Node、392静态资源哈希、自研SDK构建及原应用生产构建通过。日志：`evidence/34-node.log`、`34-sdk-build.log`、`34-app-build.log`。
- 对实际压缩文件验证CommonJS加载、独立HTML加载、内嵌SMAA资源、TAA启停、真实多视锥FXAA回退及恢复。独立页面未请求源码文件或外部SMAA查找表。
- 使用同一压缩文件替换校园预览源码入口，TAA/SSR/透明SSR/AO/环境组合及关闭恢复通过，无页面/渲染错误。最终证据入口见`evidence/34-sdk-validation.log`及其末行目录。
- 独立Viewer暴露了TAA回退在帧中途启用FXAA导致原生输出缺失的问题，现改为preUpdate阶段应用回退请求，主管线不再覆盖TAA持有的回退状态。关闭增强时保留恒等颜色传递，避免Cesium在只有禁用stage、原生HDR又关闭时找不到输出纹理。均由独立SDK实测覆盖，失败复现`34-fallback-red.log`保留。

当前可作为**0.1阶段开发SDK**交付和复用，不宜命名为“阶段1全功能完成版”。后续产品化重点是稳定公开API、补ESM/类型声明、版本迁移策略与兼容矩阵，再按需求补齐核心延迟架构和正式性能验收。
