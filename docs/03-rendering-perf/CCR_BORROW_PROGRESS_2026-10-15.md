# CCR 借鉴计划实施进度 · 2026-10-15

> **2026-10-16 视觉里程碑已验收**：用户确认日夜光照、云层及大气散射已完成并满意，以当前 SDK 为性能基线开展真实校园测试。该确认包含后续云距离/俯仰及轨道裁切修正；正式性能记录独立保存于 `verification/rendering-performance/milestone-2026-10-16/`，不以旧静态帧率报告替代新测量。

> **2026-10-16 建筑环境遮挡回归**：用户随后发现楼体被云影／天际线亮带穿透。已确认 globe depth copy 漏掉后绘制的独立 GLB；共享场景距离改为最终 scene/globe 两份深度的最近有效命中。[复现、修正与验证](../verification/rendering-performance/BUILDING_OCCLUSION_FIX_2026-10-16.md)。开发验证通过，待用户确认；已有性能数据保留为修复前 `cc76…` 记录，不作为修复后正确画面的最终基线，正式续测需要区分版本。

对照：[原始 v3 计划](./CCR_BORROW_PLAN_2026-10-14.md)。初次核查已归档为 [P1 实施前快照](./CCR_BORROW_PROGRESS_2026-10-15_BEFORE_P1.md)；本页更新为随后实际实施结果。基础设施、实际路径、开发验证与用户验收分别记录，不折算虚假的总体完成百分比。

> **P1 视觉回归修正已获用户验收**：天际线灰/暗带与轨道地表变灰改用球面高度分段积分修复；[原因、前后对照与验证](../verification/rendering-performance/ATMOSPHERE_HORIZON_FOG_FIX_2026-10-15.md)。随后日落云体偏暗已修正云天光单位转换与高阶散射截断，保留已验收的天空/曝光；[开发验证与边界](../verification/rendering-performance/CLOUD_SUNSET_LIGHTING_FIX_2026-10-15.md)，已纳入下述云形与照明验收基线。

> **云形/明暗修正已获用户验收（2026-10-15）**：用户确认“效果我已满意”。按 liaomz 云海参考图重标主体/细节尺度与单层积云高度/侵蚀，补充云天光自身遮挡并标定核心消光；[代码、真实 GPU 与实际画面对照](../verification/rendering-performance/CLOUD_STRUCTURE_LIGHTING_FIX_2026-10-15.md)。当前云形与白天/日落云照明作为后续回归基线。正午俯视较柔等差异保留为技术记录，不再列为本轮待验收阻塞项；完整复刻参考图不作为既有结论。本项不承担并行夜间照明工作。

> **夜间补全已获用户验收（2026-10-15）**：针对夜间太阳源归零后的纯黑问题，接入独立月光、冷天光、原生材质低频照明与原生星月保留；月盘另修正 scene.light 亮度耦合及短视锥深度丢弃。[夜间实现与验证](../verification/rendering-performance/NIGHT_LIGHTING_FIX_2026-10-15.md)。未调整曝光；正式性能测量和真实照度标定仍未完成。

> **按视角扩展云距离**：俯视保留原距离裁切与羽化；看到地平线时连续扩展到球面云层远界。低空/云上/高空实图已出现 40 km 以外的云，俯视及轨道视角维持 local 模式。[实现与回归记录](../verification/rendering-performance/CLOUD_HORIZON_RANGE_2026-10-15.md)。属于云形验收后的独立小需求，开发验证通过，待用户确认；未改云形、曝光或夜间照明。

## 1. 当前阶段

