# TAA 主画质与完整 SMAA 替代模式

> **已回退，以下为被撤回候选的历史记录。** 用户报告窗户、细线严重闪烁并要求恢复上一版本。已撤回本轮TAA/SMAA升级、默认配置与GUI改动；重新构建的SDK SHA256精确恢复为`e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`。下文指标不能作为当前版本或用户验收通过的结论。候选代码、测试和脚本副本保存在`rejected-candidate/`；SDK候选副本保存在本机TEMP。原有大气、云、日夜光照及建筑遮挡修复未撤回。

日期：2026-10-16。实现及开发侧验证完成，用户视觉验收待确认。本轮未提交或推送，未调整已验收的大气、云密度、日夜光照和曝光。

## 交付行为

- 默认 `antialiasing: 'taa'`，MSAA=1、原生像素；完整空间 SMAA 为清晰度优先替代。稳定运行时只有一个 AA 主路径。
- 示例 GUI 显示“TAA（画质优先）”“SMAA（清晰度优先）”，画质按钮实际切到 TAA；保留明确选择 FXAA、off、MSAA 的接口。
- 不支持 TAA 的 WebGL/浮点附件设备保留 native FXAA，并保留 requested/effective/reason 区分。多视锥等既有能力边界继续回退，不把无效历史用于混合。
- SDK：`build/0.1.0/CCR.min.js`，2,330,453 bytes；SHA256 `e034d4b55398c9dd38a578dc5fe9d9744bc7f1bd2d85d027bf69c15c76761558`。SMAA 查找表内嵌，许可证随构建同步。

```js
pipeline.setAntiAliasing('taa')
pipeline.setAntiAliasing({ mode: 'smaa', quality: 'balanced' })
pipeline.getTaaDiagnostics()
pipeline.getRenderDiagnostics().antiAliasing
```

## TAA 的实际改动

1. 修正 Gamma 插值：参数 z=静止1.5、w=运动0.75，原 shader 反向插值，运动时反而扩大接受范围。端点行为先 RED 后 GREEN。
2. 保留当前原始光栅覆盖样本。原 `outputUV+jitter` 的当前帧 Catmull 重建抵消部分亚像素覆盖；现直接取原生 raster texel，历史继续 Catmull，camera reprojection 补偿当前 jitter，历史深度与该 raw texel 配对。
3. 在压缩 HDR 的 YCoCg 域计算邻域矩、方差与中心方向 AABB clipping，防止高亮离群值无限撑宽 RGB 盒。最终在线性 HDR 混合，不通过显示层锐化/模糊补偿。
4. 当前/历史邻域颜色变化产生 reactivity，同时限制静止 coverage 与延长历史。不能把“相机静止”当作“场景静止”。对静止子像素覆盖噪声保留容忍区间。
5. 独立、不透明、普通刚体 GLTF Model 接入物体速度。实际 native color draw 后，只为本帧 primitive 矩阵变化的白名单命令追加辅助 draw；使用现有 dispatcher 与 executor bypass，原生主颜色恰好一次，不重放整场景。
6. 每 primitive 深克隆前后矩阵。RGBA32F 记录 `previousStableUV-currentStableUV`、current eye depth、previous eye depth；合法零 XY 与 clear sentinel 可区分，沿 Z 移动也有独立前帧深度。resolve 与最终 scene depth 核对，避免读取被后来前景挡住的后景速度。
7. 静态场景不分配 motion target；首次实际移动才分配。已有目标停动后清零，resize/reset/destroy 释放。unsupported shader 也参与120帧未使用淘汰。新出现/恢复可见的 GLTF 使用局部拒绝，不重置全屏历史。

## 完整 SMAA

