# 不透明材质通道 V1（Cesium 1.143）

显式开启的MRT通道，输出材质法线、粗糙度、金属度、线性自发光、有效位和米制视深度。布局V2增加第四个R8透明覆盖附件，详见 [透明覆盖契约](TRANSPARENCY.md)。它复用当前帧原生命令，额外绘制到自有 framebuffer；不替换主场景照明，也不等于延迟光照已实现。

## 使用

```js
pipeline.setMaterialChannels({ enabled: true })
pipeline.getMaterialDiagnostics()
pipeline.setAlbedo({ enabled: true })
pipeline.getAlbedoDiagnostics()
const textures = pipeline.materialChannels.getTextures()
// 仅当前帧有效；没有本帧输出、不支持范围、禁用、resize后未重建或销毁时返回null。
pipeline.setMaterialChannels({ enabled: false })
```

默认 `materialChannelsEnabled:false`、`albedoEnabled:false`，不创建实例/primitive/纹理。albedo可独立请求材质生产者，不会隐式开启Hi-Z、AO或SSR。专用设置接口只管理本模块，不重写灯光、曝光、AA或viewer尺寸。管线的禁用、嵌套暂停、恢复和销毁自动交接。发生自有 GPU/命令错误会释放资源并保留错误信息；先关闭再开启才重试，主场景继续渲染。

独立实例可从 `index.js` 导出的 `MaterialChannels143` 创建，构造参数为 `(Cesium, scene)`。`MATERIAL_FLAGS` 同时导出。升级静态 Cesium 必须重验私有命令/Shader适配。

## 格式与语义

| 纹理 | 格式 | 含义 |
| --- | --- | --- |
| normalRoughMetal | RGBA8 | RG八面体编码材质法线；B感知粗糙度；A金属度，均归一化到0–1 |
| emissiveFlags | RGBA16F | RGB线性自发光，可大于1；A直接存整数flags，不归一化 |
| eyeDepth | R32F | V2：正数为已知米制视深度；0为背景；-1为未知不透明遮挡 |
| transparency | R8 | 布局V2：保守透明覆盖，0/1；不是alpha或透射率 |
| albedoOcclusion | RGBA16F | 可选契约1：RGB为MaterialStage求值后、lightingStage前的线性`material.baseColor.rgb`；A为`material.occlusion`，不是透明alpha |
| 自有深度/模板附件 | DEPTH24_STENCIL8 | 重放深度测试和模板，不作为跨视锥米制通道 |

法线来自实际材质阶段，包含法线贴图及双面法线处理；不是屏幕深度重建法线。金属度从 `setMetallicRoughness()` 返回值捕获。材质粗糙度未经lighting阶段平方，自发光未经曝光或tone mapping。自定义材质的数值会保留，但消费者必须遵从有效位。

| flags 位 | 值 | 消费规则 |
| --- | ---: | --- |
| SURFACE | 1 | 识别的模型表面 |
| NORMAL_VALID | 2 | 有源法线且输出非退化/NaN/无穷；自定义REPLACE不默认认为有效 |
| METALLIC_ROUGHNESS_VALID | 4 | 标准PBR metallic/roughness路径；自定义和spec/gloss不赋此位 |
| EMISSIVE_VALID | 8 | 非自定义的可解释自发光 |
| ALPHA_MASK | 16 | MASK材质；被discard的孔洞不写入 |
| UNLIT | 32 | 无PBR光照路径 |
| CUSTOM | 64 | 自定义片元/替换材质 |
| SPECULAR_GLOSSINESS | 128 | spec/gloss路径，不把默认metallic当成测得值 |
| ALBEDO_VALID | 256 | albedo/occlusion来自可识别的原生MaterialStage，数值有限且可由half-float表示 |
| STANDARD_PBR_VALID | 512 | 已验证可由albedo与metalness重建标准metallic/roughness的diffuse/specular参数；不代表所有材质都可重光照 |

启用albedo时旧低8位保持不变。`ALBEDO_VALID`允许0..1之外但half-float可表示的有限基础色，不为方便测试而clamp HDR值。`STANDARD_PBR_VALID`还要求`LIGHTING_PBR + USE_METALLIC_ROUGHNESS + HAS_NORMALS`及有效法线/金属度/粗糙度；spec/gloss、specular、clearcoat、anisotropy、自定义顶点/片元/替代材质、unlit、BLEND、后续样式/modelColor/outline/裁剪边缘等路径不会赋该位。MASK的solid片元可赋该位，discard孔洞保持全零。

本地1.143发行包的标准参数关系为`diffuse=baseColor*(1-metalness)`、`specular=mix(vec3(0.04),baseColor,metalness)`，roughness为感知粗糙度。纹理基础色只执行发行包既有`czm_srgbToLinear`，当前实现为RGB `pow(value, 2.2)`；通道不重复Gamma转换。

自定义REPLACE允许省略原生MaterialStageFS，但必须匹配当前ModelFS。它可能只写diffuse而保留默认法线，所以不赋NORMAL_VALID。所有适用法线在最终输出前还会检查长度与有限性。