| 阶段 | 当前状态 | 本轮已落实 | 剩余事项 |
| --- | --- | --- | --- |
| P0：坐标、深度、HDR 基线 | 核心及主要参数/开关已落实 | 保留正确坐标/有限距离/浮点 T；解析高度雾实际消费密度、基准高度和尺度高度；关闭云不提交 march/depth/history；冻结 B2 基线 | 关闭成本的正式 GPU 测量仍未做；工程适配路径不等于原版只换三个接口的逐行完全相同实现 |
| P1：Hillaire 二维 LUT | **已接入运行并通过开发验证** | T 256×64、M 32×32、Sky 192×108；WebGL2 fragment 生成；介质/Sky 分别失效；原子发布与失败保留；天空/有限距离/云读取 LUT | 更多部署设备验证、正式成本比较未做；不宣称完整 Bruneton 等价 |
| P2：云时域/采样优化 | 核心重建及历史预算已落实，采样优化部分待做 | 独立 history、相机/材质位移重投影、距离/T 拒绝、RGB 方差/T 边界裁剪、连续风场；R32F 距离历史；天空强度/已发布介质变更重置 | 真实 STBN、1/4 比较、速度自适应权重、距离 LOD、可变步长与粗空区跳过 |
| P3：统一照明 | 部分完成 | 太阳方向一致；云光照与天空共享 T/M 介质；云相函数、多散射、powder、地面反弹和实际接收面云影 | 地表直射/PBR 与云尚非同一辐照度标尺；准确 direct 项云影、低频 IBL、玻璃/Water/MASK/outline/OIT 专项回归；四层天气和级联云影尚未做 |
| P4：新效果 Graph/资源/计量 | **主要环境链路已接入并验证物理复用** | 实际提交进入共享 Graph；current/距离/辐射/T/合成/medium 由现有 allocator 管理；LUT/history external；输出保活至下游；计时接口和完整物理纹理枚举 | shader 预热与缓存策略未新增专项比较；仍未进行整帧/分 Pass 正式性能实验 |
| §5：性能目标 | 未开展本轮正式测量 | 已冻结 B2 身份与视觉记录；有实际资源字节与对象 ID | 相同条件 3×300 帧、CPU/GPU/掉帧/显存峰值、4K 与部署设备；不能宣称 environment p95 3–5 ms |

## 2. 原文 P1 的要求现已对应落实

原计划采用 **Hillaire 三张二维 LUT**，不是完整 Bruneton 三维散射纹理。新的 `AtmosphereLut143` 与 GLSL 模块沿用固定 webgpu-cesium 提交，补齐实际积分的多散射级数；不依赖 compute/WebGPU，也不新增另一套 Graph。

- T/M 介质键包含半径、尺度高度、Mie 密度/相参数、散射/吸收/臭氧、地面反照率和模型版本。
- Sky 额外按相机高度与太阳天顶角更新；球对称介质下参考系旋转/太阳方位由运行时映射处理，不导致无意义重建。
- 只有整组实际 GPU 提交成功，才发布纹理、介质 uniforms 与失效键。Sky 单独更新不重建 T/M；失败继续使用上一完整版本。
- 天空查询 Sky-view；有限表面/云前后段采用短视线积分 + T/M 查表；云太阳光查询 T。LUT 有效时运行时不再逐视线采样嵌套太阳密度积分。
- 支持 RGBA16F，必要时 RGBA32F 和手动双线性过滤。原版 Shadertoy 对照路径保留；LUT 未就绪时才走解析兼容路径。
- 轨道向下射线已按最低高度重新分配采样，避免只加密空旷起点。CPU/GPU 独立数值验证见实施记录。

## 3. P0 的参数与关闭语义

高度雾复用已有解析指数积分与近零分支；密度、基准高度、尺度高度真正参与输出。只有真实有限场景深度启用该雾，先于人工地球求交判断，避免把天空当表面染雾。基础/体积雾开关独立于太阳大气；体积开关才启用既有 atlas 调制。

`clouds:false` 或零云量时，不 update/clear/execute 云 collection，也不执行云历史 resolve；大气 LUT/必要的天空合成可以继续运行。这比只让 shader 返回 L=0/T=1 更完整。实际浏览器记录中关闭云只出现大气/T/合成提交。

B2 既有正确画面、脚本参数及哈希保存在 [冻结基线](../verification/rendering-performance/b2-2026-10-15/manifest.json)。资产身份当前覆盖 tileset 描述文件与校园 manifest，**不是完整递归资产内容哈希**。

## 4. 资源预算与 P4 证据

旧云历史：两张 RGBA16F 颜色 + 两张 RGBA32F 距离/T。现在距离历史改成 R32F，透射率复用颜色 alpha；距离仍保留 32 位精度。T 拒绝使用已解析历史的 alpha，这是原始当前帧 T 的历史代理。

