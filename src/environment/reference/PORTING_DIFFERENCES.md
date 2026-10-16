# Shadertoy wlBXWK 移植差异清单

> 底本：`src/environment/reference/shadertoy_wlBXWK.glsl`
> SHA-256：`6944dd3e0661fa9b2c33fa22be631b61b121b3bbe1f920ec9f90fa5216b79fe7`
> 许可：MIT License, Copyright (c) 2019 Dimas Leenman（底本第 1-22 行含完整文本，已随文件保留）
> 上游出处：底本第 51-53 行注明基于 scratchapixel "Simulating Sky"

本文记录**每一处与原版不同的地方**。移植原则是照抄，因此每一处偏离都必须在此列明理由。

## 1. 常数：全部按原版，不再重新推导

之前的实现把原版的米制常数误当作"单位球空间"数值，做了 `* MODEL_SCALE / 100` 的换算，
并把 `ABSORPTION_BETA` 改写成了另一组数。原版用的就是真实米制（`PLANET_RADIUS 6371e3`），
因此这次全部恢复原值。

| 常数 | 原版值 | 旧实现值 | 处理 |
|---|---|---|---|
| `RAY_BETA` | `(5.5e-6, 13.0e-6, 22.4e-6)` | 同 | 保留 |
| `MIE_BETA` | `21e-6` | 同 | 保留 |
| `ABSORPTION_BETA` | `(2.04e-5, 4.97e-5, 1.95e-6)` | `(2.04e-6, 4.89e-6, 1.2e-5)` | **恢复原版** |
| `G` | `0.7` | `0.8` | **恢复原版** |
| `HEIGHT_RAY` | `8e3` | 8000 | 等价，改为字面值 |
| `HEIGHT_MIE` | `1.2e3` | 1200 | 等价，改为字面值 |
| `HEIGHT_ABSORPTION` | `30e3` | 25000 | **恢复原版** |
| `ABSORPTION_FALLOFF` | `4e3` | 15000 | **恢复原版** |

关于 `ABSORPTION_BETA` 的准确性说明：旧文档曾把该差异描述为"让天空向蓝色偏移"。这**不是
一个可推出的结论**——蓝通道吸收系数更大只会削弱更多蓝光，净效果取决于它与 `RAY_BETA`
散射项的相互作用。此处只记录"与原版不同"，不宣称具体的色偏方向。

`G = 0.8` 本身并非错误（Bruneton 参考实现也用该值），但原版用 0.7，因此对照版取 0.7。

## 2. 坐标：必须传入地心系

原版第 120 行：

```glsl
start -= planet_position;   // planet_position 为 vec3(0.0)
```

原版所有位置都在**地心为原点**的坐标系里。旧实现把 `eyeToLocal` 产生的 ENU 坐标（原点在
椭球面）直接传入，而积分用 `length(position) - planetRadius` 求高度。

用真实 Cesium 矩阵实测该误差（`tests/rendering/atmosphere-coordinate-contract.test.mjs`）：

| 位置 | `length(p) - 6371000` | 真实高度 |
|---|---|---|
| 校园纬度（123.41, 41.76）+100m | **-2205 m** | 100 m |
| 赤道 +100m | **+7237 m** | 100 m |
| 极点 +100m | **-14148 m** | 100 m |

误差为 2.2%–14% 的大气厚度（100 km），且**随纬度变化**，因此**单一常数偏移无法修正**。
必须真正把位置转换到地心系，并明确椭球与球面半径的高度校正。

修正方式：新增 `ecefToPlanetCentred`，把 ENU 坐标经 ENU→ECEF 变换后送回积分；积分内部
保留原版 `start -= planet_position` 结构。

**边界说明**：原版用球面 `PLANET_RADIUS = 6371e3`，而 Cesium 用 WGS84 椭球。因此即便转换
正确，球面半径与当地椭球半径仍有约 ±7 km 的差异。本次采用**底本一致**的做法（沿用球面、
沿用原版常数），把椭球适配作为独立项记录于第 5 节，不与"底层常量照抄"混在一起。

## 3. 合成：恢复场景消光

原版第 267 行：

```glsl
return (
    phase_ray * beta_ray * total_ray
    + phase_mie * beta_mie * total_mie
    + opt_i.x * beta_ambient
) * light_intensity + scene_color * opacity;
```

即 `L_out = L_scatter + L_background * T`。旧实现丢掉 `scene_color * opacity`，改成纯加法，
把天空到无穷远的积分加到近处建筑上。

