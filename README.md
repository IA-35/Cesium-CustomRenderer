# CCR · Cesium 自定义渲染管线

独立的 Cesium 1.143.0 渲染增强工程。浏览器统一命名空间为 **`window.CCR`**，UMD 文件为 **`CCR.min.js`**。源码演示也通过 `window.CCR` 暴露模块入口；不保留其他全局名称别名。

校园场景入口：`/examples/campus.html`。2026-09-15新增FXAA/SMAA空间质量档、有效MSAA模式及校园画质/开销对比，见 [校园抗锯齿配置](docs/CAMPUS_ANTIALIASING.md)。TAA实现保持不变。

## 开发与构建

需要 Node.js 22 或以上，与 Cesium 1.143.0 的依赖要求一致。

```sh
npm install
npm test
npm run build
npm run serve
```

默认开发地址：

- 源码演示：`http://127.0.0.1:8766/examples/index.html?dataset=sample`
- 校园实景：`http://127.0.0.1:8766/examples/campus.html`
- UMD 演示：`http://127.0.0.1:8766/build/0.1.0/example.html?dataset=sample`
- 可指定端口：`npm run serve -- --port 8876`

`dataset=sample` 是默认的免 token 官方 3D Tiles 示例；`points` 是官方 RGB 点云；`osm` 是 OSM Buildings，必须通过 `token` 参数提供调用方的 ion 凭据，`lon/lat/height` 选择城市视点。演示数据需要联网，源码和产物均不内置个人访问令牌。

