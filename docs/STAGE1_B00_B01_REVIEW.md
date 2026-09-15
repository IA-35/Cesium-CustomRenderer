# 阶段一 B00 / B01 实现审查

> 历史审查快照：下列问题已在后续专项修复中逐项处理，当前状态见 [修复交接](B00_B01_FIX_HANDOVER.md)。本文保留原始缺陷与复现记录。

审查日期：2026-09-15。审查基线：HEAD `31f54b1` 与本轮未提交工作区。范围为用户汇报的B00、B01新增实现及其验证/文档，不重新宣称整个阶段一通过。

**结论：请求修改。B00已有可复现采集工具，但尚不是可靠的冻结回归门槛；B01已证明部分OIT单采样场景可改色，但通用帧桥、透明合成验收与生命周期未完成。暂不应按“B00/B01全部完成”展开B02主照明接管。**

本轮只审查、增加隔离的复现证据和本文；未修改运行模块、原测试或原验收报告。下文P1为进入B02前必须解决的问题，P2为必须补齐的可靠性/证据问题。

## 1. 验证范围与证据

- **实际重跑：** `npm test`，406/406通过。日志：[docs/verification/B01-review-unit.log](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/B01-review-unit.log>)。
- **实际Chrome/WebGL补测：** 原opaqueReadHook、translucent阶段、明确指定正确目标的对照、读回状态、销毁、801×603强制resize。
- **实际Node生命周期复现：** 外部wrapper保留后卸载/重装、同一帧重复入口、OIT对象存在但该帧未启用。
- 复现脚本与结果：[docs/verification/stage1-B01-review/reproduce.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/reproduce.cjs>)、[docs/verification/stage1-B01-review/runtime-review.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/runtime-review.json>)、[docs/verification/stage1-B01-review/resize.cjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/resize.cjs>)、[docs/verification/stage1-B01-review/resize-review.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/resize-review.json>)、[docs/verification/stage1-B01-review/lifecycle.mjs](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/lifecycle.mjs>)、[docs/verification/stage1-B01-review/lifecycle-review.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/lifecycle-review.json>)。
- 源内容SHA256：[docs/verification/stage1-B01-review/source-manifest.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B01-review/source-manifest.json>)。
- 没有重新运行全校园B00长序列、OIT multipass、多视锥或正式前台性能验收；其历史通过状态不被本审查升级。
- 实際resize补测通过，没有复现“缩放必然抛异常”；因此不将静态代码中的疑似重复buffer销毁写成已复现故障。

## 2. 必须修复的问题

### R1 · P1：替换命令没有绑定所宣称的Framebuffer

**位置：** [src/pipeline/FrameBridge143.js:559](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:559>)；使用点[src/pipeline/FrameBridge143.js:589](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:589>)。

`singleTextureFramebuffer`本身已经是Cesium Framebuffer，它没有FrameBufferManager的`.framebuffer`属性。getter返回undefined，进而`command.framebuffer`也为undefined。绘制会使用调用时的passState/default目标，而不是必然写入`oit._opaqueTexture`。

**实测：** 每次捕获到的`explicitFramebufferDefined=false`。同色替换放在opaqueReadHook能看到变化，放在公开阶段translucent则画面完全不变，但仍返回applied=true。前者依赖当时恰好处于opaque绘制目标，不能用来证明目标选择代码正确。

**影响：** 调用阶段、OIT/排序透明或后续resolve变化后，会写错目标、无效写入或覆盖错误颜色。当前MSAA拒绝保留为“不支持”可以，但写入失效的成因必须在修复绑定后重新判断。

**修复与验收：** 返回真正的Cesium Framebuffer对象；明确phase/帧/generation/目标是否允许写入。支持阶段逐个验证真实目标内容和最终呈现；不支持阶段必须在写入前返回applied=false。既有排序透明“applied=true但画面没变化”同样不能作为安全降级。

### R2 · P1：透明混合测试没有采到玻璃，也没有验证0.5合成公式

**位置：** [scripts/check-frame-bridge.cjs:82](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-frame-bridge.cjs:82>)、[scripts/check-frame-bridge.cjs:225](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-frame-bridge.cjs:225>)。

