# B02 修复与交接（2026-09-16）

> 后续进度：B03 已补齐 SSR 延迟组合及透明前向，见 [B03_COMPLETION.md](B03_COMPLETION.md)。下文保留 B02 提交时的范围记录。

本轮关闭审查 R1–R9 和“重复原生照明、实际五附件”问题，完成 **Cesium 1.143、HDR、3D 透视、单采样 OIT 下标准不透明 PBR 的延迟接管**。默认仍为 enhanced。B03 的 SSR/透明完整集成、MSAA 延迟几何与排序透明接点仍未实现，不能据此称阶段一或所有渲染模式已经完成。

## 二审修复收尾

2026-09-16，针对提交 `1a361ea` 的快速二审，三项新增缺陷均已修复：

- **主几何异常恢复**：在实例 draw 接管边界捕获错误，复用照明恢复路径；释放材质目标前恢复本帧已接管对象的原生颜色。失败命令和后续命令走原生。恢复过程保留当前视锥、pass 和 viewport，避免中途恢复改变后续投影；命令执行前即登记恢复信息，覆盖写入完成后抛错的情况。
- **AO 依赖恢复**：依据实际几何接管可用性与失败状态重新计算依赖；故障、运行范围不支持或本帧全部对象走兼容渲染时，恢复传统材质生产者。AO 在后续帧重新获得有效材质/Hi-Z；恢复接管后停止无用的传统生产者。故障帧保证原生颜色恢复，不承诺该帧 AO 也立即重建。
- **编译失败清理**：照明 shader 绑定失败时释放临时程序及 RenderState 引用；几何 shader 的多个变体采用先登记所有权再构造的顺序，保证中途失败也能统一释放。

新增 `check-deferred-recovery.cjs`：七组检查包含部分几何接管前/后失败、真实多视锥、照明＋HBAO 故障、运行范围回退、全兼容回退及 UMD。同帧线性 HDR 与独立原生参考比较；失败原因保留、零场景错误、显式重试以及软回退自动恢复均纳入断言。新增单测覆盖五次编译失败清理和部分变体分配失败。证据：`verification/stage1-B02-recovery/report.json`；原二审失败记录保留，不覆盖。

## 实现及审查对应

| 原问题 | 修复 | 验证入口 |
| --- | --- | --- |
| R1 米制深度当窗口深度 | 保存原生 eye-space XY 与正米制 Z，照明直接使用 `(x,y,-depth)`；保留原生 XYZ 法线，避免锐利 GGX 高光的重建/量化误差 | 七材质、roughness=0.04 高光、log-depth 开关、多视锥 HDR 对照 |
| R2 首次开启/依赖顺序 | 延迟模块拥有独立材质生产者，首次 setLighting 即可启用；不篡改 materialChannelsEnabled/albedoEnabled | 从关闭状态启动；退出后显式选项不变 |
| R3 FBO/程序生命周期 | 按原生颜色纹理缓存写 FBO；共享深度但不拥有它；释放实际 shader 和 RenderState 引用 | 20 轮开关、缩放、关闭、viewer 先销毁、上下文丢失 |
| R4 全局 Cesium 依赖 | 全部通过构造器注入的引擎创建对象 | 删除 window.Cesium 后真实绘制；UMD 渲染 |
| R5 IBL 不等价 | 从实际模型命令获取 SH、环境立方贴图、IBL 因子、参考矩阵与 mip 上限，按实际环境分组；复用 Cesium 官方 IBL shader | IBL=0、仅间接项、独立模型 SH/因子、不同地理位置 |
| R6 阴影/AO 错误入口与时序 | 使用现有阴影深度、receiverMatrix 和同一 PCF；AO 在照明前生成，仅衰减间接项 | 直接光不受 AO 影响、间接光变暗、阴影衰减直接光、自发光不变 |
| R7 局部更新退回 enhanced | setLighting 合并规范化参数，未传入 mode 时保留当前模式 | 局部 debug/term 更新测试 |
| R8 故障不可重试/原因丢失 | 保留失败原因，显式停用后可重新启用；照明失败时同帧恢复已替换的原生颜色 | 注入写目标失败、像素对照与重试 |
| R9 过滤掉失败样本 | 强制七个普通材质全部有效，逐通道执行原门槛 | 独立原生参考；绝对误差 ≤0.01 或相对误差 ≤2%，未放宽 |
| 重复主颜色绘制 | 实例级 Context.draw 桥将受支持 opaque 主颜色命令改为 MRT 材质命令；不再先画原生 PBR 再重放材质 | 外部 draw 计数确认受支持对象原生主颜色执行数为 0；拾取身份保持 |
| 五附件冒充四附件 | compact-v1 使用四个颜色附件；透明覆盖另画到 R8，借用原生深度 | 真实四附件 FBO；限制为四槽的能力模拟 |