不支持的普通不透明遮挡物保留原discard/gl_FragDepth执行，再把材质附件写零、eyeDepth写-1，阻止远处材质残留。`depthContractVersion:2`将它与背景0分开；未知像素仍没有可用距离，**本通道不是覆盖Globe/任意primitive的完整通用深度**。不要将负值当作空白。后续新增的 [共享Hi-Z](DEPTH_PYRAMID.md) 会逐级保留未知遮挡标记。

## 绘制与所有权

在当前帧可见列表建立后的COMPUTE阶段重放，按原生视锥远到近绘制。每帧一次颜色清除，各视锥清depth/stencil、保留已有颜色；使用indices限定有效命令，不跨视锥去重。保留log-depth与HDR派生命令、原顶点变换、蒙皮、实例矩阵、MASK、feature style、裁剪路径。

普通Globe/深度平面只作为无材质遮挡失效项。遵从原生clearGlobeDepth时机。透明命令继续走原生前向/OIT，不提供透明表面材质数据。保留必要模板测试；复杂skip-LOD模板、depth-only模型、classification、edge-only、voxels、Gaussian splats、透明Globe、invert classification和WebVR明确拒绝，不能把中心相机数据冒充双眼数据。

范围为透视3D。原生分屏/特殊渲染插件及上下文丢失恢复未单独验收。MRT当前单采样，不能假设其轮廓覆盖与MSAA解析后的主颜色完全一致。仍未提供运动矢量、透明材质法线、延迟光照或统一纹理池。

原命令、Shader和uniform map不被替换。自有program/render-state缓存120帧后淘汰，停用时释放全部自有资源，并配对释放Cesium RenderState缓存引用。framebuffer分配或完整性失败会清理已创建资源。MRT纹理由本模块直接持有，不受普通postprocess stage临时纹理别名复用影响；消费者每帧取得当前纹理，在本模块执行之后使用，不能跨resize/停用保存引用。

## 资源与验证

布局V2颜色附件17字节/像素，加depth/stencil共21字节/像素。1080p自有纹理合计43,545,600字节（41.53MiB），不含驱动开销；与共享屏幕几何同时启用会分别分配，尚未去重。它增加几何和覆盖绘制，并非渲染提速功能本身。

复用本机已安装Playwright：

```powershell
python -m http.server 8766 --bind 127.0.0.1
# 在项目根目录的另一终端，按需设置已安装模块路径：
$env:CESIUM_PLAYWRIGHT = '<playwright模块绝对路径>'
node tests/rendering/run-materials.cjs
```

该无窗口测试使用真实WebGL，覆盖三个附件、原色保持、材料参数、HDR自发光存储、法线贴图、无效自定义法线、MASK、透明排除、裁剪、动态变换、蒙皮、真实多视锥、跨视锥未知遮挡、resize、十轮启停及校园HDR/SMAA/几何联动。原始证据按次保存在 `plan/evidence/17-materials-*/`。单独浏览器入口为 `shadow-fixture.html?materials=1`，执行 `fixture.runMaterialChecks()`；校园预览已有材质开关和状态按钮。

测试结果只支持实际覆盖的配置。GPU查询是该额外Pass的诊断时间，不是整场景60秒前台帧率验收；正式性能继续使用独立基准入口。
# 可选反射附件（契约1）

SSR请求时通过`setReflectionEnabled(true)`按需增加location4/5两个RGBA16F附件：`reflectionSpecular`为原生IBL镜面项与有效alpha，`reflectionResponse`为BRDF响应与感知roughness。未请求时getTextures不包含这两个字段，仍保留原四附件返回形状。原材质layoutVersion保持2，新增reflectionContractVersion1。设备不足6槽或反射目标分配失败时，基础四附件继续可用；getReflectionDiagnostics记录原因。实现与边界见[反射模块](../reflections/README.md)。

透明反射通过`setOpaqueColorEnabled(true)`再按需增加location6 RGBA16F `opaqueColor`（契约1），保存识别ModelFS的原生不透明最终颜色。不支持/未知表面写0并保持未知深度，透明覆盖不覆盖这个附件。七附件45字节/像素；缺7槽或分配失败降级到原六附件，`getOpaqueColorDiagnostics()`单独说明状态，不连带关闭不透明SSR/AO。

# 可选albedo/occlusion附件（契约1）

`setAlbedoEnabled(true)`在当前基础布局末尾增加一个RGBA16F附件：无反射时为location4（5附件/29字节每像素），反射时为location6（7附件/45字节每像素），透明反射不透明颜色同时启用时为location7（8附件/53字节每像素）。关闭时`getTextures()`保持原有4/6/7字段形状，不追加`undefined`。

设备槽位不足或新增附件分配/完整性失败时，只撤销albedo并保留已有4/6/7布局；`getAlbedoDiagnostics()`分别报告requested/supported/enabled/valid/error，显式关闭再开启才重试。布局变化使本帧输出、Hi-Z和对应Shader缓存失效，但不移除primitive hook、显式材质请求或其他消费者。未知不透明表面将albedo写零并保留eyeDepth=-1，透明coverage重放不写albedo。

GPU验收入口为`node tests/rendering/run-albedo.cjs`。它读取实际RGBA16F通道，并用独立ModelFS重放直接输出原生`material.diffuse/specular`，再与从albedo及RGBA8 metalness进行的独立GPU重建比较；测试不以待测重建函数生成参考值。
