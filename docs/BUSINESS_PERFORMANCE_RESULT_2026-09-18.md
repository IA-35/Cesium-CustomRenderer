# 业务轮廓、阴影提交与 3D Tiles 负载核查

日期：2026-09-18。对应用户确认的“悬停/选中轮廓整场景重绘 → 阴影提交成本 → 检查 3D Tiles 减负”顺序。本轮修改已构建并同步 ruoyi-ui/public/js/CCR.min.js，未提交 Git。

## 1. 已实现：复用深度的选中 ID 通道

新增 `src/selection/SelectedIdPass143.js`，由 VisualPipeline 默认安装、随管线启停/暂停生效并销毁。保留原生 silhouette、选中 ID、轮廓样式和遮挡行为；复制本帧已有的主深度，只补画选中模型内容的 ID，跳过无关不透明对象。所有透明与特殊深度命令保留。每帧重新解析选中内容归属，取消选中后释放模型引用。

适用 WebGL2、单视锥、单采样和普通深度路径。MSAA、多视锥、透明 Globe、清除 Globe 深度、命令过滤、未知选中类型等仍使用原生完整 ID pass；不把回退描述为已加速。`getRenderDiagnostics().selectionId` 报告当前帧 active、skipped、drawn、累计 copies 及原因。

校园校门镜头选中可见“信息学管”：原生实际 WebGL draw 为 **2975/帧**，优化后 **2023/帧**，少 **952 次（约 32%）**；俯视镜头跳过 **834 次**。这些是实际 GPU 绘制调用，不能与外层 Context.draw 尝试次数混淆。

校门、俯视、前景遮挡墙、MSAA4 四种 GPU 对照完成。校门确有约 7700 个高亮变化像素，避免空高亮假阳性；遮挡墙出现后选中引起的像素变化为 0；MSAA4 跳过数为 0，按预期回退。最终对照中优化/原生校门差异为 1 个像素、最大 2/255，其他三项差异为 0。

画质门槛公开说明：真实业务影像/环境的原生 A/A 重复对照也出现过少量像素漂移，最终校门原生自身漂移 17 个像素。门槛为：原生漂移不得超过全图 0.01%，优化差异像素数不得超过 max(4, 原生漂移)，单通道最大差异不得超过 2/255。前期“原生必须绝对 0 漂移”产生了误报；没有用扩大容差掩盖早期视角未稳定造成的数万像素差异，而是等待视角/资源稳定后重测。

## 2. 已实现：阴影提交分组与绑定去重

新增 `src/shadows/ShadowSubmit143.js`，DirectionalShadowPass 在提交 opaque/MASK caster 时按 shader/render state 分组，并只在同步阴影 pass 内跟踪 program、texture unit、texture target 绑定。连续相同绑定不再反复送给驱动。退出/异常时恢复方法，不跨帧缓存 GL 状态，不缓存旧阴影纹理。

真实校园同相机、同时间、4096 阴影、848 个 caster：

| 每帧指标 | 原提交 | 优化提交 |
| --- | ---: | ---: |
| 程序绑定 | 848 | 28 |
| 纹理绑定 | 1662 | 815 |
| 阴影实际 draw | 848 | 848 |

直接在同一帧比较优化前后阴影深度：**4096² = 16777216 个深度样本，0 个差异，0 WebGL 错误**。没有减少投影物、缩短投影距离或降低贴图分辨率。原生/优化最终画面跨帧有低幅背景变化，因此深度正确性门槛使用同帧全深度图比较。

短测优化后阴影 GPU 中位约 4.24–4.25ms，原提交两轮约 5.36/4.36ms；CPU 阴影提交约 5.1–5.6ms，原提交约 5.9/5.3ms。可以确认绑定冗余显著减少，但不能用这组波动数据声称 CPU 提交获得固定比例提升，几何量和 draw 数仍是下一个限制。

## 3. 3D Tiles 审计：不能再把“压缩文件小”当作渲染轻

递归读取 13 组业务 tileset，共 **67 个 JSON、117 个实际 GLB 内容**，117 个内容均为零 geometricError 的叶子，**没有带几何内容的粗模父级**。因此调高 maximumScreenSpaceError 不会生成不存在的简化网格，也不能在保持完整画面的前提下大幅减面。

树木 `SM_NH_Shu/NoLod_0.glb` 已有 `EXT_mesh_gpu_instancing` 和 Draco。12 个网格部件累计 **7066 个部件实例**，理论展开 **17511174 个三角形**；部件包括树干/树冠等，7066 不是树木株数。全部树木在单个内容内，缺少按空间分块的选择粒度及远景简化层。不能重复开发“把树改为实例化”来解决已经实例化的这份资源。

