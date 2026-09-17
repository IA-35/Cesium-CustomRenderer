# 阶段一实现审查（2026-09-17）

审查基点：`cc2819d`，分支 `codex/stage1-b07-b12`；范围包括 B07–B12 新增实现及 B04–B06 遗留问题。结论：**尚不能通过阶段一当前范围的完成验收**。本次仅审查、复现并写报告，没有修改生产代码、更新 golden 或提交。工作区另有正在修改的 B07 文档及未跟踪 SSR 检查脚本，不纳入已提交版本完成结论，也没有覆盖它们。

## 修复状态（审查后逐项回填，2026-09-17）

按审查建议顺序逐一复现并修复，每项附独立提交与回归证据：

| 编号 | 级别 | 状态 | 修复提交 | 证据 |
| --- | --- | --- | --- | --- |
| R1 | P1 | ✅ 已修复 | `080a6eb` | 包裹 `collection.update` 每帧夺回 tonemap 所有权；原生 `enabled=false` 连续 10 帧；`check-lens-effects` 通过 |
| R2 | P1 | ✅ 已修复 | `080a6eb` | `uniformState.sunPositionWC` 取方向、w=0 无穷远投影；太阳入屏 x 0.23–0.48 / y 0.15–0.50 |
| R3 | P1 | ✅ 已修复 | `080a6eb` | Primitive/Globe 环境镜面 rgb 归零，保留 alpha 接收端标记；新增回归测试 |
| R4 | P2 | ✅ 已修复 | `481cf79` | 景深单独开启请求材质通道生产 `eyeDepth`；shader `depthAvailable` fail-closed；新增回归测试 |
| R5 | P2 | ✅ 已修复 | `07aa38d` | 撤销「环境不允许恢复」错误归因；`preventDefault()` 后可恢复；显式销毁重建出口验证（恢复出 `[203,211,207]`）；记录残留诊断缺口 |
| R6 | P1 | ✅ 已修复 | `890ea24` | `prepare()`/`shouldCull()` 尊重 `debugCommandFilter`；`check-occlusion-safety` `filtered.hidden=0`/`parity=0`（原 45/189） |
| R7 | P1 | ✅ 已修复 | `3cfcd6b` | 性能/SDK setup 加载 4 个 cuboid Model 并记录负载计数；三配置负载一致；SDK 比较跑在有模型场景 |
| R8 | P2 | ✅ 已修复 | `7e30e2b` | Globe SSR 捕获 `computeWaterColor` 波浪法线（捕获非再采样）；新增 R8 回归测试 |

**仍未闭环（如实保留，不声称完成）**：R5 暴露的「恢复后诊断误报 `materialsValid: true` 但画面黑帧」是残留的诊断诚实性缺口（自动重建未实现，显式重建出口已验证）；R7 的「与 B03 校园回归同相机/同数据 60fps 基线对照」及「完整 30s/60s/3 轮性能参数」仍待跑；B08 的透明片元/多视锥/云雾分段合成等既有公开缺口不变。

## 已执行的复核

- `npm test`：631/631 通过。它未覆盖下面列出的真实接线问题。
- 构建清单逐文件 SHA256 与当前 `src` 一致；UMD 455501 字节，包 SHA256 与 manifest 一致。本次没有重新构建。
- 浏览器真实运行：`docs/verification/stage1-review-wiring.cjs`；结果 `stage1-review-wiring.json`。
- 相同 headless Chrome 中 context-loss A/B：`docs/verification/stage1-review-context.cjs`；结果 `stage1-review-context.json`。
- `check-frame-uniforms.cjs` 失败：读取未创建太阳 UBO 的 `.buffer` 抛错；日志 `docs/verification/stage1-review-ubo.log`。
- `check-occlusion-safety.cjs` 失败：命令过滤后 hidden 仍 45，断言期望 0；日志 `docs/verification/stage1-review-occlusion.log`。对应 safety.json 的过滤开关图像差异为 189。
- 检查了 B12 原始 performance.json：实际为 quick，预热 3 秒、采集 2 秒、1 轮；组合配置请求 deferred，实际记录 enhanced。

## 必须修复的问题

### R1 · P1：自定义 Filmic 与原生色调映射同时执行

位置：`src/stages/LensEffectPipeline143.js:117`；`src/stages/toneMapping143.js:168`。

