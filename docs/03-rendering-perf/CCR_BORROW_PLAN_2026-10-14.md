# CCR 渲染管线：参考项目借鉴与实施范围

> **文档编号**: CCR-BORROW-2026-10-14
> **修订**: v3（取得 Shadertoy 原版源码后逐行对照）
> **创建时间**: 2026-10-14
> **CCR 基准提交**: `7841918`（含工作区未提交的 environment 重写）
> **适用版本**: Cesium 1.143 + WebGL2

> **进度更新（2026-10-15，P1 实施后）**：以下正文及未勾选项保留为最初 v3 计划快照，其中“当前代码”“尚未实现”和旧测试数均指编写当时。实际进度请看 [逐项实施记录](./CCR_BORROW_PROGRESS_2026-10-15.md)：P0 主要参数/关闭语义已接入；P1 Hillaire T/M/Sky 与新环境链路 Graph 已接入并通过开发验证；1080p 云历史＋双版本 LUT 约 12.45 MiB。P2 采样优化、P3 准确云影/材质回归仍未完成，新链路性能目标尚未测量验收。用户已确认的是此前天空泛白修复，新 LUT 画面仍待用户验收。

**原计划说明（2026-10-14）**：本文是调研与实施范围建议。编写当时以下改造尚未实现，也未测出改造后的收益。

> **v3 核心变更**：已取得 Shadertoy wlBXWK 原版源码并**逐行对照**。结论从"实现有 bug"修正为**"当初是自行重新实现而非照抄，过程中丢了坐标变换、丢了场景消光、改错了一组常数"**。
> P0 因此由「修 bug」改为「**按原版逐行忠实移植**」。详见 §2 与 §2.6。

---

## 0. 结论

主线继续使用 **Cesium 1.143 + WebGL2**。优先顺序：

1. **校正介质坐标、深度与 HDR 合成契约**（当前存在会让大气完全失真的坐标 bug）
2. **移植大气 LUT**（先在 WebGL2 落地）
3. **云的低分辨率时域重建**
4. **统一太阳与天空照明**
5. **让新效果使用现有 Graph 与提交基础设施**

WebGPU 单独作为后端实验，**不作为上述视觉改进的前置条件**。

**不是把三个项目的代码堆在一起**：three-geospatial 提供较完整的视觉算法，webgpu-cesium 提供值得借鉴的资源和提交结构，博客提供 Cesium 场景的算法解释和视觉参考。采用哪个算法要由**正确性、集成成本和同场景测量**决定。

**复用原则**：算法独立实现与复制上游 shader 是**不同的复用方式**。

**本次的实测教训**：CCR 现有的 `atmosphereScattering143.js` 走的是「**理解后重新实现**」路线，结果出了四类错误（详见 §2.6）。因此 P0 的执行方式明确改为 **照抄上游 shader**——本次以 Shadertoy wlBXWK 为底本**逐行忠实移植**，仅做必要的坐标系与接口适配。实现时固定参考提交，保留相应来源与许可说明。

---

## 1. 已核实的参考与边界

