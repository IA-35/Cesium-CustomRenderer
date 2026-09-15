# 25A：基础颜色/遮蔽通道与PBR重建验证

> 执行会话：cesium可视化渲染管线 执行。按已有执行计划工作流逐步实施；用户已授权执行和回传，无需再要求用户确认本任务单。设计会话验收后才进入25B。

**Goal:** 为真正延迟光照补齐可用的线性基础颜色和遮蔽数据，并以GPU参考证明标准金属粗糙度PBR参数可重建。本批不改变主画面光照，不宣称已完成延迟渲染。

**Architecture:** 复用MaterialChannels143的同次MRT重放，按需增加一个RGBA16F附件；不单独再重画模型。新增通道独立于SSR请求，5/7/8附件分别对应基础+albedo、反射+albedo、透明反射颜色+albedo。保持现4/6/7附件及已实现效果兼容。

**Tech Stack:** Windows、Vue2、public/Cesium静态1.143.0、WebGL2、当前已有Node/Playwright。工作目录C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui。

## 0. 开始与范围

- [ ] 读取plan/CESIUM_RENDERING_PIPELINE_HANDOVER.md、plan/STAGE1_COMPLETION_AUDIT.md、plan/evidence/24-uniform-buffers-handover.md、plan/EXECUTION_COORDINATION.md。
- [ ] 确认分支codex/cesium-visual-pipeline和工作区现状。当前参考HEAD为71098ffb296e8e325f052d2f5ccb4e8b00cc1459；工作区才是真实基线。若发生差异先记录，不能reset/clean覆盖它。
- [ ] 创建plan/evidence/25A/，为本批待改文件保存起始哈希和原始副本。运行npm run test:rendering、npm run check:cesium，保存退出码与日志；参考基线为322通过、392资源哈希。若已有失败先辨别是否本批前存在。

可修改的文件：

- src/rendering/cesium/channels/MaterialTarget143.js
- src/rendering/cesium/channels/MaterialChannels143.js
- src/rendering/cesium/channels/materialShader143.js
- src/rendering/cesium/VisualPipeline.js、presets.js、index.js（确有公共导出需要才改index）
- src/rendering/cesium/diagnostics/RenderProfiler143.js
- 对应material/pipeline/profiler的Node测试、新tests/rendering/albedo-fixture.js和run-albedo.cjs；必要的测试fixture接线。
- 本模块README/契约文档，以及plan/evidence/25A结果。

不要改静态Cesium包、业务页面、模型文件、相机默认、天空/阴影/材质亮度参数。不要重新创建UBO、SSR或Hi-Z框架。本批不新增产品UI按钮，不改主交接的验收结论。必要的开发fixture显示原色/albedo用于取证即可。

## 1. 数据契约（先写失败测试）

公开纹理名`albedoOcclusion`，RGBA16F，RGB为材质求值后、lightingStage前的线性material.baseColor.rgb，A为material.occlusion。它不是最终照亮的颜色，也不是透明alpha。

新增flags：ALBEDO_VALID=256、STANDARD_PBR_VALID=512（存现emissiveFlags.a）。关闭本功能时原flags和getTextures返回形状不变；开启时旧低8位保持原语义。getDiagnostics增加albedoContractVersion:1，不改现materialLayoutVersion:2。

有效性规则：

- ALBEDO_VALID要求原生MaterialStage实际求值，baseColor与occlusion有限且可用，输出不会溢出half-float；颜色不能从最终color反推。不要为了通过测试而clamp掉真实HDR基础色。
- 自定义顶点/片元、替代材质、无法识别ModelFS/MaterialStage的路径本批保守不标有效；未知不透明写零并保持eyeDepth=-1。原有透明coverage输出不能写坏新附件。
- STANDARD_PBR_VALID仅用于本批已证明可重建的标准LIGHTING_PBR+HAS_NORMALS+USE_METALLIC_ROUGHNESS路径，法线/金属度有效且无USE_SPECULAR_GLOSSINESS、USE_SPECULAR、clearcoat、anisotropy、自定义shader、unlit、BLEND、后续改色样式/modelColor/outline/裁剪边缘等未处理语义。MASK可保留真实discard，并作为支持样本验证。两种valid不要混成一个“所有材质都可重光照”的标记。
- 在materialStage之后、lightingStage之前保存原材质数据；现有nativeLighting/snapshot路径要一致。不得重复gamma转换。当前本地czm_srgbToLinear是pow(rgb,2.2)，以实际发行包源为依据，不替换成另一套sRGB公式。
- 下述重建公式已在本地MaterialStageFS确认：diffuse=baseColor*(1-metalness)，specular=mix(vec3(0.04),baseColor,metalness)，roughness为感知roughness。不要额外乘0.96；特殊材质不套用这些公式。

## 2. MRT资源和失败回退

- [ ] 保留现有位置0..6。新增附件位置为当前基础附件数：albedo-only位置4，reflection+albedo位置6，opaqueColor+albedo位置7。shader输出位置必须与FBO列表一致，不能固定位置7并制造空洞。
- [ ] MaterialTarget143、materialTargetSupport现有参数后追加可选albedo=false，保持所有旧调用有效。附件数=4+(reflection?2:0)+(opaqueColor?1:0)+(albedo?1:0)，opaqueColor仍隐含reflection；新增8字节/像素。组合为5/7/8槽。
- [ ] MaterialChannels143增加setAlbedoEnabled(bool)、getAlbedoDiagnostics()，区分requested/supported/enabled/valid/error。新增请求不应隐式强开SSR或opaqueColor。
- [ ] 切换布局使本帧输出与Hi-Z失效，清理对应shader缓存并重建目标，但保留现有hooks、显式请求和其他消费者。program cache key必须区分所有实际布局。
- [ ] 设备槽数不够或新增附件分配失败时，撤销albedo分配并保留原可用4/6/7布局；报告准确原因和显式off/on重试行为，不能让新可选功能关闭已可运行的SSR/AO。现有opaqueColor/反射降级链仍保留。
- [ ] clear、未知遮挡、近远frusta覆盖、destroy、部分分配失败都正确处理新纹理。关闭时getTextures不得追加值为undefined的字段；此前此问题破坏过纹理遍历。