THROUGH_GLASS固定为[320,300]。真实投影下玻璃中心约[320,129]；当前探针位于玻璃之外。脚本只是记录玻璃像素，颜色断言只要求不透明探针“发生变化”，没有检查0.5混合数值。

**实测：** 开关玻璃时，[320,300]始终为[112,125,138,255]；真实玻璃中心从[41,134,240,255]变为[76,117,111,255]。低HDR替换后真实玻璃中心与无玻璃像素不同，说明当前某条路径确有透明贡献；但原报告的探针和断言不能证明它满足规定的0.5线性混合。

另外，夹具用的是闭合有厚度Box和受光照PerInstanceColorAppearance，不是已知颜色的单面unlit平面。不能直接把材质输入色当作玻璃最终线性颜色参考。

**修复与验收：** 用单层、已知线性色/alpha的平面；根据投影选择内部点，先用glass.show切换验证探针确实覆盖玻璃，再在tonemap前对照独立公式。至少alpha=0/0.5/1，覆盖“不透明替换错误但颜色仍变化”的负例。

### R3 · P1：读取颜色没有恢复Cesium绑定缓存，缓存FBO也不跟随目标变化

**位置：** [src/pipeline/FrameBridge143.js:458](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:458>)、[src/pipeline/FrameBridge143.js:464](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:464>)、[src/pipeline/FrameBridge143.js:480](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:480>)。

`Context.readPixels`会更新`context._currentFramebuffer`，finally仅恢复原生GL READ/DRAW绑定，遗漏Cesium缓存。本轮实际读回后`cacheRestored=false`。之后Cesium可能因缓存认为目标已绑定而省略必要绑定，造成错误读写。

同一helper一直使用首次创建的scratch.framebuffer，不检查目标texture/generation。resize、MSAA切换或view替换后仍可能读取旧附件。该分支为源码确认，未在本轮单独做resize读回故障复现。

**额外数据契约问题：** RGBA16F返回的Uint16Array被直接作为普通数字输出。旧报告的[16896,13312,15360,15360]是half-float位模式，对应[3,0.25,1,1]，不是线性颜色值。

**修复与验收：** 同时恢复Cesium缓存和GL绑定；按附件身份/generation重建只读FBO；返回解码后的值，或明确raw类型/格式。连续两次读取不同目标、读取后引擎draw、resize后读取均需验证，禁止引入同步读回作为B02主渲染流程。

### R4 · P1：外部wrapper保留后重装会复活旧wrapper，回调重复

**位置：** [src/pipeline/FrameBridge143.js:203](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:203>)、[src/pipeline/FrameBridge143.js:282](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:282>)。

uninstall保留包在外部wrapper里面的旧wrapper是正确方向，但这些wrapper没有各自的active/generation身份；它们共享state。再次install设置installed=true后，旧wrapper也重新派发回调。

**实测：** install → 外部包装resolve → uninstall → install → resolve一次，回调执行2次，期望1次。现有“保留外部wrapper”单测没有再次安装步骤，因此406项通过没有覆盖此缺陷。

**修复与验收：** 仿照现有HdrCoordinator使用每次安装独立的永久退役token；旧token不再响应新installed状态。三轮上述操作都必须每次一个回调、一个原生调用，同时保留外部包装。

### R5 · P1：B00检查会覆盖基准，不能阻止稳定回归

**位置：** [scripts/check-stage1-baseline.cjs:201](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:201>)、[scripts/check-stage1-baseline.cjs:359](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:359>)。

检查只比较“本次运行第一轮”与“本次运行后续轮”，从不读取已保存的stage1-baseline.json作参考；最后总是覆盖该文件。新画面即使稳定地变暗/缺效果，也会两轮相同并把错误结果写成新基准。默认repeat=1还会对空comparison得到valid=true，无法表示“未测试重复性”。

三个target共用一个基准文件，fixtures或campus运行还会覆盖campus-geometry的冻结记录。

