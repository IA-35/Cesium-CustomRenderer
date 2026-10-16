# 大气分层与云传输验证 · 2026-10-15

本轮为视觉、数学与生命周期验收，不是性能报告。基于工作区实现与 SDK 的真实 Chrome/WebGL2 输出；没有提交、推送或更改分支。

## 大气分层的根因

球面未命中时返回 `(1e9,-1e9)`。旧太阳透射函数只检查 `ground.x>0`，把未命中也视为地球遮挡。在视线的不同积分节点上，太阳光突然从非零变成零，形成早晚宽色带。当前检查根区间有效性后才判断遮挡。

新增 GPU 用例使用 12 km 相机、太阳高度正弦 0.02 和朝天射线。修正前该用例在 performance 档直接失败（散射为零）；修正后三档都有有限非零输出，实际值见 `p0-shader-check.json`。全局曝光和当前大气强度基值未因这个修复而改变。

旧透射编码的光学深度阶距为 `16/254`，相邻透射层相差约 6.1%。现在生产路径独立输出 FLOAT RGB T，先分别重建辐射量与透射率，再计算 `L + surface*T`。packed alpha 只用于兼容旧诊断，不参与生产透射重建。

## 接入的真实路径

1. 云颜色 RGB / 标量 T，以及同密度同抖动的加权云距离/T 分别生成。
2. 云独立历史执行相机相对坐标重投影、主体材质位移补偿、3×3 RGB 方差裁剪、T 邻域 min/max 裁剪及云距离/T 拒绝。
3. 大气对云前/后段积分；RGB 透射率单独保留精度；重建后与原始线性 HDR 场景合成。
4. 接收面云影沿太阳方向采样同一密度场。天空/无效深度/超过 50 km 接收距离排除；估计的天空份额保持照明，alpha 不变。

天气密度、高度曲线、形状/细节侵蚀、太阳/天空/地面反弹、多散射与 powder 的固定来源及差异见 [传输移植说明](../../../src/environment/reference/three-clouds/TRANSPORT_PORT.md)。天气、主体和细节采用独立周期偏移，历史位移不回绕，覆盖原 8,000/32,000 秒跳变回归。

## 已执行的检查

- `check-glsl-embedding.cjs`：125 个源文件可解析，无保留 GLSL 修饰符。
- `check-shader-compile.cjs`：三档实际编译、原版数值对照、早晚未命中地球、太阳云光照/夜间遮挡/能量上界、精确 RGB T 合成、历史接受/距离拒绝、调色恒等与边界检查。
- GPU 检查发现完整时域 shader 的 T 二阶矩异常，独立同函数却正确，具体驱动原因未确定。改为 RGB 方差裁剪与独立 T min/max 后，常量 T=0.4 保持为 0.4。接受历史输出约 `[.683712,.683712,.683712,.4]`，距离拒绝输出 `[.5,.5,.5,.4]`，不是仅编译通过。
- `judge-cloud-transport.cjs`：实际 SDK，05:30/11:00/18:00 × 云下 300 m、云中 2,200 m、云上 3,500 m、高空 12,000 m，共 12 组；中间纹理有限，颜色/距离通道的 T 一致，无页面错误。样本固定本地地形/白模资产与 50 km 单视锥，不代表真实校园全部材质、设备或多视锥场景已验收。
- 云量 0 时占用比例 0、T=1；0.42 与 0.9 时样本占用比例约 .828 与 .845，密度也增强。这个占用比例是当前相机射线命中率，不等于世界面积云量。
- 独立只关闭 resolve 的接收面云影，保持可见云、大气与相机不变：HDR 最大差约 .28118、alpha 差 0、GL 错误 0，证明云影已实际应用于接收面。它不是材质分离准确性的证明。
- 小移动历史年龄继续增长；1 km 相机突跳与 1 小时时间轴跳转都从 age=1 重新开始。分辨率/质量/关闭/销毁与失败恢复另有自动化测试。
- 完整自动化套件 932 项：929 通过、3 跳过、0 失败。另有三档真实 GPU 与 12 组浏览器输出验收；这些不等同于所有设备与用户场景的最终视觉审美验收。
- 最终 SDK 已重建，`CCR.min.js` SHA-256：`6d1538c897411f845f73cbf56cc432b41fd573af492943dd76463ac078cb8ee8`。

复现命令：

```powershell
$env:CESIUM_PLAYWRIGHT='C:/Users/Administrator/node_modules/playwright'
node scripts/check-glsl-embedding.cjs
node scripts/performance/check-shader-compile.cjs
node scripts/performance/judge-cloud-transport.cjs
node scripts/performance/judge-atmosphere-exposure.cjs --label=band-fixed --times=0530,1100,1800 --altitude=12000 --views=sun-horizon
```

证据：`cloud-transport-acceptance.json`、`p0-shader-check.json`、`p0-exposure-band-fixed.json` 和对应 PNG。相机/云运动仍需更长序列、更多用户场景检验，不能由单帧证明完全无拖影。

## 明确未实现的上游部分

本轮不是完整 three-geospatial 渲染器等价移植：仍使用解析大气与代表性天空辐照度；完整 Bruneton LUT/四层天气/真实地表反照率反馈/级联 Beer 云影图/STBN/16 帧交错升采样未接入。当前云影在合并 HDR 上估计漫反射份额，不能精确保留混合其中的自发光与镜面分量。单视锥深度门槛继续保留；没有测量 GPU 耗时、显存峰值或帧时间收益。
