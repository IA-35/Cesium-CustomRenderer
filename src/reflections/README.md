# 屏幕空间反射（Cesium 1.143）

支持已分离原生镜面项的不透明PBR模型。命中时替换对应的环境反射，未命中保留原生CubeMap；默认关闭，不改模型材质参数。

```js
pipeline.setScreenSpaceReflections({ enabled: true, distance: 150, thickness: 0.5, strength: 1 })
pipeline.setScreenSpaceReflections({ transparent: true }) // 可选透明PBR逐层反射，默认关闭
pipeline.getScreenSpaceReflectionDiagnostics()
pipeline.getTransparentReflectionDiagnostics()
pipeline.setScreenSpaceReflections({ enabled: false })
```

开启后自动请求材质、Hi-Z与两项反射附件；关闭时仍保留AO或显式请求的共享依赖。专用设置接口不改灯光、曝光或抗锯齿状态。

## 数据与合成

同一次材质重放按需从4附件扩为6附件，新增两个RGBA16F：

| 附件 | 内容 |
| --- | --- |
| reflectionSpecular | 原生IBL镜面RGB，alpha为有效标志 |
| reflectionResponse | 原生BRDF响应FssEss×iblFactor.y，alpha为感知roughness |

从静态包原生textureIBL捕获真实分量，保留原生fog对两项的线性衰减。不是从最终颜色猜测albedo或再次加亮。主材质布局版本仍为2，反射契约单独为1；基础4附件及深度契约不变。设备不足6槽或反射附件分配失败时，保留基础材质/AO，反射诊断报告不可用。

追踪沿屏幕网格进行透视正确DDA；最多使用5层Hi-Z跳跃，区间不相交才跳过，存在未知值时下降到单像素。反射启用时Hi-Z额外纳入透明覆盖：B=0，A按位保存1=未知不透明、2=透明覆盖、3=两者；父层按位OR保留标记。R/G仍是不透明深度。不透明反射遇任何标记保守停止；透明接收面只把不透明未知位当作硬阻断。

粗糙度影响步数（最多160）、置信度与邻域滤波。厚度为米，默认0.5；最大射线距离150m，可设1–2000m。屏幕边缘渐隐、近面截断，roughness≥0.85保留原生反射。半分辨率trace以全像素0、2、4…为anchor，全分辨率resolve使用同一整数位置映射及深度/法线/粗糙度约束；当前anchor未命中时不从邻域补回反射。

合成公式：`source + confidence × (hitRadiance × response - nativeSpecular)`；保留原alpha。HDR顺序为不透明SSR(5)→可选透明SSR(6)→AO(10)→体积环境(20)→原生ToneMap/后期。SSR必须在AO前，因为捕获的原生镜面项尚未乘AO。

## 透明PBR逐层反射

透明反射按需增加location6的RGBA16F `opaqueColor`，保存原生不透明颜色，避免反射采到玻璃自身的合成色。片元沿用实际透明模型的位置、法线、材质和alpha；不把多层玻璃压成单个最近表面。

排序透明逐层混合差值，前层alpha正确衰减后层反射；不反射的前层仍参与衰减。OIT逐片元累加`delta×alpha×czm_alphaWeight`，使用原生累计权重/revealage还原最终差值，支持MRT和multipass。原生透明纹理与最终alpha保持原样。深度手动比较不允许位于已知不透明面后方的透明片元写入；未知不透明遮挡保守旁路。复杂模板、非标准混合、禁用深度测试等不兼容命令使透明反射整帧旁路，避免遗漏前层。

七附件需要7个MRT槽位；不可用时保留不透明SSR六附件和AO。七附件材质含深度为89.0MiB/1080p，透明反射另有两个RGBA32F目标共63.28MiB；只在请求透明反射时增加，尚未池化或完成正式帧时优化。版本限定的OIT适配补齐1.143原生WebGL2 multipass派生源缺少的输出声明，不改静态引擎包。

## 范围与成本

已支持当前原生PBR、金属粗糙度/镜面光泽度、法线贴图及受支持模型多视锥深度。MASK可作为命中物，但不作为接收镜面；BLEND/PBR可通过透明选项逐层反射。Globe、原生Water材质Primitive及未知材质尚无反射材质通道；不支持透明物之间的递归反射和折射。清漆、各向异性、自定义shader、改色样式、轮廓/裁剪边缘等尚未分离镜面分量的路径保留原生效果。内部灰度阴影诊断动态使捕获失效。

高粗糙度回退、薄物体、屏幕缺失信息仍是屏幕反射限制；当前没有运动矢量、时间历史或TAA，边缘可见空间采样锯齿。不能据此宣称已完成阶段1的所有反射材质和抗锯齿要求。

1080p按需增加反射材质附件31.64MiB，材质目标合计73.17MiB；SSR自有半RGBA16F+全RGBA32F合计35.60MiB，Hi-Z另计10.55MiB。只是逻辑活动纹理成本，不是整体显存或性能结论。暂停、关闭、resize及销毁释放自有资源，不销毁借用的主HDR/材质/Hi-Z。

`node tests/rendering/run-reflections.cjs` 运行真实GPU数值、材质捕获、红绿箱体镜面、非log多视锥、奇数resize、透明覆盖和校园联合生命周期检查。需本地8766服务与CESIUM_PLAYWRIGHT指向已有安装；输出在plan/evidence/22-reflections-*。默认校园资产部分原生iblFactor.y=0，SSR遵守该值，不强行把草地/路面改成镜面。

`run-transparent-reflections.cjs` 验证排序透明、OIT MRT、原生OIT multipass和非金属玻璃的逐像素合成、双层/非反射前层、深度遮挡、移动、resize与释放；`run-transparent-reflection-campus.cjs` 验证与不透明SSR/AO/环境联合启停。所有GPU脚本按序运行。
