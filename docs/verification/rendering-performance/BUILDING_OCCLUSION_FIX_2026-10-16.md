# 前景建筑对环境效果的遮挡修正 · 2026-10-16

用户反馈独立建筑像透视：云影和天际线亮带越过不透明墙面，怀疑云影导致。本次已在真实校园与独立不透明盒复现，并修正共享深度选择；开发验证通过，待用户确认。

## 根因和修正

Cesium 1.143 的 `Scene.js` 先执行 GLOBE、复制 packed globe depth，再对 3D Tiles 更新副本；独立 GLB 的 OPAQUE Pass 在之后执行，不再更新该副本。最终 postprocess 输入的 depth-stencil texture 包含后绘制的 OPAQUE 深度，HDR 传递链本身没有丢失它。

原 `environmentStages.js::sceneDistance` 只要发现有效 globe depth，就提前返回。真实建筑位于185.484米而 globe/Tiles 位于438.409米时，环境仍选择438.409米，楼后的一段大气与云影接收面被错误合成到楼体上。关闭云或雾都不会纠正这个深度错误，因此不应只降低云影强度或关闭大气。

生产修正仅在此共享函数：最终 scene depth 从 `.r` 读取、globe RGBA 从 `czm_unpackDepth` 读取，各自用现有 Cesium 坐标函数转换为米，再选择最近有效距离。保留两份深度，兼容地形深度被 Cesium 清除的路径。`shellEmptyScene` 和双 miss 继续返回20,000,000米 sentinel；`finiteSurface` 仍在解析地球裁剪之前由真实纹理命中判定。

该函数由云颜色、云距离、大气辐射、RGB透射率、全分辨率合成及介质遮挡共同使用，因此修正覆盖整个环境链路，不只改变 resolve 的云影颜色。没有修改模型材质、不透明度、曝光、光照参数或云形；没有新增生产纹理、Framebuffer、Pass 或 draw。

## 实际验证

真实 Chrome/RTX3070、Cesium1.143、1200×720、70个校园GLB及周边白模，固定11:00与同一相机。截图、GPU probe 使用启动时固定的SDK响应字节。

| 检查 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 真实楼前候选像素 | 268760 | 268760 |
| 其中错误深度 | 256827 | **0** |
| 中心实际scene距离 | 185.484 m | 185.484 m |
| 中心globe距离 | 438.409 m | 438.409 m |
| 中心最终选择 | 438.409 m | **185.484 m** |
| 不透明白盒mask | 197450 pixels | 197450 pixels |
| 白盒错误深度 | 91850 pixels | **0** |
| 白盒最大深度误差 | 59801.993 m | **0** |

before `--label=red --critical` 和完整before均以实际深度断言失败（预期RED）；生产修正后，完整after的7项环境开关对照全部通过：normal/cloudsOff/fogOff/envOff，以及 synthetic-normal/cloudsOff/envOff。五项启用环境的测试均无深度误选、无虚构过近命中、WebGL错误为0。两个envOff项只保存对照画面，不冒充HDR深度验证。

最终after正常场景295542个双 miss像素、不透明盒场景254846个双 miss像素，全部精确保留20,000,000米天空sentinel。GPU gate主要验证raw scene更近超过5米的候选；globe更近、辅助纹理缺失等回退由直接执行生产选择语句的单测覆盖。

地面云影继续存在：草地区域相同像素，cloudsOff的RGB为100/168/69，normal为36/79/40；屋面样本两者都是140/158/170。云开关前，pre-environment原生HDR最大亮度相同、均值差约5e-11。白盒外的云层与地面阴影保留，盒内原先穿出的远景亮带消失。

单测先RED后GREEN。全工作区 **1005项，1002通过、3跳过、0失败**；134文件GLSL嵌入语法、通用真实WebGL2 shader检查和SDK构建通过。独立只读复核未发现本次最小修正的阻断问题。

## 对照与身份

- [校园修复前](building-occlusion-before-normal.png) / [修复后](building-occlusion-after-normal.png)
- [不透明白盒并排对照](building-occlusion-synthetic-comparison.png)：左before、右after。
- [预期失败记录](building-occlusion-red.json)、[完整before](building-occlusion-before.json)、[完整after](building-occlusion-after.json)、[汇总](building-occlusion-summary.json)。

before SDK：`cc76afb2828f56600aafc54ac28788ca4fe719d99e59929739d44e5ef475e5ec`。

after SDK：`e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`。

该验证覆盖本轮不透明GLB/Primitive前景，alpha-test通过的片元也写入最终深度。OIT透明材质通常 `depthMask=false`，本次未新增透明前表面深度，不宣称玻璃的独立介质层次也已解决。既有单视锥、透视等运行门禁保留。没有测量或宣称修复后的性能收益；此前里程碑性能记录保留原SDK身份，续测须使用修复后的正确基线。

复现：`CESIUM_PLAYWRIGHT=C:/Users/Administrator/node_modules/playwright`，构建后运行 `node scripts/performance/judge-building-occlusion.cjs --label=after`。当前SDK加before标签不能生成历史错误画面。
