# B07 完成报告：SSR 材质、水面与积水的最小完整覆盖

> 2026-09-17。基线 `336b90d`（B04–B06 落盘），分支 `codex/stage1-b07-b12`。
> 验收线以[主计划 B07](STAGE1_COMPLETION_PLAN.md) 与
> [B07–B12 执行计划](STAGE1_B07_B12_EXECUTION_PLAN.md) 为准；前置调查见
> [B07_RECONNAISSANCE.md](B07_RECONNAISSANCE.md)。

## 新增与修改

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `src/reflections/PrimitiveReflection143.js` | 普通 Primitive 与 Globe 水掩码区域的材质通道/SSR 接收端适配器 |
| 新增 | `tests/rendering/ssr-surfaces-fixture.js` | 程序化表面夹具 + 自定义水掩码 TerrainProvider + 材质通道读回工具 |
| 新增 | `tests/rendering/ssr-surfaces-fixture.html` | 夹具页 |
| 新增 | `tests/rendering/primitive-reflection.test.mjs` | 42 项单元测试 |
| 新增 | `scripts/check-ssr-surfaces.cjs` | 普通 Primitive 的 GPU 验收 |
| 新增 | `scripts/check-globe-water.cjs` | Globe water mask 四种掩码形态的 GPU 验收 |
| 修改 | `src/channels/MaterialChannels143.js` | 接入两条新路径、分项计数、只写深度命令保护 |

**未修改**任何 B02 已交付文件（`DeferredLighting143.js` / `DeferredGeometry143.js` /
`deferredLightingShader143.js`），也未修改 B03 的 SSR trace/resolve 算法。
B07 只做「材质覆盖补齐」，不重做算法（主计划明确要求）。

## 实测结果

### 普通 Primitive（`scripts/check-ssr-surfaces.cjs`）

三个真实 `Primitive` + `MaterialAppearance`（Color 不透明 / NormalMap 积水 / Water 不透明）：

| 指标 | 值 | 含义 |
| --- | --- | --- |
| `surface` | **10800** px | 全部写入有效表面标记 `flags & 3 == 3` |
| `knownDepth` | **10800** px | 全部写入正米制视深度 |
| `invalidDepth` | **0** | 无一退化为 `-1` 兼容路径 |
| `standardPbr` | **0** | 无一被标记 `STANDARD_PBR_VALID`，不会被 DeferredLighting 二次照亮 |
| `primitiveDraws` | 3 | 新路径确实在跑 |
| `invalidators` | 0 | 兼容计数为 0 |
| `ssrValid` | true | SSR 同帧有效 |

### Globe water mask（`scripts/check-globe-water.cjs`）

自定义 TerrainProvider（`hasWaterMask === true`），四种掩码形态：

| 用例 | 掩码纹理 | 水域接收端 | standardPbr | 结论 |
| --- | --- | --- | --- | --- |
| ocean-column（经度 −90°） | 8×8 逐像素 | **268800**（全屏） | 0 | 逐像素掩码正确接入 |
| land-column（经度 90°） | 8×8 逐像素 | **0** | 0 | 非水地面不被金属化 |
| all-water | 1×1（复用 255 纹理） | **268800** | 0 | 整水掩码正确接入 |
| all-land | 未建纹理（全陆） | **0** | 0 | 显式判定为不适用 |

四种形态全部满足主计划「水域响应反射、非水地面不擅自金属化」的要求。

## 本轮修复的 5 个真实缺陷

每个都是**先由测试或实测暴露**，再最小修复；均附回归测试。

1. **helper 生成了但从未插入着色器**。`ccr_primitiveOutputs` 被调用却无定义——
   GLSL 要求先声明后使用，会直接编译失败。修：插入调用点之前。

2. **FLAT 变体改写了不被编译的分支**。`FLAT` 是同一份着色器文本上的 define，
   `#ifdef FLAT`/`#else` 两个分支文本**同时存在**，只有一个被编译。原实现按文本
   顺序固定挑 phong 那一行，于是 FLAT 变体上改写的是死代码，MRT 附件一个都不写，
   而着色器仍编译通过——静默缺口。修：按 FLAT define 选择改写目标。

