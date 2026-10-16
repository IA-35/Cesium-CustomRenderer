# 日落云体照明修复 · 2026-10-15

用户已确认天际线灰带/轨道地表变灰修复。本次仅处理日落云体过暗；未修改天空积分、太阳强度、曝光、daylight、太阳大气透射或云密度。结果为开发验证通过，待用户实际场景确认。

## 核实与原因

当前 LUT 路径已经让云太阳光使用 `atmosphereSunRadiance * T`，T 来自 Hillaire 查表；天光也使用同一太阳源与 `environmentSkyScale`。因此当前实现不是云少乘一个 9 倍标定，也不是应该再提高全局太阳强度。

真实 WebGL2 探针在 sunHeight=.05、云高 2200 m 测得：太阳源 5.39467，T≈[.512207,.218262,.119812]，云直接收到的太阳辐照度≈[2.76319,1.17745,.646346]，仍有明显暖色能量。这里 daylight≈.5994；.1 时约 .8246，并非均为 .35。不增加 T 的人为下限，也不跳过行星遮挡。

两个照明实现问题：

1. **天光角度单位混用**。Hillaire M 的 Ψ 是角平均辐亮度；预计算先对方向求平均，再解 `Ψ=L2/(1-fms)`，大气运行时的多散射源也是 `σs*Ψ`。已有半球估计 `E=πΨ` 被云再次乘上游标量辐照度对应的 `1/(4π)`，得到 `Ψ/4`。云各向同性散射需要 Ψ。本次对已经校准的 E 除以 π，复用原查表，没有新增 M 查询；未就绪 fallback 维持原路径。
2. **厚云的高阶贡献被三阶截断**。低角太阳穿过云体的光学深度很大，前三项几乎全被消光。本次沿用固定上游默认八阶配置，每阶将权重、光学深度与各向异性减半。sunHeight=.05、2200 m、视线与太阳余弦 .8、τ=50 时，红通道直接散射源从约 2.43e-7 恢复到 .00491；不是放宽真实太阳透射。

上游固定提交：three-geospatial `b012ad06d858fc035d88aacfd73f092f93c994e4`，`packages/clouds/src/qualityPresets.ts` 八阶默认与 `clouds.frag` 多散射近似。Bruneton scalar irradiance 和这里 Hillaire 半球估计定义不同，不能只复制 `1/(4π)`。适配细节见 [TRANSPORT_PORT](../../../src/environment/reference/three-clouds/TRANSPORT_PORT.md)。

## 修改与代价

- 生产改动集中在 `volumetricClouds143.js` 的云天光源和多散射阶数。视线/太阳/地面密度采样、步数、powder、单次散射反照率、消光与距离羽化保持原合同。
- 每个受光样本增加五次 exp 和十次 HG pow 计算，没有新增密度采样或大气 M 查询。本轮未测 GPU 耗时，不宣称无性能成本。
- 这仍是多散射近似和 Hillaire 各向同性漫射估计，不是完整方向天空半球积分；不人为将日落所有暗面涂蓝或所有云体涂橙。阴影面由天光/自遮挡决定，受光面由实际太阳颜色决定。

## 验证

- 新增两个定向测试先在旧实现失败，修改后通过；全套 **965 项，962 通过、3 跳过、0 失败**。
- 129 个脚本的 GLSL 嵌入语法检查通过；通用真实 WebGL2 shader 检查通过。
- [云照明 GPU 探针](cloud-irradiance-after.json)：5 个 sunHeight（.015/.05/.1/.4/.8）×4 个云高，共 20 组，另逐组验证 τ=0/1/10/50/100 的八阶散射。与 CPU 八阶公式绝对误差 ≤1e-5；归一化误差最大 3.73e-9。全部 T 与修改前逐通道一致，最大差值 0。
- 实际 `examples/campus.html` 加载构建 SDK，1200×720、半分辨率环境；固定日期、天气、相机、动画关闭。17:35/17:45/17:55/11:00/00:00 ×云上 3500 m、12000 m、侧向 3500 m，共 15 例。SDK HDR/LUT/Graph 均有效，无页面异常、NaN 或 GL 错误，各帧云颜色与距离通道 T 一致。
- 日落九例中，取 cloud.march 中 T<.95 的采样像素，平均线性预乘云 RGB 的亮度提高 **20.3%–80.1%**，均维持 R>G>B；侧向 17:55 从 RGB≈[.02437,.00903,.00525] 到 [.03946,.01724,.01277]。这是云通道统计，不是整幅图像增亮率，也不是性能收益。
- 正午三例云通道也因正确天光归一化提高约 51.6%–56.3%，截图保持近中性云色与结构；这项修正有全天云亮度影响，不能称为仅日落参数调整。三个午夜视角云辐射仍为零。
- 以上云上视角的上四分之一天空亮度前后最大绝对差 **4.88e-5**，天空计算及参数未变。独立捕获的浮点/采样状态有小差异，未声称前后 alpha/像素完全相同。

完整 [比较汇总与 SDK 身份](cloud-sunset-lighting-summary.json)、[修改前](cloud-lighting-before.json)、[修改后](cloud-lighting-after.json)。构建 `build/0.1.0/CCR.min.js` SHA-256：`b979c3e6854ab909b63067cfe7c9eecd4b0fb18242956585d347984b38dbeb5b`。

复现：设置 `CESIUM_PLAYWRIGHT=C:/Users/Administrator/node_modules/playwright`，先 `npm run build`，再运行 `node scripts/performance/check-cloud-irradiance.cjs --label=after` 和 `node scripts/performance/judge-environment-lut.cjs --cloud-lighting --label=after`。修改前数据是修复前实际 SDK 捕获，不能用当前 SDK 加 `--label=before` 重建旧效果。

| 视角 | 修改前 | 修改后 |
| --- | --- | --- |
| 17:55 云上向太阳 | [截图](cloud-lighting-before-1755-above.png) | [截图](cloud-lighting-after-1755-above.png) |
| 17:45 侧向 | [截图](cloud-lighting-before-1745-side.png) | [截图](cloud-lighting-after-1745-side.png) |
| 11:00 云上 | [截图](cloud-lighting-before-1100-above.png) | [截图](cloud-lighting-after-1100-above.png) |

独立只读复核未发现本次局部修改的正确性阻塞问题。此轮没有正式帧耗时测试；日出、云下长序列、更多覆盖率与部署设备仍需扩展视觉验收。
