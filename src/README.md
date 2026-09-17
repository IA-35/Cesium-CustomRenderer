# Cesium 校园视觉模块

独立工程的路径、构建、依赖与浏览器 `CCR` 入口以[根README](../README.md)为准。下文保留原宿主的算法说明，旧命令和 plan/evidence 引用属于历史验证资料，不表示这些夹具已包含在本工程中。

当前开发基线与未完成事项见[2026-09-11阶段快照](STAGE_SNAPSHOT.md)。本次是阶段存档，不代表完整延迟渲染目标已完成。

使用 `public/Cesium/` 的静态 1.143.0。引擎不从 npm 安装；第三方组件的 `cesium` 导入由 webpack external 映射至 `window.Cesium`。项目 `.npmrc` 使用 legacy-peer-deps，防止角色控制器的 peer 自动安装另一套引擎；新增依赖时仍需人工核对 peer 兼容性。

```js
import { createVisualPipeline, getVisualPipeline } from '@/rendering/cesium/index.js'
const pipeline = createVisualPipeline({ Cesium: window.Cesium, viewer })
pipeline.setCampusOrigin(campus.staticCamera.position)
pipeline.setOptions({ exposure: 1.6, ambientOcclusion: false, fog: true })
pipeline.setColorGrading({ brightness: 1.08, contrast: 1.1, saturation: 1.05, hue: 0 })
pipeline.setAntiAliasing({ mode: 'smaa', msaaSamples: 1, resolutionMode: 'native', resolutionScale: 1 })
pipeline.setGeometry({ enabled: true, debugMode: 'off' }) // 可选共享数据；默认不创建
pipeline.getGeometryDiagnostics()
pipeline.setMaterialChannels({ enabled: true }) // 可选MRT材质数据；默认关闭
pipeline.getMaterialDiagnostics()
pipeline.setDepthPyramid({ enabled: true }) // 自动请求材质深度依赖；默认关闭
pipeline.getDepthPyramidDiagnostics()
pipeline.setScreenSpaceAO({ enabled: true, radius: 3, strength: 1, bias: 0.08 }) // 新AO默认关闭
pipeline.getScreenSpaceAODiagnostics()
pipeline.setScreenSpaceReflections({ enabled: true, distance: 150, thickness: 0.5, strength: 1 }) // SSR默认关闭
pipeline.getScreenSpaceReflectionDiagnostics()
pipeline.setScreenSpaceReflections({ transparent: true }) // 可选透明PBR逐层反射
pipeline.getTransparentReflectionDiagnostics()
pipeline.setEnabled(false) // 原生对比
pipeline.setEnabled(true)
pipeline.destroy() // 必须先于 viewer.destroy；重复调用安全
```

实例保存于非响应式字段；通过 WeakMap 可按 viewer 查找。模块不管理地图数据、Vue、业务事件或 localStorage。MainMapView 负责接入及现有调色面板转接，参数保存在 `campus-visual-pipeline:v1`，不读取旧 Tianjing 参数。

共享几何通道由管线统一启停/暂停/销毁，优先RGBA16F压缩法线/深度，保留FLOAT回退；默认关闭，单视锥透视3D范围门禁仍保留。编码、当前帧纹理契约、精度和边界见 [channels/README.md](channels/README.md)。新增的 [材质通道V1](channels/MATERIAL_CHANNELS.md) 则通过额外MRT绘制提供材质法线、粗糙度、金属度、自发光和受支持模型的多视锥深度，保留不支持表面的失效标记；不代表延迟光照或完整通用GBuffer已实现。

[共享深度金字塔](channels/DEPTH_PYRAMID.md) 已接入材质生产者，汇总已知深度范围、完整覆盖和未知遮挡；本身不执行视觉合成或遮挡剔除。材质深度契约已升级为正数/背景0/未知-1，消费者必须保留该区分。[屏幕空间AO V1](ao/README.md) 已复用这些数据实现半分辨率遮蔽、双边降噪和HDR合成；默认关闭，保留透明/MASK等明确旁路。

透明覆盖已接入材质布局V2，AO对受支持透明区域保留原色、对其他区域继续生效；复杂深度依赖/轮廓仍有安全旁路。颜色继续由原生前向/OIT生成，详见 [透明边界说明](channels/TRANSPARENCY.md)。

[SSR与原生环境反射](reflections/README.md) 已支持不透明PBR模型及可选透明PBR逐层合成：材质MRT按需增加反射分量和不透明颜色，命中后替换原镜面项，未命中保留CubeMap。HDR按不透明SSR→透明SSR→AO→雾云排序。原生Water/未知材质适配、TAA和完整延迟光照仍未完成。

[统一缓冲基础](buffers/README.md)已将共享相机和独立参数接入SSR/透明SSR，数据未变时零上传，Profiler独立统计去重后的192字节。灯页已验证5000条记录的实际GPU读回；尚未接入分块照明，不能据此宣称5000灯实时渲染。

## 阴影后端

默认使用自定义方向光阴影，接收端支持标准PBR Model/3D Tiles；校园GLB地面可接收阴影。Globe原生地形接收端尚未接入。可通过 `setOptions({ shadowMode: 'native' })` 回退原生方案。资源与静态缓存契约见 [shadows/README.md](shadows/README.md)。

## 渲染顺序

