# 阶段一：HBAO、多尺度 HDR Bloom、球壳云层交接

日期：2026-09-14。项目 `G:/_JavaScript/_IAsCesiumLib/cesium customRenderer`。
分支：`codex/stage1-hbao-bloom-clouds`。本轮开发完成，未提交或推送；用户原有示例、assets、.vscode 修改保留。

## 已实现

1. **HBAO**：在 `setScreenSpaceAO` 新增 `algorithm:'ssao'|'hbao'`；8方向×8步记录最大地平线。复用现有 R32F 深度、几何法线、透明覆盖、保守未知判定、双边滤波及 HDR 合成。切换时释放旧阶段。默认仍为 SSAO，AO 总开关仍默认关闭。
2. **多尺度 HDR Bloom**：新增 `setHdrBloom` 和 `getHdrBloomDiagnostics`；软阈值、13-tap 降采样、归一化 tent 上采样、保留源 alpha 的线性合成。默认关闭，显式启用时与原生 Bloom 互斥；位于环境之后、TAA之前；不增加第二次曝光/gamma。支持局部参数更新、层数重建、resize、失败锁定、暂停和销毁。
3. **球壳云层**：`setOptions({cloudGeometry:'shell'})`；默认仍为 local。WGS84 椭球归一化后计算同心球壳，CPU 双精度径向高度与稳定二次方程避免近地大数消减。支持云下/云中/云上/高空以及两段云壳区间，地球与最近场景深度截断。无不透明视锥的纯天空帧单独处理，显式忽略旧深度。局部雾在区域外关闭。

球壳使用128/192步（balanced/high），半分辨率积分与深度引导合成，固定中点采样。发现噪声图集采样会在长积分中产生孤立亮点/细横纹，已在 shell 模式改为 texelFetch 的显式三线性插值；局部云算法保留。未通过模糊后处理掩盖条纹。

## 使用

```js
pipeline.setScreenSpaceAO({ enabled: true, algorithm: 'hbao', radius: 3, strength: 1 });
pipeline.setHdrBloom({ enabled: true, strength: 0.15, threshold: 1, knee: 0.5, levels: 5 });
pipeline.setOptions({ environment: true, clouds: true, cloudGeometry: 'shell' });

pipeline.getScreenSpaceAODiagnostics();
pipeline.getHdrBloomDiagnostics();
pipeline.environmentRenderer.getDiagnostics();

// 独立关闭/回退
pipeline.setScreenSpaceAO({ algorithm: 'ssao' });
pipeline.setHdrBloom({ enabled: false });
pipeline.setOptions({ cloudGeometry: 'local' });
```

免 token 本地对比页：`http://127.0.0.1:8877/examples/stage1.html`。
重启服务：`node scripts/dev-server.cjs --port 8877`。
页面使用少量标准 PBR 合成几何和地球底色，支持近景、仰望天空、云上、高空及效果切换。它不是校园业务资产的视觉验收。

## 本轮验证

- `npm test`：**384/384** 通过。
- `npm run build`：通过，UMD 统一 `CCR`，外置 Cesium 1.143。
- `scripts/check-stage1.cjs`：真实 Chrome WebGL2，源码和 UMD 场景均通过，无页面/渲染错误。
- GPU 数值：原 SSAO 17项，HBAO 17项，Bloom 8项，球壳求交8组与双精度参考一致（误差小于0.1米）；噪声12,288点最大误差 `0.0000012723948157322695`。
- 场景：源码29项、UMD29项；地面向下中性、向上见云、云中、云上向外中性、云上向地球见云、2,000km高空、赤道/80°纬度地面不穿云、联合 TAA、关闭释放和重启。
- 尺寸：801×603及1280×720；Bloom目标尺寸正确，SSAO/HBAO切换、SSR、SMAA、云与 Bloom 联合有效。
- 故障/生命周期：Node 覆盖独立 Bloom 实例/collection、参数边界、原生状态交接、绘制失败旁路/锁定/显式重试；实际场景覆盖启停释放。没有做显卡上下文丢失后自动恢复或完整校园业务验收。

证据（本地忽略，不自动入 Git）：

- `docs/verification/stage1-tests.log`
- `docs/verification/stage1-build.log`
- `docs/verification/stage1-gpu.json`
- `docs/verification/stage1-combined.png`
- `docs/verification/stage1-shell-sky.png`

GPU耗时在1280×720、headless Chrome、少量合成物体近景、固定相机下采样100帧。该镜头主要看地面，云层多数被深度截断，不能拿 environment 耗时代表仰望天空/高空云性能；各pass轮换计时，不能相加当作整帧。本次不宣称校园帧率达标。

## 产物

`build/0.1.0/CCR.min.js`：292,835字节，gzip 100,292字节（包含下述天际线渐隐调整）。
SHA-256：`85f575e3fd6956aed2e087fe6086b239ae7c59d1ce1a28b4c124c74ca9ec6936`。
构建目录同时包含使用说明、示例、manifest及算法参考；版本仍为0.1.0开发快照，没有创建新tag或GitHub Release。

## 明确边界与后续

2026-09-15更新：取消下面历史记录中的高空范围扩展。shell现在所有高度固定12–50km渐隐和积分上限；100km及2,000km相机向地球观察时，超出范围的云层不再绘制。原高空保留测试已改为验证高空范围受限。

2026-09-14 天际线画质调整：用户反馈远景碎云过密，新增近地12–50km平滑衰减，覆盖率和消光密度一起降低；按镜头离云层的距离扩展淡出范围，保留高空云层。新增 GPU 检查近景不衰减、远景渐隐和高空保留；截图见 `docs/verification/cloud-horizon-before.png` 与 `cloud-horizon-after.png`。384项Node测试与源码/UMD联合回归继续通过。

- 球壳高度为椭球归一化空间的米制径向偏移，与严格测地高度有小量差异；多视锥仍回退原生环境，没有完整全球深度融合、气象级云细节或云投地阴影。
- 雾仍为局部效果；BLEND/OIT与环境的分层深度问题沿用既有边界。
- HBAO仍是屏幕空间非自发光颜色调制，没有把间接照明单独分离。MASK/UNLIT/未知材质继续保守处理。
- Bloom不应与外部原生Bloom同时计算；外部接管原生状态时新pass旁路。阈值是曝光前HDR数值。
- 植物与多光源继续暂缓。完整延迟PBR、对象遮挡反馈、5000光源性能目标没有因本轮完成而自动达成。
- 下一轮最有价值的是使用实际校园资产，对固定镜头的接触遮蔽、高光和云形做参数/画质验收，再制定下一项架构开发任务。
