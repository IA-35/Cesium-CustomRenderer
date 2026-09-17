# 自定义方向光阴影

此目录实现阴影贴图、光源相机、瓦片选择、光空间深度绘制、PCF和PBR接收端。自定义路径不使用 `Cesium.ShadowMap` 生成或接收阴影，静态Cesium发行资源保持原样。兼容目标为项目提供的1.143.0构建。

## 接入

`VisualPipeline` 默认使用 `shadowMode: 'custom'`、单级联 4096²、逐帧更新；显式 `shadowCascades: 3` 切换为三级 2048²/1024²/1024²。2026-09-15 起覆盖位置由相机自动选择，不要求提供校区ECEF锚点。`setCampusOrigin` 只保留环境/业务兼容语义，不再控制阴影区域。

```js
pipeline.setOptions({ shadowMode: 'custom', shadows: true, shadowStatic: false })
pipeline.setOptions({ shadowDebug: true }) // 独立深度图，诊断用途
pipeline.setOptions({ shadowDebug: false })
pipeline.setOptions({ shadowMode: 'native' }) // 显式原生对照，不是自动回退
pipeline.setOptions({ shadows: false }) // 关闭当前后端的阴影
```

自定义模式关闭原生ShadowMap，避免重复采样和重复变暗。退出自定义模式时恢复原命令Shader、uniform映射和更新入口。停用时释放级联目标，重新启用时按需创建；销毁时卸载其余资源。

## 文件职责

- `DirectionalShadowPass.js`：生命周期、调度、光源视锥选择、状态恢复、诊断计数。
- `CascadedShadowCoverage.js`：三级混合 split，实际接收范围和地形高度包络，稳定半径档位、10% 交叠；天空 far 不扩大所有深度图。
- `CameraShadowCoverage.js`（单级联默认路径）：使用主相机视线与椭球交点确定中心；未命中时使用相机前方区域；按投影宽度扩展范围，使用带滞回的尺寸档位。覆盖可跨任意地理位置，单张贴图仍有精度预算。
- `LightFrustum.js`：稳定正交光源相机及绝对光空间纹素对齐；初始基底只依赖太阳，避免异步地形初始范围造成永久网格偏移。必须使用 `OrthographicFrustum` 才能得到有限的瓦片SSE；直接更新向量，不调用会触发主场景拾取的Camera.setView。
- `CasterCommands143.js`：按光源视锥遍历瓦片，并遵守父级集合的隐藏状态。
- `ShadowTarget.js`：深度纹理、FBO、viewport和清除命令。
- `ShadowReceiver143.js`：隔离1.143绘制命令适配、材质更新、裁剪平面的相机空间转换、派生资源及回收。
- `shaderAdapter143.js`：投影端保留Alpha裁剪/顶点变换，移除主视图LOG_DEPTH约定；接收端只修改直接光/清漆直接反射项，使用带纹素内插值的3×3 tent PCF（4×4共16个唯一深度采样），并按接收面梯度补偿每个纹素中心的比较深度。
- `ShadowCache.js`：显式静态模式的签名、失效与缓存判定。

## 当前支持边界

- 接收端支持Cesium标准PBR `Model` / `Cesium3DTileset`，以及Globe影像表面。Globe在大气合成前调制表面光照，保留环境亮度下限；它没有Model的可分离PBR镜面项。
- 保留模型MASK空隙、双面状态、实例化和蒙皮，已验证项目角色模型播放动画时逐帧更新。
- 使用单独的3D Tiles SHADOW选择Pass获取光源视锥中的投影物，不只依赖主相机视野。普通Model可从主场景命令列表取得未被主视锥提交的候选命令。
- 平面裁剪保留；主相机眼空间的裁剪变换会转换到光源眼空间。剪裁多边形、复杂自定义顶点Shader仍需逐场景验证。
- 自发光、IBL和无光照材质不乘阴影遮蔽。BLEND对象可以接收支持的PBR阴影，但第一版不作为彩色/半透明投影物。
- **三级自定义阴影已接入模型、Globe 和透明前向；多光源阴影、PCSS 尚未实现，云雾分段合成交由 B08。** 这些不应被当作已经完成的能力。

## 静态缓存契约

默认 `shadowStatic: false`，每个渲染帧更新深度。只有调用方确认阴影相关资源静态，才可开启：

```js
pipeline.setOptions({ shadowStatic: true })
// 如果原地更新纹理像素、实例缓冲、裁剪纹理等，更新后必须调用：
pipeline.invalidateShadows()
```

自动检测光源矩阵/范围、分辨率、命令集合、Shader、VertexArray、绘制数量、模型矩阵和投影Shader的活动uniform值。资源对象身份可检测替换，但不能检测同一GPU纹理/缓冲内部的任意修改；此类修改必须显式失效。

带蒙皮、形变或自定义顶点变换标记的Shader不使用静态缓存，即使调用方开启静态模式。不能用“时钟暂停”推断全部资源静态。日照/天气工具继续使用已有suspend/resume协议，恢复时使深度失效。

## 资源与版本约束

主相机状态、命令列表、裁剪体和uniform视口在Pass结束时恢复；主场景绘制使用其原有Framebuffer/RenderState绑定。不会用CPU读回深度实现跨上下文共享。

不再出现的命令及派生程序在120帧宽限后释放，模块销毁时立即释放自有程序、深度纹理、FBO、事件和调试Stage。外部更新入口包装和材质uniform替换不会被清理逻辑误覆盖。

私有依赖集中在这些文件中：命令Shader源及属性位置、Scene.updateDerivedCommands、3D Tiles Pass、活动uniform列表等。更换Cesium版本时必须重新跑回归，不能仅修改版本字符串。

## 验证

```sh
npm test
node scripts/check-camera-shadows.cjs
node scripts/check-shadow-cascades.cjs --umd
node scripts/check-shadow-terrain.cjs
```

配置本机 `CESIUM_PLAYWRIGHT` 并启动开发服务器（默认 8877，可用 `CCR_TEST_PORT` 修改）。入口使用通用生成模型、MASK 纹理和真实程序化高程地形，不要求校园或私有白模资源。核验 300 静止帧、60 帧太阳/相机运动图像序列、三级混合、画面外投影、双面 MASK、近地接触、10 km/轨道视角、三处地理位置和多视锥。低层回归仍保留在 `custom-shadow.test.mjs`。

默认基线冷启动复现包含阴影网格的初始化历史检查；不能通过暂停时钟或重新设置业务原点掩盖相机/地形变化。静态缓存不支持 GPU 资源原地写入的自动侦测，须遵守上面的显式失效契约。
