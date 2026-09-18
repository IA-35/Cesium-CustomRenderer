# B11 完成报告：生命周期、能力降级与默认策略

> 2026-09-17。基线 `489760f`（B09 落盘），分支 `codex/stage1-b07-b12`。
> 验收线以[主计划 B11](STAGE1_COMPLETION_PLAN.md) 与
> [B07–B12 执行计划](STAGE1_B07_B12_EXECUTION_PLAN.md) 为准。

## 新增与修改

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `src/diagnostics/capabilityMatrix143.js` | 能力矩阵（六项）与默认策略判定 |
| 新增 | `tests/rendering/capability-matrix.test.mjs` | 28 项单测 |
| 新增 | `scripts/check-stage1-lifecycle.cjs` | 生命周期 + context-loss GPU 验收 |
| 新增 | `scripts/check-stage1-stress.cjs` | 固化的压力测试（交互脚本 + 漂移阈值） |
| 修改 | `src/VisualPipeline.js` | `probeCapabilities` / `probeCoverage` / `getCapabilityDiagnostics`，并接入 `getRenderDiagnostics` |

## 能力矩阵

矩阵**只做判定与报告，不创建 GPU 资源**，因此单测可完整覆盖；真实能力由
`VisualPipeline.probeCapabilities()` 从实际 context/scene 探测后传入。

| 能力 | 判定要点 |
| --- | --- |
| MRT 槽位 | 按当前**实际请求**的附件数（基础 4 + 反射 2 + 不透明色 1 + albedo 1 → 4/6/7/8）与设备 `MAX_DRAW_BUFFERS`/`MAX_COLOR_ATTACHMENTS` 的**交集**判定；原因给出「需要几个 / 设备给几个」 |
| 浮点附件 | 同时需要 32F 与 16F（compact-v1 两者都用）；**列出全部**缺失项而非只报第一个 |
| OIT 两模式 | MRT 与 multipass 任一可用即可；OIT **关闭**时报告「使用排序透明」而不是当成能力缺失 |
| MSAA 支持交集 | **与延迟几何组合时强制回退**并说明 `not implemented` —— 把 B02 的公开缺口做成可判定判定 |
| 非 3D | 非 3D 场景模式与非透视相机分别拒绝并给出原因 |
| 多视锥 | 报告当前帧视锥数；单视锥记为「有效但非多视锥」 |

每项都携带 `requested / active / reason / generation`；`generation` 为真实帧号，
可用于识别陈旧报告（有单测锁定传递）。

### 实测（`scripts/check-stage1-lifecycle.cjs`）

- `generation` = 真实帧号（>0），六项能力全部报告完整四字段
- 设备槽位从 `gl.getParameter` 实读，`attachmentsNeeded` 按当前选项计算

## 默认策略

| 类别 | 内容 |
| --- | --- |
| CCR 托管（默认开启） | 天空、环境、阴影、HDR、SMAA |
| 显式开启（默认关闭） | HBAO、SSR、Bloom、延迟光照、移轴、模糊、景深、色差、光斑、光柱 |
| 延迟模式门槛 | 覆盖矩阵（opaqueLoop / transparentLoop / ssr / msaa）**全部通过**且材质布局可用才进入候选默认；否则 `effectiveMode: 'enhanced'` 并给出缺失项 |

判定对字符串/数字型开关同样严格：`'true'`、`1` **不**被当作启用（有单测锁定）。
材质相关效果（HBAO/SSR/延迟光照）额外要求 MRT 与浮点附件可用；非材质效果
（Bloom、镜头效果）只要求浮点附件。

## 生命周期实测

| 项目 | 结果 |
| --- | --- |
| 20 轮启停 | 资源后半段峰值 ≤ 前半段 ×1.05，**实测增长 0%**；末帧画面正常 |
| 嵌套暂停 | 释放其一仍保持暂停；**重复 suspend 幂等**；单次 resume 清除该所有者 |
| resize | 320×240 → 213×160 → 400×300 → 320×240，materials/SSR 全程有效，无新渲染错误 |
| 2 个 Viewer | 各自独立 pipeline 互不影响；第一个销毁后第二个正常工作 |
| 错误后再启用 | 由 B02 `check-deferred-recovery.cjs` 覆盖（本批未重复） |

## context-loss：**实测到了一个环境限制，如实记录**

**已实际调用 `WEBGL_lose_context`**：

| 观测 | 结果 |
| --- | --- |
| 上下文丢失 | `lost@canvas` 事件触发，`gl.isContextLost() === true` |
| 丢失期间材质通道 | `valid: false`，reason `"Context lost"` |
| 丢失期间 SSR | `valid: false`，reason `"Context lost"` |
| 丢失期间 Bloom | `valid: false` |
| 丢失期间请求渲染 | **不抛错**（`renderSurvived: true`） |
| `restoreContext()` 后 2.5 秒 | `isContextLost()` **仍为 `true`** |
| `webglcontextrestored` 事件 | **从未触发**（单独实测确认，非本脚本问题） |

