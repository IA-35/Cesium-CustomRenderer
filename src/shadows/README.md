# 自定义方向光阴影

此目录实现阴影贴图、光源相机、瓦片选择、光空间深度绘制、PCF和PBR接收端。自定义路径不使用 `Cesium.ShadowMap` 生成或接收阴影，静态Cesium发行资源保持原样。兼容目标为项目提供的1.143.0构建。

## 接入

`VisualPipeline` 默认使用 `shadowMode: 'custom'`、逐帧更新。必须提供校区ECEF锚点；业务已有 `setCampusOrigin` 接入。

```js
pipeline.setOptions({ shadowMode: 'custom', shadows: true, shadowStatic: false })
pipeline.setCampusOrigin(campus.staticCamera.position)
pipeline.setOptions({ shadowDebug: true }) // 独立深度图，诊断用途
pipeline.setOptions({ shadowDebug: false })
pipeline.setOptions({ shadowMode: 'native' }) // 原生单级联回退/对照
pipeline.setOptions({ shadows: false }) // 关闭当前后端的阴影
```

自定义模式关闭原生ShadowMap，避免重复采样和重复变暗。退出自定义模式时恢复原命令Shader、uniform映射和更新入口。缓存的GPU资源在切换模式时保留以便复用，销毁模块时释放。

## 文件职责

- `DirectionalShadowPass.js`：生命周期、调度、光源视锥选择、状态恢复、诊断计数。
- `LightFrustum.js`：稳定正交光源相机及纹素对齐。必须使用 `OrthographicFrustum` 才能得到有限的瓦片SSE；直接更新向量，不调用会触发主场景拾取的Camera.setView。
- `CasterCommands143.js`：按光源视锥遍历瓦片，并遵守父级集合的隐藏状态。
- `ShadowTarget.js`：深度纹理、FBO、viewport和清除命令。
- `ShadowReceiver143.js`：隔离1.143绘制命令适配、材质更新、裁剪平面的相机空间转换、派生资源及回收。
- `shaderAdapter143.js`：投影端保留Alpha裁剪/顶点变换，移除主视图LOG_DEPTH约定；接收端只修改直接光/清漆直接反射项，使用带纹素内插值的3×3 tent PCF（4×4共16个唯一深度采样），并按接收面梯度补偿每个纹素中心的比较深度。
- `ShadowCache.js`：显式静态模式的签名、失效与缓存判定。

## 当前支持边界

- 接收端支持Cesium标准PBR `Model` / `Cesium3DTileset`，校园GLB地面也属于此范围。
- 保留模型MASK空隙、双面状态、实例化和蒙皮，已验证项目角色模型播放动画时逐帧更新。
- 使用单独的3D Tiles SHADOW选择Pass获取光源视锥中的投影物，不只依赖主相机视野。普通Model可从主场景命令列表取得未被主视锥提交的候选命令。
- 平面裁剪保留；主相机眼空间的裁剪变换会转换到光源眼空间。剪裁多边形、复杂自定义顶点Shader仍需逐场景验证。
- 自发光、IBL和无光照材质不乘阴影遮蔽。BLEND对象可以接收支持的PBR阴影，但第一版不作为彩色/半透明投影物。
- **未接入Globe原生地形着色器的接收项，也没有实现多光源阴影、级联自定义阴影、PCSS或体积散射。** 这些不应被当作已经完成的能力。

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
npm run test:rendering
npm run check:cesium
python -m http.server 8766 --bind 127.0.0.1
```

浏览器访问 `tests/rendering/shadow-fixture.html`，执行 `await fixture.runChecks()`，验证像素、MASK、自发光、裁剪、画面外投影、缓存和尺寸切换。`await fixture.runSkinningCheck()` 使用仓库的UAL1_Standard角色资源验证蒙皮动画不会错误使用静态缓存。

真实校园对比在 `tests/rendering/preview.html`。采样必须保持前台且配置不变，检查结果 `valid`、`interruptions` 和 `customStats.error`。静态缓存的成绩不能代替动态场景成绩。
