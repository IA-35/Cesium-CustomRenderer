# B09 前置调查记录

> 2026-09-17。基线 `522597e`（B08 落盘），分支 `codex/stage1-b07-b12`。
> 只记录**动手编码前**必须澄清的事实及其证据出处。验收线以
> [主计划 B09](STAGE1_COMPLETION_PLAN.md) 与
> [B07–B12 执行计划](STAGE1_B07_B12_EXECUTION_PLAN.md) 为准。

---

## 1. Cesium 1.143 自带哪些 tonemap 曲线，各自在哪一步

**结论：`PostProcessStageLibrary` 提供 5 条曲线，但它们全部是「显示阶段」算子
（内部调用 `czm_inverseGamma`），不是线性 HDR 算子。**

证据（`node_modules/@cesium/engine/Source/Shaders/PostProcessStages/`）：

| 曲线 | 工厂方法 | 曲线实现 | 是否含 `czm_inverseGamma` |
| --- | --- | --- | --- |
| ACES（Knarkowicz 拟合） | `createAcesTonemappingStage` | `czm_acesTonemapping` | **是** |
| Filmic（**Uncharted 2**） | `createFilmicTonemappingStage` | 内联 A–F/white 常数 | **是** |
| PBR Neutral | `createPbrNeutralTonemappingStage` | `czm_pbrNeutralTonemapping` | **是** |
| Reinhard | `createReinhardTonemappingStage` | 内联 | **是** |
| Modified Reinhard | — | 内联，带 `white` uniform | **是** |

ACES 实际曲线（`Builtin/Functions/acesTonemapping.glsl`，Knarkowicz 2016 拟合）：

```
g=0.985, a=0.065, b=0.0001, c=0.433, d=0.238
color = (color*(color+a) - b) / (color*(g*color+c) + d)
color = clamp(color, 0.0, 1.0)
```

Filmic 的 A–F 常数（`FilmicTonemapping.js`）：`A=0.22, B=0.30, C=0.10, D=0.20,
E=0.01, F=0.30, white=11.2`——这正是 **Uncharted 2** 的参数组，与 Epic 现代 UE
Filmic（ACES 体系）**来源不同**。计划对此的措辞要求必须遵守：本地 FILMIC 标注为
Uncharted 2；新增的 `unrealFilmicApprox` 只能称「近似」，不宣称 1:1 UE。

## 2. 「只映射一次」的正确时机

**结论：CCR 已经把场景设成 HDR + ACES，原生 tonemap 由 Cesium 的
`PostProcessStageCollection._tonemapping` 在链尾执行一次。新增曲线必须替换它，
而不是叠加。**

证据：

- `src/VisualPipeline.js:120-122`：CCR 写入 `scene.highDynamicRange = true`、
  `postProcessStages.tonemapper = C.Tonemapper.ACES`、`exposure`。这些是
  **CCR 拥有的写入**（走 `this.write` 的所有权记录，可在 restore 时归还）。
- `PostProcessStageCollection.js:45-62`：集合内部维护 `_tonemapping` stage 与
  `_tonemapper`，并把 `tonemapping` 压入执行栈
  （`stack.push(fxaa, ao, bloom, tonemapping)`）；`tonemapping.enabled` 由
  update 时按需打开。
- `src/stages/colorGrading.js` 的注释已明确记录既有事实：
  「Cesium 1.143 has already tone-mapped this input. No second gamma/exposure.」
  即现有调色阶段运行在**原生 tonemap 之后**。

因此 B09 的正确做法：

1. **不改** `PostProcessStageCollection` 内部，而是操作公开的 `tonemapper` 属性
   （Cesium 的 setter 会重建 `_tonemapping` stage）；
2. 提供真实曲线选择：`aces` / `reinhard` / `filmic` 三个直接映射到
   `C.Tonemapper.ACES` / `REINHARD` / `FILMIC`；
3. `unrealFilmicApprox` 是**第四条曲线**，它无法用 `C.Tonemapper` 表达
   （枚举里没有），因此必须自建一个 PostProcessStage 并**同时关闭原生 tonemap**，
   否则会映射两次；
4. 若无法保证只映射一次，则该曲线**不可启用**（计划明确条款）。

## 3. 曝光语义与 gamma/alpha 契约

**结论：曝光由 Cesium 的 `postProcessStages.exposure` 统一控制（原生 tonemap 前），
新增阶段必须保留它，且不得再自行做 gamma。**

- 曝光：`VisualPipeline.js:122` 写入 `p.exposure`。
- ACES/Reinhard/Filmic 三个内置 stage 都读 `uniform float exposure`
  并在曲线**之前**乘上（`FilmicTonemapping.js` 显示 `color *= exposure` 形式）。
- `czm_inverseGamma` 是显示编码；自建曲线若替换原生 tonemap，
  必须**自行补上**这一步，否则画面会变暗（这是「保留后续 gamma/alpha 契约」的含义）。
- alpha 必须原样传递（现有 `colorGrading.js` 即 `source.a` 直通）。

## 4. 现有可复用的景深/模糊支持

计划要求「优先复用 Cesium `createBlurStage` / `createDepthOfFieldStage`」。
`PostProcessStageLibrary` 中存在对应的工厂方法（与 tonemap 同一文件），
但需在实现时核实其深度/映射阶段是否符合本管线（计划也留了这个口子：
「若其深度/映射阶段不符，适配 shader 而非复制 collection」）。

## 5. B09 消费的 B08 数据（已就绪）

光柱与太阳光斑**不再自己实现遮挡 mask**（计划明确分工），而是消费
B08 已产出的介质遮挡数据：

- 入口：`EnvironmentRenderer.getMediumOcclusionDiagnostics()`
  → `{ valid, texture, size, contract, source, reason }`；
- 纹理：半分辨率 RGBA32F；
- 通道：`.r` = 太阳方向介质透射率，`.g` = 太阳可见性（阴影），
  `.b` = 视线介质透射率；
- 实测（`docs/B08_COMPLETION.md`）：`valid: true`，160×120，`.b` 范围 0–0.993。

**注意时序**：该数据在环境 pass 的 HDR 执行上下文里产出（优先级 20），
因此 B09 的光柱/光斑必须注册在**更高优先级**（更晚执行）才能读到同帧数据。

---

## 对 B09 实现方案的直接约束

1. 新增 `src/stages/toneMapping143.js`：`aces`/`reinhard`/`filmic` 走
   `C.Tonemapper` 枚举替换（保留曝光与 gamma）；`unrealFilmicApprox` 自建
   stage 并**同时关闭原生 tonemap**，显式补 `czm_inverseGamma`。
2. 所有新增效果默认关闭、强度 0 为 identity（计划硬要求）。
3. 光柱/光斑消费 B08 数据，注册优先级高于环境 pass；不重复实现遮挡 mask。
4. `blur`/`depthOfField`/`tiltShift` 三者首期互斥，启用一个必须明确反馈
   另外两项的实际状态（计划要求在 API 层固化）。
5. 新映射分支若无法保证只映射一次，则该曲线不可启用——这是**可验证的拒绝条件**，
   不是文档声明。