3. **helper 在 `v_positionEC` 声明之前引用它**。真实 GPU 报
   `'v_positionEC' : undeclared identifier`。修：把视深度改为函数参数，由调用点传入。
   **这个缺陷纯文本单元测试测不出来**，是浏览器实跑才发现的。

4. **只写深度的命令污染整张材质通道**。`replayMaterialFrusta` 在 GLOBE 之后
   `clearDepth` 并绘制 `scene._depthPlane._command`（全屏四边形，`colorMask` 全 false），
   而 `_draw` 会**强制打开** colorMask，于是它把自己的材质结果刷满整屏。
   既有守卫只覆盖标准 PBR 路径。修：非 PBR 路径的只写深度命令跳过颜色写入并计数
   （不抛错——深度平面是 Cesium 正常组成）。

5. **水掩码阈值错用 0.5**。水掩码有两种存储形态：长度 1 的整水掩码复用
   `allWaterTexture`（像素 255 → 归一化 1.0）；逐像素掩码存 0/1（归一化 0.0039）。
   GlobeFS 用「非零即水」（`GlobeFS.js:400`），写成 `> 0.5` 会让**所有逐像素掩码**
   被判为陆地，而整水掩码恰好通过——形成「整水绿、逐像素红」的假象，
   实测中确实先误导了一轮排查。修：与 GlobeFS 一致用非零判据。

此外两处**匹配鲁棒性**修复（同一类根因）：

6. **log-depth 改名导致真实命令不被识别**。Cesium 的 `ShaderSource.replaceMain`
   把入口函数改名为 `czm_log_depth_main`，模板原文在真实命令里**不存在**。
   实测：globe 命令 direct 变体匹配、logDepth 变体不匹配，而 `_draw` 用的是
   logDepth —— 不修则开启 log-depth（Cesium 默认）时 B07 一条都不生效。
   修：同时尝试原文与改名后的形式。

7. **材质定义与 appearance 主体同段**。真实命令的 `sources` 是两段且
   appearance 主体与 `czm_getMaterial` 材质定义**拼在同一段**，
   「整段等于模板」永不成立。修：按段内**子区间**定位，只改写主体区间。

## 支持与兼容边界（写入诊断，不使用「全部支持」这类说法）

**支持**：`AllMaterialAppearance` / `EllipsoidSurfaceAppearance` /
`TexturedMaterialAppearance` / `BasicMaterialAppearance` 的不透明与 FLAT 分支；
Globe 命令的 water mask 区域。

**兼容（计数不静默跳过）**：`PerInstanceColor`/`Polyline` 等其它 appearance、
拾取/阴影/透明派生包装、已被其它适配器接管的程序、无 `HAS_WATER_MASK` 的地形。

**近似换算（明确标注，不宣称与 Model 路径数值等价）**：

- `shininess → GGX 粗糙度`：`clamp(sqrt(2/(shininess+2)), 0.04, 1)`，
  Blinn-Phong 标准近似，与 B03 水面前向路径 `ccr_waterLighting` **同一式子**
  （避免同一水面出现两套粗糙度尺度，有回归测试锁定）；
- `specular → F0`：`vec3(0.02)*clamp(specular,0,1)`，把 Phong 标量高光强度
  映射到电介质 F0，**非物理等价**。

**刻意不做**：不设置 `STANDARD_PBR_VALID`，普通 Primitive 继续使用原生前向着色，
**不**被 DeferredLighting 二次照亮——这是本批最重要的边界，有专门测试锁定。

## 验证汇总

- `npm test`：**520/520 通过**（478 基线 + 42 新增）。
- GPU 验收：普通 Primitive、Globe water mask 四种形态全部通过。
- 回归：B02 `check-deferred-lighting` / `-composition`（directAo max 0、
  indirectAo darker 5834、directShadow darker 4299、emissive max 0）/
  `-matrix`（22 例 parity）/ `-recovery`（7 例）/ `-tiles`；
  B03 `check-transparent-families`、`check-deferred-transparency`
  （sorted single 0.000122、stuck 0.000153）；`check-frame-bridge`（7 模式）、
  `check-transparency-content`、`check-shadow-cascades`、`check-render-target-pool`、
  `check-occlusion`、`check-white-tiles`、`check-stage1-baseline`、`check-browser-sdk`
  （source + UMD）——**全部通过**。