创建时设置 `_tonemapping.enabled = false` 不能持续取得映射所有权。Cesium 1.143 的 `PostProcessStageCollection.update` 每帧重新执行 `tonemapping.enabled = useHdr`，之后 HDR coordinator 先执行自定义曲线，再执行原生 collection。

真实运行开启 `unrealFilmicApprox`，连续 10 帧原生与自定义 stage 各执行 10 次，原生 enabled 为 true；诊断却仍给出 `exactlyOnce:true`。自定义 shader 已应用 exposure 和 inverseGamma，因此会重复映射/显示编码，改变亮度与颜色。`exactlyOnce` 目前仅从曲线配置推导，不能证明执行次数。

修复门槛：在真实 update/execute 生命周期取得唯一映射所有权；独立 HDR 色阶数值对照和原生/自定义执行计数均通过；切换、停用、异常恢复正确。不能只断言两种曲线的截图哈希不同。

### R2 · P1：太阳位置读取了不存在的属性，光柱/光斑正常使用不生效

位置：`src/stages/LensEffectPipeline143.js:210`。

Cesium 1.143 的 Sun 没有 `positionWC`。真实场景即使 `scene.sun.show=true`，该属性仍不存在；`context.uniformState.sunPositionWC` 则存在。当前 `_sunScreen()` 恒走 `(-1,-1)` 退出，光柱与光斑 shader 因屏外判定返回原图，但管线仍报告 valid。

现有 `check-lens-effects.cjs:274` 把属性不存在归因为夹具关闭太阳；随后直接注入屏幕位置测 shader，绕过了真正失效的生产接线。

修复门槛：从有效太阳世界位置投影，处理背向、窗口坐标到纹理坐标及分辨率比例；使用生产管线验证太阳入屏/出屏、墙体/云遮挡，不以注入用例代替端到端验证。

### R3 · P1：Primitive/Globe 把 F0 当成已有环境镜面，SSR 命中会错误扣色

位置：`src/reflections/PrimitiveReflection143.js:181`、`:348`；消费者 `src/reflections/ssrShaders143.js:217`。

`reflectionSpecular` 的 rgb 契约是已经包含在主颜色中的环境镜面辐亮度；SSR 执行 `original + confidence * (radiance * response - nativeSpecular)`。新适配器却将 Primitive 的 `0.02 * material.specular`、Globe 水面的常量 `0.02` 写入该项，同时也作为 response。这些是近似反射率，不是从原生颜色分离出的镜面辐亮度。

所以暗色命中会从基础 Phong/水面颜色扣除一个并未存在的常量；如 response=0.02、命中 radiance=0、confidence=1，会无依据地扣除 0.02，继而 clamp。Primitive 文档宣称不伪造已有环境反射，实际写入与该契约冲突。现有 B07 表面测试只检查标记/深度/绘制数，不能发现这一色差。

修复门槛：没有原生环境镜面时 subtraction RGB 为零，保留独立 receiver-valid 标记；有镜面时提取真实可替换项。以有/无镜面、暗/亮命中和 miss 对照验证基础色，覆盖新 Primitive/Globe 路径而非只测标准 PBR Model。

### R4 · P2：单独开启景深没有请求深度生产

位置：`src/VisualPipeline.js:337`；`src/stages/LensEffectPipeline143.js:148`。

材质通道的依赖推导未包含 depthOfField。默认 enhanced 配置仅开启景深时，真实运行得到 `materialChannels:false`、`hasDepth:false`，但 lens diagnostics 为 `valid:true`、reason=null。shader 读 defaultTexture 而非米制深度，无法按实际焦距决定清晰区域。

修复门槛：景深单独开启时按需取得合法米制深度；不可用时明确禁用/回退，不能读默认颜色纹理当深度。以近/焦内/远三层及深度断层实测，并覆盖停用后释放。

### R5 · P2：恢复测试没有允许 context restore，不能归因为 headless 环境限制

位置：`scripts/check-stage1-lifecycle.cjs:232`。

lost 监听器没有调用 `event.preventDefault()`。本次相同 Chrome headless 对照：不取消 lost 默认行为时恢复失败；取消后等待事件分派结束再 restore，独立 WebGL2 canvas 与真实 Cesium canvas 均触发 restored，`isContextLost:false`。

这仅证明浏览器可以恢复上下文，不证明 Cesium/CCR 的旧 GPU 资源能自动重建。应撤销“环境不允许恢复”的归因，继续实际验证资源重建，或实现并验证销毁旧 Viewer 后重建的显式恢复出口。现有未验证状态必须保留。

