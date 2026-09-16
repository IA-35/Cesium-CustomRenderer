# B02 开发实现审查

> 历史审查快照。后续修复与当前能力边界见 [B02_COMPLETION.md](B02_COMPLETION.md)，以下结论保留用于追踪原问题。

审查日期：2026-09-16。范围：新增延迟照明模块、VisualPipeline接入、验证夹具及用户提供的B02证据。保持此前“通用Cesium管线”的定位，无校园资产或外部影像依赖。

**结论：请求修改，B02继续保持未通过。** 当前是利用已有材质重放结果覆盖不透明颜色的照明对照原型。除了文档已承认的IBL输入差异，仍有位置重建、首次启用、资源所有权、SDK注入、阴影/AO时序等实质问题。不能只调SH/曝光后就将B02关闭。

本轮未修改生产代码、原测试或原B02报告，未提交/推送；新增本文和隔离的审查复现证据。此前通用化工作区改动也未回退。

## 1. 本次独立核验

- 实际运行 `npm test`：**435/435通过**，[docs/verification/B02-review-node.log](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/B02-review-node.log>)。
- 原验收脚本复制到审查目录，仅改证据输出位置后重跑：**4个有效材质样本、0个达标，valid=false**。red-glossy、green-rough、emissive未进入数值门槛。[docs/verification/stage1-B02-review/acceptance/report.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B02-review/acceptance/report.json>)
- 实际Chrome/WebGL复现：首次/二次启用、参数更新、资源分配与关闭、米制深度重建、阴影/AO输入、8视锥运行、故障重试。[docs/verification/stage1-B02-review/runtime.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B02-review/runtime.json>)
- 独立记录原生/材质/延迟实际draw与IBL输入：[docs/verification/stage1-B02-review/ibl-and-draws.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B02-review/ibl-and-draws.json>)。
- 不提供globalThis.Cesium、仅构造器注入时的失败：[docs/verification/stage1-B02-review/injection.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B02-review/injection.json>)。
- 当前源文件与原始B02证据SHA256：[docs/verification/stage1-B02-review/snapshot.json](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/docs/verification/stage1-B02-review/snapshot.json>)。
- 未进行长期显存压力、正式FPS或完整材质/硬件矩阵验收。

新加的14项B02 Node测试主要验证shader字符串/模板和源结构，没有覆盖DeferredLighting对象本身的启动、资源与失败恢复。435项通过不能抵消下列实际复现。

## 2. 实现问题

### R1 · P1：把米制视深度当作窗口深度，重建出错误位置

**位置：** [src/lighting/deferredLightingShader143.js:178](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/deferredLightingShader143.js:178>)。

`eyeDepth`契约是正数米制视深度，而`czm_windowToEyeCoordinates(vec2, float)`第二参数接收窗口深度或log depth。它不会自动识别米。当前fullscreen shader也没有把这个数转换成正确的窗口深度。

**独立GPU结果：**

| 项目 | 读数 |
| --- | --- |
| 材质eyeDepth | 109.84902954101562 m |
| 当前反投影positionEC | [0.349243, -0.349243, **+1.833049**] |
| 米制射线重建positionEC | [-20.929050, 20.929050, **-109.849030**] |
| 必须满足的关系 | -positionEC.z ≈ eyeDepth |

当前位置甚至落到相机后方，viewDirection、NdotV、镜面高光和阴影投影都随之错误。它足以污染所谓“直射量级正确”的结论，必须在继续IBL拟合前修复。

**建议：** 复用现有AO/SSR对米制深度的重建方式，明确主相机与当前视锥投影契约；加入独立GPU位置检查，而不是仅断言shader包含内建函数名称。至少覆盖中心/边缘、多个距离、log depth开关和视锥变化。

### R2 · P1：默认状态首次启用不能创建所需材质输入

**位置：** [src/VisualPipeline.js:552](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js:552>)、[src/VisualPipeline.js:187](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js:187>)。

setLighting先applyMaterialChannels，随后applyLighting才将materialChannelsEnabled/albedoEnabled置true。构造时的apply顺序也相同。因此默认关闭材质通道时，第一次请求并未实际拉起生产者。

**实测：**

