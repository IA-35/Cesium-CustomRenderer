# CCR · 自定义渲染管线 API 使用文档

> 最新范围：[CCR通用渲染原则](RENDERER_SCOPE.md)。B00默认target为fixtures；校园是可选集成用例，其服务/资产问题不定义CCR的通用能力边界。
Cesium 1.143.0 渲染增强管线（CCR）的对外接口参考。全部签名、默认值、取值范围与诊断字段均取自当前源码：`src/index.js`、`src/presets.js`、`src/VisualPipeline.js`、`src/environment/environmentState.js`、`src/antialiasing/settings143.js`。

> 版本门槛：所有类都要求 `Cesium.VERSION` 匹配 `/^1\.143(?:\.0)?$/`，不匹配直接抛错。管线依赖 1.143 的若干内部结构（`scene._view.frustumCommandsList`、`globeDepthTexture`、`updateDerivedCommands`、`_primitiveBias` 等），升级 Cesium 前必须重新验证。

> 阶段一状态（2026-09-15）：本文只描述**当前可用**的接口。计划中的 `setLighting` / `setOcclusionCulling` / `setToneMapping` / `setLensEffects` **尚未实现**，不要按计划文档调用它们。验收口径、图像基线与命令入口见 [阶段一验收说明](STAGE1_ACCEPTANCE.md)。

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

UMD 导出键（实测 `require('build/0.1.0/CCR.min.js')`，35 个）：