- 构建：415916 字节，gzip 136718，sha256
  `8bc0ca51902c20d414685b9cbfa5211000717cdd002ac669fb140e4f9a1ecf7d`；
  UMD 内含 B07 代码（9 处标记）。

## 基础 PBR 色差阈值验收（`scripts/check-ssr-color-delta.cjs`）

主计划 B07 第 1 条要求「SSR 关/开时基础 PBR 色差值沿用 B03 门槛
（≤0.01 绝对或 ≤2% 相对），不能只以『不变灰/不跳变』的定性描述代替」。
本项于补充验收中完成，source 与 UMD 双模式结果一致。

### 门槛语义（澄清，避免误判）

B03 门槛的原始表述是（主计划第 164 行）「**独立原生线性 HDR 对照**，不变的
≤0.01 绝对或 ≤2% 相对误差门槛」—— 它比较的是**延迟路径 vs 原生 PBR 重放**的
基础 PBR 值，**不是**「SSR 开 vs 关的最终画面差」。

后者本来就应有明显差异：SSR 的作用正是把环境镜面项替换成屏幕空间结果。
实测接收端最大色差 **0.084（相对 33%）**——那是 SSR **正常起作用**的证据。
若把它当门槛判定，就完全误解了该条。

### 实测结果

| 判据 | source | umd |
| --- | --- | --- |
| **A) 基础 PBR 一致性**（延迟 vs 原生 `reflectionSpecular`） | | |
| 比较像素数 | 314556 | 314556 |
| 最大绝对差 | **0.000244** | 0.000244 |
| 最大相对差 | **0.000976** | 0.000976 |
| 超限像素数（>0.01 且 >2%） | **0** | **0** |
| 满足 ≤0.01 或 ≤2% | **是（两者均满足）** | 是 |
| **B) SSR 作用范围** | | |
| 真实命中次数 | 20536 | 20536 |
| 被 SSR 改变的接收端像素 | **20364** | 20364 |
| 非接收端最大变化 | **0（逐位不变）** | 0 |

结论：基础 PBR 色差**远优于** B03 门槛（0.000244 vs 0.01，差约 40 倍），
且 SSR 确实生效（改变 2 万余接收端像素）而不污染其它像素（非接收端逐位不变）。

### 测量过程中排除的三个混淆（均曾导致阈值虚假通过）

1. **不能用 `enabled:false` 作为「SSR 关」**。`VisualPipeline` 会由
   `screenSpaceReflectionEnabled` 推导 `depthPyramidEnabled`（`:336`），
   关闭 SSR 会同时停用材质通道与 Hi-Z，两帧**逐位相同**（实测 `maxAbs=0`）——
   测的是「通道开关」而非色差。正确对照是保持通道开启、只用 `strength=0`
   关闭 SSR 合成（`ssrShaders143.js:169/185` 提前返回 identity）。
2. **必须有真实命中**。屏幕空间射线需要屏内可命中几何；实测用 B03 的玻璃夹具
   （背面朝上的小平面）时 trace 置信度**恒为 0**（`maxAlpha=0`、`nonZero=0`），
   resolve 保持原值，色差**必然为 0**。因此改用 `stage1-scene.js` 的真实场景
   与高金属低粗糙材质，并在脚本里**断言命中数下限**（<100 即失败）。
3. **readiness 必须在开启 SSR 之后检查**。此前在开启前读取会得到
   `'Not requested'`，把「还没开」误判成「不可用」。

## 粗糙度换算与相机序列验收（`scripts/check-ssr-roughness-camera.cjs`）

主计划 B07 第 7 条的剩余部分（粗糙度梯度、相机旋转/俯仰/近远变化）。

### 粗糙度换算

| 材质 | shininess | 写出 roughness | 期望（GGX） | 金属度 |
| --- | --- | --- | --- | --- |
| Water | 10（`Water.glsl:55` 硬编码） | **0.4078** | 0.4082 | 0 |
| NormalMap | 1（`czm_getDefaultMaterial` 默认） | **0.8157** | 0.8165 | 0 |
| Color | 1（同上） | **0.8157** | 0.8165 | 0 |

