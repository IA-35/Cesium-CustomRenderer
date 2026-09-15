# Cesium 1.143 材质 MRT 与多视锥深度实施计划

状态更新（2026-09-09）：已按下列设计实现材质通道V1并完成限定范围GPU验证。实际实现、26项GPU检查、21个真实视锥、资源/性能与未支持范围见 [阶段17交接](evidence/17-material-channels-handover.md)。下文保留设计依据，不能据设计目标扩大已验证能力。未知表面目前采用材质和深度写零的遮挡失效路线，不是通用深度全覆盖；复杂模板/classification/WebVR等仍拒绝。

用户已免除登录业务验收门槛；这不替代 shader 编译、framebuffer 完整性和图像正确性验证。

## 已核实的源码事实

- `public/Cesium/index.cjs` 导出版本为 `1.143.0`。其 `_shadersModelFS`、`_shadersModelVS`、`_shadersMaterialStageFS`、`_shadersmodelMaterial` 与本地 `node_modules/@cesium/engine/Source` 对应 GLSL 文件逐字去首尾空白后相同。下列可读 GLSL 引用已与实际发行资源核对；不要仅凭 npm 版本假定兼容。
- `czm_modelMaterial` 有 `normalEC`、`roughness`、`emissive`、`alpha`、`baseColor`、`specular`，**没有 metallic 字段**。见 `Shaders/Builtin/Structs/modelMaterial.glsl:22`；发行包 `public/Cesium/Cesium.js:1438`。
- `MaterialStageFS.glsl:290` 的 `setMetallicRoughness()` 执行贴图与因子计算并返回 metalness；实际调用位于同文件 `:512`：`float metalness = setMetallicRoughness(material);`。这里可捕获真实 metallic，不能从最终颜色猜测。发行包对应 `:9295`、`:9517`。
- roughness 为感知粗糙度；后续直接光才平方。`material.normalEC` 包括材质法线贴图、双面处理和相关法线阶段；没有 `HAS_NORMALS` 时默认 `(0,0,1)` 不是真实表面法线。emissive 为线性 RGB。
- `ModelFS.glsl:86` 起依次执行 material/custom shader、lighting、feature styling/model color、`handleAlpha()`、line style、clipping planes/polygons 等，最终 `out_FragColor = color;` 仍位于 material/attributes 的局部作用域。发行包 lighting/final output 对应 `:10049`、`:10110`。
- `EdgeVisibilityStageFS.glsl:1` 已使用 MRT locations 1/2；只有定义 `CESIUM_REDIRECTED_COLOR_OUTPUT` 才会抑制这些额外输出声明和写入。发行包对应 `:8585`、`:8637`。
- `ModelVS.glsl:28`、`:32` 保留 morph/skinning，后续保留 instancing/custom vertex/geometry transforms。应复用完整顶点 shader，不另行重建变换。
- 实际 `DrawCommand.shallowClone()` 保留 modelMatrix、vertexArray、instanceCount、count/offset、uniformMap。实际 `Context.draw()` 在提交 uniforms 前由 drawCommand 设置 model matrix；见可读 `Renderer/Context.js:1344`，发行包 `Cesium.js:11637`。

以上 `Shaders/...` 路径相对于 `node_modules/@cesium/engine/Source/`。

## 最小材质 adapter

复用 `src/rendering/cesium/shadows/ShadowReceiver143.js:76` 的 shader/render-state 缓存、浅克隆和释放模式。每次绘制复用当前原始 uniforms、attributes 与资源引用，避免修改原生主通道命令。

1. 仅接受能确认 ModelFS/material-stage 标记的 shader。未知 shader 家族返回明确的不支持结果。
2. 复制顶点 source/defines，保留 skinning、morph、instancing、custom vertex 和 log-depth 配对逻辑。
3. 在 fragment shader 声明带项目前缀的 metallic 临时全局，在 `setMetallicRoughness(material)` 调用后捕获返回值；另设 metallic 有效标志。
4. 将 `lightingStage(material, attributes);` 替换为空操作，保留 material/custom shader、style 和 alpha 计算。
5. 仅替换确认属于 ModelFS 的最终颜色写入为 MRT 写入，不能全局替换所有 source 中的 `out_FragColor = color;`。这样 MASK、style visibility/alpha、line pattern 与 clipping discard 先执行。
6. 添加 `CESIUM_REDIRECTED_COLOR_OUTPUT`，避免已有 edge MRT 输出与新 attachment 冲突。

`shadows/shaderAdapter143.js:64` 的 caster adapter 移除 LOG_DEPTH 并添加 SHADOW_MAP，是光空间专用行为，不能直接用于主相机材质通道。相同主相机 view 下无需 `clippingPlanesInLightSpace()`。