Node至少覆盖：默认形状/字节不变，三种新布局及有序附件，5/7/8能力限制，各分配/完整性失败回退，无重复释放，invalidator写零，flags低位兼容，layout cache失效。

## 3. 管线与统计接入

- [ ] presets增加albedoEnabled:false。
- [ ] VisualPipeline新增setAlbedo({enabled})与getAlbedoDiagnostics()，getRenderDiagnostics增加albedo。仅请求albedo也能创建材质生产者；不需要Hi-Z时不强制创建Hi-Z。
- [ ] 关闭albedo保留AO/SSR/透明SSR/显式材质和Hi-Z依赖；关闭其他效果不能误释放独立albedo请求。专用setter不得重新覆盖曝光、灯光、原生AO或AA状态。
- [ ] suspend/resume、destroy和viewer先销毁按现有约定管理；Profiler纹理统计按实际对象纳入albedoOcclusion，不重复计算。

Node至少覆盖独立albedo、与AO/SSR/透明SSR组合、暂停期间修改请求、显式依赖保留、资源失败旁路、外部状态不被专用setter修改。

## 4. 实际GPU验收（不能只做源码/模拟对象测试）

新增run-albedo.cjs使用本地8766服务与已有Playwright。GPU脚本串行执行，完整保存各项输入/实际输出及失败。

- [ ] 因子颜色已知样本（含黑色、非灰RGB）：线性RGB及occlusion读回与独立期望比较。0..1样本RGBA16F绝对误差上限0.001；纹理样本按实际pow(rgb,2.2)参考计算。
- [ ] 基础色纹理×factor、顶点色、occlusion纹理、normal map、MASK孔/solid；孔处不得留下远处albedo或flags。
- [ ] metallic=0、0.5、1且roughness至少0.1/0.5/1。独立GPU参考直接输出原生material.diffuse/specular，与albedo+已有金属度重建结果比较。对0..1输入容许的最大分量差0.003，包含RGBA8金属度量化和half-float颜色量化；记录实测误差。参考不能调用待测重建函数生成预期。
- [ ] 特殊材质分支明确验证STANDARD_PBR_VALID为0；不把无效样本略去后宣称全材质支持。
- [ ] 开关新通道前后主HDR颜色和原已有附件一致（新flags上位除外）；选稳定内部像素，HDR误差≤0.002，alpha原值保持。记录是否MSAA、时间、尺寸和相机，避免加载变化污染对照。
- [ ] 不透明未知物遮住有色后景后新附件清零；移除后恢复。透明overlay不覆盖不透明albedo。非log多个真实frusta下近材质覆盖正确。
- [ ] 奇数尺寸resize释放旧纹理并重建，至少10轮开关/暂停恢复不增加残留资源；验证5→7→8及降回已有布局，三种组合都实际创建并readback。
- [ ] 校园近景启用/禁用、现SSR/透明SSR/AO同开，检查diagnostics、执行顺序、渲染错误与getTextures有效性。不得修改真实资产使测试更容易。

若精度/功能门槛失败，定位并修复；若发现门槛与原生行为确实冲突，提供最小复现、原始数据和替代建议回报设计会话，不能自行放宽标准或删减本批范围。

## 5. 最终验证与交付

在实现稳定后运行一次：

```powershell
$env:CESIUM_PLAYWRIGHT='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
npm run test:rendering
npm run check:cesium
node tests/rendering/run-albedo.cjs
node tests/rendering/run-reflections.cjs
node tests/rendering/run-transparent-reflections.cjs mrt sorted
npm run build:prod
git -c core.safecrlf=false diff --check
```

服务不存在时可启动已有Python静态服务；已有服务先复用，不重复占用端口。每项记录真实退出码，不能用后续读日志命令掩盖失败。其他回归仅在修改触及对应风险时增加，不反复跑无关测试。

交付到plan/evidence/25A/：

- RESULT.md：逐条对应以上要求；实现、GPU/Node/构建结果、未测范围、风险和未完成总目标分开。
- validation.json：检查名、passed、关键实测数据、证据路径、运行条件和退出码。
- source-hashes.json：修改后源/测试哈希；保存本批起始副本及本批diff，不把其他未提交改动混入。
- 真实日志、读回数据、截图。至少一组原色/albedo与PBR重建对照，可说明颜色语义；不能仅用截图证明数值门槛。

完成后通过send_message_to_thread向01a085b7-92e4-7231-8776-e494e0010613回报“25A执行回执”，附RESULT.md绝对路径、通过/失败数和未解决事项，并在本会话给出最终结果。然后等待设计会话的接受或返修任务，不自行推进25B、不把阶段1标为完成。

## 设计会话的接受条件

核对本批diff与哈希、实际GPU条件、所有必需组合、恢复/降级行为；读取失败实验是否已解释。必要时独立执行最小复现及测试。全部满足才写acceptance.md并下发25B；未满足直接下发具体返修。25A接受仅证明材质输入基础齐备，下一批仍必须实现真实光照替换。
