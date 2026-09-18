# B07 前置调查记录

> 2026-09-17。基线 `336b90d`（B04–B06 落盘），分支 `codex/stage1-b07-b12`。
> 本文只记录**动手编码前**必须澄清的三项事实及其证据出处。B07 的验收线仍以
> [主计划 B07](STAGE1_COMPLETION_PLAN.md) 与 [B07–B12 执行计划](STAGE1_B07_B12_EXECUTION_PLAN.md) 为准。

---

## 1. Globe water mask 在 Cesium 1.143 的可用性与采样方式

**结论：可用。** 像素级水掩码确实存在于 1.143，并且已经通过每条 globe draw command 的
uniform map 暴露出来，可以在重放 globe 命令时直接读取，不需要改引擎。

证据链（`node_modules/@cesium/engine/Source/`）：

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 地形数据 | `Core/QuantizedMeshTerrainData.js`、`Core/TerrainData.js` | `terrainData.waterMask` 为 `Uint8Array` 或 `ImageBitmap`；长度 1 表示整块全水/全陆 |
| 瓦片纹理 | `Scene/GlobeSurfaceTile.js:1104` `createWaterMaskTextureIfNeeded` | 建立 `surfaceTile.waterMaskTexture`（`PixelFormat.LUMINANCE`，`UNSIGNED_BYTE`）；`waterMask[0] !== 0` 时复用 `allWaterTexture`；**全陆瓦片不建纹理**（保持 `undefined`） |
| 瓦片变换 | `Scene/GlobeSurfaceTile.js:1148` | `waterMaskTranslationAndScale` 初始化为 `(0,0,1,1)`，由 `_computeWaterMaskTranslationAndScale` 处理源瓦片继承 |
| uniform 绑定 | `Scene/GlobeSurfaceTileProvider.js:2025-2030` | `u_waterMask` → `properties.waterMask`；`u_waterMaskTranslationAndScale` → `properties.waterMaskTranslationAndScale`。**属每瓦片 uniform map，随 command 走** |
| 片元采样 | `Shaders/GlobeFS.js:392-397` | `uv = v_textureCoordinates * scale + translation`，**`y` 取 `1.0 - y`**，再 `texture(u_waterMask, uv).r` |
| 材质注入 | `Shaders/GlobeFS.js:424` | 采样结果写入 `materialInput.waterMask` |
| 着色器门控 | `Scene/GlobeSurfaceShaderSet.js:189,306` | `hasWaterMask` 参与 program 索引；`Globe.js:996` 由 `terrainProvider.hasWaterMask` 决定 |

**采样注意点（必须照抄，否则掩码上下翻转）**：`v_textureCoordinates` 乘 `scale` 加
`translation` 之后，`y` 要取反。夹具必须包含非对称掩码，否则 y 翻转测不出来。

**必须如实记录的边界**：

- `terrainProvider.hasWaterMask` 为假时（例如 `EllipsoidTerrainProvider` 或未带水掩码的
  地形服务），**整条路径不存在**，此时必须显式报告「未接入」而不是把陆地误判为水面。
- 全陆瓦片没有 `waterMaskTexture`，命令级采样应回退为「陆地」，不能采样默认纹理后
  当作掩码值使用。
- 非水地面**不得**因为处于同一 Globe 就擅自金属化。

---

## 2. 普通 Primitive 的材质法线/roughness/反射响应提取路径

**结论：与 Model 不同源，属结构性缺口，不是配置问题。** 支持范围必须显式划定。

`src/channels/materialShader143.js` 的 `materialSources()` 要求同时命中
`C._shadersModelFS` 与 `C._shadersMaterialStageFS`，且要求
`USE_METALLIC_ROUGHNESS && LIGHTING_PBR`。普通 `Primitive` + `MaterialAppearance`
走的是**另一套着色模型**：

| | 标准 PBR Model | 普通 Primitive |
| --- | --- | --- |
| 片元着色器 | `Shaders/ModelFS.js` + `MaterialStageFS` | `Shaders/Appearances/AllMaterialAppearanceFS.glsl` |
| 材质结构 | `czm_modelMaterial`（baseColor/roughness/metallic/normalEC/occlusion/emissive） | `czm_material`（diffuse/specular/shininess/normal/emission/alpha） |
| 光照调用 | `lightingStage()` → PBR IBL | `czm_phong(...)`（`Builtin/Functions/phong.glsl`） |
| 反射响应 | `specularContribution = radiance * FssEss * model_iblFactor.y` | **无 IBL/环境镜面项**，只有 `material.specular * specular * czm_lightColor` |

因此在 B02 的现有实现里，普通 Primitive 落入 `invalidMaterialSources()`——
被标记为「未知不透明表面」，材质数据全部置无效（`campus_materialDepth = -1`），
以保证不污染延迟着色。**这是正确的保守行为，B07 不应推翻它。**

**B07 划定的支持边界**（写入夹具并对外可见）：

- 接入：具备 `normalEC` 的 `AllMaterialAppearance`/`TexturedMaterialAppearance` 路径，
  且能提供可解释的反射响应；
- 不接入：`PerInstanceColorAppearance`、`PolylineMaterialAppearance`、无光照 `FLAT`
  分支、以及任何 `czm_phong` 之外的材质；这些继续走 `invalidMaterialSources` 的
  兼容路径，并计入兼容数量，**不得静默跳过**。