- 第一次setLighting({mode:'deferred'})后：valid=false，reason=No current material G-buffer。
- 再调用相同接口一次：材质输入和照明才变为有效。
- 夹具预先开启materialChannelsEnabled/albedoEnabled，掩盖了正常接入路径的缺陷。

同时，把依赖写进用户的显式选项会使它们在切回enhanced后继续保持true。实测关闭照明后材质生产者仍enabled，持续承担额外绘制/分配。

**建议：** 用lightingMode作为材质/albedo的消费者需求，在创建生产者之前计算依赖；不要污染用户显式开关。默认首次调用即生效，撤销消费者后保留其他用户/效果需求并释放无用依赖。

### R3 · P1：每帧创建FBO，程序与RenderState释放路径没有接到实际对象

**位置：** [src/lighting/DeferredLighting143.js:256](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:256>)、[src/lighting/DeferredLighting143.js:141](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:141>)、[src/lighting/DeferredLighting143.js:418](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:418>)。

_textureTarget每次返回新包装对象，所谓_fb缓存只在这个临时对象内有效。旧FBO没有显式释放。_ensureProgram将实际shader/command放在this.program，但_releaseStages只检查从未被赋值的this.stages，然后直接丢弃program引用。setTerms还会无条件把program置null。

**实测：** 观察期间创建24个不同写FBO，关闭后24个均未调用destroy；切换term并关闭后，原shader program仍存活。该测试保留对象以检查销毁状态，因此不把24个FBO直接换算为长期显存增长量；确定的问题是每帧分配、无确定释放及shader缓存引用遗漏。

**建议：** 以纹理身份/尺寸缓存一个自有FBO；release操作处理实际command.shaderProgram与RenderState缓存引用。共享viewport quad几何归Context所有，不要销毁它。增加20轮开关/resize/term切换及分配失败测试，统计created/destroyed/active。

### R4 · P1：Framebuffer创建使用全局Cesium，破坏SDK依赖注入

**位置：** [src/lighting/DeferredLighting143.js:264](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:264>)。

类接收并保存this.C，但getter写成`new Cesium.Framebuffer`。浏览器夹具提供了全局Cesium，因此没有发现此问题。

**实测：** 构造器传入可用Cesium对象但不设置globalThis.Cesium，读取写目标立即出现`ReferenceError: Cesium is not defined`。普通ES module集成无需把引擎挂到window，当前实现会在这种合法用法下失败。

**建议：** 始终使用注入的C，并增加无全局命名空间的模块测试。不能为修复它要求所有宿主新增window.Cesium。

### R5 · P1：IBL输入与原生不同，且仍覆盖具有独立IBL配置的模型

**位置：** [src/lighting/DeferredLighting143.js:282](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:282>)、[src/lighting/DeferredLighting143.js:326](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:326>)、[src/lighting/deferredLightingShader143.js:80](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/deferredLightingShader143.js:80>)。

原生1.143从模型的ImageBasedLighting/DynamicEnvironmentMapManager取得SH、镜面贴图、IBL因子及参考系。当前CCR只读取场景自动uniform，用eye-to-world代替模型IBL参考系；STANDARD_PBR_VALID未排除这些具有独立环境配置的普通PBR模型。

**实测：**

| 输入 | 原生模型 | CCR |
| --- | --- | --- |
| SH第0项 | [0.116931, 0.145795, 0.179523] | 场景注入[0.35, 0.4, 0.5] |
| 镜面环境 | 存在模型radianceCubeMap，启用CUSTOM_SPECULAR_IBL | _hasSpecularIbl=false，镜面环境项归零 |
| 显式IBL因子设为[0,0] | 模型尊重[0,0] | u_iblFactor仍为[1,1]，像素flags仍783，可被CCR覆盖 |

报告已经承认自造SH不能完成对照，这一点与本轮证据一致。但问题不只是“再补一组SH系数”：当前材质有效位与环境输入契约不足以保证可以重光照。

**建议：** 定义可用的共享环境契约，使原生参考与CCR消费完全相同的输入；未映射的模型独立IBL应走兼容路径。分别验证IBL关闭、已知SH、已知镜面环境、IBL因子及参考系旋转，不强改用户材质以对齐测试。

### R6 · P1：阴影入口不存在，AO输入产生在照明之后