**修复与验收：** 区分显式采集/更新与只读比较，按target/configuration分文件；默认比较不得写golden。增加负例：在测试页临时改变曝光，比较必须失败且golden hash不变；单轮不能声称已证明确定性。基线采集工具可以先交付，但不能以目前代码宣称回归门槛已闭环。

### R6 · P1：影像就绪检查可以在影像未提供时通过

**位置：** [scripts/check-stage1-baseline.cjs:38](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:38>)、[scripts/check-stage1-baseline.cjs:339](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:339>)。

本地Cesium 1.143 Source没有`imageryTilesLoaded`字段。判断`=== false`使undefined直接通过，图层数为0时循环也直接通过。实际有效的globe.tilesLoaded只在初始loadTarget等待一次，每次换镜头后仅固定等待帧数；视野变化后会产生新请求，不能把初始ready当作全序列ready。

外部影像HTTP 4xx/5xx没有统一作为失败：不在本地路径列表中的错误只打印“non-fatal external responses”。因此“影像服务返回错误但请求正常完成”与requestfailed不同，仍可能得到报告通过。

**修复与验收：** 明确真实校园目标至少一个期望可见影像层；监听provider错误并记录每个镜头实际加载/失败，等待有效的Globe瓦片就绪。注入空图层、影像HTTP503、相机换视野尚在加载三个负例，必须判为未就绪/失败。campus-geometry可以作为独立图像基准，但不能弥补真实底图验收缺失。

## 3. 可靠性与证据缺口

### R7 · P2：工作区“hash”实际只哈希git状态文本

**位置：** [scripts/check-stage1-baseline.cjs:89](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:89>)、[scripts/check-stage1-baseline.cjs:115](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-stage1-baseline.cjs:115>)。

statusHash来自`git status --porcelain`文本，同一文件持续为M时无论改多少内容，hash都相同。files只统计size/mtime，结果也未输出为内容清单；未跟踪目录不会递归进入，中文路径的git转义也可能无法解析。因此无法确定报告对应哪版未提交shader/桥。

**修复与验收：** 复用SDK构建中内容hash逻辑，或用`git ls-files -z --cached --others --exclude-standard`枚举后计算源文件内容SHA256；资产与源码分开。对已经修改的同一文件再次修改字节，manifest必须变化，即使git状态不变。

### R8 · P2：帧身份与OIT可用性取自调用次数/对象存在，不能表达真实状态

**位置：** [src/pipeline/FrameBridge143.js:116](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:116>)、[src/pipeline/FrameBridge143.js:209](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:209>)、[src/pipeline/FrameBridge143.js:265](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:265>)。

beginFrame在检查frameIndexOff之前递增frameGeneration并重置viewIndex。同一frameNumber中重复入口被视为两个frameGeneration。`viewId`又是oit.executeCommands调用序号，并非稳定的实际view/frustum身份。

oitPatched只表示install时对象的方法已包装，不能表示本帧useOIT。OIT对象存在但该帧未使用时，没有oit.executeCommands事件，resolve又因oitPatched=true不发fallback，opaque阶段直接缺失。

**实测：** 同frameNumber=9入口两次，generation=2；同一对象useOIT=false后opaque回调数为0。当前单视锥正常序列不覆盖这两个场景。

**修复与验收：** 明确frame/view/frustum三个身份；按真实frameNumber和实际view生成context，并依据本帧useOIT决定能力和派发。缺少可靠边界时不冒充逐视锥。补相机模式切换、OIT存在但不支持、pick帧和多视锥测试。

### R9 · P2：销毁后遗留自建写入Framebuffer

**位置：** [src/pipeline/FrameBridge143.js:371](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:371>)、[src/pipeline/FrameBridge143.js:552](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/pipeline/FrameBridge143.js:552>)。

destroy释放scratch.framebuffer与uploadProgram，没有释放scratch.singleTextureFramebuffer。

**实测：** 三种有替换的场景在bridge.destroy后，写FBO仍isDestroyed=false。循环创建/销毁桥会积累自有GPU对象，即便附件纹理由Cesium持有也仍应释放FBO。

