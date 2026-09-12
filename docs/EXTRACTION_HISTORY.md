> 历史抽取记录：文件数、零改动和测试结论是旧时点信息。当前状态以根README和docs/CCR_REVIEW.md为准。

# Cesium 自定义渲染管线（独立工程）

从若依业务系统 `ruoyi-ui` 里抽出的 Cesium 1.143.0 自定义渲染管线，作为一个**不含业务依赖**的独立工程。

本目录是**从宿主仓库复制出来的镜像**，不是新建实现：源码逐文件复制，仅改动了工程入口、依赖声明和测试里的路径前缀。抽出的边界是宿主仓库的 `src/rendering/cesium/` 整棵子树 —— 该子树内部**全部使用相对导入**，没有任何 `@/` 别名或业务模块引用，因此可以整体搬离而不改一行源码。

---

## 目录结构

```
.
├── package.json                     # 独立依赖声明：cesium@1.143.0 + webpack/babel 构建链
├── README.md                        # 本文件
├── src/                             # ← 宿主 src/rendering/cesium/**（65 个文件，零改动）
│   ├── index.js                     # 公共 API 入口
│   ├── VisualPipeline.js            # 管线门面：启停、选项、生命周期、诊断
│   ├── presets.js                   # 默认值与取值范围
│   ├── stages/                      # 调色等独立 stage
│   ├── shadows/                     # 自定义方向光阴影（光源相机、瓦片选择、PCF 接收端）
│   ├── environment/                 # HDR 环境通道、体积雾、体积云、区域光照、噪声图集
│   ├── antialiasing/                # SMAA / FXAA / MSAA 策略、TAA（抖动 + 深度重投影）
│   ├── channels/                    # 屏幕空间几何、材质 MRT、深度金字塔（Hi-Z）
│   ├── ao/                          # 屏幕空间环境光遮蔽（半分辨率 + 双边降噪）
│   ├── reflections/                 # 不透明 SSR、透明逐层 SSR、OIT 兼容层
│   ├── buffers/                     # 相机 / 灯光 UBO
│   ├── diagnostics/                 # GPU 计时、采样守卫、渲染剖析
│   └── performance/                 # 性能调速器
├── public/rendering/smaa/           # SMAA 查找表 AreaTex/SearchTex + 第三方许可
├── scripts/
│   ├── build-rendering-sdk.cjs      # webpack UMD 打包（引擎外置，SMAA 查找表内嵌为 data URL）
│   ├── dev-server.cjs               # 零依赖静态服务器，含 Cesium 与 SMAA 路径别名
│   ├── rendering-sdk-example.html   # UMD 产物演示页（构建时一并复制进 build/）
│   └── rendering-sdk-README.md      # UMD 产物说明（构建时一并复制进 build/）
├── examples/index.html              # 源码模式（ESM）演示页，无需构建；在线加载公开三维数据
├── tests/rendering/                 # Node 单元测试（43 个 *.test.mjs）+ preview.html 对比页
└── docs/verification/               # 示例页实测截图（白模 / 官方瓦片集 / 点云 / UMD 产物）
```

---

## 快速开始

```sh
npm install          # 安装 cesium@1.143.0 与 webpack/babel 构建链
npm test             # 跑全部单元测试
npm run build        # 产出 UMD 包到 build/<version>/
npm run serve        # 启动静态服务器（默认 127.0.0.1:8766）
```

启动服务器后打开：

- `http://127.0.0.1:8766/examples/index.html` —— 源码模式演示（直接 import `src/index.js`）
- `http://127.0.0.1:8766/build/0.1.0/example.html` —— UMD 产物演示（需先 `npm run build`）
- `http://127.0.0.1:8766/tests/rendering/preview.html` —— 对比页，需自带瓦片集（见下）

两个演示页都**在线加载真实的公开三维数据**（不再是程序化方块），页面上可切换：