specular/glossiness、unlit、custom replacement material、缺失法线等情况必须用 flags 区分有效数据；不能把默认 metallic=0 或默认法线当成测得值。自定义 shader 可改变材质字段，但没有统一 metallic 字段，不能承诺其 metallic 语义。

## 第一阶段目标格式

| Attachment | 建议格式 | 内容 | 字节/像素 |
| --- | --- | --- | --- |
| 0 | RGBA8 | 八面体材质法线 RG、roughness B、metallic A | 4 |
| 1 | RGBA16F | 线性 emissive RGB、有效性/材质类型 flags A | 8 |
| 2 | R32F | 正眼空间深度 `-attributes.positionEC.z`，0 表示无效 | 4 |

颜色总计 **16 字节/像素，另加 depth/stencil attachment**；这是建议布局，不是已分配内存实测。flags 的位定义和归一化规则须在实现时固定。emissive 不能压入 RGBA8 后仍宣称保留 HDR。

需要 WebGL2、至少 3 个 draw buffers/color attachments 和相应浮点渲染能力。能力检查不能替代实际 framebuffer 完整性检查。仅当深度共享通道与材质通道的可见性完全一致后，才考虑省略第三 attachment。

## 多视锥组装

复用 `DirectionalShadowPass.js:52` 的 COMPUTE 调度入口：`Scene.js:3495` 的 `executeCommandsInViewport()` 先建立本帧 frustum commands，再执行 COMPUTE，随后绘制主场景。应确保新 replay 在其依赖的计算命令之后执行。

按照 `Scene.js:2717` 起的原生顺序重放现有视锥 bins：

1. 每帧只清一次所有 channel color attachments。
2. 由远到近遍历当前 frustum bins，更新 near/far 和 `opaqueFrustumNearOffset`。
3. 每个 bin 清硬件 depth/stencil，**保留前面 bins 的 channel colors**；近处片元覆盖远处通道值。
4. 使用 `indices[pass]` 限定实际命令数，不使用可能包含旧元素的数组长度。不跨 bins 去重；Cesium 已处理 `executeInClosestFrustum`。
5. 更新 `uniformState.updatePass(command.pass)`，feature style 的透明/不透明过滤依赖 `czm_pass`。
6. 启用 log depth 时使用当前对应的 log-depth derived command，保留其 vertex/fragment wrappers；参考 `Scene/DerivedCommand.js:163`。用眼空间深度统一不同视锥数据。
7. 在 `finally` 恢复相机、frustum、viewport、pass 等被修改的状态；自有 framebuffer 不得改写原生颜色附件。

上述 Scene/DerivedCommand 引用相对于 `node_modules/@cesium/engine/Source/`；相关调度与 frustum insertion 行为也已在发行 bundle 中核对。

## 必须处理的边界

**不支持材质的遮挡物仍必须使后方材质数据失效。** 若近处 globe/普通 primitive/未知 opaque shader 只写 depth 而不覆盖 channel colors，远处模型的材质会错误残留。它们应写可用深度并清除材质有效标志，或使用等效且可验证的遮挡失效机制。模型专用通道不能直接称为全场景 opaque depth。

- 不复制 shadow caster 的“一律禁用 stencil”设置。3D Tiles skip-LOD 和 silhouette 使用 stencil；保留主通道必要的 cull/front-face/depth/stencil 语义。
- 排除 silhouette 外扩颜色命令（`model_silhouettePass()` 为 true）和 edge-only passes，它们不是实体表面材质。
- 第一版可限定普通 opaque/MASK Models 与已验证的 3D Tiles 路径。globe depth clear/depth plane、classification、skip-LOD 等组合未复现原生规则前，应明确不支持或降级，不能默认为完整覆盖。
- 透明/OIT 不属于本阶段的材质通道支持范围。

## 分阶段交付与验证

1. **adapter 与资源层**：新增独立 shader adapter、MRT target 和静态测试，复用当前共享屏幕几何的编码/消费者约定。对实际 bundle shader 断言 metallic 捕获、MASK/style/clipping/custom stages 保留、顶点 source 不变、edge MRT suppression、log-depth 与 unsupported flags。
2. **命令重放与生命周期**：实现本帧 bins 重放、缓存失效、resize/disable/destroy 释放及状态恢复。用 mock 验证远到近顺序、每 bin depth clear、每帧一次 color clear、不跨 bin 去重和失败后恢复。
3. **GPU 验证后才启用支持声明**：验证 shader 编译、MRT 完整性、普通/MASK/法线贴图/金属/发光/style/skinning/clipping、至少两个真实视锥、近处不支持遮挡物、resize 与释放。可复用 `tests/rendering/custom-shadow.test.mjs:31` 的结构及现有独立 fixture；无需登录业务验收。

未完成第三阶段时，仅能报告源码/静态验证结果，不宣称完整材质 GBuffer、多视锥全深度或 GPU 画面正确。
