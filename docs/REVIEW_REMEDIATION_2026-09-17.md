# 阶段一二审问题修复记录

基于 `60538e0`，本轮亲自修复。结果保存在当前工作区，未提交或推送；不包含其他工作同时修改的校园资产清单、示例质量参数和 AA/基准脚本。

## 修复内容

| 二审问题 | 本轮处理 | 验证 |
| --- | --- | --- |
| F1 UMD 过期 | 重建 CCR.min.js、gzip、manifest；新增逐源文件哈希门禁 | ESM 与 UMD 均执行修复后的曲线、太阳与景深逻辑；包哈希见下 |
| F2 太阳 UV 上下翻转 | NDC 按左下角纹理坐标映射，不采用 DOM y 翻转 | 上/下半屏、背面单测；实际相机投影与 `_sunScreen` 一致 |
| F3 景深公开 setter 缺依赖 | setLensEffects 同步材质通道依赖；setOptions 切换效果时重建相关 stages；暂停不偷偷启用 | 公开 API 与 setOptions 都得到有效米制深度；缺深度报告无效 |
| F4 tonemap 包装所有权 | 捕获每代 previous 与独立 active token，只在仍持有 hook 时还原 | 外部 wrapper 保留；退休 hook 透传；再次启用和销毁通过 |
| F5 假负载/假 draw 计数 | 共用通用 225 模型夹具，镜头围绕负载；逐帧统计真实命令，移除零绘制兜底 | 三轨迹、三配置每段最少 225 条可见模型命令；deferred 请求必须实际 deferred |
| 恢复后误报有效 | 丢失后永久暂停旧管线并停止旧 Viewer 默认循环；要求显式重建 Viewer | WebGL 恢复后材质/SSR/Bloom 仍无效；重载模型后颜色与拾取恢复 |

恢复不宣称旧 Cesium GPU 资源自动重建。宿主应通过 `getRenderDiagnostics().recovery` 识别需要重建，重新加载业务资产和恢复相机/交互。实际测试销毁了旧 pipeline **及 Viewer**，重载 `recovery-building`，前后颜色均 `[169,185,193]`，拾取 ID 相同。API 说明见 `docs/API.md`。

## 实际性能修复

真实负载门禁先暴露了组合模式约 50 ms 的耗时。定位到延迟光照为每个环境分组重复查询、绑定、恢复太阳 UBO，造成驱动同步。现在在整批延迟光照内共享一次绑定；逐 draw 仍比较实际太阳数据，同帧变更不被忽略，批次异常退出也恢复外部 GL 绑定。

225 组对照中，关闭批次绑定的 GPU 约 45–56 ms，开启后约 5–12 ms；CPU 中位约 55–64 ms 降至 10–14 ms。这是指定负载和本机环境下的诊断数据，不是所有设备的 FPS 保证。

同帧、相同材质/IBL 输入的 HDR 输出逐值差异为 **0**（3 帧）。不同帧存在原生输入变化，关闭优化的重复对照也会变化，故没有用放宽跨帧像素阈值证明等价。没有保留此前无明显收益的 scissor 尝试。

默认关闭光柱/光斑时，其介质遮挡 pass 现在不分配 collection、不执行；正常云雾颜色 pass 不受影响。该数据只在有消费需求时生产，诊断如实显示未请求。

## 验证结果与边界

- 本轮相关单测 **639/639 通过**。
- 完整工作区另有未跟踪的 `campus-business-assets.test.mjs`：2 项中 1 项失败，要求示例 `maximumScreenSpaceError:128`，当前其他工作的示例配置为 32。本轮保留它们，未修改测试或示例以制造全绿。
- 浏览器通过：`check-review-remediation`、`check-frame-uniforms`、`check-deferred-ssr`、`check-lens-effects`、`check-global-fog`、`check-stage1-lifecycle`、`check-sun-batching`、`check-stage1-acceptance --quick`、`check-campus-b03-performance`。
- 延迟 SSR 回归：strength=0 差异 0，真实命中 20536 个。
- SDK ESM/UMD 图像哈希同为 `b3c058780b613353`；新增源码哈希与修复行为门禁，不再只比未启用修复功能的截图。
- 恢复与 UBO 修改均未通过更新 golden 消除错误，本轮未改 golden。

### 通用性能矩阵

1920×1080，225 个真实可见 Model；quick 为 3 秒预热、每轨迹 2 秒、1 轮。下表 GPU 取三个轨迹各自中位值的范围。

| 配置 | GPU 中位范围 | CPU 提交中位范围 | 整帧均值范围 |
| --- | --- | --- | --- |
| 隔离基线 | 4.54–8.17 ms | 3.10–3.80 ms | 16.67 ms |
| CCR 默认 | 7.79–8.24 ms | 5.90–6.40 ms | 16.67–16.68 ms |
| HBAO/SSR/Bloom + 实际 deferred | 14.75–15.04 ms | 13.50–14.80 ms | 16.67–17.82 ms |

恢复默认 FPS≥30、整帧 P95≤33.3ms 的门禁，同时保留 GPU 上界；组合模式按**整帧均值不超过隔离基线两倍**判定，删除额外 12ms 放行量。CPU/GPU 分别记录，不能互相代替。这是快速回归，不冒充 30s/60s/3 轮长测。

### 校园与 B03 同条件对照

1280×720、同一版校园示例与本地资产、固定时间、关闭远程影像以排除外部服务波动；B03 使用 Git 中 `b94a9b8` 的 UMD，当前使用本轮构建。两轮交替、全景/近景各 120 帧；等待所有当前视角瓦片稳定。资产清单含 13 个校园 tileset，周边模型同样等待完成。

相机位置差异门槛 1e-7 m，方向/上向量分量差异 1e-11，避免把 Cesium 重复正交化的约 1e-13 数值差误判为不同镜头。脚本同时校验示例源文件采样前后未变化。

| 视角 | B03 整帧均值 | 当前整帧均值 | B03 / 当前 GPU 中位 |
| --- | --- | --- | --- |
| 全景 | 18.58 ms（约 53.8 FPS） | 20.43 ms（约 48.9 FPS） | 16.06 / 16.35 ms |
| 近景 | 18.38 ms（约 54.4 FPS） | 19.59 ms（约 51.0 FPS） | 15.77 / 15.90 ms |

**当前仍慢约 7%–10%，未实现校园稳定 60 FPS。** 通过的是本脚本明确采用的整帧回退≤15%门槛，不代表用户历史的 60 FPS 要求已经达到。当前完整资产配置下 B03 自身也未达 60 FPS；不能把它与较早资产/LOD配置下的历史读数直接比较。后续若继续收紧帧预算，应先冻结同一资产与 LOD 组合再推进 CPU 开销优化。

## 产物与原始证据

`build/0.1.0/CCR.min.js`：459690 字节；SHA256：
`4ce62fd3d0c4d9cb241417a5547b3ff93e98efe2c7010ff214f3624ffb228fdb`。
manifest 的全部 sourceHashes 与当前源码一致。

本机原始报告：`docs/verification/review-remediation.json`、`sun-batching.json`、`campus-b03-performance.json`、`stage1-B11/lifecycle.json`、`stage1-B12/performance.json`；最终日志前缀 `final-check-`、`remediation-`。

本轮关闭二审的具体功能/交付/负载真实性问题；B08 透明分段介质、完整长测、B10/B13 暂缓项及稳定 60 FPS 仍按各自范围保留，不据此宣称阶段一全部完成。