这证明 `shininess → roughness` 换算**真的进入了渲染数据**（不只是单元测试里的
字符串），并能区分不同材质（Water 0.408 vs 默认 0.816）。
金属度恒为 0 —— 与本批「不把普通 Primitive 伪装成金属」的边界一致。

**通道契约**（`MATERIAL_CHANNELS.md:25`）：`normalRoughMetal` 是 RGBA8，
RG = 八面体编码法线、**B = 感知粗糙度**、**A = 金属度**。
测量中我必须按 B 通道读取——早先按 alpha（那是金属度）读取得到 0，
曾一度误判为「粗糙度丢失」，实际是实现正确、我读错了通道。

### 两处实测约束（Cesium 材质语义，非缺陷）

1. **只有 `Water.glsl` 设置 `material.shininess`**（1.143 的 Materials 目录下唯一
   一个）；`NormalMapMaterial` 只设 `material.normal`，其余材质沿用默认 shininess=1。
   因此用 NormalMap 无法扫描粗糙度梯度。
2. **`Water.glsl:55` 把 shininess 硬编码为 `10.0`**，不接受参数。因此也无法
   用 Water 扫描梯度。最终改为验证**两类材质各自的正确值**，这比强行造梯度更诚实。

### 相机序列

18 步（8 个朝向 + 5 个俯仰 + 5 个高度），**全部保持有效表面接收端**：

| 类别 | 步数 | 结果 |
| --- | --- | --- |
| 旋转（heading 0→2π） | 8 | 全部 `surface: true`，depth ≈ 148 |
| 俯仰（-π/2 → -1.20 rad） | 5 | 全部 `surface: true` |
| 高度（80 → 4000 m） | 5 | 全部 `surface: true`，depth 78→3998 随高度递增 |

**如实标注的边界**：俯仰扫描限制在能看到该水平面的范围内——实测 `pitch=-0.9 rad`
（约 -51°）时水平面已移出视野下缘，那是正常取景而非渲染失效；判据因此改为
「屏内仍有有效表面像素」而不是「中心像素是表面」。高度 1200/4000 m 时表面仍有效
（depth 1198/3998）但画面均值趋 0，属远距目标过小过暗的正常结果。

## 未完成项（如实保留，不声称完成）

1. **半透明水面（`translucent: true`）在本批夹具中未覆盖**。B03 的
   `check-transparent-families.cjs` 已覆盖并验证该路径（水面受 CCR 阴影、
   patchedFamilies.water=1），B07 不重复声称。
   附带发现：在「无 HDR 后处理链」的独立夹具配置下，半透明水面会触发
   `_target` of undefined。**已实测归因**：在未含任何 B07 改动的纯净基线上
   同样复现，属既有边界，不由 B07 引入，也未在本批修复。
2. **`scripts/check-frame-uniforms.cjs` 失败**。同样**实测归因**为既有问题
   （断言 `deferredLighting.sunUniforms` 存在，而 B04–B06 已把默认回退为
   单级联并关闭阴影太阳 UBO），与 B07 无关，未在本批修复。
3. **递归反射、复杂折射、动态场景探针、全功能水体系统**：主计划明确不要求，
   本批不实现。屏外建筑倒影不承诺存在。
4. **Globe 非水地面的反射**：按主计划「非水地面不擅自金属化」，
   本批刻意**不**为陆地提供反射；这是设计要求而非缺口。
5. **多视锥下的 Globe 水掩码**：本批在单视锥下验证；多视锥 Globe 属 B04 已交付
   范围，B07 未新增多视锥水掩码专项用例。
6. **粗糙度梯度无法通过 Cesium 内置材质扫描**（见上方「两处实测约束」）：
   1.143 中只有 Water 设置 shininess 且硬编码为 10。因此本批验证的是
   「两类材质各自的粗糙度值正确」，而**不是**连续梯度曲线。
   连续梯度的验证需要自定义 fragment shader 材质（B02 的七材质矩阵已覆盖标准
   PBR 的 roughness 轴），B07 未重复。

原始结果在本机 `docs/verification/stage1-B07/`（`primitives.json`、
`globe-water.json`、`pbr-color-delta.json`、`roughness-and-camera.json`、`recon-*.json`）。