## 4. 穿透保护 `allow_mie`

原版第 139-140 行，用于防止 Mie 光晕穿过大气内的物体：

```glsl
bool allow_mie = max_dist > ray_length.y;
```

第 170 行据其将整个 Mie 相函数项置零。

**重要限制**：这是原版的**近似处理**，不是通用穿透修复。对建筑像素，`ray_length.y` 已被第
130 行截断到 `max_dist`，条件为假，因此 Mie 项（含相机与建筑之间的介质散射）整体归零。
对照版保留原版语义；生产路径需要单独验证近景雾与遮挡边缘的表现。

## 5. 待验证与未决项

- **椭球 ↔ 球面**：原版用平均球半径，Cesium 用 WGS84。转换到地心系后仍有 ±7 km 量级差异，
  见第 2 节实测。需要决定是沿用球面（对照一致）还是引入椭球半径校正（物理更准）。
- **`max_dist` 语义**：原版传入的是场景距离；CCR 用 `sceneDistance` 得到同一量，但需确认
  在透明、OIT 和多 frustum 场景下的取值。
- **`light_intensity`**：原版为 `vec3(40.0)`，需按 CCR 的 HDR 量级重新标定，并确认原版
  `1.0 - exp(-col)` 曝光不与应用层色调映射重复。
- **采样预算**：原版桌面为 `32 x 8 = 256`，移动为 `12 x 4 = 48`。CCR 的 `balanced` 为
  `12 x 6 = 72`。原版桌面档作为**正确性对照**，运行档位独立测量——`balanced → 原版桌面`
  约为 3.56 倍嵌套预算，两者不能混用同一验收标准。
- **`skylight()`（原版 300-328 行）**：不复用，由 Cesium IBL 承担。
- **`render_scene()`（原版 339-379 行）**：替换为 Cesium `sceneDistance` 与 HDR 颜色输入。

## 6. 记录

移植后必须通过 Cesium 坐标、深度、HDR 与透明场景的集成验收；原版复现通过不等于集成通过。

### 2026-10-14 运行适配修正（以上旧实现描述不作为当前状态）

- `EnvironmentRenderer.updateAtmosphereCamera()` 使用 WGS84 相机高程和 geodetic normal，得到 ENU 基底内的参考球相机位置 `up * (6371000 + height)`。方向与太阳均保持 ENU。相机高度在赤道、校园、极点的双精度测试误差低于 `1e-5 m`。这是相机所在地的切球近似，不是完整椭球积分。
- 云噪声位置为 `position - atmosphereOrigin + cloudNoiseOrigin + wind`，与介质的球心位置分开，避免相机移动带动噪声场。
- `ccrAtmosphere` 保留原版均匀采样和 `allow_mie`，用于 GPU 原版对照；运行使用 `ccrAtmosphereScene`，在高密度端集中分配既有采样，并保留几何前方的 Mie 散射。二者共用积分、常数与消光代码。原版对照、运行适配是不同的数值模式。
- 明确裁剪地表、解包 Cesium globe depth；太阳被行星挡住时直接返回零透射。删除错误的 200 km 大气射线截断，地平线射线由球壳交点裁剪。
- 云 RGB 与背景以透射率合成；在首次有效云样本处拆分云前/云后大气（仍为薄层近似）。源辐射与场景反照率分开，resolve 使用 `radiance + original * transmittance`，在深度边界约束下重建。先前的 HDR 差值上采样已移除，避免低分辨率地表颜色污染云体。
- 保持 RGBA32F 目标：RGB 存辐射，alpha 的 24 位整数范围存三个 8 位光学深度，先解码后过滤。RGB 透射率相对量化误差不超过约 3.2%；GPU 读回验证了包括 0/1 在内的编码边界。该 alpha 是内部数据，不能当普通透明度采样。
- CCR 介质接管时暂退原生天空与地表大气，恢复时遵守原生属性所有权，避免两套大气叠加。诊断分辨率热切换会重建目标，resolve 尺寸取实际纹理。

### 2026-10-14 过曝与天空亮度修正

