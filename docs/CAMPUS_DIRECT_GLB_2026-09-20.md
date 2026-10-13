# 校园示例直接加载 SM_NH GLB

`examples/campus.html` 默认建筑数据已改为用户指定目录 `G:/ZN/nginx-1.26.3/html/DongdaBuilding_mobile/SM_NH` 中的 70 个 GLB，通过 `Cesium.Model.fromGltfAsync` 加载。

全部建筑共用用户指定的 ENU：纬度 **41.761969**、经度 **123.410315**、椭球高度 **0 米**。保留 GLB 节点内部变换，不逐栋重定位，也不使用先前试算的配准矩阵。清单及原点在 `examples/campus-glb-manifest.json`。

后续按用户校正，全部 GLB 在该 ENU 下统一绕竖直轴顺时针旋转 **90°**（北向转为东向），由清单的 `headingDegrees: 90` 控制；地理原点不变。下述性能数据采集于此次方向校正之前。

目录只有建筑，原地形与周边白模保留，现有树木和草地配置保留。`?models=tiles` 恢复旧建筑 Tiles，方便同场景对照。`?glbAssets=<URL>` 可替换 GLB 服务根地址。

本机现有 8083 服务对 `/DongdaBuilding_mobile/SM_NH/...` 返回 502，因此示例开发服务器将 `/campus-mobile-glb/<文件名>.glb` 映射到指定目录，仅读取文件，不复制或改写源 GLB。换机器可设置 `CCR_CAMPUS_GLB_DIR`，或指定可用的 `glbAssets` HTTP 地址。默认运行 `node scripts/dev-server.cjs --port 8877` 后访问 `/examples/campus.html`。

## 实测

Chrome headless、RTX 3070、1912×956、SMAA，保持相同 CCR 选项、720 株树、6318 簇草、地形、周边白模、时间与 180 帧旋转轨迹；影像在两组均关闭。SDK 哈希全程一致，原始 Tiles 一轮、GLB 两轮，均无页面/渲染错误和资源 404。70 个 GLB 全部就绪后才开始采样。

| 指标 | 原始建筑 Tiles | GLB 第 1 轮 | GLB 第 2 轮 |
| --- | ---: | ---: | ---: |
| 平均 FPS | 45.79 | 60.00 | 60.00 |
| CPU 中位 | 20.7ms | 11.8ms | 12.4ms |
| GPU 中位 | 18.14ms | 13.29ms | 13.74ms |
| 实际绘制 / 帧中位 | 2199 | 1532 | 1532 |
| 建筑＋地形逻辑资源量 | 1232.0 MiB | 286.8 MiB | 286.8 MiB |

资源量是 Model/Tiles 的逻辑几何与纹理统计，不含植被、周边白模、后处理目标、驱动副本或进程内存。新的建筑文件共 904633 个三角形、506 个 primitive、81261160 字节。

这是**更换建筑数据和加载方式的组合对照**，不能将收益全部归因于 GLB 接口，也不能外推为业务页面或 16GB 笔记本验收。GPU P95 仍存在超过帧预算的样本，短测约 60 FPS 不等于所有操作都稳定 60 FPS。

## 已知画面差异

发黑已修复：逐个读取源 GLB，清单记录 420 个省略 metallicFactor 且没有 metallicRoughnessTexture 的传统建筑材质槽。加载回调仅将这些槽的默认金属度改为 0；明确指定的金属度、金属度贴图、基础颜色、粗糙度、透明与双面设置保持原样。兼容仅作用于本示例，不修改源 GLB 或通用 CCR 管线。

Cesium 在调用 gltfCallback 前会补齐默认值，因此不能在回调里用 `metallicFactor === undefined` 识别来源。回归测试覆盖已经被补成 1 的情况，并验证显式金属材质不被覆盖。70 个模型真实加载通过、0 页面/场景错误，截图已确认建筑恢复颜色。相关测试 4 项通过；图像证据为 `docs/verification/campus-mobile-glb/material-fixed-final.png`。上面的性能数据采集于材质修复前，不当作修复后的新实测。

验证：相关 3 项测试、脚本语法检查、真实 70 GLB 加载、统一相机性能对照通过。现有草地代码块与修改前副本一致。没有重建或覆盖其他会话正在修改的 CCR SDK，也未提交推送。

原始性能数据与截图：`docs/verification/campus-mobile-glb/comparison.json`、`glb-enu.png`、`tiles-enu.png`。复现：设置 `CESIUM_PLAYWRIGHT` 后运行 `node scripts/check-campus-glb.cjs`。