**映射语义（必须显式声明，不可伪装成物理等价）**：`shininess → roughness` 与
`specular → F0` 是**近似换算**。Cesium 的 `czm_phong` 用 `czm_getSpecular(...,
material.shininess)`，与 GGX 粗糙度不是同一参数化。转换只用于「让水面/积水获得
与周围一致的环境镜面能量尺度」，对外标注为近似，不宣称与 Model 路径数值一致。

---

## 实测补充（2026-09-17，浏览器侦察）

上面第 1 节的静态阅读结论经实测确认，但**有一个 API 陷阱必须先记录**：

`CustomHeightmapTerrainProvider` **不能**用来验证 water mask —— 它的
`hasWaterMask` getter 硬编码返回 `false`（`Core/CustomHeightmapTerrainProvider.js:144`），
且 `requestTileGeometry` 只构造 `HeightmapTerrainData({buffer,width,height})`，
**根本不读取任何水掩码参数**。实测结果：`provider.hasWaterMask === false`，
globe 命令的 `u_waterMask()` 返回 `undefined`。

正确做法是**自定义 `TerrainProvider`**：`hasWaterMask === true`，并在
`requestTileGeometry` 中返回带 `waterMask` 的 `HeightmapTerrainData`。实测结果：

| 观测项 | 值 |
| --- | --- |
| `provider.hasWaterMask` | `true` |
| globe 命令 `u_waterMask()` | `Th:8x8`（真实 8×8 纹理，不是 `undefined`） |
| `u_waterMaskTranslationAndScale()` | `[0,0,1,1]` |
| 片元着色器含 `u_waterMask` 采样 | 是 |
| 瓦片 `terrainData.waterMask` | 长度 64（8×8），样本 `[1,1,1,1,0,0,0,0]` |
| 瓦片 `waterMaskTexture` | 已建立，8×8 |

非对称掩码 `[1,1,1,1,0,0,0,0]`（左半水、右半陆）证明「像素级、非全水全陆」的
掩码确实抵达命令级 uniform，且可用于检测 y 翻转。

**另一个实测陷阱**：不得递归遍历 `tile.children`。Cesium 四叉树的 `children`
getter 会**按需构造**子节点，无界下钻会瞬间构造海量对象并抛
`RangeError: Maximum call stack size exceeded`。只读 `_surface._tilesToRender`。

### 普通 Primitive 的结构缺口（实测确认）

用四个真实 `Primitive` + `MaterialAppearance`（`Color` 不透明、`Water` 半透明、
`Water` 不透明、`NormalMap`）侦察命令，**四个命令全部**：

| 观测项 | 结果 |
| --- | --- |
| 命中 `AllMaterialAppearanceFS` | 是（4/4） |
| 使用 `czm_material` 结构体 | 是（4/4） |
| 调用 `czm_phong` | 是（4/4） |
| 使用 `czm_modelMaterial` | **否（0/4）** |
| 命中 `ModelFS` | 否（0/4） |

这从运行时侧证实了第 2 节的结构性结论：普通 Primitive 与 B02 的延迟着色
（要求 `STANDARD_PBR_VALID`，即 flags 第 512 位）**不同源**，`materialSources()`
必然拒绝它们，它们目前走 `invalidMaterialSources()` 的保守兼容路径。
B07 必须在此边界上**新增**接入，而不是放宽既有判据。

`Water` 材质的可用 uniform 键（实测）：
`baseWaterColor_0`、`blendColor_1`、`specularMap_2`、`normalMap_3`、`frequency_4`、
`animationSpeed_5`、`amplitude_6`、`specularIntensity_7`（材质实例另有 `fadeFactor_8`）。
法线与高光因此**可以从材质侧读取**，不需要从 G-buffer 反推。

---

## 3. 白模绕行基线

`scripts/check-white-tiles.cjs` 已存在，依赖：

- 开发服务器 `127.0.0.1:8877`（本轮已启动，`examples/white-city.html` 返回 HTTP 200）；
- 私有资产 `assets/white-city/city-white.glb`（不入库，见 `.gitignore`）。

该脚本当前检查的是**材质通道有效性**与 **style 改写后 reflectionSpecular 归零**，
其中已包含 `roughness === 0.22 && metallic === 0` 的断言，可作为 B07「先证明确有差异」
的起点；但**它尚未输出 SSR 关/开的基础 PBR 色差值**，不足以直接充当 B03 阈值
（≤0.01 绝对 / ≤2% 相对）的延续基准 —— 这一项需要在 B07 的验收集里补测。

---

## 对 B07 实现方案的直接约束

1. `PrimitiveReflection143.js` 必须复用现有 SSR 的 trace/resolve **输出纹理**，
   只负责把普通 Primitive 与水面/积水的反射响应接进同一求值，不重做算法。
2. 水面/积水 receiver 与 Globe water mask 是**两条不同契约**：前者是材质法线动画
   参与同一次采样，后者是 Globe 自身的掩码区域；两者都不能照搬 Tianjing
   `scene._reflectTexture` 全局方案。
3. 全陆瓦片、无 `hasWaterMask` 地形、非水地面三种情况都必须显式判定，
   并在诊断里区分「已接入 / 未接入 / 不适用」，不允许以白模样例替代水/Globe 验收。
