# 夜间照明与原生星月修复 · 2026-10-15

目标：保留已验收的白天天空、曝光与日落照明；夜间可分辨冷调云层、地平线、地表和建筑，保留星空与有月相的月盘。代码、真实 WebGL2 和实际 SDK 页面开发验证通过；用户于 2026-10-15 明确确认验收。此确认针对本轮夜间视觉修复，不代表正式性能测量或真实照度标定完成。

## 1. 实际原因

太阳源归零而没有独立夜间源，确实会使 LUT 云照明失去输入。旧 `skyRadiance` 的少量夜间地板不会自动成为 LUT 天光或原生 PBR 的环境辐照度。

但 `skyAtmosphere.show=false` **不等于关闭星月**：Cesium 的 SkyAtmosphere、SkyBox、Moon 分别更新/绘制；当前框架本来就在夜间恢复原先可见的 SkyBox，并将原生 HDR 星月输入乘介质透射后保留。实际捕获也确认夜间 `skyBox.show=true`、`moon.show=true`、`skyAtmosphere.show=false`。

另有两个独立月盘问题：

- `Moon.onlySunLighting=true` 固定 Phong 受光方向为太阳，但 `czm_private_phong` 仍乘 `czm_lightColor`。场景太阳光强度为零时，原生月盘也黑；直接将场景光源改成微弱月光，还会让月盘再次受月光强度和色调影响。
- 单视锥示例 `far=50000` 下，原生月球可以通过去除远平面的可见性检查，但其不透明 EllipsoidFS 会调用 `czm_writeLogDepth`。实际月距大于 far，片元被 discard。修复前诊断曾同时满足 `moonVisible=true`、`moonCommand=true`，但 native HDR 月盘区域全零。