**修复与验收：** 释放自有单纹理FBO但保留借用附件；检查program/RenderState缓存及分配中途失败路径；20轮启停后自有对象数量归零/稳定。本轮强制801×603resize通过，不将其扩大描述为resize已损坏。

### R10 · P2：唯一冻结配置关闭了CCR阴影，未覆盖当前默认管线

**位置：** [tests/rendering/stage1-baseline-fixture.js:281](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/tests/rendering/stage1-baseline-fixture.js:281>)。

基线显式shadows=false、shadowMode='native'，AA改成FXAA；SSR/AO/Bloom也关闭。这样的隔离配置可以用来诊断，但它不是当前“默认CCR自定义阴影＋SMAA”的原样基线。即使后续把CCR阴影破坏，现有位精确门槛也不会发现。

验收文档只写shadows=native，遗漏了disabled状态；“树荫道路”镜头因此不能作为树荫基准。

**修复与验收：** 保留隔离配置，另外冻结CCR默认配置和校园推荐组合。对每配置记录实际生效值；对自定义阴影做负例变更，应只有覆盖该配置的基准失败。不要删除已有隔离证据。

### R11 · P2：拾取检查比较类型，不比较对象身份

**位置：** [scripts/check-frame-bridge.cjs:165](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-frame-bridge.cjs:165>)。

pickInfo只返回hit与idKind，id为undefined的不同模型一律相等。现有模型没有设置独特id，不能据此声称“仍是同一面墙/同一个对象”。深度位置比较可以补充证据，但不替代ID身份。

**修复与验收：** 给墙、两立方体、透明平面设置独特id，在同一页面内保存原primitive/model身份并直接比较；验证不同对象的探针能够彼此区分。报告保留稳定测试ID，不输出运行对象。

## 4. 文档与进度结论需要同步纠正

1. B00/B01计划条目不能全勾选：材料统计已注明待补，旧宿主material/albedo/透明/TAA夹具并未在本次迁移/运行范围中得到证据；B01 multipass、多视锥仍未测，排序透明未接管。
2. 移除影像后位精确，只能把差异定位到“影像相关路径/状态”。它不能排除Cesium/CCR与影像组合的渲染问题；单张瓦片4次响应相同也不能代表全部瓦片与LOD状态相同。验收文档“已排除渲染器逻辑”的结论过强，应保留未确定原因。
3. “桥存在”“限定场景改色成功”“达到B01所有门槛”是三个不同结论。本轮前两者有证据，第三个不成立。
4. MSAA目前明确返回不支持是合理的保守行为；不支持本身不是伪造成功，但修复R1后才能重新判断此前失败归因。
5. 现有resize实际补测通过；本轮没有证据说明所有模式都损坏，也不要求推翻当前整个CCR实现。

| 批次 | 审查后建议状态 | 进入下一批前条件 |
| --- | --- | --- |
| B00 | 部分完成：采集/重复性工具已有，冻结回归与底图失败门槛不足 | R5/R6/R7/R10，恢复未完成复用/统计项状态 |
| B01 | 部分完成：OIT单采样PoC可见；核心目标绑定、测试与生命周期有缺陷 | R1–R4、R8/R9/R11；补真实混合与支持矩阵 |
| B02 | 尚不具备扩大实施条件 | 先关闭以上阻塞，不把修桥问题藏进light resolve |
| B13 | 暂缓 | 不因本审查恢复多光源 |

## 5. 推荐修复顺序

1. R1明确目标绑定与可写阶段 → R2真实线性玻璃合成夹具 → R11拾取身份；先证明插入点可靠。
2. R3读取状态/附件generation → R4卸载重装 → R8真实帧/能力 → R9资源释放。
3. R5冻结/比较分离 → R6逐镜头影像就绪与失败 → R7内容hash → R10默认管线基准。
4. 重跑限定B01矩阵与B00两个确定性目标，按证据修正文档和勾选状态；然后再进入B02。

原先要求的阶段回退节点在仓库中已存在：`81b0c99 feat: checkpoint stage 1 rendering pipeline`；之后为`8fa8f55`、`31f54b1`两次B00测试提交。当前B01仍在工作区。本审查未创建新commit或push，也未把未通过实现标成稳定节点。