| 1920×1080，每轴 1/2 history | 逻辑字节 | MiB |
| --- | ---: | ---: |
| 旧历史 | 24,883,200 | 23.73 |
| 当前历史，实际 1080p 浏览器诊断 | 12,441,600 | **11.87** |
| T/M/Sky 双版本 LUT，实际分配 | 610,304 | **0.58** |
| 当前 history + 双版本 LUT | 13,051,904 | **12.45** |

这满足原计划“约 16 MiB”的 **1080p、RGBA16F 颜色分支的 history+LUT 子预算**；不包括 current、HDR scratch、池内闲置、Cesium 原生/资产/驱动资源，也不代表整卡 VRAM。颜色使用 FP32 fallback 时需要单独计量；4K 仍需另验。

`EnvironmentGraph143` 把云颜色/距离、时域、大气视线/T、合成和 medium 的真实提交接入共享 Graph。LUT 两个物理版本和 history 都 external；瞬时目标使用既有池。浏览器通过 texture ID 验证 atmosphere.raymarch 与后续 medium 的物理复用；相互重叠的云颜色/距离不复用。

修正了 keepAlive 输出在最后一个生产 Pass 完成后、native HDR/B09 消费之前被释放的问题：此类整个 alias group 保留至 endFrame/finally。验收在 HDR 返回、Graph 帧仍有效时检查实际下游可读性，而非仅在生产回调内部检查。

Profiler 覆盖全部环境输出、两组云历史与六张 LUT，包括未发布 staging 与池内驻留目标，并按物理 Texture 去重。新增 source 诊断读取 SDK 自有 RHI pool，避免不同模块实例的 WeakMap 造成漏记。GPU scope 接口保持轮换与禁止嵌套；本轮未采集正式耗时。

## 5. 验收边界

- **用户已验收**：天空泛白修复；云量/厚度 GUI 与 Cesium 时间轴；天际线灰带/轨道地表变灰修复；本轮云团结构、间隙与白天/日落云照明；夜间独立月光、冷天光、星空/月相与地表/云/建筑照明（2026-10-15）。
- **此前开发验证通过**：早晚分层、Tiles 云影白边与距离羽化；后两项尚无用户单独确认最新修复。
- **本轮开发验证通过**：三 LUT 生命周期/原子失败恢复、真实 GPU 数值、云关闭零提交、有限深度雾、Graph 物理复用、下游保活、1080p resize 与历史字节、新照明失效键。
- **尚待验收**：连续长序列的拖影/交互、更多设备、透明特殊材质及正式性能对比。当前已展示的云形与白天/日落照明视觉已验收。

当前没有因为纯白像素比例为零，就宣布所有时间/视角/用户配置的视觉问题都已解决。当前 diffuse sky irradiance 仍用 Hillaire 多散射各向同性近似，不是完整天空半球积分；接收面云影仍为合并 HDR 上的漫反射份额估算。

## 6. 下一步

1. 保持本轮 P1/Graph/雾/历史预算的回归基线，检查用户实际场景的早中晚、云下/云上与时间轴操作。
2. 推进 P2 真实 STBN、连续运动权重与采样策略；分别验证 1/4 分辨率、密度调用和拖影，避免靠强历史混合隐藏低采样。
3. 收口 P3 准确直射项云影与特殊材质；四层天气和级联云影单独推进，不把后处理估算称为已完成这些算法。
4. 补完缓存/预热与部署设备回归；视觉阶段收口后再按原 §5 采集 B2/B3/B4/B5、GPU 分 Pass 和显存峰值。

## 7. 当前证据

- [P1/Graph 实施与验证](../verification/rendering-performance/P1_HILLAIRE_GRAPH_2026-10-15.md)
- [LUT 后端真实 GPU](../verification/rendering-performance/atmosphere-lut-acceptance.json)
- [高度雾真实 GPU](../verification/rendering-performance/p1-fog-check.json)
- [实际 SDK 整链路、资源与下游消费](../verification/rendering-performance/environment-lut-integration.json)
- [通用 shader/时域/边界 GPU 检查](../verification/rendering-performance/p0-shader-check.json)
- [LUT 来源、许可与适配](../../src/environment/reference/hillaire/NOTICE.md)
- [先前白边/羽化修复](../verification/rendering-performance/CLOUD_BOUNDARY_FIX_2026-10-15.md)