| 数据集 | 来源 | 说明 |
|---|---|---|
| 白模 · OSM Buildings | Cesium ion 资产 `96188` | 全球建筑体块。ion 自带的默认样式就是纯白 `color('#ffffff')`，即「白模」。**默认数据集。** |
| 3D Tiles · 官方示例 | jsDelivr 镜像的 CesiumJS 仓库 `Apps/SampleData/Cesium3DTiles/Tilesets/Tileset` | 官方示例瓦片集，**免 token**。 |
| 3D Tiles · 点云 | jsDelivr 镜像的 `…/Cesium3DTiles/PointCloud/PointCloudRGB` | 带 RGB 的 pnts 点云，**免 token**。 |

URL 查询参数：

| 参数 | 作用 |
|---|---|
| `?dataset=osm\|sample\|points` | 启动时加载哪个数据集（默认 `osm`） |
| `?token=…` | 覆盖页面内置的 Cesium ion token |
| `?lon=&lat=&height=` | 白模数据集的城市视点（默认北京 116.3913 / 39.9075 / 2400 m） |
| `?cesium=<目录>` | Cesium 发行目录（默认 `/node_modules/cesium/Build/Cesium/`） |

### 在业务页面里使用

```js
import { createVisualPipeline } from './src/index.js'   // 或宿主里的别名路径

const pipeline = createVisualPipeline({ Cesium: window.Cesium, viewer })
pipeline.setCampusOrigin(campus.staticCamera.position)
pipeline.setOptions({ exposure: 1.6, ambientOcclusion: false, fog: true })
pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 1, resolutionMode: 'native', resolutionScale: 1 })
pipeline.setTaa({ enabled: true })
pipeline.setScreenSpaceAO({ enabled: true, radius: 3, strength: 1, bias: 0.08 })
pipeline.setScreenSpaceReflections({ enabled: true, distance: 150 })
pipeline.destroy()   // 必须先于 viewer.destroy；重复调用安全
```

完整接口清单见 `src/README.md`，各子系统边界见各自目录下的 README（`channels/`、`ao/`、`reflections/`、`environment/`、`shadows/`、`buffers/`、`diagnostics/`、`antialiasing/`）。

---

## Cesium 引擎的提供方式

**引擎外置，不进 bundle。** 本工程通过 npm 依赖 `cesium@1.143.0` 取得引擎：

- **Node 单元测试**用 `require('cesium')`，走 npm 包的 `index.cjs` 入口。
- **浏览器**用 `node_modules/cesium/Build/Cesium/` 那份发行目录（`Cesium.js` + `Widgets/` + `Assets/` + `Workers/`），由 `scripts/dev-server.cjs` 提供。

管线在构造时强校验版本，不匹配会直接抛错：

```js
if (!/^1\.143(?:\.0)?$/.test(Cesium.VERSION)) throw new Error(...)
```

因此**升级 Cesium 必须先复测**：`src/shadowBias143.js` 与 `src/shadowMap143.js` 依赖 1.143 的私有字段（`_primitiveBias.depthBias`、`normalOffsetScale`、`_lightCamera`）和 `ShadowMap` 构造选项；`UniformState.updateFrustum`、`Collection.execute` 的实例包装也按 1.143 的行为编写。这些是**版本限定的内部兼容点，不是公共 API**。

### SMAA 查找表的路径处理

`src/antialiasing/smaaLookupUrls.js` 用 `C.buildModuleUrl('../rendering/smaa/<name>')` 取查找表，实际解析为 `<CESIUM_BASE_URL>/../rendering/smaa/<name>`。宿主仓库里那个兄弟目录是 `public/rendering/smaa/`；在独立工程里该路径落到 `node_modules/cesium/Build/rendering/smaa/`，**npm 包里并不存在这个目录，也不应该往里写**。

所以 `scripts/dev-server.cjs` 把前缀 `/node_modules/cesium/Build/rendering/smaa/` 别名到本工程的 `public/rendering/smaa/`，**源码保持零改动**。若你用别的服务器（nginx/express），需要配置同一条别名，或改用 `npm run build` 的 UMD 产物 —— 后者已把两张查找表内嵌为 data URL，不再有任何外部资源请求。

---

## 示例加载的公开三维数据

演示页需要联网。三条数据路径分别踩过不同的坑，记在这里以免重犯。

