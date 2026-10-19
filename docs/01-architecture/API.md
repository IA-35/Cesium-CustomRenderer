# CCR · 自定义渲染管线 API 使用文档

> 最新范围：[CCR通用渲染原则](./RENDERER_SCOPE.md)。B00默认target为fixtures；校园是可选集成用例，其服务/资产问题不定义CCR的通用能力边界。
Cesium 1.143.0 渲染增强管线（CCR）的对外接口参考。全部签名、默认值、取值范围与诊断字段均取自当前源码：`src/index.js`、`src/presets.js`、`src/VisualPipeline.js`、`src/environment/environmentState.js`、`src/antialiasing/settings143.js`。

> 版本门槛：所有类都要求 `Cesium.VERSION` 匹配 `/^1\.143(?:\.0)?$/`，不匹配直接抛错。管线依赖 1.143 的若干内部结构（`scene._view.frustumCommandsList`、`globeDepthTexture`、`updateDerivedCommands`、`_primitiveBias` 等），升级 Cesium 前必须重新验证。

> 阶段一状态（2026-09-17）：`setLighting`、`setOcclusionCulling` 已实现；`setToneMapping` / `setLensEffects` 仍未实现。B04–B06 的资源与覆盖契约见 [资源账本](../archive/B05_RESOURCE_LEDGER.md)。验收口径、图像基线与命令入口见 [阶段一验收说明](../archive/STAGE1_ACCEPTANCE.md)。

## 目录

