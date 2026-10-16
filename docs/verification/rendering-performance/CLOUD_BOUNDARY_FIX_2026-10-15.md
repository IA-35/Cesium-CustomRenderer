# 云影白边与距离截断修复 · 2026-10-15

用户已确认天空泛白修复通过。本轮只修改接收面法线与云/云影的距离过渡，不改变天空曝光、大气强度、天气覆盖率默认值或材质颜色。

## 复现与根因

1. 云影法线原来使用 `cross(dFdx(relativeSurface),dFdy(relativeSurface))`。硬件 2×2 像素组可能同时覆盖建筑与远处背景，使轮廓像素的法线偏向侧面；云影据此估计的直射光份额变小，建筑边缘残留亮线。新增真实 GPU 屋顶/背景深度阶跃用例在旧实现失败：屋顶法线 z 最小约 `0.089912`，预期应接近 1。
2. 云影接收距离超过 50 km 时直接返回无阴影，形成用户截图中的圆弧边界。可见云也只积分到质量档最大距离，尾部没有密度淡出。旧云影 GPU 扫描在 49–50 km 仍保持阴影乘数约 0.2。

## 修正

- 法线改为从中心和四邻域重建表面位置，每个轴选更接近当前表面的差分，避免跨越建筑/背景深度断层。保留正常的墙面、屋顶方向；不通过整体模糊模型或关闭云影去隐藏白边。
- 云影在距离范围最后 30% 平滑消失：35–50 km，smoothstep 两端斜率为零。只淡化接收影响，不截短太阳穿过云层的积分距离。
- 可见云与云距离数据共享光学密度淡出，最后 30% 范围内，辐射量趋向 0、透射率趋向 1。performance 为 21–30 km、balanced 为 28–40 km、high 为 35–50 km。天空和地表保留各自颜色，不用背景色盖住云层。

## 验证

- 嵌入语法检查通过：125 个文件。
- 完整自动化套件 933 项：930 通过、3 跳过、0 失败。
- 实际 WebGL2：三质量档编译/云光照/夜间/能量/时域测试通过；新增屋顶轮廓法线 z 最小为 1。
- 云影 GPU 距离扫描：49 km 乘数约 `0.989807`，50 km 为 1，连续趋向无阴影；三档视线密度衰减在 70% 距离为 1、85% 为 0.5、99% 约 0.00326、100% 及以外为 0。
- 实际 SDK 浏览器对照：本地 3D Tiles/白模，1200 m 俯视验证建筑边缘；18000 m 斜视、远裁面 100 km 验证远景圆弧。前后均有效单视锥、浮点输出有限、GL 错误 0、页面错误 0。人工检查同视角 PNG，原有亮边明显减少，圆弧硬边改为渐隐。
- 复跑 `judge-cloud-transport.cjs`：早/中/晚 × 云下/云中/云上/高空共 12 组，以及零云量恒等、云量变化、接收面云影开关、相机突跳/时间轴跳转和历史生命周期检查通过。
- SDK 已重建，`CCR.min.js` SHA-256：`aff26fb5ac79dd57c4dc9b7bc9561e09cdde8997cafa944c12499d6b98f429a3`。

证据：`p0-shader-check.json`、`cloud-boundary-before.json`、`cloud-boundary-after.json` 与对应 PNG。复现命令：

```powershell
$env:CESIUM_PLAYWRIGHT='C:/Users/Administrator/node_modules/playwright'
node scripts/performance/check-shader-compile.cjs
node scripts/performance/judge-cloud-boundaries.cjs --label=after
```

| 视角 | 修复前 | 修复后 |
| --- | --- | --- |
| 模型轮廓 | [before](cloud-boundary-before-tiles.png) | [after](cloud-boundary-after-tiles.png) |
| 远景截断 | [before](cloud-boundary-before-range.png) | [after](cloud-boundary-after-range.png) |

深度重建对亚像素/单像素几何仍有歧义，材质法线仍是更准确的信息源。本轮未改变既有单视锥范围、漫反射份额云影近似，也没有进行性能测量。
