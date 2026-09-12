# 共享屏幕几何通道（Cesium 1.143）

`ScreenSpaceGeometry143` 已纳入 `VisualPipeline` 的生命周期管理，为 AO/反射提供前置数据；它仍不是完整材质 GBuffer、AO 或 SSR。默认禁用且不创建通道；首次请求启用时才创建。能力不足时保留请求并返回不支持的诊断，不修改默认画质。

需要材质法线、粗糙度、金属度、自发光和模型多视锥数据时，使用后续新增的 [不透明材质通道V1](MATERIAL_CHANNELS.md)。两个模块拥有不同来源和有效范围，不可混用编码；当前不会自动共享或去重纹理。

```js
pipeline.setGeometry({ enabled: true, debugMode: 'normal' })
pipeline.setGeometry({ debugMode: 'depth' }) // 只改调试模式；显示解码后的米制深度 / 1000
pipeline.setGeometry({ debugMode: 'off' }) // 透传颜色，数据仍生成
pipeline.getGeometryDiagnostics() // requested、enabled、valid、ready、encoding、纹理尺寸/字节
pipeline.setGeometry({ enabled: false })
// suspend/resume/setEnabled/destroy 自动交接通道，不另行销毁 pipeline.geometry。
// 也可通过 index.js 导出的 ScreenSpaceGeometry143 创建独立实例，自行管理生命周期。
```

## 通道契约

| 数据 | 来源 / 编码 | 限制 |
| --- | --- | --- |
| 输入颜色 | 原生 AO/Bloom/Tone Mapping 之后的场景颜色 | 已包含显示转换及透明合成，不是线性 HDR；不再加曝光/Gamma |
| 输入深度 | 后处理原始 depth-stencil texture 的 R 通道 | 不同于 RGBA 打包的 `czm_globeDepthTexture`；不调用 unpackDepth |
| RGBA16F v1 | RG：八面体编码视空间几何法线；BA：深度/1024 的半精度高位与残差，B≤0 无效 | 编码名 `oct-normal-depth-pair-v1`；最大视深度6000万米，越界返回无效 |
| RGBA32F v0 回退 | RGB：`normalEC * 0.5 + 0.5`；A：正米制视深度，A≤0 无效 | 编码名 `rgb-normal-metres-v0`，保留旧契约 |
| 解码结果 | `decodeGeometry()` 返回视空间单位几何法线 xyz、正米制视深度 w | 不是材质法线，不含法线贴图/光滑顶点法线；不是径向距离 |
| 粗糙度/金属度/材质遮罩 | 尚无来源 | 不能从颜色或几何法线猜测水面、玻璃、湿地 |

五点采样采用两侧较短切线重建法线，减轻深度断层污染。薄物、轮廓、锯齿与法线精度仍受屏幕深度影响；没有时域历史或滤波，不宣称已经降噪。

支持 WebGL2、halfFloatingPointTexture、colorBufferHalfFloat 时优先全分辨率 RGBA16F，否则在支持 FLOAT 的设备回退 RGBA32F。不重复提交几何。Composite 的两个 stage 共用原始颜色输入，末级通过**阶段名称 sampler**读取几何目标，避免 texture cache 提前复用。后续消费者也必须声明这种依赖，不要仅使用返回 Texture 的函数。

消费者应导入 `geometryEncodingShader`；v1 定义 `GEOMETRY_PACKED_V1`，v0 不定义，然后调用 `decodeGeometry(texel)`。无效结果为全零。`getTexture()` 仅返回本帧已完成生成且尺寸匹配的纹理，未渲染、暂停/禁用、上一帧、resize、销毁或不支持范围均返回 null；不能跨帧保存引用。阶段名称可从 `getDiagnostics().names.geometry` 获取；该接口不能绕过 Cesium stage cache 的依赖声明。