```
CESIUM_VERSION  VERSION  createVisualPipeline  getVisualPipeline
SmaaPass143  TaaPass143  FxaaPass143  taaBlendWeights  TaaJitter143  FrustumJitterBridge143
ScreenSpaceGeometry143  MaterialChannels143  DepthPyramid143  MATERIAL_FLAGS
ScreenSpaceAo143  HdrBloom143  ScreenSpaceReflection143  TransparentReflection143
PerformanceGovernor143  quantile  LightUniforms143  RenderProfiler143
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
pipeline.setScreenSpaceReflections({ enabled: true, distance: 1500, thickness: 1, strength: 1 })

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
| `setCampusOrigin` | `Cartesian3` | — | 设阴影/环境中心。自 `SunLight` 直射方向推导 `dot(toLight, origin) <= 0` 时阴影不就绪 |
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

> 依赖关系自动串联：`screenSpaceAoEnabled` 或 `screenSpaceReflectionEnabled` 会自动请求材质通道与深度金字塔；SSR 的透明开关会自动请求 `opaqueColor` 通道。不需要手动开 `materialChannelsEnabled`。

### 3.5 屏幕空间效果

| 方法 | 参数 | 返回 |
|---|---|---|
| `setScreenSpaceAO` | `{ enabled, algorithm, radius, strength, bias }` | 生效值 |
| `getScreenSpaceAODiagnostics` | — | 见 §5.3 |
| `setHdrBloom` | `{ enabled, strength, threshold, knee, levels }` | 生效值 |
| `getHdrBloomDiagnostics` | — | 见 §5.4 |
| `setScreenSpaceReflections` | `{ enabled, distance, thickness, strength, transparent }` | 生效值 |
| `getScreenSpaceReflectionDiagnostics` | — | 见 §5.5 |
| `getTransparentReflectionDiagnostics` | — | 见 §5.5 |

### 3.6 性能调速

| 方法 | 参数 | 返回 |
|---|---|---|
| `setPerformance` | `{ enabled, targetFps, targetFrameMs, minScale, sampleWindow, evaluateEvery, settleFrames }` | `getPerformanceDiagnostics()` |
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
| | `shadowSize` | `4096` | `1024` / `2048` / `4096` |
| | `shadowCascades` | `1` | `1` / `4` |
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
| SSR | `screenSpaceReflectionEnabled` | `false` | 布尔 |
| | `screenSpaceReflectionDistance` | `150` | `1 – 2000` m |
| | `screenSpaceReflectionThickness` | `0.5` | `0.01 – 20` m |
| | `screenSpaceReflectionStrength` | `1` | `0 – 1` |
| | `screenSpaceReflectionTransparent` | `false` | 布尔 |
| TAA | `taaJitterSamples` | `8` | `4` / `8` / `16` |
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

- **`shadowMode: 'custom'`（默认）**：自有正交光源相机 + 深度 pass，接收端为 PBR Model / 3D Tiles；校园 GLB 地面可接收。地形（Globe）接收端尚未接入。`shadowStatic: true` 会缓存静止阴影，需要**手动 `invalidateShadows()`** 才能在场景变化后更新。
- **`shadowMode: 'native'`**：回退 Cesium 原生 `ShadowMap`，用 `write()` 接管 `scene.shadowMap`/`viewer.shadowMap` 参数，并把 `viewer.shadowMap._primitiveBias.depthBias` 调到 `0.0002`、`normalOffsetScale` 调到 `0.5`（1.143 内部依赖，非公共 API）。
- 大场景投影成本提示（源码注释与文档记录）：大型校园 GLB 在 4 级联下 279 条投影命令会重复绘制成 1116 次；单级联 `shadowSize: 4096` 是默认折中，需要近景细节时可 `setOptions({ shadowMode: 'native', shadowCascades: 4, shadowSize: 2048 })` 对比。

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

### 5.5 屏幕空间反射（SSR）

```js
pipeline.setScreenSpaceReflections({ enabled: true, distance: 1500, thickness: 1, strength: 1 })
pipeline.setScreenSpaceReflections({ transparent: true })  // 追加透明 PBR 逐层反射
```

- 半分辨率 trace（输出 `vec4(hitColor.rgb, confidence)`）+ 全分辨率 resolve。命中后按 `confidence` 替换原生镜面项：`max(original.rgb + confidence * (radiance * response.rgb - nativeSpecular), 0)`；**未命中保留原生 CubeMap 环境反射**。
- 置信度渐隐规则：屏幕边缘、掠射角、过短投影射线、追踪预算末段、高粗糙度各有一条 smoothstep 衰减；`resolve` 取中心射线与邻域的最小值，**中心射线置信度为 0 时不会从邻域补回**。
- 参数语义：`distance` 最大追踪距离（`<= 0` 直接 miss）；`thickness` 深度容差，起点偏移 `start = position + normal * max(0.02, min(thickness * 0.25, 0.15))`；`strength`（`<= 0` 整段旁路）；`roughness >= 0.85` 保留原生 cubemap 不追踪。
- 内部会按需扩充材质 MRT：反射分量（`reflectionSpecular`/`reflectionResponse`）与不透明颜色（透明 SSR 时）；共用相机 UBO（160 B）与每消费者 16 B 的反射参数 UBO —— 当前 SSR + 透明 SSR 合计 **192 B**。
- 透明反射：按 `scene._environmentState.useOIT` 分 `'oit'` / `'sorted'` 两路，重放 `Pass.TRANSLUCENT` 命令到自有 RGBA32F delta 目标再 resolve。遇复杂模板、非标准混合、禁用深度测试等不兼容命令时**透明反射整帧旁路**。
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
- Hi-Z：每层 RGBA32F，R/G 为区域已知正深度 min/max，B 为完整覆盖标记，A 为位掩码（`1 = 未知不透明`、`2 = 透明覆盖`、`3 = 二者`、`0 = 均无`）。1080p 共 11 层。

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

- `taaJitterSamples`（4/8/16）在 pass 创建时读取——切换模式会重建 resolve stage 并丢弃历史，改采样数需连同模式一起重设。
- `taaBlendWeights(settings)` → `[静态帧权重, 运动帧权重, 速度阈值, 深度容差]`，clamp 区间分别为 `[0.02, 0.9]`、`[0.05, 1]`、`[1, 64]`、`[0, 0.5]`。
- 历史缓冲：2 个 ping-pong 颜色 target（RGBA16F 或 RGBA32F）+ 1 个 R32F 视深度。抖动经 `TaaJitter143` + `FrustumJitterBridge143` 发布到实际绘制的（克隆）视锥。
- `getTaaDiagnostics()` 关键键：`{ enabled, supported, valid, reason, error, failed, stats{frames,bypasses,resets}, historyValid, historySize, activeFrame, blend, staticFrames, jitter, samplers, bytes, scope, requested }`。
- `resetTaaHistory()` 的适用场景：相机瞬移、场景内容突变之后（否则历史帧会残留拖影）。

### 5.7 性能调速器

```js
pipeline.setPerformance({ enabled: true, targetFps: 30, minScale: 0.6 })
```

- 依据 P95 帧时间（最近秩分位数）在降级阶梯上单向调整 `resolutionScale`；`shadowMode === 'custom'` 时还会下调 `shadowSize`。
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
| `DepthPyramid143` | `new DepthPyramid143(C, scene)` | `update(sourceTexture, frameNumber, transparencyTexture?)` / `getLevels()` / `invalidate()` / `release()` |
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
5. **切换视图后阴影/云不对** → 调 `setCampusOrigin()`；静态阴影下再 `invalidateShadows()`。
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

详细验收范围见 [STAGE1_ACCEPTANCE.md](STAGE1_ACCEPTANCE.md)，逐项修复见 [B00_B01_FIX_HANDOVER.md](B00_B01_FIX_HANDOVER.md)。

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

几何接管或照明失败会恢复本帧已接管的原生颜色并停用延迟模块，reason 保留故障；显式切到 enhanced 再切回 deferred 可重试。所需的传统 AO 材质依赖自动恢复，在后续帧重新有效。运行范围或全兼容对象造成的软回退可以自动恢复接管，无需反复切换 mode。

compact-v1 是独立消费者契约，不能用旧 MaterialChannels 的编码读取。四颜色附件＋独立覆盖共 57 字节/像素，约 112.7 MiB/1080p，不含 Hi-Z/AO。支持矩阵、资源与复现入口见 [B02_COMPLETION.md](B02_COMPLETION.md)。


### 10.4 B03 透明前向与延迟 SSR

`setLighting({mode:'deferred'})` 自动启用支持范围内的透明前向。标准 PBR 模型保留原生材质/alpha/IBL 输入，动态消费 `direct`、`indirect`、`emissive`、`shadow`。标准 Water 接收同源太阳、阴影与环境；ParticleSystem billboard 使用自发光语义。复杂模板/分类及未映射 shader 保持兼容。

`getLightingDiagnostics().transparentForward` 提供当前帧 patchedCommands、patchedFamilies、compatibilityReasons、valid/reason。`partial` 表示仍有不支持的 Cesium shader 类型，详细矩阵见 [B03_COMPLETION.md](B03_COMPLETION.md)。

`getScreenSpaceReflectionDiagnostics().lightingSource` 区分 `deferred-lighting` 与 `native-replay`；延迟 SSR 在 OIT 合成前替换环境镜面，透明 SSR 再通过原有 delta/OIT 合成。新附件只在 SSR 启用时分配，额外成本为 24 B/像素，不含 SSR 中间纹理及水环境探针。`getLightingDiagnostics().resources.reflectionBytes` 报告这些附件实际占用。
