# B03 实现审查（2026-09-16）

> 历史审查：R1–R5 后续已修复。当前实现与验收见 [B03_COMPLETION.md](B03_COMPLETION.md)。

审查对象：基于 `3199614` 的未提交 B03 工作区，包括 TransparentForward143、FrameBridge 的逐命令接点、VisualPipeline 接入及新验收夹具。**结论：请求修改，当前不能认定“核心机制通过”。** 用户明确列出的第 3、5、6 条未完成任务继续保留，以下问题属于已声明完成的实现与验收。

本轮只读审查生产代码，新增本报告及隔离复现证据；未修改原实现、原验收报告或构建包，未提交/推送。

## R1 · P1：补丁只在首次派生时绑定，后续帧阴影输入冻结

位置：`src/pipeline/TransparentForward143.js:147–163, 204–209, 247–269`。

assign 将 command.shaderProgram 替换为补丁程序；下一帧 programFor 却继续把 command.shaderProgram 当成原始源码。补丁已经移除了 receiverSource 查找的 directColor 原始标记，因此第二次返回 null，并被当成 compatibility 跳过。assign 的 uniform 闭包捕获第一次取得的 shadow 对象，不再更新。

真实浏览器复现（测试注入固定全遮挡深度，隔离云、影像与模型因素）：

| 状态 | 实际绑定 w | HDR 像素 RGB |
| --- | --- | --- |
| 首次无阴影 | 0 | 0.318115, 0.106262, 0.097839 |
| 提供有效阴影，继续 10 帧 | **仍为 0** | 完全不变 |
| 重新启停透明模块 | 1 | 0.120850, 0.050201, 0.052643 |
| 移除阴影，继续 10 帧 | **仍为 1** | 仍然变暗 |

稳定绘制 20 帧时 patchedCommands=1、compatibilityCommands=19，valid=false、reason=null。所谓兼容数包含了已补丁的正常 PBR 命令，不能拿这些计数证明兼容对象覆盖。太阳、相机、阴影纹理重分配也会受到旧输入影响。

修复方向：通过命令记录追踪原始 source；已补丁命令继续刷新当前输入或在 uniform 求值时读取本帧输入。统计实际执行与当前帧状态，不把旧补丁算作不支持。

## R2 · P1：回退只停止新补丁，没有恢复现有命令；阴影开关也不一致

位置：`src/pipeline/TransparentForward143.js:147, 185–193, 252–260`，`src/VisualPipeline.js:245–250`。

isDeferredActive 只检查 enabled/failed/attached，不能排除 MSAA、SSR/TAA 等整帧增强回退。即使不透明模块真正 failed，scopeReason 也只是使 applyTo 早退；endFrame 对仍在透明 bin 的命令直接 continue，旧着色器和 uniform 仍然有效。

实测：不透明模块 fail 后，透明诊断报告 `Deferred opaque lighting is not active`，但命令仍绑定旧阴影补丁及 w=1，像素仍为 0.120850，而非原生无阴影的 0.318115。另调用 `setLighting({shadow:false})` 后同样保持 w=1 和变暗结果；TransparentForward 没有消费该开关。首次修正的“无需等本帧已输出”判据是必要条件，但不能代替实际能力和故障回退协同。

修复方向：明确透明路径的实际启用契约；进入回退时恢复已补丁命令并使派生缓存失效；阴影消费与 opaque 使用一致的开关。验证已经打过补丁后的故障、模式切换和参数切换。

## R3 · P2：destroy 未卸载桥与回调

位置：`src/pipeline/TransparentForward143.js:322–326`。

destroy 只调用 release，没有调用 detach。真实浏览器直接销毁后，保存的 bridge.installed 仍为 true，scene.updateDerivedCommands 仍为同一 wrapper。回调与对模块/scene 的引用继续保留。VisualPipeline 在 viewer 尚存时先 restore，恰好遮住该问题；独立销毁及 viewer 先销毁路径并未得到同样保证。

修复方向：销毁统一走 detach，并覆盖直接销毁、重复销毁和不同销毁顺序。

## R4 · P1：验收可在关闭整个 B03 模块后仍全部通过

位置：`scripts/check-deferred-transparency.cjs:78–125, 202–225, 244–262, 296`。

将验收脚本复制到隔离目录，仅在每次 setLighting 后关闭 transparentForward。**OIT 和排序透明仍然通过，report.valid=true，patchedCommands=0**，所有混合读数与原报告相同。夹具关闭了阴影，脚本没有断言补丁实际有效，也没有建立有无补丁的功能差异对照。

具体漏洞：

- OIT 单层断言实际为 ≤0.05，文档及 report.tolerance 却是 0.01。OIT 双层近似不能用于悄悄放宽单层门槛。
- stacked.error 与 noOpaqueRelight 只记录，没有通过断言验证；未核验实际 OIT multipass 分支。
- G-buffer 检查时新建的不透明 frontTwin 尚未隐藏。报告所谓 backdropAlbedo=[0.9,0.25,0.2]、depth=120 实际属于 frontTwin；夹具真正 BACKDROP 是 [0.55,0.58,0.62]、depth≈150。孪生与前玻璃同材质、同位置，使这项检查无法排除玻璃污染。
- “材质切换”只切换 model.show，没有改变材质/pass；该结果只能证明显隐恢复。脚本也未包含 README 声称的兼容 Primitive 与拾取断言，这些结论不能通过当前正式入口复现。

修复方向：增加透明物真实接收动态阴影的差异/同源测试和关闭模块必须失败的负例；修正遮挡夹具与门槛，断言各已完成项，并将尚未运行的覆盖独立列出。

## R5 · P2：FrameBridge.setEnabled(false) 不再阻止逐命令回调

位置：`src/pipeline/FrameBridge143.js:118, 126–134, 297`。

新增 dispatchCommand 没有普通 dispatch 使用的 enabled/installed/destroyed 检查。直接运行桥：安装 onCommand → setEnabled(false) → updateDerivedCommands(TRANSLUCENT)，回调仍执行 1 次。对共享帧桥来说，这是暂停语义回归，消费者仍可能修改命令。

修复方向：逐命令分发与普通阶段使用同样的生命周期门禁，并测试回调执行中停用/卸载。

## 本轮验证与保留任务

- Node：447/447 通过；其中 B03 11 项多为单次 applyTo/显式 release 测试，未覆盖连续帧更新和真实桥销毁。
- 原验收隔离复跑：两种模式均通过；原 `stage1-B03/report.json` 未改。
- 禁用模块的负例：两种模式仍通过，确认验收无法识别新增模块缺失。
- 动态阴影、失败回退、直接销毁及桥停用均有独立复现；详细文件在 `docs/verification/stage1-B03-review/`：`runtime.json`、`bridge-disabled.json`、`acceptance/report.json`、`disabled-control/report.json`、`unit.log`。

用户列出的剩余任务仍为：第 3 条 SSR 替换环境镜面；第 5 条水/粒子透明前向及相关反射组合；第 6 条透明路径 MASK、异步 tile、style、选中轮廓等。除此之外，上述 R1–R5 需要先修复，已勾选的动态阴影、兼容合成与生命周期结论不能直接签署通过。没有进行 FPS/P95 或完整资产验收。