深度使用高位和残差两个半精度分量，避免一个半精度米制值在远距离失去米级精度或超过65504溢出。半精度转换允许截断舍入。当前 GPU 的100个样本覆盖0.1米至1000万米以及无效值，最大误差0.01171875米（50公里样本），法线点积最低0.999995815；这不是所有数值/硬件的精度保证。测试容差采用 max(1毫米, 1.1×10⁻⁶×深度)，包含截断及float32重建误差。

`czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth)` 处理当前投影及 LOG_DEPTH。不能直接调用 `czm_screenToEyeCoordinates`：在此发行版它的定义位于 window 函数注册项中，直接调用不会触发依赖注入。Node 回归检查普通与 LOG_DEPTH 两种生成后源码，GPU fixture 检查实际编译和米制结果。

## 支持范围与所有权

必须具备 depthTexture 和一种可渲染浮点格式，且是 3D、透视、单视锥。能力不足不创建 stage；多视锥或正交投影时输出全零、显示端透传原色。场景最终 depth attachment 不包含所有远视锥，不能把最近视锥数据称为全场景共享深度。诊断读取版本限定的 `scene._view.frustumCommandsList`；升级引擎需重新验证。

BLEND/OIT 颜色已合成，但通常没有写入该深度，数据可能对应其后方不透明物。MASK 丢弃遵从原深度写入。未提供玻璃表面法线/透明材质遮罩；未对 Globe 地形、多视锥拼接、上下文丢失恢复、完整业务页作验收承诺。

实例只移除自己的 composite，不改全局光照、阴影、曝光、相机或业务 stage。专用 `pipeline.setGeometry()` 只应用几何设置，不重写外部灯光、曝光、MSAA或触发viewer resize；暂停/禁用期间保存请求，恢复后应用最新值。禁用后由 Cesium 下一次 update 释放资源，destroy 递归释放自有 stages。多个实例使用不同名称。`valid` 表示作用范围满足门禁；`ready` 表示可取得当前帧纹理。allocatedBytes 是**活动逻辑目标**大小之和，不能当作全局 GPU 独占显存或物理释放证明。

1080p 压缩几何目标为16,588,800字节（15.82MiB），末级RGBA8为8,294,400字节（7.91MiB），合计23.73MiB；相较原39.55MiB减少40%，数据目标本身减少50%。FLOAT回退仍为39.55MiB。禁用阶段可能仍有 Cesium 共享 cache 映射，不计为本模块活动分配。物理释放使用保存的旧 Texture.isDestroyed() 验证。

## 复现

运行 `npm run test:rendering` 和本地静态服务器后，访问：

- `/tests/rendering/shadow-fixture.html?geometry=1`，执行 `fixture.runGeometryChecks()`。复用现有 Model/MASK 场景，仅一个 WebGL viewer。
- 同页 `fixture.runGeometryEncodingChecks()` 验证100个实际RGBA16F存储/Shader解码样本。
- `node tests/rendering/run-geometry.cjs` 自动执行编码、fixture、校园HDR/SMAA联动、动态镜头、十轮暂停/恢复及销毁检查。沿用 `CESIUM_PLAYWRIGHT` 指定已安装模块；证据保存到独立 `plan/evidence/16-geometry-*/`。
- `/tests/rendering/preview.html` 提供开关、法线/深度视图和 60 秒采样。
- `/tests/rendering/preview.html?singleFrustum=1` 是**显式限定远裁面 50 公里**的实验样本，不修改默认场景。关闭/开启两轮必须使用相同样本；资产根沿用 `assets` 查询参数。

初次验证时默认校园相机 far=1e10 产生两个视锥，模块正确拒绝。后续环境模块定位到旧 CloudCollection 的无包围体透明命令；替换为自有体积通道后，默认校园实测恢复单视锥，无需强制缩短远裁面。这不代表所有场景已支持；多视锥门禁仍保留。性能采样固定相机、时间、资产、drawing buffer，记录全过程瓦片加载状态及焦点中断；比较P95。历史结果在 `plan/evidence/09-shared-geometry-validation.md`，环境续接在 `plan/evidence/11-environment-validation.md`。
