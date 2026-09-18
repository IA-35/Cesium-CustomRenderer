# R1–R8 修复二审

审查版本：`60538e0`（`codex/stage1-b07-b12`）。范围：`cc2819d..60538e0` 的修复及交付产物。结论：**部分修复有效，但不能确认 R1–R8 全部关闭**。本次没有修改生产代码、构建包或 golden，也没有提交。

## 本次重新运行的证据

- `npm test`：634/634 通过。
- `check-lens-effects.cjs`、`check-occlusion-safety.cjs`、`check-globe-water.cjs`、`check-ssr-surfaces.cjs` 均重新运行通过。
- 新的实际 API/ESM/UMD 探针：`docs/verification/stage1-rereview-wiring.cjs` / `.json`。
- 使用验收脚本自身 LOAD_MODELS_SOURCE 的负载探针：`docs/verification/stage1-rereview-load.cjs` / `.json`。
- 构建 manifest 的源码哈希与当前源文件逐项比较，发现五个源文件未同步。
- 其余日志：`docs/verification/stage1-rereview-{unit,lens,occlusion,globe,surfaces}.log`。

## 新发现与未修完整的路径

### F1 · P1：提交的 UMD 仍是修复前版本

位置：`build/0.1.0/manifest.json:73`、`:91`、`:95`；实际消费者 `examples/campus.js:10`。

当前分支工作区干净，但 manifest 中下面五个文件的哈希与源码不符：

- `src/reflections/PrimitiveReflection143.js`
- `src/stages/LensEffectPipeline143.js`
- `src/stages/lensEffects143.js`
- `src/visibility/OcclusionCulling143.js`
- `src/VisualPipeline.js`

浏览器对同一公开 API 流程直接比较 ESM / UMD：

| 实际行为 | ESM | 已提交 UMD |
| --- | --- | --- |
| Unreal 曲线十帧原生 tonemap 执行次数 | 0 | 10 |
| 同期自定义 tonemap 执行次数 | 10 | 10 |
| setOptions 开启景深后存在米制深度 | true | false |
| 太阳朝向镜头时有有效坐标 | 有（另有 F2 问题） | (-1,-1) |

因此包仍运行重复映射、无太阳位置等旧逻辑。校园示例 import 的正是该包。SDK 图像比较选项未覆盖这些变化，不能证明修复已进入发布物。

修复门槛：构建并提交 JS/gzip/manifest，一致性门禁核对 sourceHashes，并在 UMD 上重跑修复功能；不要只用未启用新功能的图像证明等价。

### F2 · P2：太阳 UV 被垂直翻转

位置：`src/stages/LensEffectPipeline143.js:278`。

改用 uniformState.sunPositionWC 是正确方向，但当前把 NDC y 映射为 `0.5 - ndcY*0.5`。这里消费者是 PostProcessStage 的 v_textureCoordinates，其左下角对应 (0,0)，不是 DOM 窗口坐标。Cesium Context 的 viewport quad 已明确把顶点 (-1,-1) 映射为 UV (0,0)。

真实相机偏离太阳中心的探针：实际纹理 UV y=0.2324921289865814，`_sunScreen()` 返回 y=0.7675078710134187。两者关于屏幕中线镜像。光斑会出现在错误位置，光柱朝错误方向，太阳遮挡也会取错 texel。

修复门槛：按渲染纹理坐标映射 y；分别测试太阳在上半屏、下半屏、屏外、背面以及不同 drawingBuffer 尺寸。中心 (0.5,0.5) 注入用例无法检测翻转。

### F3 · P2：公开 setLensEffects API 仍未建立/释放景深依赖

位置：`src/VisualPipeline.js:405`，特别是 normalizeOptions 后仅调用 applyLensEffects 的分支。

R4 在 applyMaterialChannels 中加了依赖，但公开 `setLensEffects()` 没有调用该方法。默认 enhanced 管线执行 `setLensEffects({depthOfFieldEnabled:true})`，十帧后仍 `hasDepth:false`、`valid:true`；随后执行 `setOptions({depthOfFieldEnabled:true})` 才变成 `hasDepth:true`。新 shader 只是在缺深度时返回原图，避免了错误模糊，没有使公开接口的景深真正生效。

相反，通过 setOptions 创建深度后再用 setLensEffects 关闭，也没有同步释放该依赖。现有测试通过创建时 options 开启效果，绕过公开 setter 路径。

