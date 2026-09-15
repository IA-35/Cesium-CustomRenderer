# 屏幕空间反射与原生环境反射合成实施计划

目标：完成阶段1要求的SSR+CubeMap路径，并继续保留完整阶段1目标（真正延迟光照、5000+灯、UBO、遮挡反馈、HBAO、TAA、全局体积和电影后期），不把SSR子任务当作阶段1完成。

架构：现有材质MRT按需增加两个RGBA16F附件，在同一次模型重放中捕获真实原生IBL镜面贡献和BRDF响应；SSR复用法线、线性eyeDepth、Hi-Z与透明覆盖，在HDR阶段用命中颜色替换被捕获的原生镜面项。未命中保留原生CubeMap，不叠加双份镜面，不以屏幕颜色猜测材质。SSR在AO之前合成，因为捕获的镜面项尚未被AO调制；雾云随后处理。

比较过独立反射MRT重放（重复几何绘制）和直接在屏幕后加亮（破坏能量/重复IBL），采用共享MRT按需扩展。设备不足6附件时SSR明确不可用，原4附件材质/AO继续工作；不得因为SSR关闭既有能力。

## 实施与验收

- [x] 反射shader捕获：从实际1.143的textureIBL取specularContribution与FssEss*iblFactor，保留HDR大气衰减、MASK/蒙皮/原生材质，未覆盖材质失效；实际ShaderSource Node测试和真实PBR GPU样本。
- [x] 按需6附件材质目标：reflectionSpecular(valid alpha)、reflectionResponse(roughness alpha)，共享depth/stencil及未知遮挡写零；只在SSR请求时增加16字节/像素。shader缓存区分layout，启停/resize/缺失能力回归。
- [x] Hi-Z屏幕反射：透视正确屏幕射线与层级深度区间跳跃、厚度/近面/屏幕边界检测；粗糙度决定预算与滤波/置信度。未知、透明覆盖和无效材质不能产生穿透反射。
- [x] HDR合成：source + confidence*(hitColor*response - nativeSpecular)，未命中等于输入，保留alpha及自发光；联合深度/法线/粗糙度上采样，无历史依赖。
- [x] VisualPipeline专用set/get/diagnostics、显式依赖保留、暂停/恢复/销毁、环境/AA重启顺序以及预览控制。默认关闭，主默认画面不变。
- [x] 数值GPU镜面命中/无命中/厚度/未知/透明/粗糙度/屏幕外/多视锥、真实合成颜色与原生CubeMap回退、校园开关和资源证据；全量Node、资源校验、生产构建。

实现文件：channels/reflectionShader143.js；按需扩展MaterialTarget143、materialShader143、MaterialChannels143；新增reflections/ssrShaders143.js与ScreenSpaceReflection143.js；扩展VisualPipeline/presets/preview及对应tests。复用HdrCoordinator priority5，避免另造执行框架。子任务使用现有subagent-driven-development工作流，按文件明确所有权。当前用户已多次授权继续阶段1，不再为常规设计/实施重复停下确认；保留全部未提交工作区。

透明玻璃/水体仍必须保持独立前向/OIT合成；本次先完成不透明反射基础，随后补透明反射表面输入，未覆盖前不宣称玻璃路径完成。清漆、各向异性、风格化改色等未分离分量保留原生反射。全阶段目标逐条完成并得到相应证据前保持目标active。