| 来源 | 有价值的实际实现 | 边界 |
|---|---|---|
| [three-geospatial](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4) | WebGL Bruneton 预计算散射；太阳/天空辐照度；云的深度/速度输出、重投影、方差裁剪、时间交错采样；云影与多散射近似 | Three.js/后处理框架 API 不能直接安装到 Cesium。WebGL 后处理照明的 BRDF 有限制；新的 WebGPU/TSL API 不同，云仍在开发。MIT |
| [webgpu-cesium](https://github.com/Xiaobai-grow/webgpu-cesium/tree/68032f3a574f136470dd13960cf6350070a3026b) | 地形/影像、GBuffer/PBR、Hillaire 四 LUT；Graph 实际创建 GPU Pass 并提交；纹理槽复用；RenderItem 状态复用与缓存 | 是场景/渲染后端重写；模型/3D Tiles、阴影/TAA、体积云仍属后续里程碑。没有与 CCR 校园场景对比的性能证据。Apache-2.0 |
| [2025 大气与云博客](https://www.liaomz.top/2025/02/13/cesium-zhong-shi-xian-ti-ji-yun-he-da-qi-mei-hua-xiao-guo/)及其[全球云前文](https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/) | Rayleigh/Mie、消光与合成、地球尺度云层、太阳光照和采样扰动 | 原理、片段与截图不是完整可执行管线；"性能影响小"不是我们的实测。页面标注 CC BY 4.0，但其引用的 Shadertoy shader 独立许可仍需确认 |
| [Shadertoy: Atmospheric scattering explained](https://www.shadertoy.com/view/wlBXWK) | **可直接照抄的完整大气散射实现**（Rayleigh/Mie 相函数、双嵌套 ray march、臭氧 sech² 吸收、消光与合成） | **MIT License, Copyright (c) 2019 Dimas Leenman**（源码第 1–22 行已含完整许可文本）。坐标系为**原点在地心**的球面空间；常数为真实米制 |

---

## 2. 当前代码中应先校正的契约

> 以下为**源码与数值检查证据**，不是对当前画面已完成的像素验收。

### 2.1 ENU 与地心坐标混用（严重）

- `EnvironmentRenderer.js:35` 的 `eyeToLocal` 输出以**地表为原点**的 ENU 坐标
- `environmentStages.js:135` 直接将其交给 `ccrAtmosphere`
- 后者在 `atmosphereScattering143.js:137` 对**原点居中的地球半径球**求交，并以 `length(position) - planetRadius` 计算高度

**数值证据**：用 Cesium 实际矩阵计算校园地面上方 100m 的相机：

| 量 | 当前公式结果 |
|---|---|
| ENU `[0, 约0, 100]` 算出的高度 | 约 **-6,370,900 m** |
| 向上的云底交点 | 约 **6,372,500 m** |
| 云射线限制 | **40,000 m** |

**后果**：`exp(-height/H)` 中 height 恒为负且量级 6.37e6，密度计算指数爆炸，整个大气积分失真。

**修正方向**（**照抄 Shadertoy 的坐标约定**）：

Shadertoy 原版的处理方式（源码第 62–63、120、406 行）：

```glsl
#define PLANET_POS vec3(0.0)     /* the position of the planet */
#define PLANET_RADIUS 6371e3     /* radius of the planet */

vec3 calculate_scattering(vec3 start, ...) {
    // add an offset to the camera position, so that the atmosphere is in the correct position
    start -= planet_position;
    ...

// 主函数中相机位置本身就是地心系
vec3 camera_position = vec3(0.0, PLANET_RADIUS + 100.0, 0.0);
```

**原版约定：所有位置都在「地心为原点」的坐标系里**，进入积分前先做 `start -= planet_position`。

**CCR 缺失的正是这一步**——`environmentStages.js:135` 产生的 ENU 原点（地表为原点）未经任何变换即传入积分。

**新方案**：改为传入**地心系**的 `start`，保留原版的 `start -= planet_position` 结构（`PLANET_POS` 在适配层可保持 `vec3(0.0)`）。

噪声的局部坐标**单独保留**，避免直接使用巨大 ECEF 数值。

**测试缺口**：现有测试使用 `[0,0,R+2]`，没有检查真实 ENU 输入。

### 2.2 消光未应用到场景

- `environmentStages.js:139` 获得大气 `transmittance`，却**只用于云 RGB**（`:144`）
- `environmentStages.js:175` 将环境 RGB **加到**原始场景：`original.rgb + environment.rgb * original.a`
- 云返回的残余透射率在 alpha 中，但 **resolve 不使用它**
- 大气积分**还没有以 sceneDistance 截断**

**Shadertoy 原版本来就是对的**（源码第 260–267 行）：

```glsl
// calculate how much light can pass through the atmosphere
vec3 opacity = exp(-(beta_mie * opt_i.y + beta_ray * opt_i.x + beta_absorption * opt_i.z));

// calculate and return the final color
return (
        phase_ray * beta_ray * total_ray // rayleigh color
            + phase_mie * beta_mie * total_mie // mie
        + opt_i.x * beta_ambient // and ambient
) * light_intensity + scene_color * opacity; // now make sure the background is rendered correctly
```

即 `L_out = L_scatter + L_background * T`，**且原版更新日志第 27 行专门记录过这次修正**：

> Update 4 (28-11-2019): **atmosphere now correctly blocks light from the scene passing through**, and added an ambient scattering term

**CCR 恰恰丢掉了 `scene_color * opacity` 这一项**，改成纯加法。

**不能把天空到无穷远的积分加到近处建筑上。**

**附带问题**：没有命中云时应返回**单位透射率**，当前 `ccrClouds` 的无交点返回 `vec4(0)` 也应一并校正。原版在无交点时返回 `scene_color` 而非透明（源码第 129、138 行）：

```glsl
if (d < 0.0) return scene_color;
...
if (ray_length.x > ray_length.y) return scene_color;
```

**另需补回 `allow_mie`**（源码第 139–140 行）：

```glsl
// prevent the mie glow from appearing if there's an object in front of the camera
bool allow_mie = max_dist > ray_length.y;
```

原版更新日志第 24 行记录：

> Update 1 (25-9-2019): added 2 lines to prevent mie from shining through objects inside the atmosphere

**CCR 无此保护**——这对应「mie 光晕穿透物体」问题。

### 2.3 开关和模型语义未接入新 shader

`EnvironmentRenderer.js` 仍提供 `effectFlags`、`cloudModel`、`fogParams` 等参数，但新 stages 的 uniform 集合**没有消费这些开关**：

```javascript
// environmentStages.js:121 的 required 列表
const required = ['eyeToLocal', 'sunDirectionAtmo', 'sunRadiance', 'skyRadiance',
  'cloudParams', 'cloudWind', 'noiseTexture', 'atmosphereParams']
// 缺少 effectFlags / cloudModel / fogParams
```

应验证 `clouds:false` 的真实输出与成本、不同云型、雾参数及夜间太阳贡献，**而不是仅测试 options 保存成功**。

### 2.4 半分辨率 resolve 没有重建

- 当前 resolve 是一次 texture 读取，`sampleMode` 为 **NEAREST**
- **没有深度边缘处理、历史缓冲或方差裁剪**
- 注释所称"邻域平均"（`atmosphereScattering143.js:152-153`）**没有对应实现**

### 2.6 与 Shadertoy 原版的逐行对照（v3 新增）

> 取得原版源码后完成的常数与结构对照。**这是 P0 改为「逐行忠实移植」的直接依据。**

#### 2.6.1 常数对照

| 常数 | Shadertoy 原版（第 66–75 行） | CCR 现值（`atmosphereScattering143.js:25–32`） | 结论 |
|---|---|---|---|
| `RAY_BETA` | `vec3(5.5e-6, 13.0e-6, 22.4e-6)` | `[5.5e-6, 13.0e-6, 22.4e-6]` | ✅ 一致 |
| `MIE_BETA` | `vec3(21e-6)` | `21e-6` | ✅ 一致 |
| `ABSORPTION_BETA` | **`vec3(2.04e-5, 4.97e-5, 1.95e-6)`** | **`[2.04e-6, 4.89e-6, 1.2e-5]`** | ❌ **全错** |
| `G` | **`0.7`** | **`0.8`** | ❌ 不同 |
| `HEIGHT_RAY` | `8e3` | `8.0 * MODEL_SCALE / 100` ≈ 8000 | ✅ 数值等价 |
| `HEIGHT_MIE` | `1.2e3` | `1.2 * MODEL_SCALE / 100` ≈ 1200 | ✅ 数值等价 |
| `HEIGHT_ABSORPTION` | **`30e3`** | **`25.0 * MODEL_SCALE / 100`** ≈ 25000 | ❌ 不同 |
| `ABSORPTION_FALLOFF` | **`4e3`** | **`15.0 * MODEL_SCALE / 100`** ≈ 15000 | ❌ **差约 3.75 倍** |
| `PRIMARY_STEPS` | `32`（桌面）/ `12`（移动） | `12`（balanced） | ⚠️ 取的是移动档 |
| `LIGHT_STEPS` | `8`（桌面）/ `4`（移动） | `6`（balanced） | ⚠️ 介于两档之间 |

#### 2.6.2 `ABSORPTION_BETA` 的错误影响

原版 `(2.04e-5, 4.97e-5, 1.95e-6)` 的**蓝通道最小**；CCR 现值 `[2.04e-6, 4.89e-6, 1.2e-5]` 的**蓝通道最大**，且整体量级小 10 倍。

臭氧吸收的物理作用是**在日出日落时吸收蓝绿、保留红色**，从而形成晚霞。当前取值等于**让天空向蓝色偏移**——**方向相反**。

#### 2.6.3 常数错误的来源

CCR 现值文件头注释（`atmosphereScattering143.js:21–23`）：

```javascript
// Scattering coefficients (per metre). Values follow the reference model, which is written in a
// unit-sphere space and then rescaled here to metres by dividing by the atmosphere thickness.
const MODEL_SCALE = ATMOSPHERE_RADIUS_M - PLANET_RADIUS_M   // = 100000
```

**该假设与实际不符**：Shadertoy 原版**用的就是真实米制**（`PLANET_RADIUS 6371e3`、`HEIGHT_RAY 8e3`），并非单位球空间。

因此「除以大气厚度再乘百分比」的换算虽然让部分数值碰巧正确（`8e3`、`1.2e3`），却也让 `HEIGHT_ABSORPTION`、`ABSORPTION_FALLOFF` 写错，而 `ABSORPTION_BETA` 则被**完全重写成了另一组数**。

#### 2.6.4 结构对照

| 原版结构 | 源码位置 | CCR 状态 |
|---|---|---|
| `start -= planet_position` 坐标偏移 | 第 120 行 | ❌ **缺失**（§2.1 根因） |
| `scene_color * opacity` 场景消光 | 第 267 行 | ❌ **缺失**（§2.2 根因） |
| `allow_mie` 穿透保护 | 第 139–140 行 | ❌ **缺失** |
| 无交点返回 `scene_color` | 第 129、138 行 | ❌ 返回 `vec4(0)` |
| `ray_length.y = min(ray_length.y, max_dist)` | 第 142 行 | ⚠️ 需核对 |
| `1.0 - exp(-col)` 曝光 | 第 457 行 | ⚠️ 由 Cesium 色调映射承担，需核验不重复 |
| 相机在大气内时起点夹紧 `max(..., 0.0)` | 第 133、143 行 | ⚠️ 有类似逻辑，但坐标错则无意义 |
| `skylight()` 表面天光采样 | 第 300–328 行 | ➖ 由 Cesium IBL 承担，不复用 |
| `render_scene()` 内置球体 | 第 339–379 行 | ➖ 替换为 Cesium `sceneDistance` + HDR 颜色 |

#### 2.6.5 结论

**CCR 当前实现不是「照抄后出现 bug」，而是「自行重新实现时偏离了原版」**，具体表现为：

1. **丢了坐标变换**（§2.6.4 第一项）
2. **丢了场景消光**（§2.6.4 第二项）
3. **改错了一组常数**（§2.6.1）
4. **丢了 `allow_mie`**

这印证了 §0 的复用原则——**算法独立实现与复制上游 shader 是不同的复用方式**，本次走的是前者，代价就是这四类错误。

**因此 P0 的执行方式改为：按原版逐行忠实移植，而非逐条修 bug。** 理由：

- 当前实现已偏离原版过多，逐条修反而易再生错
- 原版许可是 **MIT**（源码第 1–22 行含完整文本），**可合法照抄，只需保留版权声明**
- 原版已在注释中标注上游出处（第 51–53 行指向 scratchapixel 教程）

### 2.7 测试现状

- 本次相关 Node 测试 **19/19 通过**，覆盖 shader 生成、参数与独立球面几何，**不能证明上述集成契约**
- 浏览器检查首次遇到旧 SDK shader 编译错误；工作区随后更新源码和产物，复测 `hdrValid:true`、raymarch/resolve 存活
- 复测仍有**一个资源连接失败日志**，未完成像素/完整场景验收
- **本文不将首次编译错误作为最新版仍存在的问题**

---

## 3. 按收益与依赖安排改造

### P0：按 Shadertoy 原版逐行忠实移植，并校正介质坐标、深度与 HDR 合成

**范围**：`src/environment/EnvironmentRenderer.js`、`atmosphereScattering143.js`、`volumetricClouds143.js`、`environmentStages.js`、相关 environment 测试。新增 `src/environment/reference/`（存放原版底本与许可）。

**执行方式（v3 修订）**：**照抄上游 shader，而非自行重新实现**（依据见 §2.6.5）。

- [ ] **将原版底本存入仓库**（`src/environment/reference/shadertoy_wlBXWK.glsl` 或类似位置），**完整保留第 1–22 行的 MIT 许可文本与 Copyright (c) 2019 Dimas Leenman**
- [ ] 将原版 `calculate_scattering`（第 97–268 行）**原样移植**，常数全部按原版，**不再重新推导**（§2.6.1）
- [ ] 保留原版 `start -= planet_position` 结构（第 120 行），**传入地心系的 `start`**（§2.1）
- [ ] 恢复原版 `scene_color * opacity` 场景消光项（第 267 行），**替换当前的纯加法**（§2.2）
- [ ] 恢复原版 `allow_mie` 穿透保护（第 139–140 行）
- [ ] 无交点时返回 `scene_color` 而非透明（第 129、138 行）；`ccrClouds` 无交点改返回单位透射率
- [ ] 明确球心、高度和距离全部使用一致的**米制约定**；噪声的局部坐标单独保留，避免直接使用巨大 ECEF 数值
- [ ] 用真实 Cesium ENU/相机矩阵验证地面、云下、云内、云上、高空、水平与向下射线
- [ ] 分离天空像素和有表面深度的像素，明确透射率、预乘散射量及 alpha/coverage 的格式；**近处表面使用有限距离积分**
- [ ] 在 tonemap 前完成线性 HDR 合成；太阳强度只在明确位置乘一次（原版为 `vec3(40.0)`，需按 CCR 的 HDR 量级重新标定）；核验原版 `1.0 - exp(-col)` 不与应用层色调映射**重复**；处理夜间地球遮挡与地平线连续性
- [ ] 恢复 clouds/fog/model 开关语义，用**输出纹理及 GPU 成本**验证关闭效果确实不执行
- [ ] 保留当前单 frustum 的明确限制，或接入已经验证的统一深度；**不要直接删除限制而使用最后一个 frustum 的深度**

**仅需适配的三处**（其余保持原版）：

| 原版 | CCR 适配 |
|---|---|
| `render_scene()` 内置绿球（第 339–379 行） | 换成 Cesium `sceneDistance` + HDR 颜色输入 |
| `iResolution` / `iMouse` / `iTime` | 换成 Cesium uniform |
| `skylight()`（第 300–328 行） | 不复用，由 Cesium IBL 承担 |

**收益**：避免错误云层求交、加亮、穿透和失效开关；**这是后续优化的正确基线**。

**注意**：画面预期会变化，**不能把错误合成结果作为必须逐像素保持的 golden image**。

---

### P1：大气 LUT，先在 WebGL2 落地

**范围**：新增 `src/environment/AtmosphereLut143.js`，移植必要的 GLSL 数学，接入现有 `WebGLDevice143`、`HdrEnvironmentPass143` 与太阳参数。

**采用 Hillaire 路线，尺寸参考 `HillaireAtmosphere.ts`：**

```javascript
const TRANSMITTANCE = { w: 256, h: 64 }
const MULTI         = { w: 32,  h: 32 }
const SKY           = { w: 192, h: 108 }
// 格式统一 rgba16float
```

- [ ] 采用 Hillaire 的**二维 transmittance、multi-scattering、sky-view** 路径；初始实验尺寸如上
- [ ] **用全屏 fragment Pass 生成，不要求 compute 或 WebGPU**
- [ ] T/M 的失效键包含**介质密度、散射/吸收系数、星球半径与模型版本**；Sky-view 包含**太阳、相机高度/参考系**等实际依赖
- [ ] 与"上次成功生成 LUT 的参数"比较；生成成功后更新版本，**失败保留旧的有效版本**
- [ ] **不能照搬参考项目每帧覆盖 `lastSunDir` 的做法**（`HillaireAtmosphere.ts` 中 `this.lastSunDir = { ...sunDir }` 在声明阶段无条件写入，CCR 需改为仅成功后更新）
- [ ] 天空查 Sky-view；有限距离 aerial perspective 首期采用**短 view march + T/M 查表**，消除逐 view sample 的嵌套 sun march
- [ ] 第二步才比较二维 slice atlas 或专用 3D aerial LUT。**现有 RHI 以 Cesium 二维 Texture 为边界，不能假定 3D 纹理已可用**

**收益**：将 balanced 每环境像素 **12×6** 的大气光路密度积分，转移到小尺寸缓存与纹理读取；天空、材质与云可共享同一介质模型。

**额外读取与更新成本仍须测量，不能保证固定百分比提速。**

**取舍**：

| 路线 | 主要 LUT 尺寸 | RGBA16F 逻辑存储 | 3D 采样需求 |
|---|---|---|---|
| three-geospatial（Bruneton） | 256×128×32 | **约 8 MiB** | 需要 3D 采样或 atlas 适配 |
| **Hillaire 三张二维**（推荐） | 256×64 / 32×32 / 192×108 | **约 0.291 MiB** | 不需要 |

**两者不应被误称为同一套 LUT。**

---

### P2：云的时域重建与采样优化

**范围**：`volumetricClouds143.js`、`environmentStages.js`、`HdrEnvironmentPass143.js`，新增云专用 resolve/history 模块；复用已有相机与深度辅助方法。

- [ ] 先以**每轴 1/2 分辨率**和正确深度边缘 resolve 建立基线，再比较每轴 1/4
- [ ] 输出云**散射量、透射率以及重投影所需云深度/速度**；使用上一帧矩阵和风场位移重投影，边缘进行**深度/透射率拒绝与邻域方差裁剪**
- [ ] 使用**真实 STBN/蓝噪声**和明确的帧序列；**当前固定屏幕 hash 不应标为已有时空蓝噪声**
- [ ] 镜头跳变、resize、参考系切换、云型/太阳突变时**重置历史**；快速移动时提高当前帧贡献，避免依靠强历史混合掩盖低采样
- [ ] 借鉴 **weather/shape/detail 分离、距离 LOD、可变步长和空区跳过**
- [ ] 现有 atlas 每次三线性噪声需 **8 次 texelFetch**，优先通过**粗天气场和减少密度调用**降低次数；**不要盲目引入另一套重复噪声库**

**收益**：降低云 raymarch 的像素数量和密度采样次数，改善低采样条带与闪烁。

**注意**：每轴从 1/2 降到 1/4，raymarch 像素数减少 75%；**这只是该 Pass 工作量变化，不是整帧提速承诺**。代价是 history/速度资源和 resolve 成本，**必须同时记录显存与拖影**。

**云 history 独立于全屏 TAA**，允许 SMAA 主线下使用。复用 TAA 的已验证辅助方法，**不共用其颜色 history**，不改变此前全屏 TAA 诊断非阻塞的决策。

---

### P3：统一太阳、天空与云的照明

**范围**：`environmentState.js`、`EnvironmentLighting143.js`、现有 Sun uniforms、Deferred lighting shader、Transparent forward shader、B08/B09 介质契约。

- [ ] 以**同一个太阳方向、光谱/强度与 LUT 版本**驱动天空、云、地表直射光；**雾和云改变的是透射率，不通过重复改 exposure 补偿**
- [ ] 引入云相函数与**有限多散射近似**，先测少量 octave，避免照搬 reference 的高质量默认配置
- [ ] 小尺寸区域云影先作用于直射光；天空光按较低频率更新，IBL 与 HDR 合成各有明确职责，**避免二次照明**
- [ ] 对玻璃、Water、MASK、selected outline 和 OIT 做专门回归。**three-geospatial 的 WebGL 后处理 Lambert 照明不能直接替代当前 PBR 和透明提交**
- [ ] **建筑阴影与云影分开优化；云影算法不自动解决 shadow-map 锯齿**。保留已有阴影修复，另外测 `texelWorld`、级联连续性、receiver bias 和 shadow Pass 成本

**收益**：天空、物体、云在日落/阴天保持一致，云的阴面、银边和地面遮蔽更可信。

**云影/光柱属于额外成本，先完成 P1/P2 预算再扩展。**

---

### P4：让新效果使用现有 Graph 与提交基础设施

**范围**：`VisualPipeline.js`、`HdrEnvironmentPass143.js`、`RenderGraph143.js`、`PooledStageCache143.js`、`RenderItemExecutor143.js`、`RenderProfiler143.js`。

> **现有 Graph 已借鉴 webgpu-cesium，继续扩展当前实现，不再造第二个 Graph。**

- [ ] 将 **atmosphere LUT generation、cloud march、cloud resolve、medium data、HDR composite** 声明为与实际 GPU 工作一致的 Pass；**计时包住真实提交，而不是额外执行空回调**
- [ ] persistent LUT、跨帧 history、Cesium 输入都 **import/bind external**；只有帧内 cloud current、速度中间纹理、合成 scratch 等进入 Graph **transient allocator**
- [ ] 在**最后一个消费者完成后**释放，异常仍由 `endFrame`/`finally` 释放；alias 匹配尺寸、格式、samples 和附件用途。**persistent/history 不能为了增加 alias 数被回收**
- [ ] 诊断记录**真实 texture/lease ID、live interval、logical bytes、physical pool bytes、峰值**；**"allocator attached" 不能单独证明物理复用**
- [ ] **RenderItem 保持描述性，Executor 提交**。opaque 按完整兼容状态减少 program/texture 切换；透明只在原生顺序的连续兼容区间复用。环境 fullscreen Pass 直接复用 program 和缓存，**不增加逐物体 draw 拦截**
- [ ] 借鉴 **pipeline 预热与规范化缓存键**，接入现有 Cesium shader cache；**预热与按需编译分别测**，不能把编译移出采样窗口后宣称成本消失

**收益**：避免新效果再增加长期纹理缓存、wrapper、重复提交和难以解释的 Pass；同时提升资源可测性。

**Graph 的复用是同规格 Texture 对象/槽复用，不等同于 WebGL 驱动底层 heap alias。**

---

## 4. 资源格式与生命周期预算

> 以下是**逻辑纹理存储估算**，未包含驱动开销、Cesium 资源和完整显卡 VRAM。

| 资源 | 建议起点 | 生命周期/别名 |
|---|---|---|
| T/M/Sky LUT | RGBA16F；尺寸见 P1 | persistent external，不参与帧内 alias |
| 云 current | RGBA16F；每轴 1/2 或 1/4 | Graph transient，直到 resolve 完成 |
| 云速度/深度 | 按精度需求选 RG16F/R32F 等，**先确认 RHI 支持** | current transient；需要历史拒绝的数据另存 persistent |
| 云 resolved/history | RGBA16F 双 buffer；可先在每轴 1/2 分辨率重建 | persistent external，不参与帧内 alias |
| 最终 HDR scratch | RGBA16F，校验强光与透射率误差 | 最后消费者之前保活，之后可复用 |

**尺寸换算**：1920×1080 的全尺寸 RGBA16F 一张约 **15.82 MiB**，双 history 约 **31.64 MiB**；每轴 1/2 的双 history 约 **7.91 MiB**。

当前 RGBA32F 改成 RGBA16F 同尺寸逻辑存储减半，但**深度与大坐标计算不能因此统一降到半精度**。

---

## 5. 对照基准与验收

现有 `ab-env-on/off.json` 是每轮 150 帧、单轮历史报告；其中 environment GPU p50 约 **18.19 ms**，关闭环境的整帧 GPU p50 约 **2.30 ms**。

**这支持优先研究 environment，但报告没有 assetHash/源码哈希，不能把该数字当作当前重写版的成本或预测新算法收益。**

### 5.1 基准定义

| 编号 | 内容 |
|---|---|
| B0 | 原生 Cesium（参考成本） |
| B1 | 当前提交 + 工作区的实际 SDK |
| B2 | P0 正确介质版本（**后续画质基准**） |
| B3 | P1 大气 LUT |
| B4 | P2 云时域重建 |
| B5 | P3 统一照明 |

比较时保持相同云量、太阳、质量目标和 scene features；**环境关闭只做成本归因**。

### 5.2 固定条件

固定硬件/驱动、浏览器、viewport/DPR、Cesium 版本、时钟、资产及 SDK/source hash。

1920×1080 DPR1 为首轮，另测 4K 和实际部署设备。

### 5.3 场景

校园固定视角、持续拖拽/绕飞、近处建筑/玻璃、云下/云内/云上、高空与地平线、日出日落和夜间、resize 与相机跳变、数据加载冷启动。

**固定视角不能替代交互验收。**

### 5.4 采集要求

- 每 case 至少 **3 轮**，每轮 **≥300 有效帧**；预热至资产和 shader 就绪，冷启动另记
- **CPU p50/p95/p99 + bootstrap CI**
- 同时记录 **RAF 帧间隔、超过 16.7/33.3/50ms 的帧数、long task、编译/资源创建事件**
- **区分 CPU 工作时间与掉帧**
- GPU：整帧和 atmosphere LUT/update、cloud march、cloud resolve、cloud shadow、HDR composite、shadow、geometry/lighting、transparent **各 Pass 的异步 timer query**
- 报告**有效 query 比例、disjoint 与丢弃原因**；至少达到预先固定的可用比例再比较，查询不支持显示 unavailable
- **整帧与 Pass 查询不能违规嵌套**，必要时分轮采集
- 内存：persistent、history、Graph physical pool、Cesium 纹理分别计 current/peak，**池内空闲仍算分配**；执行多次 resize/开关后确认峰值和存活对象收敛
- **整卡 VRAM 用目标 GPU 工具另测，不将 JS heap 或逻辑纹理字节冒充显存**

### 5.5 正确性

- P0 与可信物理/解析样例及人工画面验收比较
- 后续优化以 **B2 同参数输出**为基准
- 单独检查：**透射率范围、有限距离积分、夜间太阳、云 coverage、遮挡边缘、玻璃/OIT、MASK/selected outline 和时间拖影**
- **变化像素比例必须同时定义变化阈值**，动态云先冻结风与随机序列

### 5.6 策略

**correctness 与 no-regression 通过后进入主线；更大幅度性能收益属于 optimization success，不作为保持重复旧路径的理由。**

### 5.7 首轮优化目标

> 以下为**预算目标，不是测得结果**。

在固定 1080p 部署设备上，environment 总 GPU 成本 **p95 进入 3–5 ms**，云 history/新增 LUT 的逻辑存储控制在 **约 16 MiB 内**。

**目标需由 B2 测量校准。** 若达不到，先降低额外光柱/云影成本、调整低分辨率重建，**不能直接取消云效果并称为同等画质提速**。

---

## 6. 具体源码参考

### 6.1 three-geospatial

- [大气 LUT 与照明约束](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/atmosphere/README.md)
- [CloudsPass 的缩放与 history](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudsPass.ts)
- [云重投影和方差裁剪](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/shaders/cloudsResolve.frag)
- [质量档位与成本取舍](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/qualityPresets.ts)

### 6.2 webgpu-cesium

- [Hillaire LUT 与更新条件](https://github.com/Xiaobai-grow/webgpu-cesium/blob/68032f3a574f136470dd13960cf6350070a3026b/packages/environment/src/HillaireAtmosphere.ts)
- [帧图执行、槽复用、RenderItem 提交](https://github.com/Xiaobai-grow/webgpu-cesium/blob/68032f3a574f136470dd13960cf6350070a3026b/packages/renderer/src/graph/RenderGraph.ts)
- [实际功能里程碑](https://github.com/Xiaobai-grow/webgpu-cesium/blob/68032f3a574f136470dd13960cf6350070a3026b/docs/50-progress/PROGRESS.md)
- [包划分与依赖](https://github.com/Xiaobai-grow/webgpu-cesium/blob/68032f3a574f136470dd13960cf6350070a3026b/docs/10-architecture/02-packages.md)

### 6.3 博客与 Shadertoy

- [Cesium中实现体积云和大气美化效果](https://www.liaomz.top/2025/02/13/cesium-zhong-shi-xian-ti-ji-yun-he-da-qi-mei-hua-xiao-guo/)
- [Cesium中实现全球体积云](https://www.liaomz.top/2023/12/18/cesium-zhong-shi-xian-quan-qiu-ti-ji-yun/)
- [Cesium中实现G-Buffer渲染管线](https://www.liaomz.top/2025/12/30/cesium-zhong-shi-xian-g-buffer-xuan-ran-guan-xian/)
- [Shadertoy: Atmospheric scattering explained](https://www.shadertoy.com/view/wlBXWK) ← **P0 照抄底本**
  - **许可**: MIT License, Copyright (c) 2019 Dimas Leenman（**源码第 1–22 行含完整许可文本**）
  - **原版出处**: 第 51–53 行注明基于 [scratchapixel: Simulating Sky](https://www.scratchapixel.com/lessons/procedural-generation-virtual-worlds/simulating-sky)
  - **本地副本**: [`src/environment/reference/shadertoy_wlBXWK.glsl`](../../src/environment/reference/shadertoy_wlBXWK.glsl)（462 行，含 13 条更新日志；sha256 `6944dd3e…`）
  - **关键更新日志**（原版第 24–36 行）：
    - Update 1（25-9-2019）: added 2 lines to prevent mie from shining through objects inside the atmosphere
    - Update 4（28-11-2019）: **atmosphere now correctly blocks light from the scene passing through**, and added an ambient scattering term
    - Update 6（28-11-2019）: atmosphere now doesn't use the ray sphere intersect function, meaning it's only one function
    - Update 8（15-5-2020）: Added ozone absorption
    - Update 9（6-5-2021）: Changed the ozone distribution from 1 / cosh(x) to 1 / (x^2 + 1), and removed the clamp
    - Update 13（Planned）: Change the integration again, according to seb hillaire: **transmittance + total instead of optical depth and total**
- [Bruneton, Precomputed Atmospheric Scattering](https://ebruneton.github.io/precomputed_atmospheric_scattering/)
- [Bruneton, horizon artifact 修正](https://github.com/ebruneton/precomputed_atmospheric_scattering/pull/32#issuecomment-480523982)
- [Hillaire, A Scalable and Production Ready Sky and Atmosphere Rendering Technique](https://sebh.github.io/publications/egsr2020.pdf) ← **P1 照抄目标**

### 6.4 本仓库文件（按 P0 范围）

| 文件 | 涉及 |
|---|---|
| `src/environment/EnvironmentRenderer.js` | §2.1, §2.3, P0, P1 |
| `src/environment/atmosphereScattering143.js` | §2.1, §2.2, P0 |
| `src/environment/volumetricClouds143.js` | §2.2, P0, P2 |
| `src/environment/environmentStages.js` | §2.1–2.4, P0 |
| `src/environment/environmentState.js` | P3 |
| `src/environment/EnvironmentLighting143.js` | P3 |
| `src/environment/HdrEnvironmentPass143.js` | P2, P4 |
| `src/pipeline/RenderGraph143.js` | P4 |
| `src/pipeline/PooledStageCache143.js` | P4 |
| `src/renderer/RenderItemExecutor143.js` | P4 |
| `src/diagnostics/RenderProfiler143.js` | P4 |
| `src/VisualPipeline.js` | P4 |
| `src/rhi/WebGLDevice143.js` | P1, P4 |
| `src/lighting/DeferredGeometry143.js` | P3（阴影相关另测） |
| `src/shadows/shaderAdapter143.js` | P3（shadow-map 锯齿另测） |

---

## 7. WebGPU 的独立实验边界

在具备实际 GLB/3D Tiles/PBR、透明/OIT、阴影和业务交互的**等价场景**之前，WebGPU demo FPS **无法与本管线作公平比较**。

可以先用**共享算法描述与 shader 参数契约**准备迁移，但**不为此重写现有主路径**。

若开展后端实验，要**同时比较** WGSL 迁移、纹理共享/拷贝、不同 canvas 合成、GPU query 和模型兼容成本，**测得净收益后再决定迁移范围**。

---

## 8. 待验证项

### 8.1 已由 v3 源码对照解决

- [x] ~~确认 Shadertoy wlBXWK 的独立许可条款~~ → **MIT，Copyright (c) 2019 Dimas Leenman**（§1、§6.3）
- [x] ~~确认原版坐标系约定~~ → **原点在地心，第 120 行 `start -= planet_position`**（§2.1）
- [x] ~~确认原版合成公式~~ → **`L_scatter + scene_color * opacity`，第 267 行**（§2.2）
- [x] ~~确认真实 ENU 高度错误~~ → **常数错误已定位，见 §2.6.1 对照表**

### 8.2 仍待验证

- [ ] 用真实 Cesium 矩阵**实测**复现 ENU 高度 `-6,370,900 m`（§2.1）
- [ ] 确认 `clouds:false` 是否真正阻止云 march 执行（§2.3）
- [ ] 确认 `volumetricClouds143.js` 的屏幕 hash 是否被标注为蓝噪声（§2.4 / P2）
- [ ] 确认 RHI 对 RG16F/R32F 的支持情况（§4）
- [ ] 确认原版 `ray_length.y = min(ray_length.y, max_dist)`（第 142 行）在 CCR 中的对应实现
- [ ] 确认原版 `1.0 - exp(-col)`（第 457 行）不与 CCR 应用层色调映射重复
- [ ] 标定原版 `light_intensity = vec3(40.0)` 在 CCR HDR 量级下的对应值
- [ ] `ab-env-on/off.json` 补充 assetHash/source hash（§5）
- [ ] 原版 Update 13（planned）提到的「transmittance + total 代替 optical depth + total」是否纳入，还是保留当前版本

---

**文档维护**：实施后应将结论回写至 `docs/03-rendering-perf/RENDERING_PERFORMANCE_NEXT_v3.md` 对应 Phase。
