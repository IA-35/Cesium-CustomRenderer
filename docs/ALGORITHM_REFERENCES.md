# 阶段一算法参考

本轮实现保留 CCR 的资源/材质/生命周期代码，自行编写适配 1.143 的数学和采样函数，没有复制 TianjingMap3D 的完整模块或改造引擎。

- HBAO 地平线搜索：NVIDIA gl_ssao 示例 https://github.com/nvpro-samples/gl_ssao/blob/master/hbao.frag.glsl ，由本地 Tianjing `hbao/ambientOcclusionGenerate.js` 的来源注释定位。CCR 采用几何切平面、8方向8步和既有保守覆盖契约。
- Bloom 多尺度13点降采样、tent 重建与软阈值：参考 Unity PostProcessing 的公开滤波形式 https://github.com/Unity-Technologies/PostProcessing/blob/v2/PostProcessing/Shaders/Builtins/Bloom.shader 及本地 Tianjing HDRBloomEffectPass 的调用组织。CCR 使用自己的显式双线性采样、归一化混合和 HDR 接口。
- 球壳云求交：本地 Tianjing `mergeShader/volumetricClouds.js` 提供云上/云下/云中路径参考。CCR 的椭球归一化、稳定二次方程、CPU/GPU区间对照和显式图集采样为本轮实现；使用已有 CCR 自生成噪声，无新增第三方纹理。
- SMAA 的既有许可随产物 `THIRD_PARTY_LICENSES.txt` 提供；Cesium 引擎外置，许可由其完整发行目录提供。
- 2026-09-15校园空间AA：SMAA均衡阈值0.05参考Tianjing SMAAEffectPass；沿用现有three.js/SMAA shader和查找表配对。FXAA通过外置Cesium的 `_shadersFXAA3_11` 复用NVIDIA FXAA 3.11，其原许可保留在Cesium发行shader中；CCR只提供参数与最终颜色阶段接入，未内嵌另一套FXAA实现。