原生源证据：`Scene.js` 的 `updateEnvironment` / `renderEnvironment`；`Moon.js`、`EllipsoidFS.glsl`、`phong.glsl`、`writeLogDepth.glsl`。公开 API：[Moon](https://cesium.com/learn/cesiumjs/ref-doc/Moon.html)、[SkyBox](https://cesium.com/learn/cesiumjs/ref-doc/SkyBox.html)、[Simon1994PlanetaryPositions](https://cesium.com/learn/cesiumjs/ref-doc/Simon1994PlanetaryPositions.html)。Moon 没有公开 `moonDirectionWC` 成员，本次使用与其相同的历算来源。

## 2. 接入合同

### 独立夜源和坐标

`environmentState.js` 返回 `nightWeight`、`moonPhase`、`moonHeight`、`moonRadiance`、`nightSkyRadiance`。夜间过渡为 `1-smooth(-.12,-.01,sunHeight)`；太阳高度 >=−.01 时新增能量严格为零，既有 daylight / 太阳源不变。

- 满月顶部月光工程强度为 `[.65,.8,1]*.15`，乘夜间权重、Lambert 月相与月高渐变。它独立于 `sunIntensity`。
- 低频夜空平均辐亮度为 `[.012,.022,.045]*nightWeight*(skyLightIntensity/3.2)`；无月也保留低照度，显式 skyLightIntensity=0 仍可关闭该项。
- 月相角 `α=acos(-dot(sunGeocentric,moonGeocentric))`，强度 `(sinα+(π−α)cosα)/π`：满月 1、新月 0、上下弦 1/π。这是地心 Lambert 近似，不是月面实际 BRDF 测光。
- 月球惯性位置经太阳共用的 ICRF→fixed 回退转换成为 ECEF 位置，**先减相机 ECEF 位置**，再归一化。方向以 `inverseFrame` 的向量部分旋转为 `moonDirectionAtmo`，与大气原点和射线使用同一旋转参考系；不把 ENU 相对点当地心位置。
- 月高始终为观察点椭球法线与观察点月方向的点积。数值回归覆盖地心月高 +.286°、观察点实际月高 −.664° 的视差案例，此时月光严格为零；非单位 ENU 与带平移矩阵也覆盖。

这些强度是共享线性 HDR 的工程可视化标尺，未做真实夜间照度标定。未提高曝光或太阳强度，也未给太阳透射率加下限。

### 云、大气与材质

- 云的月光沿月方向独立查询大气 T、积分同一云密度的光学深度并使用现有八阶多散射；冷天光作为独立漫射源。不再借太阳 daylight 作为夜间开关。
- 夜间大气复用已经提交的介质 T/M，沿月方向积分月光散射和冷天光。太阳专用 SkyView 不被当作月亮 SkyView，云前后分段与无云分支都保留夜源。白天提前返回零；无月时不做月光 T/M 查询。
- 原生地表与模型的定向光使用真正的 DirectionalLight，方向为“月球指向场景”，与 towards-moon uniform 符号相反。现有原生/自定义不透明物体阴影因此沿实际月方向工作。
- Model/Tileset 仅在未显式指定 SH 时接入低频冷天光；不修改用户 SH、静态反射贴图或 IBL 因子。黄昏与原生动态 SH 混合，暂停时钟也会刷新异步到达的原生 SH；只遍历已管理记录，不为此每帧重扫场景树。白天、关闭、移除及外部接管恢复所有权。
- 原生 Globe 另在直接光之后、裁剪之前添加 `color.rgb * nightSkyRadiance`，其中 color 是已解码/混合的原生影像和材质颜色，alpha 不变。复用共享 ContextDrawDispatcher，派生程序和 uniformMap 缓存；每次提交后恢复命令引用。白天、零夜源、外部关闭 globe lighting、pick、shadow caster 与外部覆盖绘制不接管。

### 原生月盘和星空

- 沿用原生 SkyBox 星图、月球几何/纹理/姿态/可见性。不创建未请求的天空对象，不改变月球角尺寸，也不引入新星表或纹理许可。
- 仅针对固定 Cesium 1.143 的默认 Moon Image 材质，在夜间使用太阳 Lambert emission；不再乘场景光源，盘面相位仍由太阳方向和真实月球表面法线决定。材质走非深度写入环境绘制，避免短单视锥的月距深度丢弃。
- 日间和关闭恢复借用材质；销毁仅释放自有材质。启用前的自定义颜色/alpha/repeat、非默认材质以及启用后的外部替换均保留，不强行接管。

## 3. 验证方式与结果

新增 21 个定向回归覆盖状态/月相/视差、SH 所有权与异步更新、材质恢复、云源绑定、Globe 派生/缓存/提交异常恢复。新增功能或边界测试先确认失败，再实现通过。最终全套 **992 项：989 通过、3 跳过、0 失败**；133 个脚本的 GLSL 嵌入检查通过，通用真实 WebGL2 shader 检查通过。

旧太阳光程测试的禁用截断检查现限定到太阳光程函数，避免把其他模块的 `16000.0` 周期常量误识别为 `6000.0` 截断；原有约 94 km 掠射光程数值断言继续保留。

[GPU 探针](cloud-irradiance-night.json)包含既有 20 组太阳/厚云数值回归，以及 9 组月高×月相检查：上弦月的散射源为满月的 1/π；新月、地下月光严格为零；无月冷天光保持非零。负月高实际查询到的 LUT T 也为零，未用人为透射率地板穿过地球。

实际页面使用构建 SDK、1200×720、环境每轴 1/2 分辨率、动画关闭；相同曝光、天气和相机。满月（9/26 23:00）、近上弦月（9/18 19:30）、无月（9/10 23:00）与白天（9/8 11:00），各抬头、校园、云上三视角。

**主要比较是同一最终 SDK 的受控对照**：[禁用夜间项](night-lighting-baseline.json)与[启用夜间项](night-lighting-after.json)。禁用仅在浏览器 fixture 内将夜源归零、恢复原生材质/灯光；不添加产品开关。这样避免把期间云空间参数等其他工作区变更算成本次收益。更早的 `night-lighting-before.json` 保留为历史症状记录，不用于精确差值断言。

- 月盘区域在原生 HDR 中已非零；满月约 76 个亮片元、近上弦约 25 个，保留相位与真实角尺寸，没有放大盘面。
- 无月抬头视角检测到原生星图局部亮点特征，非星表计数。云上的 RGB 保持 B>G>R，太阳源为零时仍可辨认云体与地平线。
- 白天新增能量为零、原生太阳恢复，三个视角合成平均亮度的前后最大绝对差约 **1.04e-6**；精确差值与构建身份见 [汇总](night-lighting-summary.json)，不将此门槛外推到任意用户配置。
- 另以彩色 GridImagery 在无月、关闭雾和云时验证原生地表：[禁用对照](night-lighting-grid-baseline.json)的原生 HDR 上四分之一平均亮度为零；[启用](night-lighting-grid-after.json)后非零，绿色线条和蓝色底色保留。测的是进入大气之前的原生影像，证明不是后处理加一层雾色。
- 全部正式 after 捕获 HDR/LUT/Graph 有效、无页面异常/NaN/GL 错误，云颜色与距离通道 T 的帧内误差 <=1e-5。独立捕获不保证像素逐一完全对齐。

| 结果 | 实际截图 |
| --- | --- |
| 满月及月周大气 | [抬头](night-lighting-after-2026-09-26T2300-sky.png) |
| 弦月与原生星图 | [抬头](night-lighting-after-2026-09-18T1930-sky.png) |
| 满月校园 | [建筑与地表](night-lighting-after-2026-09-26T2300-campus.png) |
| 满月云上 | [云与地平线](night-lighting-after-2026-09-26T2300-clouds.png) |
| 无月云上 | [冷调漫射](night-lighting-after-2026-09-10T2300-clouds.png) |
| 无月原生地表 | [彩色网格](night-lighting-grid-after-2026-09-10T2300-grid.png) |

## 4. 复现与边界

设置 `CESIUM_PLAYWRIGHT=C:/Users/Administrator/node_modules/playwright` 后，先构建，再依次运行（共用页面捕获端口，不并行）：

```text
node scripts/performance/check-cloud-irradiance.cjs --label=night
node scripts/performance/judge-environment-lut.cjs --night-lighting --night-disabled --label=baseline
node scripts/performance/judge-environment-lut.cjs --night-lighting --label=after
node scripts/performance/judge-environment-lut.cjs --night-lighting --night-grid --night-disabled --label=grid-baseline
node scripts/performance/judge-environment-lut.cjs --night-lighting --night-grid --label=grid-after
node scripts/performance/summarize-night-lighting.cjs
```

SDK hash、同构建断言、各场景结果和边界汇总保存于 `night-lighting-summary.json`。每次重建后应重做这些捕获，不能拿不同构建做精确差值断言。

本次最终 SDK SHA-256：`bb9413e1e303651b5720e66b016ab520720c039b6762ea0d332b7f83d6e55e8b`，2,261,414 字节。

未进行正式 GPU 耗时或显存峰值测量。夜间增加月光云密度积分、短大气积分与 Globe 派生程序，不能宣称没有性能成本。没有新增大气 LUT 或云 history；原生星月保持原生资源所有权。完整方向夜空积分、真实测光、月光级联云影和更多部署设备仍未宣称完成。LUT 不可用时，兼容解析分支仅提供冷天光大气源，云仍可走解析月光透射；原生月盘/Globe 私有适配固定在 Cesium 1.143。
