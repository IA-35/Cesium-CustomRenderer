# 阶段一 B00/B01 验收说明

> 最新范围：[CCR通用渲染原则](RENDERER_SCOPE.md)。B00默认target为fixtures；校园是可选集成用例，其服务/资产问题不定义CCR的通用能力边界。
2026-09-15 修订。以本说明和 [修复交接](B00_B01_FIX_HANDOVER.md) 为当前口径，历史B01报告保留作缺陷复现，不再代表当前实现。

## 1. 本阶段交付边界

B00交付可冻结/只读比较的图像基准、源码内容指纹、实际资产/材质记录、逐镜头加载门槛；B01交付明确模式边界的OIT帧观察和最终不透明颜色替换接点。它们不等于B02完整延迟照明、对象剔除或5000灯。

排序透明没有安全的透明前接点，保持原生增强路径并明确拒绝写入；没有为了勾选完成而伪造opaque回调。多光源B13仍暂缓。旧宿主完整材质/albedo/透明/TAA GPU夹具按B02/B03/B10的消费者需求继续迁移，不把未运行的旧测试列入本批证据。

## 2. B00基准契约

| 项目 | 当前行为 |
| --- | --- |
| 目标 | fixtures、campus-geometry分别建立确定性基准；campus含真实影像，独立视觉/加载验收 |
| 配置 | isolated隔离诊断、ccr-default自定义阴影＋SMAA、campus-quality加HBAO/SSR/Bloom与MSAA4 |
| 存储 | tests/rendering/baselines/<target>-<configuration>.json，已复比五份，不互相覆盖；校园campus-quality未达严格一致性，暂不发布该组golden |
| update | 必须显式请求且repeat≥2，两次独立浏览器上下文运行一致才写入 |
| compare | 默认模式；只读golden，检查图像、配置目标、GPU与资产集合，不写基准 |
| 单轮 | 可以与已冻结golden比较，但确定性状态写not-tested，不声称两轮一致 |
| 源码 | Git枚举后逐文件内容SHA256，覆盖src/scripts/examples/tests与包定义；记录采集前后源码一致性 |
| 资产 | 本机校园资产路径/内容hash；私有资产不加入公共分发 |
| 材质统计 | 每个固定镜头记录可见Model owners的材质组件、OPAQUE/MASK/BLEND、albedo纹理及unlit数量；不冒充全部未加载瓦片统计 |

固定时间2026-06-21T04:00:00Z，1280×720实际drawing buffer，固定镜头与八个绕行采样点。云动画关闭，云距仍12–50km。绕行采样之间等待稳定，因此它是固定路径采样，不是连续运动的性能/TAA验收。

CCR阴影的稳定网格有历史状态；基准在确定的第一个镜头下重建阴影实例，再执行固定轨迹。没有关闭生产阴影或更改其过滤算法来取得一致性。

### 影像就绪与失败

- 每个镜头/绕行采样都检查Globe瓦片和校园/周边模型就绪，并要求连续稳定帧。
- campus必须至少有一个实际可见、有效provider的影像层；空图层为失败。
- 所需资源HTTP错误、请求失败和provider错误均失败；URL查询参数不进入报告。
- 不使用1.143不存在的imageryTilesLoaded属性。
- campus-geometry从请求开始即禁用外部影像，且报告明确其范围，不能用它替代campus视觉验收。
- 历史影像差异只能定位到影像相关路径/状态，不能据单张瓦片稳定或移除影像就排除渲染器逻辑。

## 3. B01已验证矩阵

| 模式 | 观察/写入位置 | 结果 |
| --- | --- | --- |
| OIT MRT、单采样 | 最终translucent（OIT compose之前） | 正确线性合成 |
| OIT MRT、MSAA4 | 最终translucent，写已解析opaque纹理 | 正确线性合成；旧“MSAA一定不可用”结论撤销 |
| OIT multipass | 初始化真实单附件OIT目标及multipass派生命令 | 正确线性合成 |
| 10视锥 | per-frustum观察＋最终translucent写入 | 正确最终合成，未宣称逐视锥light resolve |
| OIT关闭/排序透明 | 仅resolve观察 | 无伪造opaque事件，颜色写入明确拒绝 |
| 无玻璃 | 最终translucent | 正确替换 |
| UMD加载 | 同一矩阵夹具调用构建出的CCR | 正确线性合成 |

使用单层、已知线性色的透明平面，实际投影选择采样点；alpha=0/0.5/1对照独立线性公式。不能把tonemap后的截图或“像素有变化”当作混合公式验证。

已验证范围还包括：明确对象ID与拾取深度、帧外写入拒绝、读回half-float解码、GL绑定和Cesium缓存恢复、801×603 resize、旧FBO释放/借用纹理保留、卸载/重装、外部wrapper保留、上下文丢失退役。宿主整个场景的上下文自动恢复仍属于B11，不由帧桥承诺。

