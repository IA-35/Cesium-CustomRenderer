# CCR 文档索引

Cesium 1.143 自定义渲染管线（CCR）的文档入口。

> **架构分界（重要）**：2026-10-13 的 `cbab9e3` 完成 Render Graph 与 WebGL RHI 迁移，
> 其后又重写了环境（大气/体积云）与提交路径。**在那之前的文档描述的是旧架构**，
> 已统一移入 [`archive/`](archive/)，仅作溯源，不代表当前实现。
>
> 判断依据：`01-`–`04-` 目录下的文档要么在架构调整后更新过，要么仍被 `src/ tests/ scripts/`
> 引用；`archive/` 下的则两条都不满足。

---

## 目录结构

| 目录 | 篇数 | 内容 | 何时读 |
|---|---|---|---|
| `01-architecture/` | 5 | **架构总览**、对外接口、范围边界、算法出处、**外部审查委托书** | **接入前必读** |
| `02-stage1/` | 6 | 阶段一仍有效的计划/侦察/验收 | 了解已建成能力 |
| `03-rendering-perf/` | 6 | 渲染性能契约、基线、优化方案 | 做性能工作前 |
| `04-integration/` | 5 | 校园/白模/植被/车流等业务集成 | 集成具体场景时 |
| **`archive/`** | **33** | **架构调整前的旧文档** | **一般不需要，仅溯源** |
| `verification/` | — | **脚本输出目录**，非文档（见下） | 通常不需要 |
| `superpowers/` | — | 计划模板与规格 | 一般不读 |

---

## 按需求找文档

### 我要接入 CCR
1. [**架构与模块分化**](01-architecture/ARCHITECTURE.md) —— **先看这个**：分层、三条主线、依赖矩阵、新增模块落位指南
2. [渲染范围与边界](01-architecture/RENDERER_SCOPE.md) —— 通用能力边界与兼容性承诺
3. [API 参考](01-architecture/API.md) —— 全部方法、选项、诊断字段
4. [算法出处](01-architecture/ALGORITHM_REFERENCES.md) —— 各效果的上游来源与许可

### 我要请外部审查（Claude / 其他模型 / 外部同事）
1. [**审查委托书**](01-architecture/REVIEW_BRIEF.md) —— 可直接复制给人或模型：项目事实、架构地图、已知问题、审查任务分组、验收口径、交付格式
   - 内含「工作区有未提交改动」的边界说明，**交付前先读 §2**，否则会审到已作废的 TAA

### 我要做性能优化
1. [渲染性能契约 v3](03-rendering-perf/RENDERING_PERFORMANCE_NEXT_v3.md) —— **当前性能契约（8 个 Phase）**
2. [性能基线与限制](verification/rendering-performance/README.md) —— Phase 0 冻结数据、成本归因
3. [优化指南](03-rendering-perf/OPTIMIZATION_GUIDE_2026-10-14.md) —— 分优先级的可执行建议
4. [借鉴计划](03-rendering-perf/CCR_BORROW_PLAN_2026-10-14.md) —— 从三个参考源可抄什么

### 我要改云/大气
1. [云与大气实现来源](../src/environment/README.md) —— 代码内的模块说明
2. [借鉴进度](03-rendering-perf/CCR_BORROW_PROGRESS_2026-10-15.md) —— P0–P4 实际完成度
3. [移植差异清单](../src/environment/reference/PORTING_DIFFERENCES.md) —— 与原版的每一处偏离

### 我要改植被/车流/白模
- [固定树木与实例化植被](02-stage1/INSTANCED_VEGETATION_DESIGN.md)
- [车流系统](04-integration/TRAFFIC_SYSTEM.md)
- [EZ-Tree 集成](04-integration/EZ_TREE_INTEGRATION_2026-09-18.md)
- [白模与反射过渡](./archive/WHITE_CITY_REVIEW.md)
- [校园抗锯齿配置](04-integration/CAMPUS_ANTIALIASING.md)

### 我要了解阶段一做了什么
1. [阶段一完成计划](02-stage1/STAGE1_COMPLETION_PLAN.md) —— **主索引，引用最多**
2. [阶段一验收说明](./archive/STAGE1_ACCEPTANCE.md) —— 验收口径与图像基线
3. [B07–B12 执行计划](./archive/STAGE1_B07_B12_EXECUTION_PLAN.md)

---

## 关于 `verification/`

**这是脚本的输出目录，不是输入依赖。** 30+ 个 `scripts/check-*.cjs`、`scripts/performance/*.cjs` 会往这里写
截图、JSON 报告与 `.f32` 原始缓冲。绝大多数内容被 `.gitignore` 忽略，可随时删除并用脚本重新生成。

唯一入库的部分：`verification/rendering-performance/` 下的 Phase 0 冻结基线（4 个 `baseline-*.json`
+ 1 个对比结果）与各次修复的文字记录（`.md`）。

**清理判据**：以「是否被代码/README/scripts/docs 引用」为准，而不是按文件名猜测。

---

## 文档维护约定

- **活文档**（契约、API、范围）改动时同步更新，并在文首标注更新日期
- **过时文档只归档、不删除**：移入 `archive/`，其内部链接会同步改写；确认历史事实需要时仍可追溯
- **判定归档的两条规则**：① 最后一次提交早于架构调整（2026-10-12 及以前）；② 没有被 `src/ tests/ scripts/ examples/` 引用。
  只被根 README 历史提及不算活依赖——那类链接会一起改写到 `archive/`
- **不报总体完成百分比**：正确性、算法范围、资源接管、性能目标权重不同，按勾选数量折算会误导
- **声称完成后必须有实测证据**：接口存在不等于路径生效，测试数量不等于场景验收

### 校验命令

```bash
node scripts/check-doc-links.cjs            # 断链检查；0 = 通过，有坏链退出码 1
node scripts/check-doc-links.cjs --strict    # 连指向 verification/ 产物的引用一并报出
```

---

## 相关入口

- 仓库根 [README.md](../README.md) —— 项目总览与运行方式
- [src/README.md](../src/README.md) —— 源码结构与模块职责
- [tests/README.md](../tests/README.md) —— 测试结构与运行方式
- 示例页 `/examples/campus.html`、`/examples/stage1.html`、`/examples/traffic.html`