### Cesium ion（白模）

页面里内置了一个 Cesium ion token（赋给 `Cesium.Ion.defaultAccessToken`），只用于 **Cesium 自己的公开资产**，可用 `?token=` 覆盖。

- **`IonResource.fromAssetId()` 与 `Cesium3DTileset.fromUrl()` 之间必须 `await`。** 类型声明写的是 `fromUrl(url: Resource | string | Promise<Resource> | Promise<string>)`，但这个 1.143 构建**不会解包 `Promise<Resource>`**：直接传 `fromUrl(IonResource.fromAssetId(id))` 会失败，报 `We.createIfNeeded(...).fetchJson is not a function`。实测对照：

  ```js
  await Cesium3DTileset.fromUrl(await Cesium.IonResource.fromAssetId(96188))  // ok
  await Cesium3DTileset.fromUrl(Cesium.IonResource.fromAssetId(96188))        // 报错
  ```

- `api.cesium.com/v1/assets/<id>/endpoint` 返回的 JSON 里有**两个** token：请求用的 `access_token`，以及一个**独立的、约 1 小时有效的 `accessToken`**。资产仓库（`assets.ion.cesium.com`）只认后者。用 `IonResource.fromAssetId()` 时 Cesium 会自动走完这一步，**不要**手工拼 `tileset.json?access_token=<你的 ion token>` —— 那样只会拿到 401。
- 本 token 实测可访问的公开资产：`96188`（OSM Buildings，`3DTILES`）、`1`（Cesium World Terrain）、`2`（Bing 影像）。常见教程里的 `43978` 在本 token 下返回 404。
- 白模的地球尺度意味着它的 `boundingSphere` 是整个地球，**不能**用它来框相机；示例改为显式飞到某个城市，并把 `setCampusOrigin` 锚在该点。

### jsDelivr（免 token 的 3D Tiles 示例）

CesiumJS 仓库的 `Apps/SampleData/` 是官方示例数据，但 **`sandcastle.cesium.com` 不返回 `Access-Control-Allow-Origin`**（HEAD/GET 都没有），浏览器跨域 fetch 会被拦。改用 jsDelivr 镜像同一个仓库，它返回 `Access-Control-Allow-Origin: *`：

```
https://cdn.jsdelivr.net/gh/CesiumGS/cesium@1.143/Apps/SampleData/…
```

实测存在且可用的路径：`Cesium3DTiles/Tilesets/Tileset`（白模方块）、`Cesium3DTiles/Tilesets/TilesetWithViewerRequestVolume`、`Cesium3DTiles/Batched/BatchedColors`、`Cesium3DTiles/Batched/BatchedWithBatchTable`、`Cesium3DTiles/PointCloud/PointCloudRGB`、`Cesium3DTiles/PointCloud/PointCloudWithPerPointProperties`、`Cesium3DTiles/PointCloud/PointCloudConstantColor`、`Cesium3DTiles/Instanced/InstancedWithBatchTable`、`Cesium3DTiles/Composite/Composite`，以及 `models/Cesium{MilkTruck,Air,Man,Drone}/…glb`。`Cesium3DTiles/Expiration/…`、`Cesium3DTiles/Batched/BatchedWithoutBatchTable`、`models/CesiumBalloon/…`、`models/WoodBarn/…` 在 1.143 标签下不存在。

### 两个渲染相关的观察

- **点云默认几乎看不见**：黑底 + 默认点大小 + 距离衰减。示例对点云数据集设了 `pointCloudShading = new PointCloudShading({ attenuation: false, eyeDomeLighting: true })` 和 `style.pointSize = 2.5`。
- **地球尺度的 3D Tiles 与 `setCampusOrigin` 不兼容**：见上文白模那条。
- 这台机器上 `assets.cesium.com` 用 Windows PowerShell 5.1 直连会在 TLS 握手阶段失败，需要显式指定 TLS 1.2（`[Net.ServicePointManager]::SecurityProtocol = 'Tls12'`）。**浏览器不受影响**，它自己会协商。

### token 的安全边界