- 原版对照函数仍使用白色强度 40，并保留原版积分返回值；原版最后的显示映射是 `1-exp(-col)`。运行时仍由 Cesium 统一执行曝光、ACES 和 gamma，不在积分中叠加原版显示映射。
- 运行时使用独立的 `atmosphereSunRadiance`，晴天默认沿用原生天空强度 20。它按用户请求的太阳强度和天气 profile 缩放，太阳颜色、地平线消光和行星遮挡由积分处理。云的辐射量与参考大气的艺术强度并非同一亮度标尺，不能直接将云的 6.6 替换到大气中；这次试验导致天空变暗，已撤销。
- 不叠乘云光照的暖色太阳 RGB，不使用直接光的地平线淡出系数来关掉黄昏的大气散射。上述强度是当前 Cesium HDR 显示链下的视觉标定，不宣称物理辐射单位或与 Shadertoy 截图逐像素等价。
- 显示调色改为保留黑白端点的对比度与有界亮度增益。修正旧 clear preset 把输入 0.9 和 0.95 都硬裁剪成 1 的问题，仍保留 neutral/disabled 恒等、亮度 0 为黑、对比度 0 为平灰、alpha 不变。全局曝光仍为原配置，不通过调暗建筑来修天空。
- 云形改用固定 `three-geospatial b012ad06` 的 Perlin-Worley/Worley 场，离线生成图集并随包内嵌。视线与太阳共享密度，使用双 HG 相函数和三阶多散射近似。不再采用独立二值太阳遮挡，也不再把像素哈希称为蓝噪声。
- 云的 `balanced` 为 `96×6`，`high` 为 `128×8`。这是视觉修正后的采样预算，不是性能收益。此次不进行性能测试；新 LUT、时域重建与光照标定仍属于后续阶段。

### 2026-10-14 大气太阳辐射的昼夜响应修正

> 历史记录：本节的 20 与表格是当时的方案，不是当前运行值。2026-10-15 当前基值为 9，来自排除原生 SunBloom LDR 中间层后的多时刻/多方向亮度拟合；它不是物理单位或两个模型完全等价的证明。下文关于旧 `ccrSunRadiance()` 云光照的说明也已被新传输链替代：云采样点现在使用 `atmosphereSunRadiance` 与该点的太阳透射率。最新范围见 `three-clouds/TRANSPORT_PORT.md`。

上一节的第 2 条把 `atmosphereSunRadiance` 从云的直射光淡出中解耦，但**同时把昼夜响应也一并去掉了**：该值只按 `o.sunIntensity / 默认值` 与 profile 缩放，`sunHeight` 完全不参与。后果是**太阳落到地平线以下后天空仍保持正午亮度**，`environment-p0.test.mjs` 里那条 `sunset.atmosphereSunRadiance === day.atmosphereSunRadiance` 的断言把这个行为固化成了"正确"。

修正为引入 `daylight`：

```js
atmosphereSunRadiance: [1, 1, 1].map(v => v * 20
  * o.sunIntensity / environmentDefaults.sunIntensity * p.sun * daylight)
```

**用 `daylight` 而不是 `direct`**：`direct = smooth(0, 0.12, sunHeight) * ...` 在太阳过地平线时立刻归零，会把这套积分本应产生的晚霞一并删掉；`daylight = smooth(-0.12, 0.18, sunHeight)` 覆盖地平线前后各一段，天空在暮光中渐暗、夜间归零。

实测响应（`clear`、默认 `sunIntensity`）：

| 场景 | sunHeight | daylight | sunIntensity | atmosphereSunRadiance |
|---|---|---|---|---|
| 正午 | 1.00 | 1.0000 | 2.2000 | 20.000 |
| 金色时刻 | 0.10 | 0.8246 | 1.3241 | 16.492 |
| 日落 | 0.00 | 0.3520 | 0.0000 | 7.040 |
| 刚落地平线 | -0.05 | 0.1379 | 0.0000 | 2.759 |
| 民用暮光 | -0.12 | 0.0000 | 0.0000 | 0.000 |

**与 `sunRadiance` 的不对称是有意的**：云的直射光（`ccrSunRadiance()`）在 `sunHeight ≤ 0` 时归零，因为太阳已被地球本体挡住；而大气的散射（`atmosphereSunRadiance`）保留衰减后的非零值，因为太阳落到地平线附近时**高层大气仍被照亮**并将其散射到观察者眼中——这正是晚霞的成因。两者不应被同一个系数驱动。

`20` 的性质需明确记录：它是 Cesium 自己的 `skyAtmosphere.atmosphereLightIntensity`，由 `EnvironmentLighting143` 写入原生对象，此处沿用是为了让接管/卸载自定义天空时亮度不跳变。**它是 Cesium LUT 模型的标定常数，不是物理辐照度**，因此它与本积分 `radiance` 项的乘积是**艺术标定匹配，不是推导量**。原版对照函数仍使用 40，常数与参考文件未改动。
