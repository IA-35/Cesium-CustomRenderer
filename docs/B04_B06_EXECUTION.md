# B04–B06 执行与验收账本

基线 b94a9b8；分支 codex/stage1-b04-b06。2026-09-17。亲自执行，不分派执行端 agent；私有 assets/、.vscode/、.workbuddy/ 不纳入提交。

## 当前实现

- B04：三个实际接收区间、lambda 0.6、2048²/1024²/1024²；独立画面外 caster 和高程 z 范围；稳定半径档位、绝对光空间 texel snapping、10% overlap、世界单位 bias、距离渐隐；模型、Globe、透明接收接通。
- B05：资源账本先于分配；AO/Bloom 真实共享目标；lease/generation/context 与输入读保留；Camera 160 B、Sun 48 B、Environment 192 B 共享数据；统计与失败清理。详见 B05_RESOURCE_LEDGER.md。
- B06：静态 Model/tiles 分组及命令/资源 revision；128 query 预算、跨帧两次确认、变化当帧可见；主颜色/材质跳过，投影/拾取/瓦片更新保留；requestRender 有限轮询和开放场景退让。

> **后续性能回退（2026-09-17）**：复杂场景实测 B04 三级阴影的逐层瓦片选择/投影绘制与 B05 太阳 UBO 的每 draw GL 状态查询导致帧率骤降，已将默认值回退为 `shadowCascades: 1, shadowSize: 4096`（单级联）并关闭阴影太阳 UBO。三级级联与太阳 UBO 仍可通过显式选项启用（`shadowCascades: 3`、deferred/transparent 前向路径），本账本其余条目描述的仍是当时三级实现的验证证据，不代表当前默认行为。

## 已确认的关键证据

- B04：300 静止帧逐像素一致；60 帧太阳/镜头运动保存逐帧 PNG，5802 对平滑参考样本最大变化约 0.13%，194 次跨 split。接地首个阴影样本旧/新均 0.1 m。24 MiB 深度预算（旧单图 64 MiB）。三处地理位置、10 km/轨道、多视锥、画面外 caster、双面 MASK 和透明接收通过。
- 程序化山地：实际 HeightmapTerrainData，118 个 tile 请求，约 2002.7 m 的 Globe 接收点。阴影/无阴影 HDR 明确不同且可恢复，不以抬高平面代替地形检查。
- B05：640×420 AO/Bloom 原目标 12,248,960 B → 池 7,679,360 B（约少 37.3%），池开关逐像素相同。环境关闭输入活跃期重叠时不别名。十轮启停/resize、失败重试、同帧 UBO GPU 读回、停用归零通过。
- B06：46 组隐藏 45 组；deferred materialDraws 46→1，画面一致。更大边界用例 186 组隐藏 185 组，实际 query 批次 128/57/128/57，画面一致。
- B06：门洞/0.4 m 细缝、相机/变换/透明度/剪裁、真实异步 tile、蒙皮变形、拾取和阴影 caster 保留通过；空旷场景无新查询；长期 pending 在 10 帧后停止请求；真实 context loss 释放隐藏状态、池 lease 与附件。
- B06 GPU：RTX 3070 / Chrome 152，三组交替 A/B 固定输入；steady frame 中位约 3.94→1.22 ms，绘制降低 97.8%；8 帧分块、按成对运行重采样的收益 95% 区间约 2.34–3.27 ms。初始查询另计，移动视图不保证收益。

## 本轮审查修复

1. B06 初始化中途失败残留 draw hook/primitive：测试先失败，现统一清理并报告失败。
2. B05 后续 HDR 消费者抛错未释放当前颜色 lease：测试先失败，现 finally 覆盖整条 HDR 链。
3. B06 缓存漏记绘制拓扑/pass：补充实际输入签名与 LOD/style/同纹理上传回归。
4. B04 两次冷启动不一致：旧网格锚点和基底继承第一次地形 LOD 中心，导致永久历史偏移。修为仅由太阳建立初始基底，绝对光空间双精度 texel snapping。失败单测、修后两次近景逐像素一致和完整运动回归均通过。
5. 原 check-camera-shadows.cjs 依赖私有 white-city，现转到通用级联/地理位置矩阵。

## 尚待收口

- 正在跑最终源码/UMD 的 B04、B05、B06 矩阵（当前构建已同步）。
- 默认基线第一次两次冷启动失败已保留，未强行覆盖 golden；上述网格根因修复后需重跑完整 update/独立 compare。隔离无阴影配置两次冷启动一致。
- 补齐当前阶段完成摘要、最终构建指纹和计划勾选，审查 staged diff 后提交。完成门槛保持原计划，不用接口存在或单个夹具通过代替。

原始结果在本机 docs/verification/stage1-B04、B05、B06；公开归档摘要应写在非忽略的 docs/ 文件中。B03 本轮复核另见 B03_RECHECK_2026-09-17.md。B07–B13 不算本批完成，多光源继续暂缓。