收尾审查还补上 Context.draw 的 shader/uniform override、原生雾效兼容判断、写目标缺失的同帧恢复。中性 feature ID 可以接管；实际改色 style 保持原生。生产代码不按校园位置、资产文件名或 URL 决定行为。

## 数据与成本

| 附件 | 格式 | 内容 |
| --- | --- | --- |
| normalRoughMetal（保留接口键名） | RGBA32F | 原生 eye-space normal XYZ、roughness；本布局不使用八面体编码 |
| emissiveFlags | RGBA32F | HDR emission RGB、低十位材质 flags + group ID × 1024 |
| eyeDepth（保留接口键名） | RGBA32F | 正米制深度、eye-space X/Y、metalness |
| albedoOcclusion | RGBA16F | 线性 albedo RGB、材质 occlusion |
| transparency（独立 pass） | R8 | 保守透明覆盖，非透明度 |

四个颜色附件加覆盖共 **57 字节/像素，1080p 约 112.7 MiB**，不含按需 Hi-Z/AO 与 Cesium 自有目标。RGBA32F 保留锐利高光所需精度；不能宣称低显存或已经性能优化。旧增强路径公开 MaterialChannels 布局不变，AO 通过生产者契约识别新布局。多个不同环境组会增加全屏照明次数，后续需正式性能评估。

## 支持边界

- 接管：标准 metallic/roughness OPAQUE/MASK、法线贴图、双面、实例化、蒙皮、普通 Model 与中性 feature 的 3D Tiles；保留原生顶点变换、MASK discard、深度/拾取。真实六视锥已验证。
- 按对象兼容：unlit、clearcoat 等未映射材质扩展、自定义材质/独立 lightColor、改色 style、原生雾正在作用的模型等。原生颜色保留，并将其覆盖的材质像素失效，避免背后对象漏出。
- 整帧增强回退：MSAA > 1、OIT 关闭/排序透明、SSR 或 TAA 同开、非 HDR/非 3D/非对称透视、复杂分类等未支持命令族。`getLightingDiagnostics()` 区分 requested 与 activeMode，并给出 reason。
- OIT 透明几何仍由 Cesium 绘制，CCR 在最终合成前写不透明颜色；已验证玻璃混合和覆盖。完整透明照明与 SSR 数据契约属于 B03。
- 四槽为能力限制模拟，未据此宣称已在只有四槽的实体 GPU 或所有厂商上通过。无正式 FPS/P95、长时间显存压力或全部资产验收。
- 上下文丢失验证资源释放与失败状态；不承诺 Cesium 场景自动恢复。宿主恢复引擎后需显式重新启用。

## 复现与证据

启动项目开发服务器，设置 CCR_TEST_PORT（默认 8877）与本机 CESIUM_PLAYWRIGHT 模块路径后执行：

```powershell
npm test
npm run build
node scripts/check-deferred-lighting.cjs
node scripts/check-deferred-matrix.cjs
node scripts/check-deferred-recovery.cjs
node scripts/check-deferred-composition.cjs
node scripts/check-deferred-tiles.cjs
node scripts/check-stage1.cjs
node scripts/check-frame-bridge.cjs
node scripts/check-browser-sdk.cjs
node scripts/check-renderer-locations.cjs
node scripts/check-stage1-baseline.cjs --mode compare --configuration ccr-default --repeat 1
```

运行结果摘要见同目录 `B02_VALIDATION.json`。详细本机证据仍遵循既有忽略规则：`verification/stage1-B02-fixed/report.json`、`verification/stage1-B02-matrix/report.json`、`verification/B02-composition.json`、`verification/B02-tiles.json`。最初 `verification/stage1-B02/` 的失败报告与 `B02_IMPLEMENTATION_REVIEW.md` 保留为历史，不作为当前通过证据。

本提交同时包含此前已完成但尚未提交的通用范围修正：B00 默认采用无资产合成夹具，地理位置矩阵独立验证；校园特定叶片/IBL 适配迁到 `examples/compat`，由校园示例显式启用。TAA 算法、多光源与私有资产没有纳入本轮开发。
