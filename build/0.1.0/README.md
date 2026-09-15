# CCR · 独立 UMD 构建

校园空间抗锯齿：`pipeline.setAntiAliasing({mode:'smaa',quality:'balanced',msaaSamples:1,msaaCombine:false})`。quality可选sharp/balanced/smooth，仅作用于SMAA与FXAA；质量优先可显式请求SMAA+4×MSAA。仅MSAA模式从原请求1进入且未指定样本时默认请求4，实际样本仍以HDR颜色/深度格式支持为准。TAA原算法与原生FXAA回退不变。

Cesium 1.143.0 渲染增强管线的独立打包产物。`CCR.min.js` 是 UMD 入口，可直接用 script 加载并暴露全局 `CCR`，也支持 CommonJS / AMD。

在 Node 的 ESM 工程内直接 require 此 UMD 时，请保留同目录的 `package.json`（`type: commonjs`）。浏览器 script 加载只需要 JS 文件及外置 Cesium。根 npm 包的源码入口仍为 ESM；当前 npm pack 不包含 build 目录。

```html
<script>window.CESIUM_BASE_URL = '/Cesium/';</script>
<script src="/Cesium/Cesium.js"></script>
<script src="/sdk/CCR.min.js"></script>
<script>
const viewer = new Cesium.Viewer('scene');
const pipeline = CCR.createVisualPipeline({ Cesium, viewer });
pipeline.setCampusOrigin(Cesium.Cartesian3.fromDegrees(123.42, 41.77, 0));
pipeline.setTaa({ enabled: true });
// 可选：pipeline.setScreenSpaceReflections({ enabled: true });
// 可选：pipeline.setScreenSpaceAO({ enabled: true });
// 页面销毁前：pipeline.destroy(); viewer.destroy();
</script>
```

必须部署 Cesium 1.143.0 完整发行目录，包括 Assets、Workers、Widgets 等所需资源；本产物不内嵌第二套引擎。两张 SMAA 查找表已嵌入 JS，不再依赖外部 `rendering/smaa` 目录。默认 SMAA，TAA/SSR/AO 等可选功能通过统一 pipeline 接口启用。

`example.html` 提供无登录、无框架的最小演示：通过 HTTP 服务打开，可用 `?cesium=/your/Cesium/` 指定 Cesium 发行目录；默认指向 `node_modules/cesium/Build/Cesium/`，配合本工程的 `scripts/dev-server.cjs` 可直接运行。

演示**在线加载真实的公开三维数据**并可在页面上切换：

| 参数 | 数据集 | 是否需 token |
|---|---|---|
| `?dataset=osm` | Cesium ion 资产 `96188`，OSM Buildings 建筑白模 | 需要调用方通过 `?token=` 提供 |
| `?dataset=sample`（默认） | CesiumJS 仓库官方示例瓦片集（jsDelivr 镜像） | 免 token |
| `?dataset=points` | CesiumJS 仓库官方 RGB 点云（jsDelivr 镜像） | 免 token |

另有 `?lon=&lat=&height=` 指定白模的城市视点。示例不内置个人 token；调用方应使用适合部署域名和资产范围的凭据。

包含：太阳阴影、HDR 区域云雾、调色、SMAA/FXAA/MSAA/TAA、材质 MRT/Hi-Z、SSAO/HBAO、多尺度 HDR Bloom、球壳云、PBR/透明 SSR、相机 UBO、性能诊断与调速器。`LightUniforms143` 是分页灯光数据组件，不代表 5000 灯渲染已实现。

本产物不是完整地图业务 SDK，不包含框架页面、业务 API、模型/影像、POI/交互工具。需由宿主提供 `Cesium.Viewer` 与数据。勿在同一个 Viewer 上重复安装本 SDK，或同时用另一份源码模块创建管线。

尚未完成：真正替代前向渲染的延迟照明、实际多光源管理/5000 灯、实际遮挡剔除、跨效果资源池、全球体积雾及完整电影后期。TAA 目前使用单视锥深度，多视锥回退 FXAA；透明/变形物体和正式性能仍有适用边界。

`manifest.json` 记录版本、依赖、源码哈希和产物 SHA256；源码哈希对应当前工作区，不能仅用 `sourceCommit` 重现未提交修改。发行时同时保留第三方许可文件。`.gz` 是 HTTP 预压缩副本，不直接用 script 加载。

## 阶段一新增接口（2026-09-14）

```js
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao' });
pipeline.setHdrBloom({ enabled: true, strength: 0.15, threshold: 1, knee: 0.5, levels: 5 });
pipeline.setOptions({ environment: true, clouds: true, cloudGeometry: 'shell' });
```

新增功能均显式启用；原默认保留。球壳云支持单视锥或纯天空帧，多视锥仍安全回退，雾仍为局部效果。算法参考见 ALGORITHM_REFERENCES.md。