**位置：** [src/VisualPipeline.js:195](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js:195>)、[src/VisualPipeline.js:222](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js:222>)、[src/ao/ScreenSpaceAo143.js:83](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/ao/ScreenSpaceAo143.js:83>)、[src/ao/ScreenSpaceAo143.js:131](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/ao/ScreenSpaceAo143.js:131>)。

- _deferredShadowVisibility要求customShadow.getReceiverUniforms，但DirectionalShadowPass没有该方法，所以返回null。
- AO在HDR后处理阶段生成，getVisibilityTexture仅返回本帧结果；延迟照明却在更早的opaqueReadHook执行，因此无法取到本帧AO。

**实测：** 自定义阴影ready=true，AO在帧末valid=true，但连续8次照明调用里shadow=false、ao=false。并且原有AO最终颜色调制仍然执行，不能宣称AO已仅作用于间接光。

**建议：** 复用真实阴影接收数据接口；拆分AO计算和最终合成，让可见性在照明前产生，延迟模式下撤掉旧整色调制。测试要读取实际输入与分项光照，不能只看两个模块各自valid。

### R7 · P2：更新单个照明参数会意外关闭延迟模式

**位置：** [src/VisualPipeline.js:544](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/VisualPipeline.js:544>)。

mode参数被文档标为可选，但缺省时无条件设为enhanced。实测在有效deferred模式调用setLighting({debugMode:1})，requested变enhanced、enabled变false。

**建议：** 缺省保留当前mode；显式非法值按既定规范拒绝/归一化。补debugMode、aoStrength、terms部分更新测试，并统一走参数归一化，防止NaN/越界值绕过presets中的范围。

### R8 · P2：失败后“关闭再开启”无法重试，原失败原因被覆盖

**位置：** [src/lighting/DeferredLighting143.js:111](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:111>)、[src/lighting/DeferredLighting143.js:135](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/lighting/DeferredLighting143.js:135>)。

_fail将failed=true，再调用_detach把reason覆盖为Disabled；setEnabled(false)不清failed，随后_attach因failed直接返回。

**实测：** 注入一次GPU分配失败后恢复正常函数，执行enhanced→deferred，仍是failed=true、attached=false、valid=false、reason=Disabled。

**建议：** 区分用户关闭和失败清理，保留错误原因；在明确的关闭/重试动作中重置失败状态并重新分配。覆盖失败发生在安装、shader构造、目标创建和draw的不同阶段。

### R9 · P2：数值门槛允许悄悄丢掉必测材质

**位置：** [scripts/check-deferred-lighting.cjs:160](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-deferred-lighting.cjs:160>)、[scripts/check-deferred-lighting.cjs:201](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/scripts/check-deferred-lighting.cjs:201>)。

脚本只要求supportedSamples.length>0。七种预期支持材质里，red-glossy、green-rough、emissive此次全部被过滤；只剩四项进入门槛。即使未来只剩一块灰板且它通过，脚本仍可能宣告valid=true。

**建议：** 每个预期支持案例必须命中对应材质内部像素，越界/无有效深度/缺flags均视为夹具失败；支持数必须等于预期案例数。单独验证自发光、轮廓排除、透明/未知遮挡和已知不支持材质的保色，不用过滤无效样本代替覆盖。

补充：夹具注释称平面朝向随日期/位置自动适配，实际sunLocalENU缺省是固定常量。它可作为明确固定测试输入，但不能据此宣称跨位置/时刻测试已经成立。

### R10 · P1：并未实现所声明的四颜色附件布局

**位置：** [src/channels/MaterialTarget143.js:9](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialTarget143.js:9>)、[src/channels/MaterialTarget143.js:41](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialTarget143.js:41>)、[src/channels/MaterialTarget143.js:54](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/src/channels/MaterialTarget143.js:54>)。

shader读取四张纹理不等于生产者仅分配四个附件。现有布局基础为normal/emissive/depth/transparency四个附件，albedo是第五个。B02没有修改这个生产者。

**实测：** 当前材质目标colorAttachmentCount=5。只有4个MRT槽位的设备不能取得所需albedo；同时开启其他消费者仍可能升到7/8个附件。计划里“精简四附件、透明coverage另画、4/6/8槽模拟验证”的勾选缺乏实现依据。

