# B03 透明前向与兼容合成：完成交接

2026-09-17 复核：当前工作区的 B03 核心验收及关联回归再次通过，详细结果和源码/UMD 版本边界见 [B03_RECHECK_2026-09-17.md](B03_RECHECK_2026-09-17.md)。

2026-09-16。本轮修复审查 R1–R5，并完成 B03 原计划剩余第 3、5、6 条。**B03 在下述支持/兼容矩阵内完成开发与验收**；不将 B02 的 MSAA 延迟几何、排序模式的不透明延迟接管、TAA 稳定性或 B08 云雾分段算作本阶段完成。

## 实现结果

| 项目 | 最终行为 |
| --- | --- |
| 透明 PBR | 复用原生材质、顶点变换、SH/IBL 贴图与参考矩阵；CCR 控制直接光、阴影、间接光因子及自发光。透明物不进入不透明 G-buffer |
| 动态输入与回退 | 持有原始 shader，逐次绘制读取当前阴影；失败或能力回退时恢复命令，既有派生命令也通过中性 uniform 保持原生结果。直接销毁卸载桥、回调和资源 |
| SSR 环境镜面替换 | 同一次延迟照明输出环境镜面与响应；复用已有 tracer，以 `原色 + confidence × (SSR radiance × response − 环境镜面)` 替换。两项都包含相同的间接光/AO 权重，不通过减亮度或调曝光掩盖错误 |
| 合成次序 | 不透明延迟照明 → 不透明 SSR → 保存不透明背景 → 原生 OIT 合成 → 透明 SSR delta 合成 → 后续 HDR 效果与 tonemap；不在玻璃合成后重新照明不透明物 |
| 水 | 标准 Water + MaterialAppearance.ALL 接入 PBR 太阳、共享 PCF 阴影和同源场景大气环境探针；保留水的法线、alpha 与动画。探针随位置/环境参数更新并由模块释放 |
| 粒子 | 识别真实 ParticleSystem 的 billboard，按自发光前向语义处理 RGB；同时处理 alpha=1 核心与半透明边缘，保留原生分批、alpha、discard、深度及 OIT，不虚构表面法线 |
| 动态内容 | MASK 孔洞、迟到的透明 3D Tiles、feature style、OPAQUE↔TRANSLUCENT 切换、拾取与选中轮廓均有实际图像检查 |
| 兼容对象 | Globe/生成影像、自定义 Primitive/unlit/未映射材质保持原生。分类或复杂模板轮廓采用整帧增强兼容，移除后自动恢复，不锁成永久失败 |

增强模式继续用旧材质重放的 reflectionSpecular；延迟模式只消费新照明输出。`getScreenSpaceReflectionDiagnostics().lightingSource` 区分 `native-replay` 与 `deferred-lighting`。默认不额外启用传统材质生产者，四附件 G-buffer 不增加槽位。

## 审查缺陷关闭

- R1：连续帧不再把自己的补丁当成未知 shader；阴影开/关、纹理/矩阵变化即时生效，当前帧统计及无绘制原因准确。
- R2：回退恢复已修改命令，并统一消费 lightingShadow 等开关；派生已完成后发生故障时，动态 uniform 退回中性值。
- R3：destroy 统一走 detach，处理不同销毁顺序和上下文丢失。
- R4：重建验收门槛。孪生面默认隐藏，确实读到背景 albedo `[0.55,0.58,0.62]` 和约 150 m 深度；所有模式单层门槛固定 0.01。材质切换使用真实 style/pass 变化。完全关闭模块的负例必须被拒绝。
- R5：逐命令桥与阶段桥使用相同的 enabled/installed/destroyed 门禁，回调内卸载也会停止后续调用。

接通 compact-v1 消费者时另修复大环境组编号的低位标志精度问题：AO/SSR 先取低十位再转整数，GPU 覆盖组编号 1、8192、16383。

## 验收证据