## 4. 复现

开发服务器从进程环境读取CCR_EXAMPLE_IMAGERY_URL和CCR_EXAMPLE_ION_TOKEN。静态部署通过部署流程注入window.CCR_EXAMPLE_CONFIG。凭据不写入仓库；examples/runtime-config.js仅为空配置默认值。

```powershell
node scripts/dev-server.cjs --port 8877
$env:CCR_TEST_PORT = '8877'
# CESIUM_PLAYWRIGHT 设置为本机已安装的Playwright路径
npm test
npm run build
node scripts/check-frame-bridge.cjs
node scripts/check-baseline-guards.cjs

# 默认只读比较；其余配置可替换为isolated或campus-quality
node scripts/check-stage1-baseline.cjs --target fixtures --mode compare --configuration ccr-default --repeat 1
node scripts/check-stage1-baseline.cjs --target campus-geometry --mode compare --configuration ccr-default --repeat 1
node scripts/check-stage1-baseline.cjs --target campus --mode visual --repeat 1

# 仅在明确需要建立新golden时执行
node scripts/check-stage1-baseline.cjs --target fixtures --mode update --configuration ccr-default --repeat 2
```

历史tests/rendering/stage1-baseline.json不再读取或更新。当前golden针对本次Chrome/RTX3070环境；硬件/资产变化先判不匹配，再审阅新图像，不能自动更新以掩盖回归。

## 5. 证据目录

- docs/verification/stage1-B01-fixed/report.json：当前桥GPU矩阵、混合读数、资源/拾取结果。
- docs/verification/stage1-B00-fixed/：各组update与compare记录；campus-quality和真实影像失败记录单列。
- docs/verification/B00-guards.json：实际曝光回归、golden不变、空图层和HTTP503负例。
- docs/verification/B00-B01-unit.log、B00-B01-build.log、B00-B01-stage1.log、B00-B01-sdk.log、B00-B01-aa.log。
- 可公开的检查摘要随修复交接提交；本地原始截图/日志仍保持忽略规则。

本批不提供正式前台FPS或P95认证，也不声称覆盖全部材质、GPU、Cesium版本与业务交互。

## 6. 当前场景验收限制（没有放宽阈值）

- 五组确定性基准已通过独立复比：fixtures的三种配置、campus-geometry的isolated与ccr-default。
- 校园campus-quality在独立运行中出现少量像素波动。逐像素诊断中每个镜头最多十余个变化像素，最大通道差21/255；1/255试验门槛也拒绝了它。未扩大容差，未发布该组golden，未将此结果写为位精确通过。该组合的SSR/HBAO/Bloom/MSAA生产实现未在本轮修改，后续效果稳定性验收仍需处理。
- 真实影像长轨迹出现provider失败，当前加载门槛正确返回失败。独立近景检查可正常加载不能证明整条轨迹通过；本轮不签署完整影像轨迹验收。
- 这些限制不撤销B00工具及B01接点的修复测试，也不代表阶段一整体完成。源码修复可独立审查提交，场景质量/服务可用性验收继续保留未通过状态。

## 7. B02 当前阶段

标准不透明 PBR 的单采样 OIT 延迟接管及原审查缺陷修复见 [B02_COMPLETION.md](B02_COMPLETION.md)。默认通用合成基准保持只读比较，未用更新 golden 掩盖回归。B02 的 MSAA 延迟几何、排序模式不透明延迟接点及 TAA 组合仍有公开缺口；SSR 已由 B03 接通；不将安全增强回退等同于这些模式已被延迟接管。

## 8. B03 完成验收

透明前向修复、延迟环境镜面 SSR 替换、水/粒子、MASK/异步 tile/style/选中轮廓及显式兼容矩阵已通过。当前证据与复现入口见 [B03_COMPLETION.md](B03_COMPLETION.md) 和 [B03_VALIDATION.json](B03_VALIDATION.json)。原 stage1-B03 首轮报告保留为历史，不能代替修复后的验收。

## 9. B04–B06 完成验收

相机跟随级联阴影、共享 FBO/UBO 资源复用、实际对象遮挡剔除及缓存见 [B04_B06_EXECUTION.md](B04_B06_EXECUTION.md) 与 [B05_RESOURCE_LEDGER.md](B05_RESOURCE_LEDGER.md)。**须注意其后有性能回退**：复杂场景实测三级级联与太阳 UBO 导致帧率骤降，默认已回退为 `shadowCascades:1, shadowSize:4096`；三级级联与太阳 UBO 仍可显式启用。

## 10. B07–B12 完成验收

