# 天空光照、雾与体积云（Cesium 1.143）

环境模块默认随 VisualPipeline 启用。使用 Cesium 的真实太阳、Rayleigh/Mie 大气与 PBR 环境贴图，增加自有线性 HDR 体积合成。2026-09-14 新增可选球壳云模式；没有实现 SSRT/GI 或投到地面的云影。

```js
pipeline.setOptions({ environment: true, environmentPreset: 'clear' })
pipeline.setOptions({ environmentPreset: 'morning', fogBaseHeight: 30, fogHeightFalloff: 90 })
pipeline.setOptions({ cloudModel: 'stratus', cloudBaseHeight: 1200, cloudThickness: 700 })
pipeline.setOptions({ environmentQuality: 'high' })
pipeline.setOptions({ cloudGeometry: 'shell' }) // 默认 shell；local 为显式兼容模式
pipeline.setOptions({ fog: false, clouds: false }) // 保留天空/环境光
pipeline.setOptions({ environment: false }) // 恢复原生环境状态
pipeline.environmentRenderer.getDiagnostics()
```

## 数据和执行顺序

场景主颜色/深度与透明合成 → 自有半分辨率体积积分 → 全分辨率深度约束合成 → 原生 AO/Bloom/ACES → 调色/业务后处理/FXAA。

HdrEnvironmentPass143 只包装当前 scene.postProcessStages.execute，不改prototype。副 PostProcessStageCollection 的 update 第三个参数为false，禁用副管线Tone Mapping；所有中间目标均为FLOAT，输出 `sceneHdr * transmittance + inScattering`。原HDR纹理通过function uniform借用，绝不销毁。原生ACES保留唯一曝光1.6。

同时读取原始 depthTexture.r 与本帧可用的 Globe packed-depth 副本（通过 czm_unpackDepth 解码），取最近有效正距离。Cesium 在 depthTestAgainstTerrain=false 时会清除主纹理中的地球深度，并可能写入地平线平面；仅使用主深度会让雾积分到地下，造成高空影像灰屏与悬空阴影。Globe 副本在执行时借用，不缓存或销毁；隐藏或缺失时使用默认纹理并关闭该采样。windowToEyeCoordinates 根据当前viewport归一化回UV，并使用主相机projection重建。半分辨率执行后恢复viewport；上采样使用同一合并距离，薄前景没有可用低分辨率样本时保持原色，避免远云泄漏。

## 光照与介质

- PBR天空光：保留 Model/Tileset 的IBL、材质、SH和specular输入，通过其现有 environmentMapManager 调整散射强度。默认3.2，显式传入的强度仍优先。显式关闭的manager不被强开；设置变化时仅失效一次。场景和Globe大气均跟随SUNLIGHT。环境图按60模拟秒更新，不逐帧重建。
- 旧校园资产的IBL/树叶修正已移到 `examples/compat`，由示例显式启用。核心不再根据文件名修改IBL因子或alpha cutoff。
- 太阳：真正的天文太阳方向，日间基础强度2.2；按高度/天气衰减，低太阳角度变暖，太阳落到地平线以下直射强度为0。渲染器不改当前日期或推进时钟。
- 高度雾/体积雾：以WGS84高度基准为参考的局部ENU指数密度，加可选三维周期噪声。沿视线逐段Beer–Lambert积分，HG相函数计算太阳散射；已有自定义方向光阴影的有效范围内以2×2PCF控制太阳项，天空漫散射不乘阴影。
- 体积云：64³确定性周期噪声（带边框的528²切片纹理及平滑插值），积云/层云两种密度分布，限定高度层内步进；每个云样本沿太阳方向另取4个样本形成云内自遮挡。静态空间分层偏移减少规则步进的水平层纹，不使用逐帧抖动或时域历史。云层截在不透明表面之前，远距离密度渐隐。
- 大气：使用原生Rayleigh和Mie两种散射成分，晴天/霾/夕照采用不同Mie参数。它们是同一物理大气模型的参数预设，不是多个独立大气算法。

地面高度雾与高云分别积分，再按相机高度排序合成。这是分层、单次散射近似，不能称为完整多次散射或任意互相穿插介质。云影投地、云在IBL/反射探针中的反馈、局部灯光体积散射尚未实现。局部雾在ENU参考系计算，默认shell模式下近地相机跨区域时自动重建局部参考系；球壳云不受校园位置限制。显式local兼容模式保留区域范围。

## 预设和控制

预设有 `clear`、`morning`、`overcast`、`sunset`、`haze`。预设不改时间；预览页的时间按钮单独控制6:30/11:00/17:30，播放按钮推进模拟时钟。风偏移取模拟时间，暂停时钟可以在当前位置停止云雾；`environmentAnimation:false` 则使用固定零相位，供可复现比较。