- 固定 MIT 上游 `dmnsgn/shaders-smaa@1d73155c07e1bd68a53536c5b517ece08c2cae11`，原始 GLSL 保存于 `src/antialiasing/smaaUpstream.js`。
- High/Ultra 包含完整对角搜索、diagonal area 和水平/垂直角点处理、双邻居归一化混合。
- sharp/balanced 使用 High，smooth 使用 Ultra；阈值0.1/0.05/0.035，水平垂直搜索16/16/32，对角搜索8/8/16。
- 配套 Area 160×560，SHA256 `e450ae401365efbb60210dbe083298becfc5a898a4aa06708a9b47ede3c0769e`；旧Area与配套表有408个RG像素差异，本轮替换。
- Search 保留66×33原文件，shader 精确映射上游64×16裁剪/翻转/值域。1024真实texel与578种边编码/边界对应测试通过。保持最终 gamma 显示颜色输入，不进行第二次 gamma 转换。
- 真 WebGL2 发现移植时漏带 vertex 偏移计算的 `mad` 宏，已修复；三档均实际 `effective=smaa`，非 FXAA 回退。详见 [三档结果](smaa-qualities.json)。

## 画质与速度数值证据

程序化 GLB，640×420、DPR1、固定相机/光照，Chrome headless / ANGLE D3D11。细线覆盖多角度与亚像素宽度，参考使用每维3倍分辨率（9样本），先在线性 HDR 下平均，再经过同一 Cesium tone map 和 CCR 调色。前后参考 PNG SHA256 完全一致：`3125aac8aa190626e5eec9081071c7796b2ed39f61a5b2b3deccd428cdaa9211`。

旧基准 SDK：`e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`，保留其内嵌旧查找表。新算法测量使用当前源码；最终 UMD 另在实景和轮廓中验证。

| 模式 | 旧边缘 RMSE | 新边缘 RMSE | 解释 |
|---|---:|---:|---|
| off | 37.8472 | 37.8472 | 相同基准 |
| FXAA | 36.3173 | 36.3173 | 未修改 |
| SMAA | 34.9318 | 35.4324 | 本细线夹具略差约1.43%，不宣称完整空间实现对所有内容都优于旧版 |
| TAA | 20.1555 | 15.9465 | 本夹具边缘误差降低20.88% |

静止180帧后相邻一对帧的全图平均绝对亮度差（0–255）旧0.01421、新0.01506；这不是长时间闪烁验收，也不宣称所有静止闪烁消失。当前保留线性 HDR 混合；调试中的压缩域混合未采用。

动态表统计离最终真实轮廓至少2像素、3×3/5×5参考区域颜色稳定的平坦像素；与同一最终姿态的 off 参考比较，平均通道误差>8计为错误像素。它检查已揭露背景/表面上的残留色，不把AA边缘差异直接算拖影。

| 运动 | 旧错误像素 | 新错误像素 |
|---|---:|---:|
| Model平移 | 23 | 6 |
| Model平移并改变距离 | 12 | 7 |
| Model纯深度移动 | 9 | 6 |
| Model平移并旋转 | 17 | 10 |
| 相机移动 | 10 | 9 |
| 相机与Model同时移动 | 16 | 11 |

实际读回运动RGBA32F，与 Cesium CPU 变换预期比较：最大 UV 速度误差0.00970像素，current/previous eye depth最大误差0.00000153米。仅相机移动时没有 Model 辅助draw；物体移动时一条辅助draw。证据：[旧结果](before.json)、[新结果](after.json)、[TAA放大对比](taa-comparison.png)。

## GPU测量范围

上述生成场景，off/SMAA/TAA各3轮×300帧，预热90帧；前后各2700帧。GPU查询在整帧与AA作用域间交替，避免嵌套查询；AA模式每轮150有效AA查询和150整帧查询，off每轮300整帧查询。所有轮次query availability=100%、无disjoint、pending=0、GL error=0。

| AA GPU耗时（毫秒，三轮范围） | 旧 p50 | 新 p50 | 旧 p95 | 新 p95 |
|---|---:|---:|---:|---:|
| SMAA | 0.131–0.154 | 0.157–0.159 | 0.793–1.043 | 0.865–1.024 |
| TAA | 0.234–0.236 | 0.220–0.232 | 0.802–1.239 | 0.660–1.183 |

