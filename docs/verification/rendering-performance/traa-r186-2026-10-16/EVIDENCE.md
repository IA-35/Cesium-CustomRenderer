> 历史阶段记录：以下是原样r186移植及其失败诊断，已被用户授权的采样/历史适配取代。当前构建与结论请读[ADAPTATION.md](ADAPTATION.md)和[STATUS.md](STATUS.md)，不要将下方“最终UMD”当作当前版本。

# TRAA r186 实机验收记录

本目录保存测具输出和阶段诊断。脚本正常退出仅表示完成采样，**不表示画质或生产验收通过**。当前最终 UMD 的窗格时间稳定性仍弱于回退基线。

## 固定输入和复现

- 回退 SDK 只读取系统临时目录 `ccr-traa-r186-baseline/CCR.min.js`，SHA256 `e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`，启动时强制核对。
- 最终 UMD：`6d4c47a5f901ff4a1816a76aea4eadfa0d4d89fd5427080ba19f4c50ba0e824a`。每次运行一次性读取并通过 Playwright 路由供应固定字节；后续重新 build 不会改变该次测量。
- 默认源码模式会固定读取整个 `src` JavaScript 模块集合，逐文件 SHA256 保存在报告中。测具和页面也记录 SHA256；最新测具同时固定供应 fixture HTML/JS。
- Chrome、ANGLE D3D11、NVIDIA GeForce RTX 3070、WebGL2。固定 viewport / drawing buffer 为 640×420，设备缩放 1。
- 几何夹具复用 `deferred-transparency-fixture.js` 的 `planeGlb`；使用真实 GLTF 窗格横竖线、细栏杆、移动平面、MASK 和 CustomShader 不支持前景。固定相机、方向光和时钟。

```powershell
node scripts/performance/validate-traa-r186.cjs --baseline
node scripts/performance/validate-traa-r186.cjs --bundle --label umd-static --case static
node scripts/performance/validate-traa-r186.cjs --bundle --label umd-resolve-motion --motion-only --samples 32
node scripts/performance/validate-traa-r186.cjs --bundle --campus --label umd-campus
node scripts/performance/validate-traa-r186.cjs --bundle --campus --performance --label umd-campus-performance
node scripts/performance/validate-traa-r186.cjs --baseline --campus --performance --label baseline-campus-performance
```

不带 `--baseline/--bundle` 时使用当前源码。`--bundle <path>` 可显式指定本次构建。所有输出均位于本目录下的对应 label 子目录。

## 静止时间序列

预热至少 128 帧，随后采集完整 128 帧；保存前 32 帧逐相位 PNG 和后续关键帧。ROI 包含窗格及轮廓，不只挑选平坦像素。使用显示输出的 0–255 亮度计算每像素时间标准差；边缘以首帧邻域亮度差大于 8、半径 2 的掩码识别。同时保留全部像素、平坦像素和边缘的 mean / p95 / max，以及每帧 ROI 对比度、相位、reset、newSurfaces。

| 静止几何夹具 | 窗格 edge mean std | 窗格 edge p95 std | 栏杆 edge mean std | 栏杆 edge p95 std |
| --- | ---: | ---: | ---: | ---: |
| baseline 8 相位 | 0.262740 | 0.918632 | 0.522348 | 3.195937 |
| 最终 UMD 8 相位 | 0.786277 | 3.729170 | 1.091062 | 5.630006 |
| 最终 UMD 32 相位 | 1.234415 | 6.439781 | 1.403250 | 6.705922 |

最终 UMD 8 相位的 128 帧中 `newSurfaces=0`、`motion.draws=0`。可重复的时间变化仍然存在。当前数据不能支持“窗格闪烁已消除”。

`baseline-8` 与最终 `umd-quality` 保留慢平移、停止、慢转动、停止、移动/消失后背景显露的完整 128 帧时序；最终 UMD 8/32 相位分别采样。早期 source 运动画质不作为最终版本验收依据。运动图像和时序可用于人工核对重影，单一 temporal std 不足以证明无重影。

## 真实校园

初始 URL 保留默认 traffic / trees / water / clouds，仅 `imagery=none` 固定外部影像网络，`singleFrustum=1` 为明确的支持范围。地形和 GLB 均来自 localhost:8083/Dongda，GLB 路径为 DongdaModel_PBR/SM_NH。

基线及最终 UMD 均实际等待 70 建筑 GLB、60 辆原生独立 `Cesium.Model`、720 株树和 2 处水面 ready。草地默认初始化段在示例中已注释，未宣称草地运行。时钟冻结，车流 `performance.now` 继续推进；基线 traffic 时间序列 elapsedSeconds 从 4.6283 推进至 7.4285。相机在 trafficReady 后固定，先用 lookAtTraffic(125)，再固定建筑近景。

| 校园视图 | 基线 edge mean / p95 std | 最终 UMD edge mean / p95 std |
| --- | ---: | ---: |
| traffic 125m | 0.416656 / 0.713802 | 1.092924 / 3.398961 |
| building 窗格 | 0.312662 / 0.704097 | 1.113348 / 3.714095 |

每个视图保存 128 帧 JSON 和 32 个相位 PNG。默认云历史、运动汽车、相机加载时间会影响场景时间变化，不能将全图变化全部归因于 TAA。固定几何夹具提供独立的窗格回退证据。另补 45m 接近俯视的汽车镜头，专门观察汽车轮廓及车辆移走后背景。

## 实际速度纹理和 resolve