token 直接写在 `examples/index.html` 与 `scripts/rendering-sdk-example.html` 里（构建会把它复制进 `build/<version>/example.html`）。**任何打开页面的人都能看到它。** 只当演示用：不要用于私有资产，不要部署到公网。换 token 改 `ION_TOKEN` 常量或用 `?token=` 即可。

---

## 相对宿主仓库做过的改动

### 删除（业务接缝，不属于管线）

| 文件 | 原因 |
|---|---|
| `tests/rendering/environment-weather.test.mjs` | 整个文件 `readFileSync` 宿主业务文件 `src/views/IAsCesiumLib/lib/fnLib/WeatherEffect.js` 并求值，断言新旧天气切换的交接顺序。属宿主职责。 |
| `tests/rendering/image-controls.test.mjs` 中 4 个用例 | `'business color action…'` 读 `MainMapView.vue`；`sceneFilterPanel()` 辅助函数 + 3 个面板用例读 `SceneFilterPanel.vue`。改色面板与调色面板的字段合并策略属宿主职责。 |
| `tests/rendering/visual-pipeline.test.mjs` 中 2 个用例 | `'actual weather adapter…'` 读 `WeatherEffect.js`，`'actual sun-analysis adapter…'` 读 `SunAnalysis.vue`。`suspend/resume` 交接本身由管线侧用例覆盖，这两个验证的是宿主适配器写法。 |

被删除的都是**宿主适配器**的测试：它们验证业务页面/组件是否正确调用管线，而不是管线自身行为。管线侧的 `suspend`/`resume`/调色字段合并语义仍由保留的用例覆盖。

### 残留的业务耦合：源码里还留着两处「按资产名匹配」的特例

这两处**是功能代码，不是文档**。抽取时**没有改动**它们（保持 `src/` 字节一致），因此必须点名，由你决定是否要泛化：

| 位置 | 行为 | 在别的工程里的后果 |
|---|---|---|
| `src/environment/EnvironmentLighting143.js:124` | 正则 `/\/SM_NH_(?:Terr\|Building)\/tileset\.json/` 命中时，把 `imageBasedLightingFactor` 从 `(1,1)` 改成 `(1,0)`，即**关掉天空的镜面 IBL 分量**。原因是这两个旧版资产的材质用基础色贴图 + 统一 0.45 粗糙度，加上天空镜面瓣会在平视时把立面洗白。 | 资产名不匹配 → 正则不命中 → **静默不生效**，不会报错也不会破坏渲染。但如果你换用自己的瓦片集且遇到同样的「平视洗白」，需要把这个正则换成你自己的资产名或改成显式开关。 |
| `src/environment/FoliageMask143.js:47` | 正则 `/\/SM_NH_Shu\/[^/?#]+\.glb/` 不命中就 `return`，即**只对名为 `SM_NH_Shu/*.glb` 的模型做植被遮罩**。 | 不匹配 → 该函数直接跳过 → 植被遮罩对你的模型**不生效**（无副作用，但也无效果）。用自己的植被模型时需要改这个正则。 |

### 残留的 "Campus" 命名

`src/` 里大量标识符带 `campus` 前缀，都是**纯命名、不影响功能**：UBO 块名 `CampusCamera` / `CampusReflection` / `CampusLights`、着色器变量 `campus_*`、stage 名 `campus_visual_color` / `campus_custom_shadow_depth`、内部函数 `createCampusShadowMap`。

其中 **`pipeline.setCampusOrigin(origin)` 是公共 API 方法名**，改名属破坏性变更；需要的话应同时保留旧名做别名。

### `src/` 内部文档仍使用宿主相对路径

`src/` 下的 README（`README.md`、`channels/README.md`、`reflections/README.md` 等）是**宿主视角写的**，保持字节一致所以没改。里面的这些说法在本工程里不成立，一律以本文件为准：

