# 阶段一算法参考

> 2026-10-16 前景建筑遮挡修正：Cesium 1.143 的 packed globe depth 在独立 OPAQUE GLB 之前复制。环境效果改为分别解码最终 scene depth 与 globe 辅助深度，在米制下选择最近有效命中，供云、云影、大气与雾共享；保留天空 sentinel 和单视锥门禁。无需新增 Pass 或关闭效果。真实 GLB／不透明盒的 RED/GREEN GPU 证据见 `BUILDING_OCCLUSION_FIX_2026-10-16.md`；不扩展为透明 OIT 前表面深度支持。

> 2026-10-15 云距离适配：俯视维持质量档 30/40/50 km 与原密度羽化；近地远景延伸到球面可见云层远界之外。收缩基准由本地羽化距离与实际云底的球面交点推导，避免地平线刚离屏就恢复 40 km；低空仍保守保留可见地平线云，高空以相机高度/本地距离比例平滑关闭扩展，防止轨道斜看重新铺满全球云。较长占据光程改为向近处分配更多采样的指数距离分段，最多两倍视线步数；短光程与俯视保留旧采样。没有新增纹理或资源池。实际页面与 GPU 数值、连续旋转裁边复现和轨道回归见 `CLOUD_HORIZON_RANGE_2026-10-15.md`；未测正式性能。

### 2026-10-15 夜间光照补全

