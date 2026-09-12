# 透明覆盖与原生前向/OIT边界

材质布局V2新增 `transparency` R8纹理：0表示未标记覆盖，1表示保守的透明片元覆盖。它不是透明颜色、alpha、透射率或透明表面GBuffer。透明颜色仍由Cesium原生前向/OIT绘制，当前没有替换成自有延迟光照引擎。

```js
pipeline.setScreenSpaceAO({ enabled: true })
const textures = pipeline.materialChannels.getTextures()
// textures.transparency：当前帧R8覆盖图；正常情况下由AO自动消费。
```

## 生成顺序

材质FBO现在有4个颜色附件，新增location3写透明覆盖0；另外一个仅绑定R8覆盖图的FBO共享同一个depth/stencil纹理。每个视锥按原生顺序执行：

1. 远到近处理各视锥，清depth/stencil并保留远视锥颜色。
2. 不透明绘制写材质/深度，同时将可见像素的覆盖写0，清除被遮挡的远处透明覆盖。
3. 按原生规则将near从opaque偏移恢复为当前bin.near，保留不透明硬件深度。
4. 重放TRANSLUCENT命令到独立覆盖FBO，保留原discard和gl_FragDepth，关闭颜色混合、depth写入和stencil写入，保留深度测试。

透明重放不附着材质或eyeDepth颜色目标，不会覆盖不透明数据。顺序无须按颜色混合排序，因为覆盖是二值并集。

## AO消费

普通受支持透明物体不再导致整帧AO关闭。覆盖像素在HDR合成时保留原色；AO估计在对应2×2覆盖单元保守返回中性，避免借用透明面后方的深度。未覆盖区域继续AO。现有MASK/unlit/custom接收面规则保持。

## 保守边界

- 重放保留原片元discard，但不从alpha猜测贡献；零alpha片元可能被过度标记。这样宁可少算局部AO，也不误改透明颜色。
- 含原生深度采样依赖的Shader不能在COMPUTE时安全重放，检查覆盖vertex和fragment源码。某些billboard/label变体即使条件分支未启用，也会保守拒绝。
- 半透明silhouette/edge命令不静默漏掉，而是使当前生产者输出无效。复杂模板等原有门禁继续保留。
- 这类可识别范围限制只旁路当前帧；对象移除后自动恢复。真正GPU/分配错误仍使用原off/on重试规则。
- 二值、单采样覆盖不等于完整MSAA透明覆盖，不提供玻璃/水面自身法线、深度或折射参数。SSR透明接收端还需要额外表面数据。
- 自定义渲染插件和未识别的自定义采样依赖必须另行验证，不扩大当前支持声明。

## 资源与验证

需要至少4个draw buffers/color attachments。覆盖图新增1字节/像素；1080p新增2,073,600字节（约1.98MiB），材质自有纹理总计43,545,600字节（41.53MiB）。覆盖FBO共享depth/stencil，销毁时不会重复释放共享纹理。透明命令额外重放，开销取决于透明内容；没有正式整体帧率结论。

`node tests/rendering/run-transparency.cjs` 分别在默认OIT与关闭OIT时验证可见覆盖、前向颜色不变、不污染不透明深度、隐藏/被遮挡清除、跨视锥、普通深度near边界、discard、暂时旁路自动恢复、resize和释放。AO与材质原有回归另行运行。证据位于 `plan/evidence/20-transparency-*/`。