| 批次 | 结论 | 证据 |
| --- | --- | --- |
| B07 SSR 材质/水面/积水覆盖 | 完成 | [B07_COMPLETION.md](B07_COMPLETION.md)、[B07_RECONNAISSANCE.md](B07_RECONNAISSANCE.md) |
| B08 全局地理高度雾与介质遮挡 | 完成主体 | [B08_COMPLETION.md](B08_COMPLETION.md)、[B08_RECONNAISSANCE.md](B08_RECONNAISSANCE.md) |
| B09 Tonemap 与镜头效果 | 完成主体 | [B09_COMPLETION.md](B09_COMPLETION.md)、[B09_RECONNAISSANCE.md](B09_RECONNAISSANCE.md) |
| B10 TAA 稳定性收口 | 已恢复开发，基础及交互修补已实现，完整运动/组合矩阵未收口 | TAA_INTERACTION_FIX_2026-09-18.md、INTEGRATION_2026-09-18.md |
| B11 生命周期/能力降级/默认策略 | 完成主体 | [B11_COMPLETION.md](B11_COMPLETION.md) |
| B12 场景矩阵验收与 SDK 候选产物 | 完成主体 | [B12_COMPLETION.md](B12_COMPLETION.md) |

### 固定负载性能（B12）

以下数字为早期历史记录，不作为当前版本性能认证。后续已修正有效负载与绘制计数；以实际负载门禁和最新运行证据为准，见 REVIEW_REMEDIATION_2026-09-17.md。

1920×1080、三条固定镜头轨迹、当地正午。判定使用 **GPU 中位时间**
（`EXT_disjoint_timer_query_webgl2`），因为实测 headless 下 rAF 被 vsync 锁在
~60 FPS，三配置 FPS 几乎相同（59.47/59.99/59.96），**无区分力**；rAF 抖动
达 4.8–77 ms，p95 亦不可用。旧/新阈值与原因见
[B12_COMPLETION.md](B12_COMPLETION.md)，非静默放宽。

| 配置 | GPU 中位 | 门槛 |
| --- | --- | --- |
| 隔离基线 | 1.16 ms | 参考 |
| CCR 默认 | **7.03 ms** | ≤33.3 ms ✓ |
| 效果组合 | **12.60 ms** | 增量 11.43 ms ≤ 14.33 ms ✓ |

ESM 与 UMD 在相同配置下**图像逐字节相同**（哈希 `b0b06c3437e824cf`），
导出为超集关系（UMD 追加 4 个白名单便利导出）。`npm pack --dry-run`
为 99 文件 / 259.4 kB，私有资产零泄漏。

## 11. 产物与命名边界

当前产物位于 `build/0.1.0/`，版本 `0.1.0`。字节数、SHA-256 和逐源码文件指纹统一以该目录 `manifest.json` 为准，不在验收正文重复固化旧哈希。

**B13（5000+ 延迟光源）仍暂缓**，因此产物名称与说明**不得**称「原始目标全部完成」。
本文件与各批次完成报告一律按「阶段一当前范围」表述。

## 12. 阶段一当前范围的公开未完成项

以下按批次汇总，逐条均在各完成报告中有详细说明，**未勾选**对应主计划复选框：

| 批次 | 未完成内容 |
| --- | --- |
| B02 | MSAA 延迟几何接管（现为安全回退）；排序透明的不透明延迟接点与 TAA 组合 |
| B03 | 旧宿主 GPU 夹具迁移 |
| B04 | 三级级联与太阳 UBO 默认已回退（性能原因），仅可显式启用 |
| B07 | 「SSR 关/开基础 PBR 色差 ≤0.01/≤2%」未单独测量；粗糙度梯度图像验证；相机旋转/俯仰/近远序列 |
| B08 | 多视锥透明分段**未接入渲染路径**；透明片元按自身距离读取介质；云雾真正分段 T/S 合成；云层档位未改 12–50 km；全球测试未含山区/云下中上/高空俯视 |
| B09 | 景深焦带/深度断层测试；光斑图案化外观；完整 HDR 色阶矩阵；未复用 Cesium blur/DoF stage（因二次 gamma 风险，走计划给出的适配出口） |
| B10 | 已实现基础 TAA、稳定 ID/POI 分层；完整运动向量、动态物体与跨模式延迟接管仍未收口 |
| B11 | 浏览器恢复事件与显式销毁重建出口已验证；旧 Viewer GPU 资源不自动重建。完整 30 分钟压力运行、完整异步/外部 wrapper 矩阵、真实受限设备（4/6 槽）验证仍未完成 |
| B12 | 完整性能参数（30 s/60 s/3 轮）运行；**卫星底图**逐条验收（该夹具无影像层，由 B00 campus 覆盖）；像素级阴影浮空/重影（由 B04 覆盖）；场景交互统一复验；离线最小消费者 UMD 验证；`effects-combined` 像素基线 |
| B13 | **整批暂缓**（5000+ 延迟光源） |

**阶段一原始目标完整完成仍需要 B13**；当前范围候选产物**不等于**原始目标全部完成。