修复门槛：公开 setter 同步所有相关依赖，关闭时清理；不可用的景深不能报有效。补充 setter 开启/关闭、互斥切换及独立深度需求的浏览器测试。

### F4 · P1：tonemap update 包装没有所有权与退役保护

位置：`src/stages/LensEffectPipeline143.js:132`、`:383`。

R1 的正常单实例渲染已不再双重映射。但关闭时只要 `collection.update !== beforeUpdate` 就强制恢复 beforeUpdate，会覆盖在 CCR 包装之后安装的外部包装。

本次实测：先开启自定义 Filmic，给 collection.update 安装第三方包装，然后切回 ACES。结果 `foreignPreserved:false`，后续十帧外部包装调用数 0。第三方更新逻辑被静默移除。

此外，包装从可变的 `owner.ownedTonemapper` 获取 beforeUpdate；如果外部保留该包装引用，释放后调用它会因 ownedTonemapper 已清空而不再转发原始 update；再次启用时也可能指向另一代包装。这违背现有 HDR/frame bridge 使用 token + 捕获 previous 的退役契约。

修复门槛：捕获本代 previous、保存 hook 身份、仅在仍持有 hook 时恢复；退休 hook 必须继续透传，不得重激活。验证外部 wrapper、启停、重新启用、失败释放。

### F5 · P1：R7 的 draw 计数仍可伪通过，性能镜头没有看到模型

位置：`scripts/check-stage1-acceptance.cjs:93`、`:128`。

`if (draws === 0) draws = f.models.length` 把真实零绘制改成正数。载入四个模型并不代表性能采样时模型参与绘制；四个小 cuboid 位于相机正下方，当前 orbit/altitude 镜头从 3000m 高处斜看远方。

本次复用该脚本的完整模型加载函数，等待就绪后读真实 frustumCommandsList：

| 场景/镜头 | 模型实际可见命令 |
| --- | ---: |
| 加载函数报告 draws=4 后的初始镜头 | 0 |
| orbit，heading=0、pitch=-0.5、高3000m | 0 |
| orbit，heading=π、pitch=-0.5、高3000m | 0 |
| altitude，pitch=-0.5、高4200m | 0 |
| pitch，pitch=-1.3、高3000m（正对照） | 4 |

这证明计数方法能够看到模型，但大部分既定轨迹未覆盖模型。修复并未解决 R7 的有效负载问题。短跑可以验证接线，不能把零绘制兜底成有效性能负载；即使跑满时长也无助于这一问题。

修复门槛：移除伪造的 draws 回退，每个采样阶段统计真实主视图绘制；镜头轨迹围绕实际负载并有视野覆盖门禁。扩展到能体现命令/瓦片开销的规模，并完成与 B03 的校园同条件对照；CPU/GPU/整帧指标分别记录。

## R1–R8 关闭状态

| 原编号 | 二审判断 |
| --- | --- |
| R1 | 源码正常路径双 tonemap 已修，0/10 次执行证据成立；外部包装生命周期有 F4，UMD 有 F1。 |
| R2 | 真实太阳数据源已修，但 F2 垂直翻转；UMD 未同步。 |
| R3 | 源码不再将 F0 写入可扣除镜面项，修正符合通道契约；Primitive/Globe 接入检查通过。UMD 未同步。 |
| R4 | 构造/setOptions 路径深度依赖已修，公开 setter 仍有 F3；UMD 未同步。 |
| R5 | 错误环境归因已撤销。公开承认的恢复后黑帧却报 materialsValid/ssrValid 仍未修；不能标完整关闭。 |
| R6 | 本轮源代码浏览器 safety 通过，filtered.hidden=0、parity=0；已修原复现。UMD 未同步。 |
| R7 | 添加了模型，但 F5 使负载门槛仍失真；校园/B03 对照继续未完成。 |
| R8 | 捕获实际波浪法线的代码方向正确，Globe 水掩码 GPU 检查通过；尚未见波浪动画/法线纹理变化的独立 GPU 数值对照，不扩大为全部动态法线契约已验收。UMD 未同步。 |

R5 的“显式恢复出口”目前是验收脚本创建另一个无业务模型的 Viewer，并用非黑像素判定成功；代码仅销毁旧 pipeline，未在该分支销毁旧 Viewer。它证明新 Viewer 能启动，不证明原场景资产、相机、拾取与交互已恢复，也未提供生产使用的恢复入口。需保留为未闭环项。

综上，634 项单测和现有浏览器脚本通过均可确认，但“八项全部修复并验收”需要撤回，按上述路径补齐后再关闭。