**建议：** 按计划实现独立布局契约并保留旧消费者兼容；以实际FBO附件数和模拟4槽限制验证。不应把“四张输入纹理”写成“四附件G-buffer已完成”。

## 3. B02尚未完成的架构目标

### 主绘制尚未接管，不能直接划给B03

实测连续8帧：**原生模型draw 56次、材质重放56次、延迟fullscreen draw 8次**。源码也明确承认保留了原生opaque颜色绘制。作为对照实验可保留该模式，但B02原计划已要求受支持对象的原生PBR主颜色draw为0；不能因仍需原生参考，就把这一交付自动转成B03要求。

数值对照可以在单独参考运行中保留原生；正式deferred模式需要自己的主绘制/深度/ID路由。当前不满足这一门槛，也没有证明性能收益。

### 帧执行能力沿用了过期B01结论

B01修复后的合成前translucent接点已验证MSAA4和多视锥。B02却重新实现写目标选择，挂在opaqueReadHook，并把MSAA拒绝解释为“与B01结论一致”。这是过期描述。

本轮额外加入远处模型，形成**8个真实视锥**。B02运行8帧触发64次opaqueReadHook并重复fullscreen照明，仍报告valid=true。这个结果证明它未限制/验证该模式，不证明数值正确；本轮没有将它描述为已复现多视锥黑屏。

下一步应明确每视锥生产/消费与最终合成契约，复用B01的能力边界与资源接口，不再独立绕过它的安全写入规则。

### 测试不能只锁定当前实现字符串

新增14项测试主要覆盖shader模板，甚至会认可当前错误的反投影形式。需要有真实行为测试保护依赖、资源、失败恢复、SDK注入与位置重建。统计中的supportedPixels/compatibilityPixels始终为0，也没有提供实际覆盖计数；valid只代表本帧执行，不代表材质等价或架构完成。

## 4. 对“9个真实缺陷已修复”的核对

从当前源码可以确认，已经采用全屏quad、显式render state、scene.context、Framebuffer对象、czm_pbrLighting入口、specular编译期分支、模板守卫与纹理采样探针。这些改法存在，但当前report不能独立重放每个历史失败的完整因果链，也不能证明上述实现已闭环。

以下解释需要修正：

- “DrawCommand.execute应用自身状态，而context.draw使用默认pass state”与本地1.143源码不符；[node_modules/@cesium/engine/Source/Renderer/DrawCommand.js:670](<G:/_JavaScript/_IAsCesiumLib/cesium customRenderer/node_modules/@cesium/engine/Source/Renderer/DrawCommand.js:670>)实际就是context.draw(this, passState)。真正差异应检查传入command、framebuffer、uniform或passState。
- “MRT只能通过1×1shader读取”过于绝对。该方法是可用探针；直接读取还需正确readBuffer、附件格式/类型、FBO绑定与缓存。一次GL_INVALID_OPERATION不能推出引擎MRT普遍不可读。
- “误差方向反转，因此可排除色彩空间并定位镜面公式”不是充分归因。当前已确认位置重建错误及两套环境输入不一致，必须先消除这些变量。
- 阴影PCF实际在新模块复制了一份字符串，没有直接共享原模块；当前内容相近不能保证后续不会分叉。

## 5. 建议的修复顺序与退出门槛

1. 修R1位置重建、R2依赖、R3资源、R4注入、R7/R8控制与恢复；先确保通用SDK能可靠启动/退出。
2. 对照用例显式关闭双方IBL，仅比较同太阳、同材质的直接光与自发光；强制所有预期案例参与。
3. 给双方同一套SH/镜面探针/因子/参考系，再验证间接光；不通过调曝光掩盖差异。
4. 正确接入阴影与AO，验证分项作用和执行顺序。
5. 实现真实四附件布局与原生主颜色绘制替换，单独参考模式保留A/B。
6. 完成MSAA/多视锥/不支持材质的有效路由或明确安全退出，更新README/计划勾选，再申请B02验收。

B02当前状态应为：**通用合成场景上的延迟照明对照原型；数值、资源生命周期与架构交付均未通过。B03不宜用来承接尚未关闭的B02基础缺陷。**
