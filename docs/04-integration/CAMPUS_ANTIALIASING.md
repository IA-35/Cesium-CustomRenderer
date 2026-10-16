# 校园场景空间抗锯齿改进与配置

2026-09-15，基准为用户新增的 `examples/campus.html`。本轮只改进 FXAA、SMAA、MSAA 使用策略与校园面板，TAA shader、相机抖动和历史实现没有修改。

## 推荐配置

| 方案 | 配置 | 观感与用途 | 成本和限制 |
| --- | --- | --- | --- |
| 轻量 FXAA | mode:fxaa，quality:sharp，MSAA1 | 保留更多细纹理，减轻明显锯齿；适合交互流畅优先 | 一个颜色过滤阶段；仍可能软化细线，运动中没有时间积累 |
| FXAA 均衡/平滑 | mode:fxaa，quality:balanced/smooth | 降低暗部/低对比边缘阈值；平滑档更积极处理亚像素细边 | 比清晰档更柔和，可能损失纹理对比度 |
| **SMAA 均衡（默认）** | mode:smaa，quality:balanced，MSAA1 | 补足白墙/屋檐低对比边缘，保留窗框与纹理；日常推荐 | 三阶段；不能恢复几何亚像素覆盖，也不是时间抗锯齿 |
| SMAA 平滑 | mode:smaa，quality:smooth，MSAA1 | 更低边缘阈值和更长搜索，更积极处理连续边缘 | 纹理也可能被识别为边缘；不是完整 SMAA Ultra/对角线扩展 |
| 仅 MSAA4 | mode:msaa，msaaSamples:4 | 主要改善真实几何轮廓；不对整幅贴图做额外平滑 | 显存/带宽与场景绘制成本增加，不能单独解决着色、SSR、阴影和纹理内的锯齿 |
| 仅 MSAA8 | mode:msaa，msaaSamples:8 | 更多几何覆盖采样 | 必须由HDR颜色与深度格式共同支持；不一定比4×明显改善 |
| **SMAA＋MSAA4** | mode:smaa，quality:balanced，msaaSamples:4，msaaCombine:true | 校园屋檐、模型边线、道路斜线更平滑；质量优先推荐 | 比纯后处理明显更贵；按实际GPU预算选择 |
| 关闭 | mode:off | 原始锯齿对照 | 请求样本保留，但实际MSAA为1且空间AA关闭 |

```js
// 日常校园场景
campus.pipeline.setAntiAliasing({ mode: 'smaa', quality: 'balanced', msaaSamples: 1, msaaCombine: false });

// 画质优先，明确要求组合
campus.pipeline.setAntiAliasing({ mode: 'smaa', quality: 'balanced', msaaSamples: 4, msaaCombine: true });

// 更轻量
campus.pipeline.setAntiAliasing({ mode: 'fxaa', quality: 'sharp', msaaSamples: 1, msaaCombine: false });

// 仅几何多重采样；省略样本且原请求为1时，自动改为4
campus.pipeline.setAntiAliasing({ mode: 'msaa' });

// 读取实际状态
campus.pipeline.getRenderDiagnostics().antiAliasing;
```

`quality`只控制FXAA/SMAA；存入options.spatialAaQuality，并通过diagnostics.antiAliasing.quality与postProcess.settings返回。原getAntiAliasing四字段结构保留兼容性。显式msaaSamples:1仍表示1；切换到SMAA/FXAA时若未允许组合，MSAA请求继续按策略降为1。TAA原有行为保留。

## 具体变化与来源

参考 Tianjing `SMAAEffectPass.js` 采用颜色边缘阈值0.05、搜索8步；原CCR颜色阈值0.1、搜索8步。保留既有三阶段与配套查找表，新增质量档：

| quality | SMAA阈值 | SMAA搜索步数 | FXAA subpix | FXAA相对阈值 | FXAA最低阈值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| sharp | 0.1 | 8 | 0.25 | 0.125 | 0.0625 |
| balanced | 0.05 | 8 | 0.5 | 0.0833 | 0.0312 |
| smooth | 0.035 | 16 | 0.75 | 0.063 | 0.0156 |

Tianjing FXAA实际调用Cesium原生createFXAAStage；本轮没有把它误当另一套算法。CCR复用当前Cesium发行版的FXAA 3.11 shader，保持其quality preset39，调整阈值/subpix，并在现有最终显示颜色挂接点执行，使用实际输入纹理尺寸。原生FXAA仍作为加载/失败及TAA既有回退路径，不修改它的shader。