`examples/campus.html` 是校园场景示例：地形、建筑、树木与周边白模全部读自本工程自带的 `assets/campus-assets/`，不需要额外的瓦片服务；影像默认走沈阳影像服务，可用 `?imagery=none` 关闭或 `?imagery=<模板>` 替换，周边白模可用 `?contextTiles=none` 关闭，资产根目录可用 `?assets=<目录>` 覆盖。`?shadow=native|custom` 与 `?singleFrustum=1` 沿用测试页的固定实验开关。页面本身只是一层壳（`#scene` + 只读输出区 `#hud`），全部逻辑在 `examples/campus.js`；可调控件由右上角的 [lil-gui](https://lil-gui.georgealways.com/) 面板生成，不再逐个手写 DOM 事件。左下角另挂了 three.js 的帧率面板（`js/stats.module.js`，原样引入的 ES module，由 `scene.preRender/postRender` 配对驱动 `begin/end`），点击面板本身或调用 `window.campus.stats.showPanel(0|1|2)` 可在 FPS / MS / MB 之间切换。脚本用 `window.campus.look(pitch, range)` 暴露镜头设置，供 `scripts/check-campus-*.cjs` 调用。

测试页 `tests/rendering/preview.html` 是同一场景的采样版本，但**不提供默认值**：`assets`、`imagery`、`contextTiles` 都必须显式传入，否则不会加载任何瓦片。原业务服务地址不作为默认值。

## 浏览器接入

```html
<script>window.CESIUM_BASE_URL = '/Cesium/';</script>
<script src="/Cesium/Cesium.js"></script>
<script src="/sdk/CCR.min.js"></script>
<script>
const pipeline = CCR.createVisualPipeline({ Cesium, viewer });
pipeline.setCampusOrigin(sceneOrigin);
pipeline.setTaa({ enabled: true });
// 按需开启：pipeline.setScreenSpaceAO({ enabled: true });
// 按需开启：pipeline.setScreenSpaceReflections({ enabled: true });
// 页面销毁：pipeline.destroy(); viewer.destroy();
</script>
```

Cesium 引擎始终外置。开发时由 npm 依赖提供，浏览器仍需完整的 Cesium.js、Workers、Assets、Widgets 目录。UMD 内嵌两张 SMAA 查找表；源码模式通过开发服务器的资源别名读取项目图片。

构建目录 `build/0.1.0/` 包含 JS、gzip、manifest、README、示例、第三方许可及 `package.json`。构建目录中的 `package.json` 声明 `type: commonjs`，使 `require('./build/0.1.0/CCR.min.js')` 正确读取 UMD；浏览器使用 script 加载不受影响。根包仍为 ESM，入口是 `src/index.js`。

当前 `npm pack` 的 files 列表只包含源码和资源，不含 UMD 构建目录；交付 UMD 时请分发构建目录。不要把它误认为已完成 npm 双格式发布配置。

## 范围与限制

包含太阳阴影、HDR 局部云雾/球壳云、多尺度 HDR Bloom、SSAO/HBAO、PBR/透明 SSR、MRT/Hi-Z、SMAA/TAA、共享相机 UBO、性能调速与诊断。主颜色仍来自原生前向渲染；真实延迟照明、5000 光源、实际遮挡反馈、全球体积雾等尚未实现。

2026-09-14 新增功能与验证见 [阶段一更新](docs/STAGE1_ENHANCEMENTS.md)。本地免 token 对比页为 `/examples/stage1.html`。原默认行为保留：AO 默认关闭，AO 算法默认 SSAO；多尺度 Bloom 默认关闭；云层默认 shell。

城市白模 HDR/Bloom/SSR 对比页：`/examples/white-city.html`，使用本地城市模型衍生资源；说明见 [白模与反射过渡](docs/WHITE_CITY_REVIEW.md)。

```js
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao', radius: 3, strength: 1 });
pipeline.setHdrBloom({ enabled: true, strength: 0.15, threshold: 1, knee: 0.5, levels: 5 });
pipeline.setOptions({ environment: true, clouds: true, cloudGeometry: 'shell' });
```

内部 `campus_*` shader/UBO 标识符和公共方法 `setCampusOrigin` 沿用原契约，本轮只统一浏览器全局名称。旧校园资产的材质/叶片兼容规则仍按指定资源路径匹配，对其他资产不生效。

## 本次审查与验证

- 分离后的 65 个源文件均存在；初始比较发现 3 个 JavaScript 文件漏了宿主最近的兼容修复，本轮已同步，另外 1 个差异是内部 README。
- 修复原生 HDR 关闭时的空后处理输出，以及 TAA 回退 FXAA 在帧中途切换的问题；没有重做渲染算法。
- 本目录 `npm test`：373/373 通过；`npm run build` 通过。
- 本目录真实浏览器检查：源码/UMD 均只暴露 CCR，SMAA/TAA、原生恢复、重新启用通过；UMD 额外源码请求和 SMAA 图片请求均为 0。
- 完整宿主 GPU 数值/画质夹具尚未迁移，因此上述基础检查不等于全部效果画质验收。

审查细节及未关闭事项见 [docs/CCR_REVIEW.md](docs/CCR_REVIEW.md)。历史抽取说明保留在 [docs/EXTRACTION_HISTORY.md](docs/EXTRACTION_HISTORY.md)，不作为当前验证结论。

基础浏览器回归：先运行开发服务器，再设置 `CESIUM_PLAYWRIGHT` 为已安装 Playwright 的模块路径，用 `node scripts/check-browser-sdk.cjs` 执行；默认测试端口为 8876，可通过 `CCR_TEST_PORT` 覆盖。脚本使用免 token 官方示例，不需要 ion token。

## 阶段一 B00/B01 基准与接点

已修复B00的基准覆盖、影像失败判定、源码内容hash，以及B01的目标绑定、透明混合验证、安装生命周期和资源释放。当前状态与范围见 [修复交接](docs/B00_B01_FIX_HANDOVER.md) 和 [验收说明](docs/STAGE1_ACCEPTANCE.md)。

- 五份已复比基准按目标/配置分别保存，未通过严格复比的校园高质量组合不发布golden；默认compare不改写，显式update要求两次冷启动一致。
- 含外部影像的campus只做视觉/加载验收，不使用几何目标替代它。
- 帧桥验证了OIT MRT、multipass、MSAA 4×与10视锥的最终颜色接点；不等于已完成B02延迟照明。
- 排序透明、拾取和不支持阶段明确拒绝颜色写入。

```js
const bridge = CCR.createFrameBridge({ Cesium, scene })
bridge.on('translucent', () => bridge.uploadOpaqueColor([1.2, 0.9, 0.7, 1]))
bridge.install()
// 用完后 bridge.destroy()
```

```powershell
node scripts/dev-server.cjs --port 8877
$env:CCR_TEST_PORT = '8877'
# 先按本机安装位置设置 CESIUM_PLAYWRIGHT
node scripts/check-stage1-baseline.cjs --target fixtures --configuration ccr-default --mode compare --repeat 1
node scripts/check-frame-bridge.cjs
```

校园示例需要自备 `assets/campus-assets/`。影像URL和Ion token通过服务器进程环境 `CCR_EXAMPLE_IMAGERY_URL` / `CCR_EXAMPLE_ION_TOKEN` 配置，示例源码与SDK不保存访问凭据。详细配置、其他基准命令和支持边界见 [API](docs/API.md)。
