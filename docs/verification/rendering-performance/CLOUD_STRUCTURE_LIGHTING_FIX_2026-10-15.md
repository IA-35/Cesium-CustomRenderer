# 云团结构与明暗修正 · 2026-10-15

> **用户已验收 · 2026-10-15**：用户明确确认“确认，我已验收，效果我已满意”。验收范围为本轮云形与白天/日落云照明。当前记录的参数、截图和 SDK 身份作为后续回归基线；下文保留的参考图差异与技术近似不再作为本轮待验收阻塞项。该确认不扩展为夜间照明或正式性能验收。

目标采用用户提供的 [liaomz 2025-02-13 文章](https://www.liaomz.top/2025/02/13/cesium-zhong-shi-xian-ti-ji-yun-he-da-qi-mei-hua-xiao-guo/) 及其云海截图：有大小团簇和间隙、亮顶部与冷色凹槽、近处立体而远处融入大气。本轮只负责云形与白天/日落云照明；夜间照明为并行工作，保留其改动但不承担其验收。

## 1. 核实结果

- 上游 `sampleMedia(position)` 的位置是米制 ECEF，归一化仅用于法线/球面 UV；`.0003` shapeRepeat 对应约 3333 米的完整纹理周期。大气 `METER_TO_LENGTH_UNIT` 转换不改变云噪声位置。
- CCR 的 `64/period` 把米映射为 64³ 噪声体的格坐标；64 是每轴采样数，与 8×8 图集排版的 tile 数含义不同。这条单位换算没有错误。
- 但纹理内部已有噪声频率。原 shape 8 km / detail 2 km 的实际结构尺度过近；仅看完整周期不能判断云团直径。
- 当前运行路径已有 Hillaire LUT 天光和八阶太阳多散射，并非只使用常数 `ccrSkyRadiance()`。缺少的是平均天光经过云自身遮挡后的空间变化。LUT M 还包含地面半球，不能将其视为纯上半球输入后再叠一份 diffuse ground。

参考：固定 three-geospatial `b012ad06d858fc035d88aacfd73f092f93c994e4` 的 `clouds.glsl`、`CloudsEffect.ts` 和本仓 [移植合同](../../../src/environment/reference/three-clouds/TRANSPORT_PORT.md)。本轮未新增第三方资产或复制一套资源管理器。

## 2. 最终实现

| 项目 | 修改前 | 当前 |
| --- | --- | --- |
| Weather 完整纹理世界周期 | XY 32 km | 保留 32 km |
| Shape 完整纹理世界周期 | XYZ 8 km | XYZ 16 km |
| Detail 完整纹理世界周期 | XYZ 2 km | XYZ 1.2 km |
| 单层积云 weather 高度偏置 | .35，包络峰值约 t=.14 | 用 t² 输入原函数，等效 .7，峰值约 t=.37 |
| 积云形状侵蚀 | 上游 shapeAmount 固定为 1 | 恢复该机制，固定标定 1.25 |
| 消光系数乘数 | .03/m | 积云 .06/m，层云保留 .03/m |
| 天光 | Ψ×高度梯度，无云内遮挡 | Ψ×原高度梯度×双向密度遮挡 |

实际 media density 仍使用真实高度 t；层云 weather 保留原 .35 轮廓。shapeAmount 通过 `shape'=1-(1-shape)*1.25` 接入原 remap，后续 clamp 保证非负、有界密度。它在密度场中开辟间隙，未改变 coverage=.42 或显示层。

周期由 `cloudSpatial143.js` 共用于 shader 和风场每轴 wrap，材质重投影仍用未 wrap 位移。没有新增 RenderTarget、LUT、Pass 或 Graph allocator。

积云消光的再次标定来自独立对照：结构修正后，在默认 1200 米层厚的 24 km 采样场中，旧 .03 的云柱 τ 中位数只有 .95；很多云表现为透光薄幕。改为 .06 后中位数约 1.90、p90 约 7.01，保留透光边界与不透明厚核心。实际太阳/云影透射同步改变，powder 也继续读取真实局部消光；不是提高曝光或叠加对比曲线。此系数仍是 CCR 材质标定，不宣称来自特定实测云含水量。

天光用生产密度沿上/下球壳边界各积分一次，以两条垂直射线代表上下半球。每个方向采用归一化的八阶各向同性消光近似：无遮挡为 1，厚度增加时连续趋近零，没有人为亮度下限。保留此前 Ψ 的正确单位归一化及太阳八阶散射；LUT ready 时停止额外 diffuse ground，兼容解析分支保留原地面估算。

曾试验 24×24×16 km shape / 64 km weather：俯视云占屏接近 99.4%，形成更平的整层，未采纳为最终配置。该候选记录在 `cloud-structure-shape.json`，不能作为最终视觉完成证据。

## 3. 验证与数据

**GPU 公式验证**：[cloud-ambient-gpu.json](cloud-ambient-gpu.json)。8 组可见度、15 组均匀密度径向路径，真实生产 helper/球壳/积分执行。可见度最大误差约 7.64e-8，光学深度最大误差约 3.81e-7；通过空介质、对称、单调、范围与零密度检查。均匀密度 fixture 验证公式，不等价于完整噪声场验收。

**GPU 密度场对照**：[cloud-density-field.json](cloud-density-field.json)。RTX 3070、24×24 km、128² 水平采样、48 层高度中点，同一噪声及零风偏移。Baseline 是明确重建的旧算法诊断变体，不是旧 SDK；shape-only 隔离形态，candidate 才使用最终材质消光。

| 指标 | 旧算法 σ=.03 | 新形态 σ=.03 | 最终 σ=.06 |
| --- | ---: | ---: | ---: |
| Opacity 平均半相关长度 | 750 m | 937.5 m | 937.5 m |
| 云柱占用率，T<.95 | 91.96% | 73.10% | 74.40% |
| τ p50 | 1.197 | .951 | 1.902 |
| τ p90 | 2.798 | 3.504 | 7.009 |
| 有效云顶 p50 | 2037.5 m | 2287.5 m | 2287.5 m |
| 有效云顶 p90−p10 | 300 m | 275 m | 275 m |

结果支持水平相关尺度增大、间隙增多和云顶整体抬高；**不支持云顶高度分布范围增大**。每组都检查有限值和 `τ≤σ×1200` 上界，分别 36/36/72。早期 probe 曾误用 densityScale=1，已修正并覆盖，不采用那版统计。

**实际 SDK 页面**：[修改前](cloud-structure-before.json)、[最终修改后](cloud-structure-after.json)、[汇总](cloud-structure-summary.json)。固定位置 123.42°E/41.77°N、1200×720、coverage=.42、base=1600/thickness=1200、动画关闭、曝光 1.6、太阳/天光强度不变；11:00/16:00 的云上向阳、侧向、云下、正顶，加 17:45 云上，共 9 例。每例 24 帧收敛，HDR/LUT/单 frustum 有效，无 GL/页面异常、非有限颜色或负透射，cloud march/depth 的 T 最大差值为 0。

比较指标是 occupied cloud pixels 的线性 `L/(1-T)` 分布，contrast=`(p90-p10)/(p90+p10)`，不是后处理对比度参数：

| 视角 | Contrast 前→后 | P10 暗部前→后 | P90 亮部前→后 |
| --- | --- | --- | --- |
| 11:00 云上向阳 | .214→.296 | .413→.394 | .639→.725 |
| 16:00 云上向阳 | .361→.491 | .328→.277 | .699→.813 |
| 16:00 云上侧向 | .257→.387 | .276→.239 | .467→.541 |
| 11:00 正顶 | .155→.142 | .452→.500 | .619→.665 |

侧光结果有更明确的团簇、间隙、亮顶与冷色凹槽；**正午正顶的该对比指标未改善**，不能宣布所有视角都已达到参考照片。占用像素集合随形状变化，因此这张表衡量最终整体输出，不能单独归因于某一个照明项。

最终 after 固定返回脚本启动时读入的 SDK bytes，即使另一个工作重建也不漂移：SHA256 `bb9413e1e303651b5720e66b016ab520720c039b6762ea0d332b7f83d6e55e8b`。历史 before 的旧脚本是在末尾对磁盘 bundle 求哈希，身份保证弱于新 after；其记录 SHA 为 `b979c3e6854ab909b63067cfe7c9eecd4b0fb18242956585d347984b38dbeb5b`。

全分辨率诊断未明显改变 16:00 侧向画面的平软程度，故本轮没有通过提高默认环境分辨率掩盖问题。独立规格与质量复核未发现生产改动的确定阻断问题；质量复核指出的零 case 误成功路径已修正。

全工作区测试 **989 项，986 通过、3 跳过、0 失败**；133 文件 GLSL 嵌入语法、通用真实 WebGL2 shader 检查及 SDK 构建通过。

## 4. 对照与剩余边界

| 视角 | 修改前 | 当前 |
| --- | --- | --- |
| 16:00 云上侧向 | [截图](cloud-structure-before-1600-above-side.png) | [截图](cloud-structure-after-1600-above-side.png) |
| 11:00 云上向阳 | [截图](cloud-structure-before-1100-above-sun.png) | [截图](cloud-structure-after-1100-above-sun.png) |
| 17:45 日落 | [截图](cloud-structure-before-1745-above-sun.png) | [截图](cloud-structure-after-1745-above-sun.png) |

仍使用 64³ atlas、固定视线/太阳采样和双垂直方向的 ambient 近似。细节与正午俯视仍比参考图柔，不能用函数通过或平均相关长度增加声称完全复刻照片。四层天气、真实 STBN、方向天空半球积分与级联云影不属于这次已完成内容。更多厚度、覆盖率、位置与设备仍需扩展视觉验收。

LUT 常见路径净增一条二次密度积分：balanced 每个有云受光样本由太阳6+地面6，变为太阳6+上下12；另有归一化八阶 ambient 的标量计算。没有新增纹理资源，但 GPU 耗时未测量，不宣称无成本或性能提升。

复现使用 `CESIUM_PLAYWRIGHT=C:/Users/Administrator/node_modules/playwright`：构建 SDK 后运行 `node scripts/performance/judge-cloud-structure.cjs --label=after`、`node scripts/performance/check-cloud-ambient.cjs`、`node scripts/performance/check-cloud-density-field.cjs`。当前 SDK 加 `--label=before` 不能重建历史旧画面。