1. 自有光空间深度Pass；Cesium场景材质直接光接收阴影，继续执行主颜色/深度与透明/OIT。
2. 独立线性 HDR 环境通道：高度/体积雾、太阳与阴影散射、体积云，半分辨率积分后深度约束合成。
3. 原生 AO、Bloom、HDR Tone Mapping（ACES，唯一曝光入口），然后显示空间调色。
4. 其他业务 stage 依其原有顺序执行，最终使用所选SMAA或FXAA。SMAA未就绪/失败回退FXAA，就绪后不叠加两种后处理AA。

普通自定义 stage 的颜色已经过色调映射，调色阶段不再曝光或Gamma。环境模块通过1.143限定的 collection.execute 实例包装取得色调映射前的 HDR，副管线禁用自己的 Tone Mapping。深度读取原始 `.r`，由 windowToEyeCoordinates 处理对数深度；透明/OIT 深度仍有边界，不宣称为透明材质专用体积合成。

天空和PBR环境光跟随真实太阳；云采用空间密度光线步进及云内太阳自遮挡，支持积云和层云。旧CloudCollection和显示空间近似雾已被替换。详细算法、参数、能力限制和资源所有权见[环境模块](environment/README.md)。

## 参数

`presets.js` 定义默认值和范围。曝光0.05–5、对比度/亮度/饱和度0–3、色相-1–1；阴影图1024/2048/4096、级联数1/3/4（custom 使用 1 或 3，native 使用 1 或 4），距离100–20000米，基础雾密度0–0.0005。校园默认使用4096自定义正交阴影贴图、逐帧更新、日间太阳强度2.2、天空环境图散射强度3.2、曝光1.6、亮度1.08、对比度1.1、饱和度1.05；AO和Bloom关闭。太阳强度随高度和天气衰减，日落后直射为0，不擅自推进时钟。

专用调色、抗锯齿与分辨率API见[图像质量接口](antialiasing/README.md)。默认SMAA1x + MSAA1 + 原生DPR；后处理AA开启时，多重采样组合需显式设置`msaaCombine:true`。原生像素会增加GPU成本，CSS分辨率是显式性能选项。诊断区分请求、配置和实际附件，不将MSAA值直接当作质量验收。

原生AO在本版Cesium中直接调制到颜色，没有后续降噪。此前lengthCap=2配合4方向/8步导致远处平面出现大面积颗粒/条带，因此默认关闭该旧选项，保留真实投影。新开发使用上方独立的setScreenSpaceAO接口，其支持范围和验证与原生AO分开记录。

`resolveSavedFilters`供页面与调色面板共用：两组已知旧默认签名升级为明亮清晰预设；其他手动记录保持原值并校验范围。面板普通操作仅提交当前字段，防止覆盖代码接口期间更新的其他值。可用明亮清晰、中性预设或重置，参数读取/修改/重置均有代码入口。

原生回退方案：大型校园GLB的包围范围覆盖四个级联，实测279条投影命令会重复绘制成1116次。单级联减少重复绘制，仍保留完整校园投影；4096单级联与原2048四级联均使用4096×4096图集。它的分辨率分配不同，极近距离细节仍可能不如四级联，可通过 `setOptions({ shadowMode: 'native', shadowCascades: 4, shadowSize: 2048 })` 对比。没有降低主画面分辨率，也没有缓存静止阴影或跳过动态更新。

`suspend(owner)` / `resume(owner)` 用于日照分析和旧天气路径交接。新环境启用时，天气工具改为设置环境预设，雨雪只增加降水覆盖，不再暂停整个管线或将时间改到固定正午。跨新旧模式取消天气会恢复原状态。暂停期间参数修改仅保存，全部owner释放后应用最新值；模块只恢复仍由自己拥有的属性。

## 版本限定的内部兼容点

原生回退中的 `shadowBias143.js` 对1.143的 `_primitiveBias.depthBias` 和 `normalOffsetScale` 做版本限定调节。真实南湖屋顶在默认偏移0.00002下出现条纹，调整为0.0002后明显改善。该文件是内部接口依赖，并非公共API；升级Cesium时必须复测屋顶、近景接触阴影和远景。关闭时恢复原值。没有改写压缩引擎、DrawCommand或原生postProcessStages集合。

原生回退中的 `shadowMap143.js` 使用1.143的ShadowMap构造选项及原生 `_lightCamera`。模块拥有自己的ShadowMap；启用时挂接到scene，暂停/禁用恢复原对象，销毁或更换级联时释放自己创建的GPU资源。不会销毁原生对象或改动其级联配置。静态Cesium发行文件保持原样，392文件哈希继续有效。

## 验证与预览

独立的[共享屏幕几何通道实验](channels/README.md)继续保持关闭，不是完整GBuffer。旧云集合的无包围体透明命令曾撑大视锥；本轮移除后默认校园实测为单视锥。真实多视锥依然拒绝，不能把一次校园验证推广为全场景支持。

```sh
npm run check:cesium
npm run test:rendering
npm run build:prod
python -m http.server 8766 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8766/tests/rendering/preview.html`。默认使用本地8083端口的南湖建筑、地面和树木，可通过 `?assets=...` 指定模型服务。对比页没有后台登录、底图或业务覆盖物，不代表完整应用的性能。它支持原生/增强、四级联/单级联、三个相机视角和60秒不删异常值的帧间隔采样。瓦片未加载完成时不开始采样；采样期间锁定按钮，结果包含配置和各阴影pass命令数。

现有应用可以通过 actionCenter 的 `setVisualPipelineEnabled` 开关增强；原调色面板继续生效。不要以单个瞬时FPS或测试页截图宣称达到目标图。