1. [接入与入口](#1-接入与入口)
2. [快速开始](#2-快速开始)
3. [VisualPipeline 方法总表](#3-visualpipeline-方法总表)
4. [选项完整参考](#4-选项完整参考)
5. [效果专题](#5-效果专题)
6. [诊断体系](#6-诊断体系)
7. [低层 API（可选）](#7-低层-api可选)
8. [排查清单](#8-排查清单)
9. [能力边界与未实现](#9-能力边界与未实现)
10. [验证入口与图像基线](#10-验证入口与图像基线)

---

## 1. 接入与入口

### 1.1 两种加载方式

**源码（ESM，开发用）**：入口 `src/index.js`，配合 `npm run serve`（`scripts/dev-server.cjs`）通过 HTTP 打开。

```html
<link rel="stylesheet" href="/node_modules/cesium/Build/Cesium/Widgets/widgets.css">
<script>window.CESIUM_BASE_URL = '/node_modules/cesium/Build/Cesium/'</script>
<script src="/node_modules/cesium/Build/Cesium/Cesium.js"></script>
<script type="module">
  import * as CCR from '/src/index.js'
  // ...
</script>
```

**UMD（发布用）**：`build/0.1.0/CCR.min.js`，暴露全局 `CCR`（同时支持 CommonJS / AMD）。内嵌两张 SMAA 查找表，源码模式则通过开发服务器的 `rendering/smaa` 别名读取项目图片。

```html
<script>window.CESIUM_BASE_URL = '/Cesium/';</script>
<script src="/Cesium/Cesium.js"></script>
<script src="/sdk/CCR.min.js"></script>
<script>
  const pipeline = CCR.createVisualPipeline({ Cesium, viewer });
</script>
```

UMD 导出键包含以下管线与固定植被入口：

```
CESIUM_VERSION  VERSION  createVisualPipeline  getVisualPipeline
SmaaPass143  TaaPass143  FxaaPass143  taaBlendWeights  TaaJitter143  FrustumJitterBridge143
ScreenSpaceGeometry143  MaterialChannels143  DepthPyramid143  MATERIAL_FLAGS
ScreenSpaceAo143  HdrBloom143  ScreenSpaceReflection143  TransparentReflection143
PerformanceGovernor143  quantile  LightUniforms143  RenderProfiler143
FixedTreeCollection  createFixedTreeCollection  validateFixedTreePoints
GrassCollection  createGrassCollection
stableTreeVariation  projectedTreePixels  selectTreeLod  DEFAULT_TREE_LOD_THRESHOLDS
halton  jitterSample  nearPlaneOffsets  isSubPixelOffset  DEFAULT_JITTER_SAMPLES
resolveMsaaPolicy  isPostProcessAntiAliasing  postProcessAntiAliasingModes
defaultFilters  normalizeOptions  normalizeColorGrading  colorGradingControls  colorGradingPresets
```

### 1.2 两个入口函数

```js
import { createVisualPipeline, getVisualPipeline } from 'src/index.js'

const pipeline = createVisualPipeline({ Cesium, viewer, options })  // 创建并立即启用
const same = getVisualPipeline(viewer)                              // 按 viewer 查找（WeakMap）
```

### 1.3 固定点位实例树木

`createFixedTreeCollection` 独立于 `VisualPipeline` 生命周期，使用固定版本 `cesium-ez-tree` 的 `EzTreePrimitive`。GLB 与程序化来源都复用上游 20 字节量化实例属性、共享几何缓冲、空间剔除、分帧上传及缓存。常态 720 个点位由一个 primitive 管理，不再创建每块四个 Cesium Model，也不按距离稀释道路点位。

校园示例默认使用 `source:'glb'`，通过 ez-tree 的 GLB 通道加载三种四级 LOD 树模型。`?treeSource=procedural` 可切回轻量程序化 Pine 作为性能对照。输入清单由 `scripts/prepare-fixed-tree-assets.cjs` 生成。

GLB 树按未抖动相机的投影高度选择几何 LOD，默认阈值为 `[180, 80, 12]` 像素并带 15% 滞回。叶片 Alpha cutoff 随 LOD 使用 `[0.35, 0.30, 0.24, 0.18]`，补偿远景 mipmap 和简化几何的覆盖损失；颜色与阴影通道使用同一 cutoff。

已适配 CCR 阴影投射/接收及 Mask 轮廓。树木使用上游前向植被着色器，不是完整 Model PBR/MRT；不能宣称它已接入延迟材质通道或成为 SSR 材质接收面。SMAA 等颜色后处理照常覆盖最终画面。

```js
const trees = CCR.createFixedTreeCollection({
  Cesium,
  viewer,
  manifestUrl: '/assets/vegetation/manifest.json',
  source: 'glb', // 校园默认；程序化对照使用 'procedural'
  clampToGround: true,
  heightOffset: 0.1,
  // 排除旧树木层，避免新树贴到旧树冠上。
  objectsToExclude: [oldTreeTileset]
})

await trees.readyPromise
console.log(trees.getDiagnostics())
trees.setVisible(false)
trees.setVisible(true)

// 必须在 viewer.destroy() 之前调用。
trees.destroy()
```

校园示例默认加载本地 GLB 树；使用 `?treeSource=procedural` 可切换程序化对照，`?trees=none` 可关闭，`?trees=<manifest-url>` 可替换清单。

诊断的 `instances` 是固定点位总数；`visibleBatches` / `submittedInstances` 表示本帧实际提交的批次与批次内实例（仍可能包含屏外株）。`bufferBytes` / `textureBytes` 只统计集合所持有资源，不能代替整场景显存。

### 1.4 GeoJSON 面内程序化草地

`createGrassCollection` 读取 `prepare-grass-polygons.cjs` 生成的 WGS84 面数据，按面积调用 `cesium-ez-tree` 的程序化草簇采样和实例 primitive。默认密度为 450 簇/公顷（`0.045/㎡`），最多 10,000 簇；当前 14.0402 公顷数据生成 6,329 簇。

草网格使用宿主目录中的 `grass-10.glb` 与 `grass-17.glb`，按稳定实例 ID 做 50/50 分配。两者相同的 BaseColor WebP 经哈希分桶和逐字节校验后只创建一份 GPU 纹理。源 BaseColor 的 Alpha 全不透明且背景为黑色，因此草专用 shader 使用 RGB 亮度 `0.03` 作为 cutout，并直接使用 atlas RGB，避免黑底和深色实例色相乘。法线/粗糙度贴图当前不上传。

草命令强制 `castShadows=false`、`receiveShadows=false`，不进入 CCR 光照视锥的投射或接收流程；树木阴影策略不受影响。

草地采用固定局部 ENU 高度 `3`，不会调用 `scene.clampToHeightMostDetailed`。面采样每 12 个多边形主动让出一次主线程；资源 ready 只依赖 GLB/纹理完成，不要求初始镜头已经提交可见命令。

```js
const grass = CCR.createGrassCollection({
  Cesium,
  viewer,
  polygonsUrl: '/grass/polygons.json',
  height: 3,
  density: 0.045,
  maxInstances: 10000
})

await grass.readyPromise
console.log(grass.getDiagnostics())
grass.setVisible(false)
grass.setMaximumDistance(600)
grass.destroy() // 必须先于 viewer.destroy()
```

宿主需在 `polygons.json` 同目录部署 `grass-10.glb`、`grass-17.glb`。校园示例默认加载草地；使用 `?grass=none` 可显式关闭。固定 1280x800 近景中，草开启相较关闭使 GPU P50 从 9.75 ms 增到 12.82 ms，帧间隔 P95 从 18.6 ms 增到 21.7 ms；该结果是同机位 headless Chrome 对照，不是前台 FPS 承诺。

| 入口 | 签名 | 说明 |
|---|---|---|
| `createVisualPipeline` | `({ Cesium, viewer, options? }) => VisualPipeline` | `Cesium` 与 `viewer` 必需；`options` 走 `normalizeOptions` 校验。**构造时即调用 `setEnabled(true)`** |
| `getVisualPipeline` | `(viewer) => VisualPipeline \| undefined` | 全局注册表，实例不放在响应式对象里 |

两条硬约束：

- **一个 viewer 只能有一个管线**。重复创建抛 `Viewer already has a VisualPipeline`。同一页面上不要同时用源码模块和 UMD 各建一个。
- **`pipeline.destroy()` 必须先于 `viewer.destroy()`**。`destroy()` 幂等，重复调用安全。

---

## 2. 快速开始

```js
const pipeline = CCR.createVisualPipeline({
  Cesium,
  viewer,
  options: { environment: true, shadows: true, shadowMode: 'custom', antialiasing: 'smaa' }
})

// 建筑/资产锚点：自定义阴影与环境云都以它为中心
pipeline.setCampusOrigin(Cesium.Cartesian3.fromDegrees(123.42, 41.77, 0))

// 调色（唯一曝光入口，走 ACES）
pipeline.setColorGrading({ brightness: 1.08, contrast: 1.1, saturation: 1.05, hue: 0, exposure: 1.6 })

// 按需开启的效果
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao', radius: 5, strength: 0.6 })
pipeline.setHdrBloom({ enabled: true, strength: 0.15, threshold: 1, knee: 0.5, levels: 5 })
pipeline.setEnvironmentReflections({ enabled: true, strength: 0.6,
  map: '/assets/environment/your-prefiltered-ibl.ktx2' })

// 原生对比：一键回退，再开回来
pipeline.setEnabled(false)
pipeline.setEnabled(true)

// 页面销毁
pipeline.destroy()
viewer.destroy()
```

可运行的参考页：`examples/index.html`（在线 3D Tiles）、`examples/stage1.html`（本地合成场景，免 token）、`examples/white-city.html`（白模 + HDR/Bloom/SSR）、`tests/rendering/preview.html`（帧率采样与效果对比）。

---

## 3. VisualPipeline 方法总表

### 3.1 生命周期与全局

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `setOptions` | `options` | 新 options | 合并 + 校验；`shadowMode`/`environment`/`antialiasing` 变化会先 `restore()` 再 `apply()`；`shadowCascades` 变化会重建阴影图 |
| `getOptions` | — | 浅拷贝 | 读取当前生效值 |
| `setEnabled` | `boolean` | — | `false` 恢复所有被接管的原生属性并释放自有资源；`true` 重新应用 |
| `suspend` / `resume` | `owner = 'default'` | — | 多所有者挂起计数。挂起期间参数只保存，最后一个 owner 释放后一次性应用 |
| `setCampusOrigin` | `Cartesian3` | — | 设置局部环境/业务参考；阴影始终由相机和可见接收物自动定位，无需迁移原点 |
| `invalidateShadows` | — | — | 手动让自定义阴影缓存失效（静态阴影下地形/模型变动时用） |
| `write` | `(object, key, value)` | — | 记录原值后写属性，`restore()` 时只回滚仍由本模块拥有的键。高级用法 |
| `destroy` | — | — | 释放全部资源并从注册表移除；幂等 |
| `getRenderDiagnostics` | — | 大对象 | 见 [§6](#6-诊断体系) |

### 3.2 调色

| 方法 | 参数 | 返回 |
|---|---|---|
| `setColorGrading` | `{ contrast, brightness, exposure, saturation, hue }` | 生效后的 5 项 |
| `getColorGrading` | — | `{ contrast, brightness, exposure, saturation, hue }` |
| `resetColorGrading` | — | 重置为 `defaultFilters`（即 `colorGradingPresets.clear`） |

预设（`colorGradingPresets`）：

| 名称 | 值 |
|---|---|
| `neutral` | `{ contrast: 1, brightness: 1, exposure: 1.6, saturation: 1, hue: 0 }` |
| `clear` | `{ contrast: 1.1, brightness: 1.08, exposure: 1.6, saturation: 1.05, hue: 0 }` ← `defaultFilters` |

### 3.3 抗锯齿与分辨率

| 方法 | 参数 | 返回 |
|---|---|---|
| `setAntiAliasing` | `{ mode, quality?, msaaSamples, msaaCombine?, resolutionMode, resolutionScale }` 或字符串 `mode`；quality为sharp/balanced/smooth，只作用FXAA/SMAA | `getAntiAliasing()`；quality见getOptions/诊断 |
| `getAntiAliasing` | — | `{ mode, msaaSamples, resolutionMode, resolutionScale }` |
| `setTaa` | `{ enabled, jitterSamples, historyBlend, motionBlend, velocityThreshold, depthTolerance }` | `getTaaDiagnostics()` |
| `resetTaaHistory` | — | `getTaaDiagnostics()`，丢弃历史缓冲 |
| `getTaaDiagnostics` | — | 见 §5.6 |

### 3.4 几何 / 材质 / Hi-Z

| 方法 | 参数 | 返回 |
|---|---|---|
| `setGeometry` | `{ enabled, debugMode }` | `{ enabled, debugMode }` |
| `getGeometryDiagnostics` | — | 见 §5.5 |
| `setMaterialChannels` | `{ enabled }` | `{ enabled }` |
| `getMaterialDiagnostics` | — | 见 §5.5 |
| `setAlbedo` | `{ enabled }` | `{ enabled }` |
| `getAlbedoDiagnostics` | — | `{ ...actual, requested }` |
| `setDepthPyramid` | `{ enabled }` | `{ enabled }` |
| `getDepthPyramidDiagnostics` | — | 见 §5.5 |

> 依赖关系自动串联：`screenSpaceAoEnabled` 会自动请求材质通道与深度金字塔。Cube 环境反射直接使用 Cesium IBL，不请求 MRT、Hi-Z 或场景颜色。

### 3.5 屏幕空间效果

| 方法 | 参数 | 返回 |
|---|---|---|
| `setScreenSpaceAO` | `{ enabled, algorithm, radius, strength, bias }` | 生效值 |
| `getScreenSpaceAODiagnostics` | — | 见 §5.3 |
| `setHdrBloom` | `{ enabled, strength, threshold, knee, levels }` | 生效值 |
| `getHdrBloomDiagnostics` | — | 见 §5.4 |
| `setEnvironmentReflections` | `{ enabled, strength, map }` | `{ enabled, strength, map, mode: 'cube-map', source: 'static-ktx2', sceneReflections: false }` |
| `setEnvironmentReflectionIncluded` | `primitive, included=true` | 该模型当前是否参与反射 |
| `getEnvironmentReflectionDiagnostics` | — | 见 §5.5 |
| `setScreenSpaceReflections` | `{ enabled, strength }` | 兼容别名；转到 Cube 环境反射 |

### 3.6 性能调速

| 方法 | 参数 | 返回 |
|---|---|---|
| `setPerformance` | `{ enabled, targetFps, targetFrameMs, minScale, allowResolutionScaling?, sampleWindow, evaluateEvery, settleFrames }` | `getPerformanceDiagnostics()` |
| `getPerformanceDiagnostics` | — | `{ enabled, reason, targetFrameMs, targetFps, step, maxStep, label, p95, samples, ... }` |

调速器**默认关闭**，便于确定性测量。改动 `targetFps`/`targetFrameMs`/`minScale`/`sampleWindow`/`evaluateEvery`/`settleFrames` 会销毁并重建实例（这些键只在创建时读取一次）。

---

## 4. 选项完整参考

`options` 通过 `normalizeOptions(input, current)` 合并校验：数值键只在 `Number.isFinite` 时被接受并 clamp 到区间；布尔键只在 `typeof === 'boolean'` 时被接受；枚举键只在白名单内时被接受。非法值被静默忽略（保留旧值），不抛错。

### 4.1 默认值一览

| 分组 | 键 | 默认 | 允许范围 / 取值 |
|---|---|---|---|
| 抗锯齿 | `antialiasing` | `'smaa'` | `off` / `msaa` / `fxaa` / `smaa` / `taa` |
| | `msaaSamples` | `1` | `1` / `2` / `4` / `8` |
| | `msaaCombine` | `false` | 布尔 |
| | `resolutionMode` | `'native'` | `native` / `css` |
| | `resolutionScale` | `1` | clamp `0.5 – 2` |
| 阴影 | `shadows` | `true` | 布尔 |
| | `shadowMode` | `'custom'` | `custom` / `native` |
| | `shadowSize` | `4096` | `1024` / `2048` / `4096`；custom 单级联时是整张贴图尺寸，三级时是近级尺寸，中远级各为一半（最低 512） |
| | `shadowCascades` | `1` | `1` / `3` / `4`；custom 使用 1 或 3（历史 4 映射为 3）；native 非 1 使用原生 4 级 |
| | `shadowDistance` | `4000` | `100 – 20000` m |
| | `shadowDebug` | `false` | 布尔 |
| | `shadowStatic` | `false` | 布尔 |
| 环境 | `environment` | `true` | 布尔 |
| | `environmentPreset` | `'clear'` | `clear` / `morning` / `overcast` / `sunset` / `haze` |
| | `environmentQuality` | `'balanced'` | `balanced` / `high` |
| | `skyLightIntensity` | `3.2` | `0 – 5` |
| | `sunIntensity` | `2.2` | `0 – 5` |
| | `clouds` | `true` | 布尔 |
| | `cloudGeometry` | `'shell'` | `local` / `shell` |
| | `cloudModel` | `'auto'` | `auto` / `cumulus` / `stratus` |
| | `cloudCoverage` | `null`（跟随预设） | `0 – 0.95`，`null` = 预设值 |
| | `cloudBaseHeight` | `null` | `50 – 12000` m |
| | `cloudThickness` | `null` | `100 – 6000` m |
| | `volumetricFog` | `true` | 布尔 |
| | `sunScattering` | `true` | 布尔 |
| | `environmentAnimation` | `true` | 布尔（关掉则云不飘动） |
| | `fogBaseHeight` | `20` | `-1000 – 10000` m |
| | `fogHeightFalloff` | `null` | `10 – 3000` |
| 雾/原生 | `fog` | `true` | 布尔 |
| | `fogDensity` | `0.000025` | `0 – 0.0005` |
| | `ambientOcclusion` | `false` | 布尔（原生 AO，默认关） |
| | `bloom` | `false` | 布尔（原生 Bloom，默认关） |
| 调度 | `exposure` | `1.6` | `0.05 – 5` |
| | `contrast` | `1.1` | `0 – 3` |
| | `brightness` | `1.08` | `0 – 3` |
| | `saturation` | `1.05` | `0 – 3` |
| | `hue` | `0` | `-1 – 1` |
| HDR Bloom | `hdrBloomEnabled` | `false` | 布尔 |
| | `hdrBloomStrength` | `0.15` | `0 – 2` |
| | `hdrBloomThreshold` | `1` | `0 – 20` |
| | `hdrBloomKnee` | `0.5` | `0 – 1` |
| | `hdrBloomLevels` | `5` | 整数 `2 – 6` |
| 几何/材质 | `geometryEnabled` | `false` | 布尔 |
| | `geometryDebugMode` | `'off'` | `off` / `normal` / `depth` |
| | `materialChannelsEnabled` | `false` | 布尔 |
| | `albedoEnabled` | `false` | 布尔 |
| | `depthPyramidEnabled` | `false` | 布尔 |
| SSAO/HBAO | `screenSpaceAoEnabled` | `false` | 布尔 |
| | `screenSpaceAoAlgorithm` | `'ssao'` | `ssao` / `hbao` |
| | `screenSpaceAoRadius` | `3` | `0.1 – 20` m |
| | `screenSpaceAoStrength` | `1` | `0 – 2` |
| | `screenSpaceAoBias` | `0.08` | `0.02 – 0.5` |
| Cube 环境反射 | `environmentReflectionEnabled` | `false` | 布尔 |
| | `environmentReflectionStrength` | `1` | `0 – 1` |
| | `environmentReflectionMap` | `null` | 预过滤 CubeMap KTX2 URL |
| TAA | `taaJitterSamples` | `8` | `4` / `8` / `16` / `32` |
| | `taaHistoryBlend` | `0.03` | `0.02 – 0.5` |
| | `taaMotionBlend` | `0.5` | `0.1 – 1` |
| | `taaVelocityThreshold` | `12` | `1 – 64` px |
| | `taaDepthTolerance` | `0.1` | `0 – 0.5` |

### 4.2 默认开启的效果

不做任何配置时：环境（体积雾 + 云 + 天空 + PBR 环境光）、自定义方向光阴影、ACES 色调映射、`clear` 调色、SMAA1x + MSAA1 已生效。AO / Bloom（HDR 与原生）/ SSR / 几何 / 材质 / Hi-Z / TAA / 调速器均**默认关闭**，需显式开启。

> 白模或纯净演示场景常用 `options: { environment: false, shadows: false, shadowMode: 'native', antialiasing: 'fxaa', fog: false }` 起步，再逐项叠效果。

---

## 5. 效果专题

### 5.1 阴影

- **`shadowMode: 'custom'`（默认）**：CCR 自有光源相机、投影选择、深度图与接收 shader。默认单级联 4096²（共 64 MiB 深度附件）；显式 `shadowCascades: 3` 且保留默认 `shadowSize: 4096` 时为 4096² + 2048² + 2048²（96 MiB）；同时设 `shadowSize: 2048` 才是 2048² + 1024² + 1024²（24 MiB）。PBR Model、3D Tiles、Globe 和透明前向共享级联；Globe 保留自己的表面光照语义。
- 线性/对数混合 split（lambda 0.6），按实际接收范围收紧覆盖；固定半径档位与 texel snapping 稳定，区间末端 10% 混合，阴影距离之外渐隐。每级独立选取画面外 caster，高程参与光空间深度范围。
- `shadowMode: 'native'` 是显式原生对照选项，不是 custom 失败后的自动回退。原生多级对照可设 `shadowCascades: 4, shadowSize: 2048`；原生单级对照可设 `shadowCascades: 1, shadowSize: 4096`。
- `shadowStatic: true` 按光源矩阵和实际 caster 内容签名复用；同一纹理或实例缓冲原地改写须 `invalidateShadows()`。自适应更新在相机静止或移动时均最多复用一个显示帧，下一帧重新检查、提交阴影；不会因为相机静止而永久冻结动态 caster。光照、视锥、根图元、caster 命令引用、阴影尺寸或配置变化立即退出复用；每帧新建的 COMPUTE 调度命令不参与 caster 身份比较。原地矩阵/动画/缓冲变化最多延后一帧，要求当帧生效时调用 `invalidateShadows()`。

### 5.2 环境（雾 / 云 / 天空）

由管线默认启用的独立 HDR 支线完成：高度雾与体积雾、太阳与阴影散射、体积云，半分辨率积分后按深度约束合成，再回到主 HDR 链。

| 预设 | 雾系数 | 雾高 | 云量 | 云型 | 云底/云顶 | Mie | 太阳 |
|---|---|---|---|---|---|---|---|
| `clear` | 1 | 180 | 0.42 | cumulus | 1600 / 2800 | 0.65 | 1 |
| `morning` | 9 | 85 | 0.3 | cumulus | 1800 / 2800 | 1.1 | 0.9 |
| `overcast` | 2.5 | 260 | 0.78 | stratus | 1000 / 1600 | 1.6 | 0.45 |
| `sunset` | 2 | 160 | 0.4 | cumulus | 1400 / 2600 | 1.2 | 1 |
| `haze` | 5 | 380 | 0.22 | stratus | 1800 / 2400 | 2 | 0.7 |

- 太阳强度随太阳高度角自动衰减：`daylight`、`direct`、`white` 三条 smoothstep 曲线决定 `sunColor` 与 `sunIntensity`，日落后直射为 0。模块**不会自行推进时钟**。
- `cloudGeometry`：`local` 为以 `setCampusOrigin` 为中心的 ENU 局部体积，相机离中心超过 **100 km** 时旁路（退回原生全球大气，因此不是全球体积云）；`shell` 为椭球归一化球壳，区域外也能渲染云，且允许 0 视锥的纯天空帧。
- `environmentQuality`：`balanced` / `high` 决定步数（雾 24/40 步，云 64/96 步，shell 128/192 步）与最大云距（30 km / 50 km）。
- 1080p 记录目标：半分辨率 960×540 RGBA32F（7.91 MiB）+ 全分辨率 1920×1080 RGBA32F（31.64 MiB）+ 噪声图约 1.06 MiB ≈ **40.61 MiB** 逻辑目标量（不含原生环境图、驱动开销与瞬态峰值）。
- 诊断入口：`pipeline.environmentRenderer.getDiagnostics()` → `{ enabled, lighting, hdr, preset, quality, sunAltitude, withinRegion, volumeRadius: 100000, cloudGeometry, cloudScope, cloudModel, cloudCoverage, fogDensity, windOffset, effectSize }`。

### 5.3 屏幕空间 AO（SSAO / HBAO）

```js
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao', radius: 5, strength: 0.6, bias: 0.08 })
```

- 算法：`ssao` 为 8 方向 × 4 径向采样（可见性 `1 - strength * occlusion / 32`）；`hbao` 为 8 方向 × 8 步、只累加新增地平线角（`1 - strength * occlusion / 8`）。**两者同名 `strength` 不等价**。
- 半分辨率 `raw/horizontal/vertical`（RGBA8）+ 全分辨率 `resolve`（FLOAT）：横纵各 5 tap 双边滤波（权重 `[1,4,6,4,1]`），resolve 再按平面距离与法线校验。**不要把 raw 阶段当最终结果**。
- 只对 `eyeDepth > 0`、`flags & 3 == 3` 且非 MASK/unlit/自定义材质、有有效法线的接收点生效；透明覆盖（`transparency.r > 0`）像素跳过；Hi-Z 有未知遮挡标记（`hiz.a > 0`）时保守取消该估计。
- 合成式为 `emission + (source - emission) * visibility`，保留原 alpha，不重复曝光/伽马。
- 开启自定义 AO 时原生 `postProcessStages.ambientOcclusion` 会被关掉（避免叠加）。
- 诊断键：`{ enabled, supported, valid, algorithm, reason, error, failed, stats{frames,bypasses}, bytes, scope, allocationScope, requested }`。`valid` 为真表示本帧输出纹理可用。

### 5.4 HDR Bloom

```js
pipeline.setHdrBloom({ enabled: true, strength: 0.15, threshold: 1, knee: 0.5, levels: 5 })
```

- 线性 HDR 空间的多尺度 Bloom：`levels` 级降采样（首级带 `threshold`/`knee` 预过滤）+ `levels-1` 级 tent 上采样 + 1 级 resolve。默认 5 级共 10 个后处理 stage。
- 运行在原生色调映射**之前**、TAA **之前**（优先级 22）。`strength = 0` 时整帧旁路并记录 `reason = 'Zero strength'`。
- 改 `levels` 需要重新启用（`setEnabled(true)` 检测到层数不符会先释放再建）。
- 诊断键：`{ enabled, supported, failed, error, valid, reason, levels, stats{frames,bypasses}, bytes, scope, requested }`。`bytes` 是去重后的活动纹理逻辑量，不等同进程显存。

### 5.5 Cube 环境反射

```js
pipeline.setEnvironmentReflections({
  enabled: true,
  strength: 0.6,
  map: '/assets/environment/your-prefiltered-ibl.ktx2'
})
pipeline.getEnvironmentReflectionDiagnostics()

// 模型默认不参与；只把确实含镜面材质的对象加入，传 false 可移除。
pipeline.setEnvironmentReflectionIncluded(mirrorBuilding, true)
```

- `map` 写入模型/3D Tiles 的 `imageBasedLighting.specularEnvironmentMaps`，必须是包含六个面和粗糙度卷积 mip 链的 KTX2。它与 Blender 的 HDRI 镜面路径等价，不采样当前屏幕内建筑、道路或其他场景颜色。CCR 对相同 map、强度和 diffuse 因子的 GLB 模型共享一个 `ImageBasedLighting` 实例，避免每个模型并发创建相同 URL 的 KTX2 加载；关闭、变更或销毁时恢复模型原有 IBL 所有权。
- `strength` 只调整 `imageBasedLightingFactor.y`；静态环境图优先于 `DynamicEnvironmentMapManager` 的天空/大气镜面图。关闭、挂起或销毁管线时恢复资产原值，不替换资产原有 `imageBasedLighting` 对象。
- 不创建 SSR 后处理、透明反射、反射 MRT、场景颜色副本或反射专用 Hi-Z。诊断固定报告 `mode: 'cube-map'`、`sceneReflections: false`。
- 校园示例随附 `/assets/environment/kiara_6_afternoon_2k_ibl.ktx2`；其他接入方应部署自己的预过滤 KTX2，并传入可访问 URL。
- 旧 `setScreenSpaceReflections`/`getScreenSpaceReflectionDiagnostics` 保留为兼容入口，但会转到相同的 CubeMap 路径；`distance`、`thickness`、`transparent` 不再生效。
- 诊断键：SSR 为 `{ enabled, supported, valid, reason, error, failed, stats{frames,bypasses}, bytes, uniformBuffers{camera,reflection}, scope, allocationScope, requested }`；透明反射额外有 `mode: 'oit' | 'sorted'`。

**材质 / 几何 / Hi-Z 诊断**（自动开启后可用）：

| 方法 | 关键键 |
|---|---|
| `getMaterialDiagnostics()` | `enabled, supported, valid, reason, error, stats{frames,draws,invalidators,transparentDraws,frustumCount}, bytes, allocationScope, format, opaqueOnly, unsupportedSurfacesHaveInvalidDepth, materialLayoutVersion: 2, depthContractVersion: 2, ...` |
| `getGeometryDiagnostics()` | `enabled, supported, debugMode, encoding, ready, depthUnits, valid, frustumCount, reason, drawingBuffer, geometryTexture, outputTexture, estimatedBytes, allocatedBytes, names` |
| `getDepthPyramidDiagnostics()` | `supported, valid, reason, error, failed, bytes, frames, outputFrame, transparencyIncluded, unknownMaskContractVersion: 2, unknownMaskBits{opaque:1,transparency:2}, levels, format, allocationScope` |

纹理格式与契约：

- 材质 MRT：`RGBA8 normal/roughness/metallic + RGBA16F emissive/flags + R32F eye-depth + R8 transparency`，另有 `reflectionSpecular`/`reflectionResponse`（RGBA16F）、`opaqueColor`（RGBA16F）、`albedoOcclusion`（RGBA16F）。
- 深度契约 v2：**`正数 = 已知视空间米数`，`0 = 背景`，`负数 = 未知不透明遮挡`**。消费方必须保留这个区分。
- 几何通道 v1：RGBA16F，RG 为八面体视空间法线、BA 打包 `depth/1024`；全零表示无效。
- Hi-Z：每层 RGBA32F，R/G 为区域已知正深度 min/max，B 为完整覆盖标记，A 为位掩码（`1 = 未知不透明`、`2 = 透明覆盖`、`3 = 二者`、`0 = 均无`）。显式 `setDepthPyramid({ enabled: true })` 仍生成完整金字塔（1080p 为 11 层）；仅由 AO 自动请求时只生成基础归约层。内部反射消费者请求多级，不能用自动依赖的裁剪覆盖调用者显式完整请求。

`MATERIAL_FLAGS`（`materialShader143.js`，RGBA16F 附件 A 通道的非归一化整数）：

```
SURFACE 1   NORMAL_VALID 2   METALLIC_ROUGHNESS_VALID 4   EMISSIVE_VALID 8
ALPHA_MASK 16   UNLIT 32   CUSTOM 64   SPECULAR_GLOSSINESS 128
ALBEDO_VALID 256   STANDARD_PBR_VALID 512
```

### 5.6 抗锯齿与分辨率

| 模式 | 做法 | 备注 |
|---|---|---|
| `off` | 关闭 | 强制 `msaaSamples` 生效值为 1 |
| `msaa` | 仅多重采样 | 原请求1且未显式指定时默认请求4，实际取HDR颜色/深度共同支持值 |
| `fxaa` | CCR最终颜色单pass，复用Cesium FXAA3.11 | quality调节亚像素平滑与阈值；原生FXAA保留作回退 |
| `smaa` | 自有 SMAA 1x（三阶段，AreaTex 160×560 / SearchTex 66×33） | quality为清晰/均衡/平滑，默认均衡；未就绪或失败时回退原生FXAA |
| `taa` | 自有时间抗锯齿 | 自身完成 HDR 链解析，与 MSAA、SMAA/FXAA 互斥 |

`resolveMsaaPolicy({ antialiasing, msaaSamples, msaaCombine })` → `{ requested, effective, combined, reason }`：后处理 AA 默认将effective降到1；显式msaaCombine:true时保留多采样请求。硬件采样与后处理可能互补，按场景预算选择；旧P95记录不再作为验收结论，当前校园配置与证据见CAMPUS_ANTIALIASING.md。

**TAA**：

本分支以固定Three.js r186 TRAA为上游，并包含经授权的CCR采样/历史接受适配；有效选项`taaDepthThreshold=.0005`、`taaEdgeDepthDiff=.001`、`taaMaxVelocityLength=128`、`taaUseSubpixelCorrection=true`。`setTaa`对应`depthThreshold/edgeDepthDiff/maxVelocityLength/useSubpixelCorrection`。旧blend/velocityThreshold/depthTolerance/Gamma仅保留解析，不影响resolve，以`algorithm/legacyIgnored`诊断为准。官方深度阈值为主相机perspective[0,1]域，另有前帧眼空间米制遮挡拒绝。TAA强制MSAA=1；其他模式组合规则保留。来源及偏离见`src/antialiasing/reference/three-r186/PORTING.md`。

- `taaJitterSamples`默认8，可选4/8/16/32；运行时改变会重启历史，不必连同模式重设。更多相位不保证更稳定。
- `taaBlendWeights(settings)`和`taaVarianceGammas(settings)`仅作源模块兼容helper，不代表实际帧权重。
- 私有历史：2个RGBA32F颜色+1个R32F眼深；RHI只保留1个RGBA32F显示颜色目标，继续计入兼容字段`rhiHistoryBytes`，移动刚体另用RGBA32F motion。Graph直接绑定私有历史；显示拷贝将采样年龄alpha恢复为场景alpha后返回显示链。
- `getTaaDiagnostics()`包括`algorithm.adaptation/legacyIgnored/motion/stageBytes/rhiHistoryBytes/bytes`；`staticFrames`是相机停稳时长，不能当所有像素的历史年龄。实际颜色、深度采样器也单独报告。
- `resetTaaHistory()` 的适用场景：相机瞬移、场景内容突变之后（否则历史帧会残留拖影）。

### 5.7 性能调速器

```js
pipeline.setPerformance({ enabled: true, targetFps: 30, minScale: 0.6 })
```

- 依据 P95 帧时间（最近秩分位数）在降级阶梯上调整质量；默认保持 `resolutionScale` 不变，只下调 `shadowMode === 'custom'` 的 `shadowSize`，避免运行中画面变模糊。只有显式传入 `allowResolutionScaling: true` 才允许降级阶梯修改 `resolutionScale`；禁用调速器会精确还原基线。
- 阶梯：`baseline(1.00)` → `-10%(0.90)` → `-20%(0.80)` → `-30%(0.70)` → `-40% + shadow ≤ 2048(0.60)` → `-40% + shadow ≤ 1024(0.60)`。
- 诊断键：`{ enabled, reason, targetFrameMs, targetFps, step, maxStep, label, p95, samples, sampleWindow, evaluations, changes, minScale, baseline, pendingStep }`。
- `quantile(values, fraction)` 为独立导出的分位数工具（空数组返回 `0`）。

### 5.8 渲染顺序（HDR 效果优先级）

```
SSR(5) → 透明 SSR(6) → AO(10) → 体积环境(20) → HDR Bloom(22) → TAA(25) → 原生 tonemap/后处理
→ 调色（显示空间） → SMAA / FXAA
```

SSR 必须早于 AO（捕获的原生镜面项此时尚未乘 AO）。环境支线通过包装 `collection.execute` 取得色调映射前的 HDR；调色阶段（`color` stage）已经在显示空间，**不再做曝光或伽马**。

---

## 6. 诊断体系

`pipeline.getRenderDiagnostics()` 返回（`src/VisualPipeline.js:434`）：

```js
{
  enabled, suspended,
  colorGrading,                                   // 5 项调色值
  antiAliasing: {
    ...getAntiAliasing(),                         // mode, msaaSamples, resolutionMode, resolutionScale
    msaa: { requested, selected, combined, policy, ... },   // selectMsaaSamples 的实测结果
    configuredMsaaSamples,                        // scene.msaaSamples 实际配置
    allocatedAttachments,                         // 只读 GPU 查询：scene / globe 的 renderbuffer 采样数
    postProcess: { effective: 'taa' | 'smaa' | 'fxaa' | 'off', ... }
  },
  resolution: { nativeDpr, css, drawingBuffer, effectivePixelRatio, imageRendering },
  geometry, materials, albedo, taa, depthPyramid,
  screenSpaceAO, hdrBloom, screenSpaceReflections, transparentReflections,
  performance
}
```

每个子效果诊断都遵循同一套语义：

| 字段 | 含义 |
|---|---|
| `enabled` | 请求是否生效（管线启用、未挂起、已创建对应资源） |
| `supported` | 硬件/上下文能力检测结果（如缺 `colorBufferFloat`） |
| `valid` | **本帧**输出是否真的可用（多数实现要求 `outputFrame === scene.frameState.frameNumber`） |
| `reason` | 未生效的**具体原因字符串**，下表 |
| `error` / `failed` | 渲染期异常。失败后**锁存**，必须显式 `setEnabled(false)` 再开才能重试 |
| `requested` | 独立回显的请求参数（部分方法额外拼装） |
| `stats` | `{ frames, bypasses, draws, resets, ... }` 计数 |
| `bytes` / `allocationScope` | 本模块自有的活动纹理逻辑字节数与统计范围（不含借用的原生/他模块资源） |

常见 `reason` 字符串：

| 字符串 | 出现场景 |
|---|---|
| `'Not requested'` / `'Disabled'` | 上层没开或已显式关闭 |
| `'Suspended'` / `'Pipeline disabled'` / `'Destroyed'` | `suspend()` / `setEnabled(false)` / `destroy()` |
| `'Not rendered'` / `'No output'` / `'Not ready'` | 本帧还没跑或输出尚未就绪 |
| `'Requires HDR'` | 场景 `highDynamicRange` 未开（管线已强制开启） |
| `'Requires 3D scene'` / `'Requires perspective camera'` / `'Requires symmetric perspective camera'` | 2D/哥伦布视图、正交或非对称视锥 |
| `'Requires one current frustum'` / `'Requires single-frustum depth'` | 多视锥帧（VR/分屏） |
| `'underground camera'` / `'translucent globe depth'` | 地下相机、透明地球 |
| `'No current material depth'` / `'No current Hi-Z depth'` / `'No current transparency coverage'` | 依赖通道本帧缺失 |
| `'Missing webgl2, depthTexture, ...'` | 能力缺失列表 |
| `'<模块> failed; disable before retrying'` | 渲染期异常后的锁存状态 |
| `'Zero strength'` | Bloom 强度为 0 |
| `'Unsupported transparent depth test/write state'`、`'Complex transparent stencil not supported'`、`'Unsupported sorted transparent RGB blending'` 等 | 透明反射遇到不兼容命令，整帧旁路（只写 reason，不置 failed） |
| `'Material pass failed; disable before retrying'` 等各子通道失败串 | 子通道异常，需重新开关 |

独立性能剖析器（默认不安装）：

```js
const profiler = new CCR.RenderProfiler143(Cesium, pipeline)
// ...运行若干帧
profiler.getReport()
// { scope, gpuSupported, gpu:[{label,milliseconds}], cpu:[...], frames:[{milliseconds,drawCalls,submittedCommands}],
//   textures:{ scope, currentBytes, peakBytes, entries[] },
//   uniformBuffers:{ scope, currentBytes, peakBytes, entries[] }, pending, discarded, skipped, drawScope }
profiler.destroy()
```

`textures` 与 `uniformBuffers` 都**按对象去重**统计；两个反射消费者共用的相机 UBO 只计一次，这也是文档里 "192 字节" 的由来。`gpu` 走 `EXT_disjoint_timer_query_webgl2`，扩展不可用时全部计入 `skipped`。

---

## 7. 低层 API（可选）

常规接入只需 `VisualPipeline`。以下类可直接 `import`（源码路径）或经 `CCR.*`（UMD）使用，构造函数与回调契约：

| 类 | 构造 | 回调契约 |
|---|---|---|
| `ScreenSpaceAo143` | `new ScreenSpaceAo143(C, scene, getMaterials, getOptions)` | `getMaterials()` 必须返回带 `getTextures()` 与 `getDepthPyramidLevels()` 的材质生产者；`getOptions()` 返回含 `screenSpaceAo*` 的选项 |
| `HdrBloom143` | `new HdrBloom143(C, scene, getOptions)` | `getOptions()` 返回含 `hdrBloom*` 的选项 |
| `ScreenSpaceReflection143` | `new ScreenSpaceReflection143(C, scene, getMaterials, getOptions)` | `getTextures()` 须含 `eyeDepth`/`normalRoughMetal`/`emissiveFlags`/`transparency`/`reflectionSpecular`/`reflectionResponse`，且 `getReflectionDiagnostics().valid` 为真 |
| `TransparentReflection143` | `new TransparentReflection143(C, scene, getMaterials, getOptions)` | 额外需要 `opaqueColor` 与 `getOpaqueColorDiagnostics().valid` |
| `ScreenSpaceGeometry143` | `new ScreenSpaceGeometry143(Cesium, scene)` | 无回调；方法 `setEnabled` / `setDebugMode('off'\|'normal'\|'depth')` / `getTexture()` / `getDiagnostics()` |
| `MaterialChannels143` | `new MaterialChannels143(C, scene)` | 子通道开关 `setEnabled` / `setDepthPyramidEnabled` / `setReflectionEnabled` / `setOpaqueColorEnabled` / `setAlbedoEnabled`；`getTextures()` / `getDepthPyramidLevels()` |
| `DepthPyramid143` | `new DepthPyramid143(C, scene)` | `setMaxLevel(level?)` / `update(sourceTexture, frameNumber, transparencyTexture?)` / `getLevels()` / `invalidate()` / `release()` |
| `SmaaPass143` | `new SmaaPass143(C, scene)` | 字段 `readyPromise`；`getDiagnostics().effective` 为 `'smaa' \| 'fxaa' \| 'off'` |
| `TaaPass143` | `new TaaPass143(C, scene, getOptions)` | `resetHistory()` / `getDiagnostics()`；另导出 `taaBlendWeights(settings)` |
| `TaaJitter143` / `FrustumJitterBridge143` | `new TaaJitter143(C, scene, { samples })` / `new FrustumJitterBridge143(C, scene, { request })` | `request()` 返回 `{ frustum, pixel, baseX, baseY, xOffset, yOffset }` 或 `null` |
| `PerformanceGovernor143` | `new PerformanceGovernor143(pipeline, options)` | 需要一个具备 `setOptions`/`getOptions`/`viewer` 的管线；`setEnabled` / `detach` / `destroy` |
| `RenderProfiler143` | `new RenderProfiler143(C, pipeline)` | `getReport()` / `destroy()`；满 4096 帧自动销毁 |
| `LightUniforms143` | `new LightUniforms143(C, context)` | `update(lights, offset, viewMatrix)` → `{ count, nextOffset, uploadedBytes }`；容量 `LIGHT_CAPACITY = 128`/页 |

工具函数：`halton(index, base)`、`jitterSample(index, samples = 8) → { x, y }`（分量 `[-0.5, 0.5]`）、`nearPlaneOffsets(frustum, jitter, resolution) → { xOffset, yOffset } | null`（单位米）、`isSubPixelOffset(frustum, resolution, pixels = 1)`、`DEFAULT_JITTER_SAMPLES = 8`、`quantile`、`taaBlendWeights`、`resolveMsaaPolicy`、`isPostProcessAntiAliasing`、`postProcessAntiAliasingModes`、`normalizeOptions`、`normalizeColorGrading`、`defaultFilters`、`colorGradingPresets`、`colorGradingControls`（面板用 `{ key, label, min, max, step }`）。

深路径 import（既不在 `src/index.js` 也不在 UMD 上的符号）：`src/buffers/` 的 `CameraUniforms143`、`UniformBuffer143`，`src/shadows/*`、`src/shadowBias143.js`、`src/shadowMap143.js`、`src/reflections/OitCompatibility143.js`、`src/environment/*`，以及 `src/antialiasing/settings143.js` 的 `selectMsaaSamples`/`renderResolution`/`readMsaaAttachments`。

只有 UMD 额外导出、源码入口没有的符号：`LightUniforms143`、`RenderProfiler143`（`scripts/build-rendering-sdk.cjs` 的入口里显式加了它们和 `VERSION`/`CESIUM_VERSION`）。源码模式下 `RenderProfiler143` 走 `src/diagnostics/RenderProfiler143.js`，`LightUniforms143` 走 `src/buffers/LightUniforms143.js`。

---

## 8. 排查清单

1. **效果开了但画面没变** → 先看 `getXxxDiagnostics().reason`，再确认 `valid` 是否为 true。`enabled: true, valid: false` 说明本帧没跑成。
2. **一次失败后再也起不来** → 失败是锁存的（`reason: '... failed; disable before retrying'`）。写 `setEnabled(false)` 再 `setEnabled(true)`。
3. **AO/SSR 在遮挡物附近出现噪点或截断** → 属于屏幕空间固有边界（屏幕外信息不可恢复、未知遮挡保守拒绝、薄物体）。可增大 `distance`/`thickness` 或换视角验证，不要当成 bug。
4. **静止场景不出画面（`requestRenderMode: true`）** → 改完参数要 `viewer.scene.requestRender()`；本管线的 setter 内部大多会调用，但直接改 `pipeline.options` 不会。
5. **切换视图后阴影/云不对** → 阴影随相机自动定位；检查 shadowDistance、太阳是否在地平线以上及 customShadow.stats.error。只有局部环境参考需要 setCampusOrigin；静态阴影资源原地改写后调用 invalidateShadows。
6. **多视锥 / 分屏 / VR / 正交相机** → 环境、几何、材质、AO、SSR、TAA 都会按 `reason` 旁路，属预期行为。
7. **销毁顺序** → `pipeline.destroy()` → `viewer.destroy()`。反向顺序会触发管线内部的视图已销毁分支。
8. **调色和 Bloom 的曝光关系** → 曝光只在管线 ACES 通道做一次；调色是显示空间。环境支线内的天空有独立的 `rayleighScale`/`mieScale`/`atmosphereIntensity` 平衡，不要再手动补曝光。

---

## 9. 能力边界与未实现

- 默认 enhanced 模式的主颜色仍来自 Cesium 原生前向渲染。B02 可选 deferred 已接管支持范围内的标准不透明 PBR（见 10.3）；尚无实际对象遮挡剔除、分块光照、5000 灯实时渲染。
- 体积雾与云是**局部/球壳**效果，不是全球体积雾；云影不投到地面，云不参与 IBL 与反射探针。
- 材质通道只支持单采样 MRT，不提供运动矢量、透明表面法线、玻璃/水自身光学参数；拒绝 classification、edge-only、voxels、Gaussian splats、透明 Globe、invert classification、WebVR、depth-only 模型。
- 透明覆盖是二值单采样，不等于完整 MSAA 透明覆盖；透明物体之间不支持递归反射与折射。
- Hi-Z 只提供保守深度范围与未知标记，不做视觉合成、不做 DrawCommand 剔除、无时域历史、不是硬件 mipmap。
- TAA 使用单视锥深度；多视锥回退 FXAA。无运动矢量的物体边缘仍可能有空间采样锯齿。
- 环境支线需要 `depthTexture`、`floatingPointTexture`、`colorBufferFloat` 与 3D 透视单视锥。
- 上下文丢失后的自动重建、完整业务页面与所有硬件组合的兼容性均未认证。
- 原生回退路径依赖 1.143 私有字段（`_primitiveBias`、`_lightCamera`、`frustumCommandsList` 等），升级 Cesium 必须重新验证屋顶、近景接触阴影与远景表现。

---

## 10. B00 基准与 B01 帧执行桥（2026-09-15 修复）

详细验收范围见 [STAGE1_ACCEPTANCE.md](../archive/STAGE1_ACCEPTANCE.md)，逐项修复见 [B00_B01_FIX_HANDOVER.md](../archive/B00_B01_FIX_HANDOVER.md)。

基准位于 `tests/rendering/baselines/<target>-<configuration>.json`。默认只读比较；`--mode update --repeat 2` 才能建立/更新基准，且必须两次独立浏览器上下文运行一致。历史单文件 `stage1-baseline.json` 已停用，不会继续覆盖。支持 `isolated`、`ccr-default`、`campus-quality` 三种配置。当前发布五份通过独立复比的golden；校园campus-quality未通过严格复比，不发布该组golden，保留失败证据。

```powershell
node scripts/dev-server.cjs --port 8877
$env:CCR_TEST_PORT = '8877'
# 按本机安装位置设置 CESIUM_PLAYWRIGHT 后运行
node scripts/check-stage1-baseline.cjs --target campus-geometry --configuration ccr-default --mode compare --repeat 1
node scripts/check-stage1-baseline.cjs --target fixtures --configuration ccr-default --mode compare --repeat 1
node scripts/check-stage1-baseline.cjs --target campus --mode visual --repeat 1
node scripts/check-baseline-guards.cjs
node scripts/check-frame-bridge.cjs
```

真实校园需要本地校园资产和实际影像配置，缺失时应失败。移除影像的几何目标只用于独立回归，不能替代真实影像验收。跨硬件/驱动的位精确图像不作保证；硬件/资产不匹配先复核，再显式更新基准。

### 10.1 帧执行桥

`createFrameBridge({ Cesium, scene })` 是实验性OIT接点；VisualPipeline 的可选 deferred 模块使用它，桥本身不等于完整延迟照明。优先使用最后的OIT合成前阶段：

```js
const bridge = CCR.createFrameBridge({ Cesium, scene })
const off = bridge.on('translucent', context => {
  // 全部不透明颜色已准备好，OIT尚未合成。
  const result = bridge.uploadOpaqueColor([1.2, 0.9, 0.7, 1])
  if (!result.applied) console.debug(result.reason)
})
bridge.install()
// off(); bridge.destroy()
```

| 阶段/模式 | 契约 |
| --- | --- |
| opaqueFrame / opaqueReadHook | 每次OIT透明绘制入口的观察事件；frustum给出近远值，viewId表示真实view身份，不等同视锥序号 |
| translucent | 最终OIT合成前；已验证MRT、multipass、MSAA 4×、10视锥颜色替换 |
| resolve | 后处理结束，只观察；不允许覆盖不透明颜色 |
| OIT关闭/排序透明 | 没有伪造的opaque事件，只观察resolve，写入返回applied=false |
| 帧外、拾取、非3D、WebVR | 不允许写入；不触发渲染消费者 |
| 上下文丢失 | 卸载并释放自有资源；宿主恢复上下文后再显式安装，不保证整个Cesium场景自动恢复 |

`opaqueReadHook`只允许单视锥、单采样写入；MSAA/多视锥必须在`translucent`阶段写入已解析颜色。这里证明的是最终颜色接点，不证明已经完成逐视锥延迟照明。

`readOpaqueColor(x,y)`是同步诊断接口，坐标以纹理左下角为原点，结果为解码后的线性色；MSAA读回限于`translucent`回调。该接口恢复GL绑定及Cesium绑定缓存，并随纹理身份重建附件；不能用CPU读回实现主照明。

消费者抛异常后会被停用并记录错误，避免每帧重复失败；卸载保留外部wrapper，但旧安装token永久失效。resize/卸载/销毁只释放自有FBO与program，保留Cesium借用纹理和共享全屏几何。

### 10.2 示例运行时配置

示例通过 `examples/runtime-config.js` 读取 `window.CCR_EXAMPLE_CONFIG`；SDK不内嵌示例凭据。开发服务器从当前进程环境读取：

- `CCR_EXAMPLE_IMAGERY_URL`：校园影像模板URL。
- `CCR_EXAMPLE_ION_TOKEN`：可选Cesium Ion token。

在启动服务器的终端设置，值不要写入Git、构建包或持久化系统环境。静态部署由部署流程生成运行时配置或在加载示例前注入同名对象。客户端实际需要的配置会发送给浏览器，不能用它保存服务端秘密。


### 10.3 B02 标准不透明延迟照明（可选）

```js
pipeline.setAntiAliasing({ mode: 'smaa' }) // 单采样；MSAA 走增强回退
pipeline.setScreenSpaceReflections({ enabled: true, transparent: true }) // B03 支持延迟镜面替换与玻璃反射
pipeline.setLighting({ mode: 'deferred' })
pipeline.setLighting({ aoStrength: 0.8, debugMode: 0 }) // 未传 mode 时保留当前模式
console.log(pipeline.getLightingDiagnostics())
// 显式关闭也会清除失败锁；随后可以重试
pipeline.setLighting({ mode: 'enhanced' })
```

如需 AO，请另外通过 setScreenSpaceAO 开启；lighting.ao 仅决定是否消费可用的 AO。shadow 同理，消费现有自定义太阳阴影。开关 direct、indirect、emissive、shadow、ao 分别控制对应项，aoStrength 限定 0–1。debugMode：0 正常、1 直接、2 间接、3 自发光、4 阴影可见性、5 AO、6 roughness/metalness、7 albedo。

诊断 requested 是请求模式，activeMode/valid 才是本帧结果；reason 说明回退或故障。默认 enhanced 不变。MSAA、多种非透视/分类模式、排序模式的不透明延迟接点及 TAA 组合暂不接管；SSR 延迟组合已由 B03 支持。标准 Model、MASK/法线贴图/实例化/蒙皮及中性 feature 3D Tiles 已验证；未映射材质按对象保留原生。

几何接管或照明失败会恢复本帧已接管的原生颜色并停用延迟模块，reason 保留故障；显式切到 enhanced 再切回 deferred 可重试。所需的传统 AO 材质依赖自动恢复，在后续帧重新有效。运行范围或全兼容对象造成的软回退可以自动恢复接管，无需反复切换 mode。为避免每模型独立 IBL 纹理把全屏延迟光照放大成大量绘制，延迟几何捕获超过 32 个环境组时会在捕获前记录预算原因并使用 enhanced forward；诊断中的 `lighting.activeMode` 和 `lighting.reason` 反映实际路径。

compact-v1 是独立消费者契约，不能用旧 MaterialChannels 的编码读取。四颜色附件＋独立覆盖共 57 字节/像素，约 112.7 MiB/1080p，不含 Hi-Z/AO。支持矩阵、资源与复现入口见 [B02_COMPLETION.md](../archive/B02_COMPLETION.md)。


### 10.4 B03 透明前向与延迟 SSR

`setLighting({mode:'deferred'})` 自动启用支持范围内的透明前向。标准 PBR 模型保留原生材质/alpha/IBL 输入，动态消费 `direct`、`indirect`、`emissive`、`shadow`。标准 Water 接收同源太阳、阴影与环境；ParticleSystem billboard 使用自发光语义。复杂模板/分类及未映射 shader 保持兼容。

`getLightingDiagnostics().transparentForward` 提供当前帧 patchedCommands、patchedFamilies、compatibilityReasons、valid/reason。`partial` 表示仍有不支持的 Cesium shader 类型，详细矩阵见 [B03_COMPLETION.md](../archive/B03_COMPLETION.md)。

`getScreenSpaceReflectionDiagnostics().lightingSource` 区分 `deferred-lighting` 与 `native-replay`；延迟 SSR 在 OIT 合成前替换环境镜面，透明 SSR 再通过原有 delta/OIT 合成。新附件只在 SSR 启用时分配，额外成本为 24 B/像素，不含 SSR 中间纹理及水环境探针。`getLightingDiagnostics().resources.reflectionBytes` 报告这些附件实际占用。

## B05/B06 控制与诊断

太阳 UBO 在延迟光照的一批 draw 中共享绑定；离开批次（包括异常退出）后恢复外部绑定。
不同视图/同一帧的太阳数据仍按实际值更新，未用“每帧只更新一次”替代数据契约。
环境积分仅有一个消费者时使用普通 uniforms；光柱/光斑需要介质数据时才创建共享环境 UBO。
`frameUniforms` 诊断中的实际 buffer 数量随活跃消费者变化。

太阳阴影网格自动使用主相机附近的局部参照。跨区域重定位保留网格相位，
动态太阳不会再驱动以地球半径放大的采样跳动；无需传入业务场景原点。
连续太阳运动时使用地表固定方向的仿射投影，投影矩阵与裁剪体同步更新，
避免整个光平面旋转引起密集几何的反复采样变化。实景结果与边界见
[校园动态阴影复查](../archive/CAMPUS_DYNAMIC_SHADOW_FOLLOWUP_2026-09-17.md)。

### 上下文丢失与恢复

`pipeline.getRenderDiagnostics().recovery` 返回 `{ required, reason }`。上下文丢失后，
旧管线保持暂停，旧 Viewer 的默认渲染循环停止；浏览器恢复 WebGL 后也不会把旧纹理
重新报告为有效。`setEnabled(true)`、普通 `resume()` 不解除这项暂停。
使用自定义渲染循环的宿主也应在 `recovery.required` 为 true 时停止调用旧 Viewer 的 render。

宿主收到 `webglcontextrestored` 后，应保存业务场景状态，依次销毁旧 pipeline 与 Viewer，
重新调用自己的场景创建/资产加载函数，再恢复相机、时间、配置与交互状态。
仅重新安装 CCR 无法修复 Cesium 1.143 已失效的原生 GPU 资源。不要把旧模型对象放回新 Viewer；
应从资产 URL/业务描述重新加载。`check-stage1-lifecycle.cjs` 实际验证了相同模型重新加载、
相机与时间恢复、颜色一致以及相同对象 ID 的拾取。

### 景深与曲线切换

`setLensEffects({ depthOfFieldEnabled: true })` 会按需启用米制深度；关闭后移除该项依赖，
其它消费者仍需要的通道继续保留。缺少有效深度时景深返回原图，诊断报告无效。
`setOptions` 与 `setLensEffects` 都支持运行中切换曲线/效果；暂停、关闭和销毁会退役
色调映射包装，保留宿主后来安装的包装。

光柱和光斑都关闭时，不执行其专用介质遮挡 pass；`getMediumOcclusionDiagnostics()`
返回无有效输出及 `No medium consumer requested`。云和雾的正常颜色合成继续执行。

```js
pipeline.setOptions({ renderTargetPoolEnabled: true }) // 默认开启；false 用于同源对照
pipeline.setOcclusionCulling({ enabled: true }) // 默认 false，按稳定视图/可靠静态模型保守剔除
pipeline.getOcclusionDiagnostics()
pipeline.getResourcePoolDiagnostics()
pipeline.getFrameUniformDiagnostics()
```

遮挡查询每帧最多 128 组，连续两次同状态不可见才隐藏。相机、投影、viewport、命令/瓦片/材质 revision 变化当帧恢复；近裁剪面、相机内部、未知变形/动画保持可见。只省去主颜色及对应材质生产，太阳投影、拾取、瓦片加载/LOD 不停止。无有用遮挡体时不查询；requestRender 查询长期 pending 有有限轮询预算。直接几何 buffer 改写导致包围体不再可信，本实例保守停用剔除，确认边界更新后可关闭再开启。

总诊断新增 occlusion/resourcePool/frameUniforms；RenderProfiler 新增 occlusion query 的 GPU scope。GPU 性能数字必须连同固定相机、时间、图像一致性和实际 skipped draws 一起看。复现与资源活跃期见 [B05_RESOURCE_LEDGER.md](../archive/B05_RESOURCE_LEDGER.md)。

### 独立车流系统（2026-10-09）

`CCR.createTrafficSystem({ Cesium, viewer, manifestUrl, pipeline })` / `new CCR.TrafficSystem(...)` 创建独立车辆运行模块。`pipeline` 可省略；传入时车辆移动当帧令自定义阴影失效。模块不修改全局时钟，支持闭合 GeoJSON 跟车路线或有向车道路网、岔路选择、路口让行和死胡同销毁/异地安全再生，保留原生 GLB 车辆、独立播放暂停、速度倍率、显隐、诊断与销毁。

```js
const traffic = CCR.createTrafficSystem({ Cesium, viewer, pipeline, manifestUrl: '/traffic/traffic.json' })
await traffic.readyPromise
traffic.setSpeed(1.5)
traffic.pause()
traffic.play()
traffic.setVisible(true)
traffic.getDiagnostics()
traffic.destroy() // 必须早于 viewer.destroy()
```

数据 schema、路网拓扑与禁转、初始化贴地、模型尺寸/朝向、加载与销毁契约以及性能边界见 [TRAFFIC_SYSTEM.md](../04-integration/TRAFFIC_SYSTEM.md)。可直接传 `routes` 或 `network`，连同 `vehicles` 替代清单 URL；入口只导出模块，不在 VisualPipeline 中自动创建车流。免外部资产演示 `/examples/traffic.html`，校园接入 `?traffic=<清单URL>`。

### 选中轮廓与阴影提交优化（2026-09-18）

管线默认优化原生 selected ID 通道，保留原生 silhouette 及其选择语义。WebGL2、3D、单视锥、单采样、普通深度路径下，复用当前主画面深度，只补画选中 Model/3D Tiles 内容的 ID；透明对象和特殊深度命令仍按原路径绘制。MASK 和不透明遮挡物的深度来自本帧，拾取通道不受影响。MSAA、多视锥、清除 Globe 深度、透明 Globe、调试命令过滤或未知选中类型使用原生完整 ID 绘制。

`pipeline.getRenderDiagnostics().selectionId` 返回本次 ID 通道的 `skipped`、`drawn`、累计 `copies`、`frameNumber`、`active` 与回退 `reason`。没有执行 ID 通道的帧不会报告旧帧仍 active。Context.draw 调用计数包含适配器跳过的请求，衡量实际绘制时应记录 WebGL draw 调用。

阴影的 opaque/MASK 投影按程序和渲染状态排序；程序/纹理绑定仅在同步阴影提交范围内去重，退出后恢复原方法，不跨帧缓存 GL 状态。仍逐帧绘制全部投影物，4096 分辨率、动态太阳、材质和模型更新语义保持不变。