SmaaPass143保留原公开类；已验证的执行、FXAA回退、异步代际取消和资源清理提取为SpatialAaPass143，由SMAA与FXAA共用。新FXAA单pass不加载SMAA纹理；两者均在HDR/tonemap/调色之后执行，保持alpha，无时间历史。质量改变重建自有阶段，不改变材质或模型。

修正MSAA单独模式可能继承1样本的问题。继续查询实际HDR颜色与深度支持的采样数，显示已分配renderbuffer样本，不用下拉框值冒充实际生效值。参考示例常叠加4×MSAA与后处理，当前保留为显式质量选项，不再断言两者组合必然没有收益。

## 校园对比证据

固定1280×720、同一校园镜头、2026-09-08 03:00 UTC、关闭环境动画，模型与周边白模均来自campus页本地资源。为消除远端影像加载波动，数值/截图对比使用 `?imagery=none`，未改校园页默认影像。测试时禁用交互/碰撞调镜，等待瓦片加载完成。

修改前后off截图逐通道平均绝对差为0，确保对比基线一致。截图包含窗口、屋檐、道路与植被，局部2倍放大对比为 `docs/verification/campus-aa-comparison.png`。观察：SMAA均衡相较原版补充低对比边缘；组合MSAA4对几何覆盖更平滑；FXAA平滑档更柔和。没有宣称所有细线、叶片及运动闪烁全部消失。

GPU合成夹具：0.075对比度边缘，原SMAA检测0个，均衡检测92个；新FXAA生成72个过渡像素，alpha保留、平坦颜色保持、输出有限。此夹具验证阈值/颜色正确性，不作为全场景画质分数。

校园每档预热30帧、短采样80帧，headless Chrome。记录的是整帧GPU耗时，非单独AA耗时；不是前台性能验收。如下为本次中位数，近似耗时不能用于给相差零点几毫秒的方案排序：

| 配置 | 整帧GPU P50(ms) | 实际MSAA |
| --- | ---: | ---: |
| off | 9.07 | 1 |
| FXAA sharp / balanced / smooth | 10.49 / 9.03 / 9.61 | 1 |
| SMAA sharp / balanced / smooth | 9.45 / 9.57 / 9.35 | 1 |
| MSAA4 | 16.03 | 4 |
| MSAA8 | 16.40 | 8 |
| SMAA balanced + MSAA4 | 15.87 | 4 |

本轮不沿用旧文档中未锁定前台/相机条件的P95结论，也不把一次短采样当作正式30/60FPS验收。

## 验证和复现

- Node：最终工作区392项通过。
- 校园十档静态运行，加载状态/相机/时间/画布检查通过，错误0。
- 校园生命周期：质量切换释放、FXAA→SMAA、移动SMAA、TAA→FXAA、关闭恢复、实际4×分配、801×603 resize通过。
- GPU低对比边缘/alpha/平面数值5项通过；原阶段一源码与UMD组合另跑回归。
- 阶段一源码/UMD联合回归复跑通过。首次运行在2,000km云层覆盖断言失败，单独用FXAA/off/SMAA复测均正常，再次完整执行通过；未改云层逻辑，也未把这一次失败隐藏为稳定性能证据，云层加载/切镜时序仍需跟踪。
- TaaPass143.js、TaaJitter143.js、taaShaders143.js、FrustumJitterBridge143.js本轮无差异。

服务：`node scripts/dev-server.cjs --port 8877`。运行 `node scripts/check-campus-aa.cjs after`、`node scripts/check-campus-aa-lifecycle.cjs` 和 `node scripts/check-stage1.cjs`；CESIUM_PLAYWRIGHT 指向已安装Playwright。报告位于docs/verification/campus-aa-after/report.json与campus-aa-lifecycle.json，均本地忽略。

本轮没有新建另一套校园数据或替换campus页面；原有天空、阴影、SSR及TAA控件保留。修改尚未提交或推送。

构建产物：`build/0.1.0/CCR.min.js`，298,301字节，gzip101,816字节，SHA256 `8d84c204c06eb6834e36eb963d4bb9c21dbc2e52e2758ce9db4e3d658aad53f5`。构建目录与zip已更新。过程中环境模块有其他工作区更新，已保留；本页性能表记录的是对比采样时点，不用于断言这些后续环境变更的性能。
