# 建筑总览合批实验工具

这是性能验证工具，**不是原分层模型的直接替换器，也不是已完成的 LOD 生成器**。业务默认资源尚未接入。性能结果、失败实验及后续方案见 `../../docs/TILESET_PERFORMANCE_2026-09-19.md`。

在本目录运行 `npm ci --ignore-scripts`、`npm test`。依赖版本由本目录 lockfile 固定；Cesium 数学类型复用 CCR 根目录已安装的 `cesium@1.143.0` CommonJS 包。工具依赖不会加入 CCR SDK。

```powershell
node overview.mjs <原始tileset.json> <尚不存在的输出目录>
node overview.mjs <原始tileset.json> <另一个输出目录> --compact
```

默认只合并兼容材质并转换坐标，不简化三角形、不重编码压缩几何；GLB 可能明显变大。`--compact` 对位置/法线做 16 位量化并使用 Meshopt 编码，保留 UV、颜色和 feature ID；该模式有精度变化，需另行验收近景。

输出 `tileset.json`、`overview.glb`、`report.json`；报告记录每份输入的 SHA-256、primitive/三角形计数、兼容修正次数和输出大小。源文件不修改，输出目录必须不存在，内容引用不得越出源目录。遇到不支持的内容时停止；不把未支持扩展静默删除。

当前范围：本地相对引用、球形/盒形根包围体、静态单场景 GLB、OPAQUE/MASK、一个显式 `_FEATURE_ID_0` 与字符串属性表。没有支持 BLEND、动画、骨骼、实例化、隐式瓦片、多内容、区域根包围体、数字/数组属性、已有内容 LOD。也未验证任意非刚性变换或其他导出器。

总览中的原始属性保留，另有 `ccrSource`、`ccrFloor`。原始 `id` 可能跨文件重复，交互映射需结合建筑和来源。合批不保留可单独移动的楼层节点，展开时必须切换回原始分层资源。

业务测量脚本为根目录 `scripts/check-business-tiles-cost.cjs`。设置 `CCR_HOST_ROOT` 为业务前端目录、`CESIUM_PLAYWRIGHT` 为 Playwright 位置，确保业务服务运行；默认复用其现有 MainMap/API 测试夹具。

可选 `CCR_OVERVIEW_ROOT` 指向本机生成副本的集合目录，`CCR_TEST_URL` 指向 CCR 静态服务（默认 `http://127.0.0.1:8894`），只在测试浏览器中替换请求。生成目录应在 CCR 工作区内。`CCR_CASES=all,all-repeat` 用于候选与基线对照；不配置则含诊断删减子项。`CCR_RUN_LABEL` 用于保留各次报告，`--profile` 为诊断增加 CPU profile，其开销不能混入正式对比。

通用转换器不包含校园名称或业务路径；`check-business-tiles-cost.cjs` 是明确针对当前业务的测试适配器，不是渲染管线默认行为。
