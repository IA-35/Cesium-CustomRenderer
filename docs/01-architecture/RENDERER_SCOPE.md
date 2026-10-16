# CCR通用渲染范围与验证原则

2026-09-15，按用户最新要求纠正阶段一计划。CCR面向通用Cesium场景，不以任何校园、城市、资产包或影像服务定义核心行为。

## 1. 运行边界

- src只依据Cesium对象类型、实际材质、GPU能力、相机与地理数据工作；不得按资产文件名、项目URL或固定校区坐标修改材质。
- 旧校园的IBL降镜面因子与树叶alpha cutoff修正已迁到examples/compat，由campus.js显式启用，不进入SDK。
- setCampusOrigin、campus_* uniform等是历史命名。环境参考点接受任意ECEF位置，阴影由相机自动覆盖；本次保留命名兼容，不把批量重命名误作通用化。
- 通用目标不意味着当前所有Cesium类型均已接管。标准PBR、透明、Globe、Primitive、实例化/蒙皮及不支持类型必须分别建立支持矩阵，不能用单个场景成功概括全部能力。

## 2. 验证层次

| 层次 | 内容 | 判定作用 |
| --- | --- | --- |
| 算法/资源契约 | 已有AO、SSR、Bloom、深度、UBO、AA数值与生命周期夹具 | 验证输入输出和资源正确性 |
| 通用合成场景 | 程序生成几何/PBR、自发光、透明、深度/拾取；MRT/multipass/MSAA/多视锥等 | B00默认基准与核心能力验收 |
| 地理位置回归 | 赤道、南半球高程、高纬度；地面/云中/云上/高空等 | 验证坐标、环境与相机适用范围 |
| 可选真实资产集成 | 校园或其他独立工程，由各自的场景适配器提供资产、位置及加载契约 | 揭示实际资产兼容性，不限定CCR架构与默认配置 |

固定测试输入用于复现，不能进入生产管线变成固定场景规则。不同位置的太阳、云和大气可以不同，通用测试验证渲染约束，不要求画面长相一致。

## 3. 当前入口

- 默认：node scripts/check-stage1-baseline.cjs --mode compare --configuration ccr-default --repeat 1，目标为fixtures。
- 跨地理位置：node scripts/check-renderer-locations.cjs，无校园模型、外部影像或token依赖。
- 综合算法/SDK：node scripts/check-stage1.cjs。
- OIT/透明/采样模式：node scripts/check-frame-bridge.cjs。
- 校园测试仍可通过--target campus或--target campus-geometry显式调用；对应外部服务失败和质量组合差异是该集成用例的记录，不能直接等同为CCR整体通过或失败。

后续B02至B12优先按材质/几何/透明/相机/地理位置/硬件矩阵推进；任何业务资产特例只能位于示例或应用适配层。

## 4. 本轮核验

- Node测试421/421通过，包含核心不按资产URL改变IBL，以及示例适配的应用/恢复测试。
- 三处独立地理位置各29项GPU检查通过；默认fixtures基准只读比较通过。
- 既有算法、源码/UMD场景与resize检查通过，校园示例的AA生命周期回归通过。
- SDK重新构建；59个生产源码hash与manifest一致，产物不包含校园资产名称判断规则。
- 未据此宣称所有材质、地形或硬件已完成验收，后续继续扩展通用支持矩阵。