`umd-resolve-motion` 从实际 RGBA32F 读取 `(currentNDC-previousNDC).xy, currentEyeDepth, previousEyeDepth`，并用实际提交的 primitive 矩阵、C.Matrix4 CPU 投影对照三个表面点及不同相位。移动平移、旋转、纯 Z、相机和物体同时移动，raw xy 最大误差小于 3.4e-8，z/w 最大误差小于 2.3e-5。

`umd-transform-oracle` 还用测具已知的当前/上一帧动画 modelMatrix 与 camera.viewMatrix 独立检查提交矩阵，不只验证 GPU 对传入 uniform 的算术。相机和物体同时移动的最大矩阵差为 1.8627e-9，其余场景为 0；该运行所有 resolve 接受判定 mismatch=0。

另执行一份**原生产 resolve shader** 的诊断输出，只把计算完的 velocityNDC、visibleMotion、closestEyeDepth 写入额外 RGBA32F，不替换判定逻辑。静止遮挡物、unsupported CustomShader 前景和 MASK 洞采用最终深度与 3×3 closest-depth 规则比对。最终报告各场景接受判定 mismatch 均为 0：静止前景拒绝后景残余速度，MASK 孔中保留可见后景速度。相机单独运动、GLB 静止时辅助 draw 为 0。启停、出现、消失和新表面事件记录在逐帧 summaries 中。

旋转 / 纯 Z 的 resolve 速度来自 3×3 邻近表面像素，和中央 CPU 点可以产生约 1.9e-5 / 2.8e-6 的速度差；raw texture 的 CPU 点对照更精确。没有把该邻域差误称为矩阵投影误差。

## 性能口径

每次 300 帧、3 轮，frame / AA / motion 按帧轮换 EXT_disjoint_timer_query_webgl2，避免嵌套 TIME_ELAPSED。性能轮不 readPixels。CPU 值是 viewer.render 的提交用时，包含该帧其他 CPU 渲染工作。GPU motion 对每个辅助 draw 分别查询，再按帧相加；不把首个 draw 当全部 draw，也不把此数值叫包含 begin/clear 的整段 motion pass。

| 真实校园 | GPU AA median / p95 ms | GPU frame median / p95 ms | CPU 提交 median / p95 ms |
| --- | ---: | ---: | ---: |
| baseline 8 | 0.118784 / 0.122880 | 4.818944 / 13.849600 | 9.90 / 16.40 |
| 最终 UMD 32 | 0.084992 / 0.093184 | 5.639168 / 16.559104 | 10.50 / 19.10 |

两次查询均 disjoint=0、unavailable=0；AA 与 frame 每个 scope 各 300 个有效查询。最终 UMD 的 300 个 motion 采样帧中，164 帧有 1–8 个辅助 draw，其余无 draw。只对这些非零帧的 draw 总和计算，median=0.008192ms、p95=0.123904ms。该运行中车流离开固定视野，不能用非零子集数值替代整个采样分布。后续测具显式记录零 draw 帧。

AA 解析段的 GPU 数值下降；全帧与 CPU 数值上升。真实车辆 / 云历史并非逐帧完全相同的负载，不能从全帧差值分离出单一原因。

最终 `umd-fixture-performance` 另外单独采 8/32 相位，各 300×3 帧。8 相位 GPU AA median/p95 为 0.056320/0.061440ms，32 为 0.069632/0.070656ms；两档辅助 draw 总和均为 0.012288/0.013312ms，各 300 个采样帧，每帧一个实际移动 draw。两档 CPU 提交 median/p95 分别为 1.50/2.80ms、1.70/2.60ms，disjoint=0、unavailable=0。全帧查询也保存于 JSON，但两档顺序采样的全帧差异明显，不能只用该差值归因相位数或证明性能改善。

字节口径：旧 baseline 的 diagnostics.bytes 只报 5,376,000，但实测另有 4 张 RHI history 纹理，共 6,451,200。两者相加 AA 为 11,827,200，与最终 UMD 的 stage+RHI 相同；最终 UMD 另有 4,300,800 motion，总 16,128,000。不能用旧报告少计的 bytes 直接证明全部增长。

## 生命周期与阶段诊断

最终 UMD 实测 AA 关闭/重开、pipeline 暂停/恢复、704×462 resize/恢复均可恢复有效输出。远平面与更小 log-depth far-to-near 比生成实际 2 个 frusta，TAA 返回 Requires single-frustum depth；移除远平面并恢复设置后再次有效。destroy 后 motion texture 已释放，programs/aliases 为 0。gl.getTexParameter 读取的真实 historyColor MIN/MAG=LINEAR，historyDepth=NEAREST。

hover / pick / selection / Label / Billboard 的独立检查由 `scripts/check-taa-silhouette.cjs` 负责，本测具不重复覆盖。

阶段纠正保留：

- `harness-precheck-wrong-label` 原标 8 相位实际为 32，不可用作 8 相位比较。
- 早期 `source` 的静止 frame28–36 有新 GLTF 命令引起的局部 invalid，不能全部归因物体运动。最终稳定 primitive 身份版本静止采样没有该事件。
- `source-motion` 直接要求遮挡区域 raw texture 清零的假设被撤回；生产 resolve 会用最终深度拒绝被遮挡速度。
- `source-resolve-motion` 的 5 个 MASK 边界 mismatch 来自 CPU 原按单像素分类，最终按独立 3×3 覆盖分类后 mismatch 为 0。
- cameraNearFar 的 root/draw 隔离实验记录在两个 domain 子目录；相同额外 reset/预热后两组静止结果接近，不能把额外预热带来的改善直接归因深度域修复。
