# CCR · Cesium 自定义渲染管线

独立的 Cesium 1.143.0 渲染增强工程。浏览器统一命名空间为 **`window.CCR`**，UMD 文件为 **`CCR.min.js`**。源码演示也通过 `window.CCR` 暴露模块入口；不保留其他全局名称别名。

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
- UMD 演示：`http://127.0.0.1:8766/build/0.1.0/example.html?dataset=sample`
- 可指定端口：`npm run serve -- --port 8876`

`dataset=sample` 是默认的免 token 官方 3D Tiles 示例；`points` 是官方 RGB 点云；`osm` 是 OSM Buildings，必须通过 `token` 参数提供调用方的 ion 凭据，`lon/lat/height` 选择城市视点。演示数据需要联网，源码和产物均不内置个人访问令牌。

校园对比页的模型根目录通过 `assets` 参数指定；可选影像模板和周边模型分别通过 `imagery`、`contextTiles` 指定。原业务服务地址不作为默认值。

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

包含太阳阴影、HDR 区域云雾、SSAO、PBR/透明 SSR、MRT/Hi-Z、SMAA/TAA、共享相机 UBO、性能调速与诊断。主颜色仍来自原生前向渲染；真实延迟照明、5000 光源、实际遮挡反馈、HBAO、全球云雾等尚未全部实现。

内部 `campus_*` shader/UBO 标识符和公共方法 `setCampusOrigin` 沿用原契约，本轮只统一浏览器全局名称。旧校园资产的材质/叶片兼容规则仍按指定资源路径匹配，对其他资产不生效。

## 本次审查与验证

- 分离后的 65 个源文件均存在；初始比较发现 3 个 JavaScript 文件漏了宿主最近的兼容修复，本轮已同步，另外 1 个差异是内部 README。
- 修复原生 HDR 关闭时的空后处理输出，以及 TAA 回退 FXAA 在帧中途切换的问题；没有重做渲染算法。
- 本目录 `npm test`：373/373 通过；`npm run build` 通过。
- 本目录真实浏览器检查：源码/UMD 均只暴露 CCR，SMAA/TAA、原生恢复、重新启用通过；UMD 额外源码请求和 SMAA 图片请求均为 0。
- 完整宿主 GPU 数值/画质夹具尚未迁移，因此上述基础检查不等于全部效果画质验收。

审查细节及未关闭事项见 [docs/CCR_REVIEW.md](docs/CCR_REVIEW.md)。历史抽取说明保留在 [docs/EXTRACTION_HISTORY.md](docs/EXTRACTION_HISTORY.md)，不作为当前验证结论。

基础浏览器回归：先运行开发服务器，再设置 `CESIUM_PLAYWRIGHT` 为已安装 Playwright 的模块路径，用 `node scripts/check-browser-sdk.cjs` 执行；默认测试端口为 8876，可通过 `CCR_TEST_PORT` 覆盖。脚本使用免 token 官方示例，不需要 ion token。