TAA CPU提交p95旧1.4ms，新1.3–1.8ms；未建立置信区间，不据此声称CPU无回归或性能提升。测试为固定小场景，GPU有尾部波动；不能外推1080p/4K校园帧率，也不替代此前未完成的环境全管线性能里程碑。

静态640×420 TAA自有纹理合计11,827,200B，其中stage历史5,376,000B、已有RHI历史复制6,451,200B；旧诊断漏记RHI，本轮补齐，不能把统计口径修正当作新增分配。运动时额外4,300,800B（16B/像素）；1080p约31.64MiB、4K约126.56MiB。已分配motion停动后保留并清零直到reset/resize/关闭。这里是自有纹理分配，不是整卡显存峰值。

## 实景、交互与回归

- 实际校园70个GLB、1200×720、最终UMD；URL未加singleFrustum参数。默认实际`requested=taa/effective=taa/valid=true/frustums=1`，不是只改下拉框。该门槛仍因相机/场景而异。
- 切换TAA/SMAA均有效，无页面/GL错误；中心拾取命中Model；TAA静态场景motion.bytes=0。记录：[campus.json](campus.json)，图片：[TAA](campus-taa.png)、[SMAA](campus-smaa.png)。该实景没有开启交通、植被、水、影像，未测试完整动态负载。
- UMD选中轮廓：原生ID、边缘输出、最终青色轮廓在16帧抖动周期、相机移动、重启TAA后逐像素稳定，清除选择正常。证据：[selection.json](selection.json)。
- Node：1031项，1028通过、3跳过、0失败；GLSL嵌入137文件解析通过，完整SMAA四个生成预设无保留qualifier；真实环境shader编译通过，AA shader由实际渲染覆盖。
- `npm run build`、专项diff whitespace检查通过。规格与代码审查发现的缓存淘汰、全屏reset、静态分配及unsupported默认AA回退问题均已修正。

## 明确边界

物体motion仅覆盖独立不透明普通刚体GLTF primitive矩阵变换。Tiles、蒙皮、morph、实例化、自定义顶点位移和透明对象不宣称具备正确运动向量；继续使用深度/颜色reactivity，复杂同色同深度动态和透明/体积对象仍可能拖影。保留既有单视锥透视HDR门禁。动态云自身的时域重建没有重写。

不能从本夹具宣称“完全无拖影”“SMAA全面提升”或“生产性能目标达成”。用户最终视觉验收仍以实际项目交互为准。

## 复现

```powershell
$env:CESIUM_PLAYWRIGHT='C:/Users/Administrator/node_modules/playwright'
node scripts/performance/judge-antialiasing-quality.cjs --before --measure
node scripts/performance/judge-antialiasing-quality.cjs --measure
node scripts/performance/check-antialiasing-campus.cjs
node scripts/check-glsl-embedding.cjs
node scripts/performance/check-shader-compile.cjs
npm test
npm run build
```

`--before`读取`CCR_AA_BASELINE`指定目录（默认本机TEMP/ccr-aa-baseline-2026-10-16）的旧CCR.min.js；旧SDK内嵌原LUT。实景检查需要`localhost:8083/Dongda`的既有数据服务。脚本GPU任务必须串行运行。

## 参考来源

- [固定SMAA GLSL](https://github.com/dmnsgn/shaders-smaa/tree/1d73155c07e1bd68a53536c5b517ece08c2cae11/packages/glsl-smaa)，MIT，版权随包。
- [Playdead temporal](https://github.com/playdeadgames/temporal)，MIT，YCoCg/AABB思路。
- [Intel TAA](https://github.com/GameTechDev/TAA)，variance clipping与运动/静止Gamma算法说明；未复制其DX12 Compute管线。
- [Three.js TRAA](https://github.com/mrdoob/three.js/blob/c94d808a4c773375bf221b13e61938e0aef9aea0/examples/jsm/tsl/display/TRAANode.js)，历史有效性与运动权重的工程对照；没有引入Three渲染器。
