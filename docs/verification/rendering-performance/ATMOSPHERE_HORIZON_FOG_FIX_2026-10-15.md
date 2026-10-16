# 天际线灰带与轨道地表变灰修复 · 2026-10-15

这是 P1 接入时新接回高度雾造成的视觉回退。修复范围为实际生产雾的曲率语义；未调曝光、太阳强度、调色或 LUT 的散射系数，也未撤掉 LUT。

最终 SDK SHA-256：`220782fbef94857c836e4b6b2ffad9d3b9f410a98444faba43c7946503d7cf6f`。[本轮验证汇总](atmosphere-horizon-fix-summary.json)记录测试统计、天际线/轨道回归与 SDK 身份。

## 根因与复现

`ccrSegmentFog` 曾将全球视线交给平面高度模型：`h(t)=hCamera+dot(up,ray)*t`。它适合局部短距离，但越过地球曲面几百公里或从轨道俯瞰时，会把真实地表投影到地下。负高度进入指数密度后，光学深度饱和到 80，`T≈1.8e-35`。原有大气散射和地表都被雾源颜色覆盖：地平线出现灰/暗带，轨道视角只剩正下方小孔没有变灰。

12 km 相机、向下 4°、实际球面地表距离约 232,642 m 的样例：

| 指标 | 旧平面模型 | 球面修正 |
| --- | ---: | ---: |
| 雾光学深度 | 80 | 0.1470805 |
| 雾透射率 | 约 0 | 0.8632245 |

排查时将实际 shader 的无雾 view 散射、Sky-view 与最终散射分别回读：前两者接近，最终输出却被压成大片相同灰值，确认是表面雾盖住散射，不是 LUT 被移除。

上轮固定的 50 km 远裁面把远处地表剔除，使这类射线被当成无表面天空，没有触发错误表面雾，因此漏掉了用户实际视角。新增地平线 fixture 使用 1,000 km 远裁面、1 km 近裁面，仍保持有效单视锥。

## 实现

- 新增球面高度雾适配：先求真实雾层球壳区间，按地表/实际深度裁剪，再沿径向高度积分。
- 雾层取到 base+12H 的可忽略尾部；16 个分段按最近接近地球的位置分配，复用已有解析指数积分计算各段，不把整条全球射线当平面。
- 保留带符号的高度，避免把合法负海拔场景强行裁为海平面。原局部解析 API 保留给局部调用方；生产 `ccrSegmentFog` 切换到球面接口。
- 云前后分段、RGB 透射率与介质消费者沿用同一修正。真实天空/有限场景深度判定保持原契约。

## 验证

- 完整自动化：**963 项，960 通过、3 跳过、0 失败**。
- 新数值回归覆盖 12 km 的 233 km 地表射线、8,000 km 轨道不同角度、负海拔；地表样例与独立 65,536 段 Simpson 径向积分误差低于 1%。
- 实际 WebGL2 雾检查 **69 组**，包含原局部语义与新增球面语义。最大 CPU/GPU 绝对误差约 `0.000185514`，全段/分段差约 `0.000136375`。GPU 与 CPU 使用相同分段近似，不能拿一致性代替独立物理精度证明。
- 新地平线 fixture：12 km、俯角10°，白天/日落；真实远处地表有效。各 35 个无遮挡远地表样点，修复后保留无表面雾散射亮度的最低比例约 **92.8% / 89.0%**，专项门槛为 80%。旧结果的灰/暗平台在同视角对照中消退。
- 轨道 fixture：8,000 km、完整地球，使用 Cesium 自带彩色 GridImageryProvider，排除外部影像网络因素。旧算法的受控重放中，正午中央区域只有约 **0.15%** 像素保留明显色差；修复后为 **100%**，网格与地表颜色可见。这是已定义测试区域与色差阈值的结果，不是任意真实影像的全局颜色保证。
- 轨道旧图由当前测试页仅对真实 ray/T pass 重放旧平面雾表达式得到，原 shader 参数和曝光保持一致；不混淆为另一套旧 SDK 的独立发布包。
- 通用 shader 检查与 16 组现有整链路场景也复测；SDK 已重建。具体记录见本轮 JSON 与最终 bundle manifest。

### 前后对照

| 场景 | 旧结果 | 修复结果 |
| --- | --- | --- |
| 白天地平线 | [before](atmosphere-horizon-wide-before-1100.png) | [after](atmosphere-horizon-after-1100.png) |
| 日落地平线 | [before](atmosphere-horizon-wide-before-1800.png) | [after](atmosphere-horizon-after-1800.png) |
| 轨道彩色地表 | [旧算法重放](atmosphere-orbit-before-1100.png) | [after](atmosphere-orbit-after-1100.png) |

### 复现工具

```powershell
$env:CESIUM_PLAYWRIGHT='C:/Users/Administrator/node_modules/playwright'
node scripts/performance/check-environment-fog.cjs
node scripts/performance/judge-environment-lut.cjs --horizon --label=after
node scripts/performance/judge-environment-lut.cjs --orbit --label=after
node scripts/performance/judge-environment-lut.cjs
```

证据：`atmosphere-horizon-after.json`、`atmosphere-orbit-after.json`、`p1-fog-check.json`、`environment-lut-integration.json`。`--planar` 只在验证工具中重放旧模型，不是产品实验开关。

## 精度与验收边界

16 段径向高度近似仍有精度边界：独立复核的完整掠射雾层、但不接触地表的有限射线样例，光学深度约低估 1.98%，最大透射率绝对差约 .00717。当前不把它等同于已穷尽所有雾参数/几何；这不影响已复现的错误地下高度饱和问题被消除。

新增了真实地平线和轨道视角，不能再用只有 50 km 远裁面的用例宣布全球验收。用户实际业务场景仍需最终视觉确认。本轮没有性能测试或未测得的提速声明。