| 参数 | 含义 |
| --- | --- |
| skyLightIntensity / sunIntensity | 程序化天空环境散射 / 日间太阳强度，0–5；IBL因子仍保持合法0–1 |
| fogDensity | 基础消光密度0–0.0005，再乘天气预设系数 |
| fogBaseHeight | WGS84近似雾基准高度，-1000–10000m |
| fogHeightFalloff | 指数密度衰减高度10–3000m；null使用天气预设 |
| cloudCoverage | 0–0.95；null使用预设覆盖率 |
| cloudModel | auto / cumulus / stratus |
| cloudGeometry | local / shell（默认）；球壳模式使用 WGS84 椭球归一化空间 |
| cloudBaseHeight / cloudThickness | 50–12000m / 100–6000m；null使用预设 |
| volumetricFog | 是否加入空间噪声；关闭仍可保留高度雾 |
| sunScattering | 雾与云的太阳散射；关闭保留天空散射和消光 |
| environmentQuality | balanced: 雾24步/云64步/云视距30km；high: 雾40步/云96步/云视距50km |

两档均半分辨率积分，主画面始终全分辨率。1080p活动目标为960×540 RGBA32F（7.91MiB）+1920×1080 RGBA32F（31.64MiB）+噪声约1.06MiB。约40.61MiB只是逻辑目标总量，不含原生环境图、驱动开销或瞬态峰值。

## 生命周期和限制

disable/suspend会销毁自有体积collection和噪声，撤销自己的光照/大气/manager设置；恢复时重建。不覆盖外部工具接管后的值，不销毁Cesium拥有的IBL/manager。HDR失败旁路原色并记录error；不逐帧反复尝试，显式关闭再开启可重试一次。外部若包装同一个execute，旧token保持失效且不会覆盖外部hook。

需要depthTexture、floatingPointTexture、colorBufferFloat，以及3D透视单视锥。真正多视锥、正交视图、地下相机、透明Globe旁路体积。local 模式在区域外旁路；shell 模式可在区域外渲染云，局部雾随区域限制关闭。shell 允许没有不透明视锥的纯天空帧，该帧显式忽略两张深度纹理。BLEND/OIT一般不写深度，雾的遮挡仍可能取透明物后方表面，尚未做玻璃分层合成。关闭地形深度测试时，地表后的普通primitive仍可能被原生渲染到前面；最近距离合并对这类覆盖物的雾量是保守近似。上下文丢失后的自动重建、全业务页面及所有硬件兼容性未完成认证。

shell 模式使用同心归一化球壳描述云底/云顶，CPU 双精度准备径向高度，GPU 稳定求交；地球和最近场景深度截断路径。云高是归一化空间米制径向偏移，与精确测地高度有小量差异。balanced/high 分别最多128/192步，最远场景距离20,000km；复用半分辨率深度引导合成。噪声使用显式三线性插值和固定中点积分，避免图集采样条纹与逐帧随机噪声。不承诺气象级云微结构、云投地阴影或多视锥全局深度融合。

shell 在所有相机高度下均从12km开始降低覆盖率和消光密度，50km完全淡出；积分也在50km截断。2026-09-15按用户要求取消云上/高空范围扩展，云层在该视距之外时不进入云积分循环，避免高空绘制整片云层。局部云模式不受此规则影响。

独立工程本轮验证运行 `node scripts/check-stage1.cjs`，默认测试服务器8877，需通过 CESIUM_PLAYWRIGHT 指定 Playwright。下面的旧宿主夹具说明作为历史记录，独立工程以本轮脚本与 docs/STAGE1_ENHANCEMENTS.md 为准。

天气工具的新路径通过预设与环境交接；旧路径仍保留原行为。跨两种模式的取消/切换均有回归。MainMapView暴露 `setVisualEnvironmentOptions` / `getVisualEnvironmentState` action；渲染对象不进入Vue响应式data。

## 验证

`npm run test:rendering` 包括参数、日夜、噪声边框、ShaderSource、HDR顺序、外部所有权、跨天气模式和失败重试。访问 `/tests/rendering/shadow-fixture.html?environment=1` 后执行 `fixture.runEnvironmentChecks()`，检查真正FLOAT像素、HDR>1、太阳/阴影散射、云遮挡、动画、resize、释放和十轮生命周期。

校园对比使用 `/tests/rendering/preview.html`。正式性能需要固定相机/时间/资产/画布，关闭时间播放，且独立核验系统前台；页面valid只验证页面条件。结果与截图保存在本地 `plan/evidence/11-environment-validation.md`。

Globe 深度专项运行 `node tests/rendering/run-environment-globe.cjs`（CESIUM_PLAYWRIGHT 指向已安装的 Playwright）：比较 1km/4km 俯视与 4km 斜视、log 开关及地形深度测试开关，并重跑 1000×800/1920×1080 环境与阴影检查。`run-environment-campus.cjs` 等待校园、白模、影像加载完成，在同一镜头临时禁用/恢复表面深度选择，生成可复核的旧行为与修复后截图；不更改生产源码或预览默认设置。
