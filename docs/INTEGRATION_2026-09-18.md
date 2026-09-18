# CCR 修复、分支整合与二审记录

范围仅 `cesium customRenderer`。本轮按「先修复与验证 → 全部本地开发分支合并 main → main 二审」执行。保留所有分支，不推送远程，不包含业务项目修改。

## 合并前分支清单

| 分支 | 起始提交 | 与起始 main 的关系 |
| --- | --- | --- |
| main | b94a9b8 | 起始主分支 |
| codex/stage1-b04-b06 | b94a9b8 | 与 main 相同 |
| codex/stage1-b07-b12 | e09bbc2 | 领先 main 18 个提交，当前工作区另有未提交成果 |
| codex/stage1-hbao-bloom-clouds | 31f54b1 | 分叉历史，3 个独有提交，需要真实合并 |

## R1–R7 修复

| 编号 | 修复 | 验证 |
| --- | --- | --- |
| R1 | 景深缺深度只跳过景深。原生 tone 每帧准备回退，仅在自定义 tone 当帧成功输出后禁用；不再提前关闭原生 tone | 3D/2D 缺深度均为十帧自定义执行 10 次、原生 0 次；未就绪保留原生回退；外部 update 包装保留 |
| R2 | 抽取粒子 Billboard 分类供透明前向/TAA 共用，TAA 每帧缓存粒子集合，世界粒子继续参与 HDR 链 | 100 个粒子未被分类为 UI；排除开关负对照与正常路径的亮度总和差低于 2%；嵌套集合单测 |
| R3 | 介质输出带帧号，每次执行及释放时失效；getter 要求当帧且环境 pass 有效 | 透视有效→正交后 mediumValid=false，不再暴露旧纹理 |
| R4 | 默认资格与真实生效模式分开；actual producer 驱动 active/effectiveMode，覆盖矩阵单独报告 candidateReason | SSR 关闭时实际 deferred 与诊断一致；未知/未就绪不误报 active |
| R5 | 树集合 ready 只看资产/纹理，不依赖可见命令数 | 资产完成、cachedCommandCount=0 时 readyPromise 正常结束 |
| R6 | 草地使用总量受限的整数份额分配，零密度/预算返回空集合且可正常 ready | 25 个面 max=10 实际分配 10；零密度 0；小预算和确定性分配通过 |
| R7 | 仅在存在 Globe 时写 Globe 光照参数 | 无 Globe Viewer 的管线创建、连续绘制与销毁通过 |

同时修正：校园示例测试解析实际启用的模型清单（不把注释里的旧树算进去）、移除旧端口假设、更新 SSE 32 预期；草地预处理测试改为临时合成数据，避免新检出依赖本机私有资产；补齐内部 vendor 测试导出；保留公开 vendor 许可资产。`.gitattributes` 固定被 manifest 记录的源文件换行，保证 Windows 新检出可验证哈希。

七项新增回归测试在修复前全部失败，修复后全部通过。合并前完整 `npm test`：691/691，无跳过；`npm run build` 通过；ESM 与 UMD 的修复 GPU 门禁均通过；基础效果检查（SSAO/HBAO/Bloom、场景、缩放、UMD）和镜头效果检查通过。

阶段说明同步纠正：B10 已恢复开发但完整收口未完成；浏览器 context restore 与显式重建已验证，旧 GPU 不自动恢复；SDK 信息以 manifest 为准；三级阴影默认 4096 配置为 96MiB，2048 配置才为 24MiB。既有多视锥介质、完整延迟组合与 B13 暂缓边界不虚假关闭。

## 合并与二审

修复提交为 `753b045`。切换 main 前，在独立干净检出目录执行 691 项测试全部通过（无私有校园资产、无跳过），生成后的逐源码哈希与提交的 manifest 一致。

| 开发分支 | 合并结果 |
| --- | --- |
| codex/stage1-b04-b06 | 已包含于起始 main，执行合并返回 Already up to date |
| codex/stage1-b07-b12 | `fa106b5`，包含 18 个既有提交与本轮修复/当前开发成果 |
| codex/stage1-hbao-bloom-clouds | `d70e86c`，保留独有 3 个历史提交的真实 merge ancestry |

旧分支产生 40 处冲突。逐项对照证明：其中 25 处 incoming blob 在历史整合提交 `c28bc66` 已逐字存在；其他 15 处是随后 B00/B01 校验、runtime-config、示例/文档和产物的演进。保留主线的后续修复，构建包从解决后的源码重建。旧分支最终对 main 文件树只带来重建 manifest 的提交来源变化，没有回退当前渲染代码。逐文件判定见同名 JSON。无未解决冲突，所有本地开发分支均为 main 的祖先；所有分支保留，没有推送远程。

**合并后才执行正式二审。** 二审额外发现并修复镜头效果释放时的属性所有权问题：只有 native tonemapper/启用状态仍等于本模块最后写入的值才还原；没有执行自定义 tone 时不覆盖 native fallback。新增失败→通过回归。TAA 销毁时也清除新增粒子分类集合的强引用。

最终 main 工作树验证：`npm test` **692/692，0 失败、0 跳过**；SDK 构建通过；ESM/UMD 均通过 R1/R2/R3/R4/R7 浏览器门禁（包括介质恢复为透视后的重新有效、无 Globe 渲染错误捕获）；基础数值/场景/UMD 检查通过；帧桥七种情况通过；20 轮启停及 context-loss 显式重建通过；gzip 与 JS 一致、sourceHashes 无差异。

**二审结论：本轮已报告缺陷与分支整合通过，没有遗留的合并冲突或本轮阻塞项。** 不把它扩大为阶段一原始目标全部完成：B13 仍暂停，完整 TAA/MSAA/排序透明延迟组合、多视锥透明介质和任意设备 60fps 不在已完成声明内。原始审查报告保留为历史证据。

所有已存在的当前开发成果随修复一起保留；本地资产、编辑器状态和原始验证文件仍按既有忽略规则留在工作区。

复现入口：`npm test`、`npm run build`、`scripts/check-pipeline-review-fixes.cjs`（`CCR_TEST_PORT`、`CCR_TEST_MODE=esm|umd`、`CESIUM_PLAYWRIGHT`）。本轮原始日志保存在 `docs/verification/integration-2026-09-18/`；修复 GPU 结果在 `docs/verification/pipeline-review-fixed/`。