| 文档里的说法 | 本工程实际 |
|---|---|
| `import … from '@/rendering/cesium/index.js'` | `'./src/index.js'`（或发布后的包名） |
| 「使用 `public/Cesium/` 的静态 1.143.0，引擎不从 npm 安装」 | 引擎来自 npm 依赖 `cesium@1.143.0` |
| `npm run check:cesium` | 本工程无此脚本（那是校验宿主静态发行目录 392 文件哈希的） |
| `npm run test:rendering` | `npm test` |
| `npm run build:prod` | `npm run build`（产出 UMD，不是宿主的前端工程） |
| `python -m http.server 8766 --bind 127.0.0.1` | `npm run serve` |
| 引用 `plan/evidence/campus-assets/`、`run-*.cjs` | 这些未随抽取带过来 |

### 未带走的宿主侧内容

- `tests/rendering/run-*.cjs`、`taaRegression.cjs`、`run-sdk.cjs` —— Playwright GPU 回归 harness（含 `pngCompare.cjs` 解码工具）。
- `tests/rendering/*-fixture.js`、`shadow-fixture.html`、`image-quality-fixture.html` 等 GPU 夹具页。
- `plan/evidence/` 开发历史与 56 MB 校园瓦片夹具 `campus-assets/`。
- `public/Cesium/`（22 MB 静态发行目录）与 `public/player/` 业务模型。

需要 GPU 回归能力时，从宿主仓库按同样路径取回上述文件，并把 harness 里的 `plan/evidence/...` 输出目录改到本工程内。

### 改写（仅路径与命名）

| 项 | 原 | 现 |
|---|---|---|
| 测试源码导入 | `../../src/rendering/cesium/…` | `../../src/…`（82 处） |
| 测试引擎导入 | `require('../../public/Cesium/index.cjs')` | `require('cesium')`（31 处） |
| `preview.html` 引擎路径 | `../../public/Cesium/` | `../../node_modules/cesium/Build/Cesium/`（3 处） |
| UMD 全局名 / 产物名 | `CampusRendering(.min.js)` | `CCR(.min.js)` |
| 构建入口源目录 | `src/rendering/cesium` | `src` |
| 构建版本号 | 硬编码 `0.1.0-stage1` | 读 `package.json` 的 `version` |
| manifest 的 `sourceCommit` | 强依赖 git | 非 git 环境下降级为 `null`（源码哈希仍为权威） |

**`src/` 下 65 个文件逐字节未改动。** 命名从 `CampusRendering` 改为 `CCR` 是因为 "Campus" 是校区业务品牌，与"脱离业务系统"的目标冲突；若需要与宿主产物名保持一致，改回 `scripts/build-rendering-sdk.cjs` 里的 `library` 常量即可。

---

## 验证状态

以下都是**在本目录**（不在宿主仓库）实测的结果：

| 检查 | 结果 |
|---|---|
| `src/` 与宿主 `src/rendering/cesium/` 逐文件 SHA256 比对 | **65/65 字节一致**，无增无减无改动 |
| `npm test` | **373 / 373 通过，0 失败**（43 个文件；宿主侧 380，差值为上面删除的 6 个业务接缝用例） |
| `npm run build` | 产出 `build/0.1.0/CCR.min.js`，**267 KB / gzip 94 KB**（宿主同源产物 276 KB，差异来自版本号与打包器小版本），附 `manifest.json`（含 65 文件源码哈希）、第三方许可、`example.html` |
| 浏览器实测 `examples/index.html`（源码模式） | `getRenderDiagnostics().antiAliasing.postProcess.effective === 'smaa'`；**SMAA 查找表经 `…/node_modules/cesium/Build/rendering/smaa/AreaTex.png` 取到** → 开发服务器的别名生效；0 页面错误、0 失败请求、0 个 4xx |
| 浏览器实测 `build/0.1.0/example.html`（UMD 产物） | `window.CCR` 存在、33 个导出、`VERSION=0.1.0`、`CESIUM_VERSION=1.143.0`；**SMAA 请求数为 0、`/src/` 侧加载为 0** → 查找表确实已内嵌为 data URL；0 错误 |
| 浏览器实测三个数据集（源码模式） | `?dataset=osm`（ion 白模：`tilesLoaded === true`，全局 16661 块瓦片）、`?dataset=sample`、`?dataset=points` 均 `state=loaded`，**各 0 控制台错误、0 失败请求、0 个 4xx** |
| 浏览器实测 UMD 产物切换数据集 | `?dataset=osm` 与 `?dataset=sample` 均 `state=loaded`、0 错误 → 数据逻辑与打包产物一并可用 |