### R6 · P1：命令过滤后继续使用旧遮挡结果，导致可见对象消失

位置：`src/visibility/OcclusionCulling143.js:62`。

当 `scene.debugCommandFilter` 不再绘制遮挡墙时，命令列表/内容 revision 未必改变，缓存仍把墙后的对象隐藏。本次重新运行现有 safety 脚本失败：hidden=45 而期望 0，过滤状态下开/关剔除图像最大差 189。不是单纯缺测试，而是现存真实错误。

修复门槛：过滤路径无法可靠建模时当帧恢复可见；或把实际过滤结果纳入遮挡证据与失效条件。补查 shader/render-state overrides；再次验证拾取和 caster 不被跳过。

### R7 · P1：B12 性能/SDK 验收负载没有模型，无法证明复杂场景性能

位置：`scripts/check-stage1-acceptance.cjs:288`（性能 setup）；`:201`（SDK setup）；`:379`（性能门槛）。

两个 setup 只初始化 Viewer、椭球 Globe 和管线，没有调用 startStage1Scene、添加 Model/Primitive 或加载 Tiles。所谓固定负载矩阵主要测背景与后处理，未覆盖导致校园回退的瓦片选择、级联 caster 和大量 draw。组合配置虽然请求 deferred，现有原始报告实际为 enhanced，脚本只检查 actual 对象存在，未要求所测路径实际工作。

把整帧 P95 改成 GPU 中位值会漏掉 CPU 提交/驱动状态查询瓶颈；额外 12 ms allowance 也不是等价转换，不能用这个门槛宣称此前的校园性能回退已解决。清楚登记了阈值变化，并不能使不同量纲/统计口径等价。

修复门槛：通用代表性多模型/3D Tiles/MASK/透明负载，加校园实际回归；记录对象/命令/三角形数量、CPU/GPU/整帧分位值和实际接管模式。相同相机、分辨率、数据对照 B03，保留 60fps 基线；SDK 一致性包含本批新功能，而非只比较未启用它们的空场景。

### R8 · P2：Globe SSR 法线没有使用水面波浪法线

位置：`src/reflections/PrimitiveReflection143.js:340`。

原生 Globe 海洋在 computeWaterColor 中根据动画噪声计算波浪法线，再用其计算光照；SSR 适配器只读取 `v_normalEC` 地表法线，并固定 roughness=.08。水面光照的波浪变化不会驱动反射方向，未满足 B07“同一次法线采样参与照明和反射”的已勾选条款。water mask 四种形态检查只能证明范围标记，不证明法线一致。

修复门槛：从同一次水面材质计算捕获实际波浪法线/反射响应，避免再采样产生时间差；验证动画和法线纹理变化能同步改变照明与 SSR。

## 进度判定与文档修正

| 范围 | 审查判定 |
| --- | --- |
| B04–B06 | 有实现及局部通过证据；默认单级阴影回退不等于三级性能优化完成。UBO 浏览器门禁和 B06 safety 当前失败，不能关闭。 |
| B07 | 表面接入主体存在；新增表面反射能量/法线契约仍有缺陷，不应标完整完成。另有工作区 SSR 补测正在修改，需单独复核。 |
| B08 | 解析基础雾已接入；透明片元/多视锥/云雾分段仍未接入，不是只剩验收。 |
| B09 | 曲线与效果实现存在，但重复 tonemap、无真实太阳位置、景深缺深度为实质缺陷。 |
| B10/B13 | 本轮按汇报中的暂缓范围处理。 |
| B11 | 丢失侧/局部生命周期有证据；恢复“环境受限”解释不成立，恢复出口未完成。5 分钟测试不扩大为长期无泄漏结论。 |
| B12 | 工具与候选包存在；quick 空场景 GPU 测量不构成整阶段性能验收，也不能替代先前校园回退复核。 |

另需纠正文档中的单位语义：`cloudShell143.js` 的 12000–50000 是**相机到云样本的距离淡出预算**，当前已固定；不是要求把云层海拔改成 12–50 km。主计划/验收文档将“clear 云层海拔 1600–2800 m”列为未完成 12–50 km 的理由有误，不应据此抬高云层。

建议修复顺序：R1/R3/R6（错误画面）→ R2/R4/R8（功能接通）→ R5（恢复出口）→ R7（有效负载门禁与 B04–B06 性能对照），再处理已公开的 B08 分段介质缺口。修复后重新运行独立验收，不能以现有 631 项单测通过直接关闭这些问题。