**结论**：Chrome + headless 下 `WEBGL_lose_context.restoreContext()` **不真正恢复**上下文。
这是**环境限制而非 CCR 缺陷**，但它导致的直接后果是：
「全管线 generation 重置、纹理/program/UBO/query 重新创建、旧异步回调不复活」
**无法在本环境验证**，因为无法进入恢复态。

已确认的补充事实：Cesium 1.143 自身**完全没有** `webglcontextrestored` 处理
（`node_modules/@cesium/engine/Source` 全树搜索无匹配），因此恢复链路本就依赖
宿主环境重新初始化，不是本库单方面可闭合的。

因此主计划该条**保留未勾选**，而不是用「丢失侧正确」冒充「恢复已验证」。

## 压力测试

固化了主计划要求的**两件前置事项**：

1. **交互脚本**：9 步固定序列（orbit / pitch-sweep / zoom-in / zoom-out /
   toggle-ssr / toggle-bloom / toggle-lens / toggle-deferred / reset），可复现；
2. **漂移阈值**：`DRIFT_TOLERANCE = 5%`，判定方式为**前后半段峰值比较**，
   而不是首尾比较——首尾法会被早期高水位掩盖单调上升。

短时运行结果（**5 分钟、2977 个循环**）：

| 指标 | 前半段峰值 | 后半段峰值 | 增长 |
| --- | --- | --- | --- |
| 资源字节 | 2046080 | 2046080 | **0%** |
| 活跃目标数 | 0 | 0 | **0%** |
| 目标总数 | 10 | 10 | **0%** |
| UBO 字节 | 352 | 352 | **0%** |
| UBO 数量 | 2 | 2 | **0%** |

末帧画面正常（203,211,207）——失败路径仍呈现明确可用画面。
另有一次 1 分钟、579 循环的运行同样全部为 0%。

完整 30 分钟以 `--minutes 30` 触发（脚本已支持，且如实报告实际时长）。
本轮按用户指示未跑满 30 分钟；**时长不是通过条件，漂移才是**——
5 分钟 2977 循环已覆盖 20 倍于启停测试的循环量，足以暴露单调增长。

## 本轮修复的缺陷

本次新增的诊断探测**在极简测试夹具下抛错**（`Cannot read properties of undefined`），
暴露了 `probeCapabilities` 对不完整 scene/Cesium 命名空间的假设。修：探测全程防御，
任一字段缺失都退化为保守值而绝不抛错——能力探测只服务诊断，不能拖垮
`getRenderDiagnostics` 整条链。由既有测试（`image-controls.test.mjs` 等）暴露。

## 验证汇总

- `npm test`：**631/631 通过**（603 + 28 新增）。
- GPU：`check-stage1-lifecycle`（能力矩阵 / 20 轮启停 / 嵌套暂停 / resize / 2 Viewer /
  context-loss）、`check-stage1-stress`（1 分钟 579 循环）。
- 构建与 UMD 一致性检查按 B12 一并执行。

## 未完成项（如实保留，不声称完成）

1. **context-loss 的恢复链路未获验证**（环境不触发 `webglcontextrestored`）。
   丢失侧全部验证通过；恢复侧无法进入，故 generation 重置与资源重建未验证。
2. **完整 30 分钟压力运行未执行**（按用户指示，不必等满）。已跑 **5 分钟 / 2977 循环**
   与 1 分钟 / 579 循环，漂移**均为 0%**；脚本与阈值已固化，`--minutes 30` 可复现。
   时长不是通过条件，漂移才是。
3. **tile 异步到达、外部 wrapper / 参数修改、错误后再次启用**未纳入本批脚本。
   其中 tile 异步与外部 wrapper 由 B04–B06 的既有检查覆盖，错误后再启用由
   B02 `check-deferred-recovery.cjs` 覆盖；本批**未重复**，也未合并进 B11 脚本。
4. **未做拾取验证**。主计划「恢复后真实渲染输出通过颜色与拾取检查」中，
   **颜色已用真实像素验证**（`centreColor()`），**拾取未验证**——因为无法进入恢复态。
   拾取本身在 B03/B07 的检查中已覆盖。
5. **能力矩阵的 4/6/8 槽位未在真实受限设备上跑过**。判定逻辑有 28 项单测覆盖
   （含 4/6/7/8、限额取交集、缺失与非法值），但本机设备上限为 8，因此
   「设备只有 4 槽时真实回退」未在硬件上实测。矩阵提供的是**判定正确性**证据。

原始结果在本机 `docs/verification/stage1-B11/`（`lifecycle.json`、`stress.json`）。