- 复用 Cesium 1.143 原生 SkyBox 星图与 Moon 几何/纹理/月相；没有新增第三方星图或星表。SkyAtmosphere、SkyBox、Moon 是独立绘制对象，关闭大气壳层不等于关闭星月。
- 月球历算使用 Cesium Simon1994，沿太阳的 ICRF→fixed 回退路径变换，再扣除观察点 ECEF 位置计算有视差的月方向，最后以 inverseFrame 的向量旋转进入大气切球参考系。月高使用观察点椭球法线；月相强度采用地心夹角 Lambert 近似。
- 独立低照度月光与冷天光不随太阳 daylight 归零。云与夜间大气复用已发布介质 T/M，夜空不把太阳专用 SkyView 当月亮 SkyView；原生材质使用实际 DirectionalLight 与受所有权保护的夜间漫射 SH。强度为可视化工程标尺，未经真实夜间照度标定。
- 原生地球单独在 GlobeFS 已解码的影像/材质颜色上叠加冷天光照明，保留地表反照率与 alpha；通过共享 ContextDrawDispatcher 的夜间 handler 派生缓存 program，提交后恢复原 command。没有第二个 context.draw wrapper，不用雾色代替地表受光。
- 原生 Moon.onlySunLighting 仍在 Phong 中读取 scene.light 的颜色，因此适配器仅在夜间将默认月盘 Image 材质改为太阳 Lambert emission。使用非深度写入环境绘制，避免短单视锥把月距片元丢弃；保留真实角尺寸、纹理与月相，日间和停用恢复。该私有材质适配仅支持固定 Cesium 1.143，用户自定义颜色、repeat、透明度或自定义材质不被接管。
- 公开 API 参考：[Moon](https://cesium.com/learn/cesiumjs/ref-doc/Moon.html)、[SkyBox](https://cesium.com/learn/cesiumjs/ref-doc/SkyBox.html)、[Simon1994PlanetaryPositions](https://cesium.com/learn/cesiumjs/ref-doc/Simon1994PlanetaryPositions.html)。实现及验证边界见 `docs/verification/rendering-performance/NIGHT_LIGHTING_FIX_2026-10-15.md`。本轮不修改全局曝光，不宣称物理测光或性能目标已达成。

本轮实现保留 CCR 的资源/材质/生命周期代码，自行编写适配 1.143 的数学和采样函数，没有复制 TianjingMap3D 的完整模块或改造引擎。

- HBAO 地平线搜索：NVIDIA gl_ssao 示例 https://github.com/nvpro-samples/gl_ssao/blob/master/hbao.frag.glsl ，由本地 Tianjing `hbao/ambientOcclusionGenerate.js` 的来源注释定位。CCR 采用几何切平面、8方向8步和既有保守覆盖契约。
- Bloom 多尺度13点降采样、tent 重建与软阈值：参考 Unity PostProcessing 的公开滤波形式 https://github.com/Unity-Technologies/PostProcessing/blob/v2/PostProcessing/Shaders/Builtins/Bloom.shader 及本地 Tianjing HDRBloomEffectPass 的调用组织。CCR 使用自己的显式双线性采样、归一化混合和 HDR 接口。
- 球壳云求交：本地 Tianjing `mergeShader/volumetricClouds.js` 提供云上/云下/云中路径参考。CCR 的椭球归一化、稳定二次方程、CPU/GPU区间对照和显式图集采样为本轮实现；使用已有 CCR 自生成噪声，无新增第三方纹理。
- SMAA 的既有许可随产物 `THIRD_PARTY_LICENSES.txt` 提供；Cesium 引擎外置，许可由其完整发行目录提供。
- 2026-09-15校园空间AA：SMAA均衡阈值0.05参考Tianjing SMAAEffectPass；沿用现有three.js/SMAA shader和查找表配对。FXAA通过外置Cesium的 `_shadersFXAA3_11` 复用NVIDIA FXAA 3.11，其原许可保留在Cesium发行shader中；CCR只提供参数与最终颜色阶段接入，未内嵌另一套FXAA实现。

- 2026-10-14 云形修正：固定 three-geospatial `b012ad06d858fc035d88aacfd73f092f93c994e4`，复用其 Perlin-Worley 云形、Worley 侵蚀和周期噪声源码，离线生成 CCR 原有尺寸的 528×528 RGBA 图集（64³，含环绕边框）。原文件与 MIT 许可保存在 `src/environment/reference/three-clouds/`，构建产物携带许可。运行时使用双 HG 相函数、多散射近似和连续消光，光线与视线共享同一密度场；CCR 的球壳、深度和 HDR 适配独立实现。

### 2026-10-15 云传输与早晚分层

> 同日 P1 后续更新：现已接入 Hillaire 二维 T/M/Sky（保留原气体系数）；完整 Bruneton 仍未实现。运行时天空查 Sky、有限距离用短 view march＋T/M、云太阳/漫射天光共享介质。原子双版本、实际 Graph transient、R32F 历史与验证范围见 `docs/verification/rendering-performance/P1_HILLAIRE_GRAPH_2026-10-15.md`。这属于新阶段，不是先前视觉修复记录已经完成的内容。

> 同日天际线/轨道回归修正：表面高度雾改为实际球面高度分段积分，避免平面外推地下导致光学深度饱和、地表被灰雾覆盖。局部解析指数积分继续复用，未通过修改曝光补偿。有效远地表、轨道颜色及数值验证见 `ATMOSPHERE_HORIZON_FOG_FIX_2026-10-15.md`。

> 同日日落云照明修正：Hillaire M 的 Psi 是角平均辐亮度，云从现有半球估算 E=pi*Psi 恢复 Psi，纠正误用上游标量辐照度的 1/(4*pi) 导致四倍损失；复用已有查表。太阳多散射由三阶补为固定上游 qualityPresets 的八阶，保留厚云长光程的高阶贡献。未修改太阳强度、曝光、daylight 或太阳大气透射下限。真实 GPU 数值与 15 个实际 SDK 场景见 `CLOUD_SUNSET_LIGHTING_FIX_2026-10-15.md`；未进行耗时测试。

> 同日云团结构/明暗更新：按用户提供的 liaomz 2025-02-13 云海图验证。主体/细节世界周期改为 16 km/1.2 km，weather 保留 32 km，三者与运动各轴包裹共用合同。积云单层天气有效 height bias=.7、上游 shapeAmount=1.25，层云保留旧低轮廓；积云/层云消光分别 .06/.03。云天光按真实密度向上下边界积分，采用归一化八阶近似保留间接光，不再额外叠加 LUT M 已包含的地面半球。曝光/显示对比未调整。真实 GPU 场/公式与实际 SDK 定点对照、尚存的正午平软和细节差距见 `CLOUD_STRUCTURE_LIGHTING_FIX_2026-10-15.md`。

- 修正球面 MISS 根 `(1e9,-1e9)` 被错误当成行星遮挡的判定。太阳光线未击中地球时不再被置零；三种质量档均新增真实 WebGL 回归。
- 生产合成使用独立 FLOAT RGB 透射率纹理，移除 8 位对数透射率解码链；原 packed alpha 只保留作旧诊断。辐射量与透射率保持线性，由原生 HDR 链映射显示。
- 固定上游提交不变，移植天气覆盖/高度曲线、形状与细节侵蚀、多散射、powder、云采样点的太阳透射与地面反弹。天气、主体、细节各自周期化，历史帧使用不回绕的材质位移。来源、公式与差异见 `src/environment/reference/three-clouds/TRANSPORT_PORT.md`。
- 云颜色/透射率与云距离独立于场景颜色产出，经过相机/风重投影、3×3 RGB 方差裁剪、T 邻域边界裁剪、距离/T 拒绝后再与大气合成。相机突跳、时刻突跳、天气、质量、原点与尺寸改变会丢弃历史。不是复用场景 TAA，也未实现上游 16 帧交错升采样。
- 地形/模型云影从接收点沿太阳方向采样同一云密度场。现有合并 HDR 采用漫反射直射份额估计，不是上游级联 Beer 阴影图，无法精确分离自发光与镜面分量；边界见 `CLOUD_SHADOW_PORT.md`。
- 当前大气强度基值为 9，来自原生强度 20 的多时刻/方向亮度拟合，不代表物理单位或所有角度等价。此轮分层修复未改变全局曝光与该基值。
- 浏览器的早中晚/四种高度、接收面云影、云量与历史重置证据见 `docs/verification/rendering-performance/CLOUD_TRANSPORT_2026-10-15.md`。完整 Bruneton LUT、四层天气和级联云影没有被宣称完成；没有进行性能测试。