**未在本目录验证**：GPU 回归（合成器截图 / 抖动像素位移 / 历史纹理采样器等），因为 harness 与 56 MB 瓦片夹具按上面的范围界定没有带过来。`src/` 与宿主字节一致，所以宿主侧的 GPU 结论在逻辑上仍然成立，但**不要**把这句话当作本工程的 GPU 验收结论。

截图证据（`docs/verification/`，均为等待若干真实帧后截取）：`example-osm-buildings.png`（源码模式 · 白模 OSM Buildings，北京）、`example-sample-tiles.png`（源码模式 · 官方示例瓦片集）、`example-point-cloud.png`（源码模式 · 点云）、`umd-osm-buildings.png` 与 `umd-sample-tiles.png`（UMD 产物）。

### 单元测试为什么锁定 `cesium/Build/Cesium/index.cjs`

这是抽取过程中唯一一个会让测试**整体变红**的坑，值得单独说清：

- 宿主仓库用的是静态发行目录的 `public/Cesium/index.cjs`。经 SHA256 比对，它与 npm 包里的 **`Build/Cesium/index.cjs`（压缩版）字节完全相同**。
- 但 npm 包的根入口 `cesium/index.cjs` 是个 378 字节的转发器：`NODE_ENV === 'production'` 时用**压缩版**，否则用 **`Build/CesiumUnminified/index.cjs`（未压缩版）**。
- 未压缩版保留了压缩版会剥掉的 `DeveloperError` / `Check` 断言，行为并不等价。实测把测试指向未压缩版会产生 **16 个失败**（如 `new Cesium.Model(...)` 抛 `Expected options.resource to be typeof object`，以及材质程序缓存键、render state 缓存引用等用例）。

所以测试统一 require `cesium/Build/Cesium/index.cjs`，**精确对应宿主验证过的那份压缩发行构建**，且不依赖 `NODE_ENV` 这个隐式状态。浏览器的示例页本来就指向 `Build/Cesium/`，两者一致。

> 这意味着：本管线是按**压缩发行构建**验证的。若你在 Node 侧自己集成，不要让它落到 `cesium` 包的根入口。

### UMD 产物不要用 Node `require()` 自测

本工程 `package.json` 带 `"type": "module"`，所以 `build/<v>/CCR.min.js` 在**本目录内**会被 Node 当成 ESM，`require()` 它（Node 22 的同步 ESM require）只会返回一个**空命名空间**——这不是 bundle 坏了。要在 Node 里验 CJS 分支，把产物复制到没有 `"type": "module"` 的目录再 require；要验浏览器分支（`window.CCR`），放进浏览器加载 `example.html`。上面的验证走的是后者。

### preview.html 的瓦片集

`tests/rendering/preview.html` 默认去 `http://127.0.0.1:8083/Dongda` 取校区瓦片，可用 `?assets=<tileset 根目录>` 覆盖：

```
http://127.0.0.1:8766/tests/rendering/preview.html?assets=/path/to/your/tileset
```

该页面的默认影像与瓦片名仍是校区资产命名，属于宿主的资产约定；换成你自己的瓦片时改页面顶部的 `contextTiles` / 影像配置即可。

---

## 已知边界（承自宿主，未因抽取而改变）

- 真正替代前向渲染的延迟光照、实际多光源管理/5000 灯、实际遮挡剔除、HBAO、跨效果资源池、全球云雾、完整电影后期**均未实现**。
- TAA 使用单视锥深度，多视锥回退 FXAA；无 velocity buffer 与动态物体 ghosting 测试。
- `LightUniforms143` 是分页灯光数据组件，**不代表 5000 灯渲染已实现**。
- 原生地形（Globe）接收自定义阴影尚未接入；校园 GLB 地面可以。
- 静态 Cesium 发行文件在宿主侧保持原样、392 文件哈希有效；本工程不改引擎。