| 检查 | 结果 |
| --- | --- |
| Node | 452/452 |
| 透明主矩阵 | MRT、multipass、排序、UMD、无全局 Cesium 五种配置通过 |
| 单层 0.5 混合绝对误差 | MRT 0.002197；multipass 0.000244；排序 0.000122，均 ≤0.01 |
| 叠层 | 排序误差约 0.000153；OIT 与原生加权混合一致，约 0.068–0.069 的精确排序差异仍明确记录为算法近似 |
| 有效功能负例 | 关闭整个透明前向后，以 `transparent lighting negative-control gate` 拒绝；不再让原生混合冒充 CCR 功能通过 |
| SSR 数值/边界 | 28 项，包括 compact 大编号标志；314,556 个有效像素的环境镜面与原生对照，失败数 0（原 0.01/2% 门槛） |
| SSR 实际输出 | 20,536 个命中样本，60,968 个不透明 RGB 通道变化；玻璃 delta 和合成输出、最终呈现画面均有可测贡献 |
| 动态内容 | 两模式 MASK 孔洞/实体、tile style/native 对照、恢复误差为 0；轮廓实际出现 1,238 像素，拾取保持；真实材质 pass 切换与自动恢复通过 |
| 兼容 | 自定义 Primitive 与原生最大差 0.000244；Globe 影像和分类结果与原生差为 0，影像加载门槛通过 |
| 生命周期 | SSR resize 释放旧纹理；切回 enhanced 时新附件释放、额外附件字节归零；B02 七组故障恢复、22 组渲染矩阵以及 B01 桥回归通过 |

原始机器可读结果见本机 `docs/verification/stage1-B03-fixed/`：`report.json`、`negative.json`、`ssr.json`、`ssr-umd.json`、`families.json`、`content.json`、`unit.log`。公开摘要与构建指纹在 `B03_VALIDATION.json`。原审查与失败报告保留为历史，不覆盖成通过记录。

## 支持范围与成本

- 引擎固定 Cesium 1.143，WebGL2；延迟不透明 + SSR 要求 HDR、3D 透视、单采样 OIT。OIT MRT 与 multipass 都保留引擎累积；排序透明保留原生顺序，不透明侧使用增强路径。
- MSAA 延迟几何、TAA 延迟组合、任意自定义材质/扩展 PBR 不在本批接管范围；兼容原因通过诊断公开。`transparentForward.partial=true` 表示仍有显式兼容类型，不代表缺少本阶段矩阵中的测试。
- Water 的完整 GPU 验收采用 MaterialAppearance.ALL；不支持的自定义水 shader 留原生。粒子采用自发光语义，不模拟粒子体积散射。
- G-buffer 仍为 57 B/像素；开启延迟 SSR 后，镜面、响应、不透明快照额外 24 B/像素，1080p 约增加 47.5 MiB。SSR 中间纹理、透明 delta、水环境探针另计，未声称低显存或正式 FPS/P95 达标。
- SSR 未命中/屏幕外继续保留环境镜面，不提供离屏动态场景的精确反射。云雾与透明的视线分段交由 B08。
- 默认 enhanced 模式不变；候选默认切换及正式性能门槛仍按 B11 执行。

## 复现

启动开发服务器，设置本机 `CESIUM_PLAYWRIGHT`；端口默认 8877，可用 `CCR_TEST_PORT` 指定。

```powershell
npm test
npm run build
node scripts/check-deferred-transparency.cjs
node scripts/check-deferred-transparency.cjs --disable-forward # 必须退出1，且原因必须是功能负例门槛
node scripts/check-deferred-ssr.cjs
node scripts/check-deferred-ssr.cjs --umd
node scripts/check-transparent-families.cjs
node scripts/check-transparency-content.cjs
node scripts/check-deferred-matrix.cjs
node scripts/check-deferred-recovery.cjs
node scripts/check-frame-bridge.cjs
node scripts/check-stage1.cjs
node scripts/check-browser-sdk.cjs
node scripts/check-stage1-baseline.cjs --mode compare --configuration ccr-default --repeat 1
```