运行时统计的 13 组已驻留资源约：几何 **251.9 MiB**、纹理 **914.7 MiB**（仅资产统计，不含阴影、后处理、驱动存储）。主建筑抽样单个 GLB 就有 60 个材质/primitive；综合楼等也有较多材质分段。引擎的树木 triangle 统计只报基础网格 27559，不包含实例展开，不能据此低估真实实例负载。

后续真正轻量化的优先顺序：

1. **保留现有 GPU 实例化，树木按空间单元拆分，并增加简化树冠/远景 LOD**。共享网格和纹理，避免为每株复制资产；保留实例 ID/属性。近景质量作为硬约束。
2. **建筑增加有几何内容的分层 LOD**，保留可拾取 feature metadata；仅调整 tileset JSON 的 geometricError 而不制作粗模无效。
3. **合并兼容材质分段、纹理去重/图集与 GPU 压缩纹理**。MASK、UV、颜色空间和建筑选择 ID 必须回归；Draco 主要缩小传输，不能替代几何 LOD。纹理压缩主要减显存/上传成本，也不能替代减面。

本轮未重写、删减或替换模型源资产。运行时已降低重复渲染与状态提交；资产几何/纹理本身的轻量化尚未实施。

## 4. 验证、产物和边界

- 652 项本轮相关渲染单测通过。排除未参与本轮的 `campus-business-assets` 既有端口/SSE 预期冲突测试，以及正在开发的 fixed-tree/instanced-gltf/tree-lod 系列；不得称全仓库全部通过。
- UMD 的 `check-shadow-cascades` 通过：300 帧静态零变化、MASK 孔洞、屏外投影、级联移动、接触阴影、多视锥、接收/释放等。
- `check-solar-shadow-motion` 单级联/三级联动态光方向回归通过，0 页面/渲染错误；保留此前动态阴影修复的已知细边缘变化边界，不声称消除所有时间采样变化。
- 业务四视角轮廓对照通过，实际 native ID pass 保留，不影响原生拾取；当前业务 FXAA 配置保持。
- 最后复核补上“取消选中后释放模型引用”的生命周期分支（先失败再通过的测试），随后重新构建同步。最终业务 `ccr-host-browser` 通过：13 tilesets、选中打开/取消关闭 ID 通道、同一 pipeline、Viewer/兼容层正确销毁、记录和监听器清零。四视角画质证据来自补充该释放分支前的构建；选中渲染路径和着色器未在其后更改。
- SDK 已同步业务 public，服务网络字节校验通过；旧包备份在业务 `plan/evidence/ccr-host-performance/CCR.before-optimization.min.js`。
- 最终 SDK：482016 字节，SHA-256 `d4d23528888b2e946086f0ba99a9362ce7e906572b53345b84f3f8c86497534f`。共享库中同时存在其他实例化模块开发，其既有导出随构建保留，不计为本轮功能。
- FPS/总帧耗时仍有跨轮漂移，四次轮廓性能采样最后一次出现明显异常。因此最终只以可重复的 GPU draw/绑定减少和图像/深度正确性作为确定结论，不声称已稳定 60 FPS。云层成本、无 LOD 的大量实例几何仍在。
- 业务周边白模 404 与其他并行修改保持原状，不属于本轮修改。

## 5. 复现与证据

业务项目 `tests/ccr-host-performance.cjs`：

- `--outline-check`：真实可见选中、俯视、完整遮挡、MSAA4 的原生/优化图像对照。
- `--outline-perf`：同一 Viewer 内原生/优化 A/B/A/B，计实际 WebGL draw。
- `--shadow-check`：同帧完整深度图对照、实际绑定及 draw 计数、资源统计。
- `--sdk`：测试浏览器临时替换为独立库产物；交付验证不加此参数，直接使用业务服务实际响应。

`tests/ccr-sdk-serving.cjs` 校验服务响应与 public 文件字节一致；`tests/ccr-tileset-audit.cjs` 只读递归审计资源结构。

业务证据：`plan/evidence/ccr-host-performance/outline-parity.json`、`shadow-submission.json`、`host-1912-outline-perf.json`、`tileset-audit.json`、`glb-sample-audit.json`、`tree-instancing-audit.json`。库证据：`docs/verification/business-optimization-unit.log`、`docs/verification/stage1-B04/report-umd.json`、`docs/verification/business-solar-regression.log`。这些本机证据沿用仓库忽略规则。
