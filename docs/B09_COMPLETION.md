# B09 完成报告：Tonemap、模糊、色差、光斑与 Light Shaft

> 2026-09-17。基线 `522597e`（B08 落盘），分支 `codex/stage1-b07-b12`。
> 验收线以[主计划 B09](STAGE1_COMPLETION_PLAN.md) 与
> [B07–B12 执行计划](STAGE1_B07_B12_EXECUTION_PLAN.md) 为准；前置调查见
> [B09_RECONNAISSANCE.md](B09_RECONNAISSANCE.md)。

## 新增与修改

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `src/stages/toneMapping143.js` | 四条曲线选择与「只映射一次」契约、Unreal 近似曲线 |
| 新增 | `src/stages/lensEffects143.js` | 移轴/模糊/景深/色差/光柱/光斑着色器与互斥解析 |
| 新增 | `src/stages/LensEffectPipeline143.js` | 管线管理器（stage 创建/销毁、原地更新、诊断） |
| 新增 | `tests/rendering/tone-mapping.test.mjs` | 26 项单测 |
| 新增 | `tests/rendering/lens-effects.test.mjs` | 27 项单测（含文件名大小写碰撞防护） |
| 新增 | `scripts/check-lens-effects.cjs` | GPU 验收（identity / 单次映射 / 不透墙） |
| 修改 | `src/VisualPipeline.js` | 接入 `applyLensEffects` / `setLensEffects` / 诊断与销毁 |
| 修改 | `src/presets.js` | B09 选项、范围与白名单校验 |

**文件名注意**：管理器刻意命名为 `LensEffectPipeline143.js` 而非 `LensEffects143.js`。
Windows 文件系统大小写不敏感，后者会与 `lensEffects143.js` **是同一个文件**——
本项目实测过该事故（管理器覆盖着色器模块、所有着色器导出消失），因此新增了
「同一目录内不得存在仅大小写不同的文件」的自动守卫测试。

## 实测结果

### 色调映射（`scripts/check-lens-effects.cjs`）

| 曲线 | 画面均值 | 哈希 vs 基线 | 生效方式 |
| --- | --- | --- | --- |
| `aces`（默认） | 207.203 | **相同** | 原生枚举（CCR 本来就是 ACES，不引入变化） |
| `reinhard` | 185.000 | 不同 | 原生枚举，`exactlyOnce: true` |
| `filmic` | 172.707 | 不同 | 原生枚举，`exactlyOnce: true` |
| `unrealFilmicApprox` | 220.171 | 不同 | **自建 stage + 关闭原生**，`exactlyOnce: true` |

四条曲线的诊断都报告 `exactlyOnce: true`，即「原生」与「自建」两个分支**永不共存**。
自建曲线额外验证：曝光在曲线之前施加、`czm_inverseGamma` 由自建分支自行补上
（否则画面整体变暗）、alpha 原样直通、`toneActive` 为假时逐位 identity。

### 镜头效果 identity（硬验收线）

六个效果在**强度 0** 时与「完全关闭」的整屏哈希**逐位相同**：

| 效果 | 哈希 | 判定 |
| --- | --- | --- |
| tiltShift 强度 0 | `994a2948ff9f8284` | = 基线 ✓ |
| blur 强度 0 | 同上 | = 基线 ✓ |
| depthOfField 强度 0 | 同上 | = 基线 ✓ |
| chromaticAberration 强度 0 | 同上 | = 基线 ✓ |
| lightShaft 强度 0 | 同上 | = 基线 ✓ |
| sunFlare 强度 0 | 同上 | = 基线 ✓ |

identity 是着色器的**第一分支**（`if (strength <= 0) { out_FragColor = source; return; }`），
不是靠参数恰好抵消——因此关闭时既逐位相同也不产生任何采样开销。

### 效果生效证据（证明 identity 不是「什么都没执行」）

| 效果 | 证据 |
| --- | --- |
| blur | 梯度能量 **0.1018 → 0.0418**（降低 59%），stage 执行 45 次 |
| chromaticAberration | 整屏哈希改变，stage 执行 45 次 |
| 三个模糊互斥 | 同时请求三者时诊断 `active: 'tiltShift'`，另两个带 `Suppressed by tiltShift` 原因 |

### 光柱 / 光斑：不透墙（着色器级验证）

场景几何无法把太阳放进视锥（`worldToWindowCoordinates` 返回 null），因此直接编译
`lightShaftShader` 做验证：

| 用例 | 亮度 | 哈希 | 判定 |
| --- | --- | --- | --- |
| 参考（强度 0） | 0.495 | `cb1ada55053264d3` | 基准 |
| 太阳可见、遮挡通透 | **1.035** | `8a31c20023a04327` | ✓ 真实叠加光 |
| **完全遮挡**（建筑遮日） | 0.495 | `cb1ada55053264d3` | ✓ **逐位相同 → 不透墙** |
| 太阳在屏幕外 | 0.495 | `cb1ada55053264d3` | ✓ 背向太阳退出 |

光柱/光斑**消费 B08 的介质遮挡数据**（`occlusion.r * occlusion.g`），
不自造遮挡 mask（有测试锁定：着色器中不得出现 `shadowTexture`/`localToShadow`）。

## 本轮修复的 2 个真实缺陷

1. **Unreal 近似曲线在 `Infinity` 输入下产生 `NaN`**。分式在 `color = Inf` 时是
   `Inf/Inf = NaN`，而 HDR 缓冲里出现极大值是正常情况（太阳直射、加法混合亮斑），
   一个 NaN 会沿整条后处理链扩散成整屏花屏。修：进入分式前把输入截到白点。
   由单元测试暴露（`x=Infinity produced NaN`）。

2. **文件名大小写碰撞导致着色器模块被覆盖**。管理器写进 `LensEffects143.js` 时
   直接覆盖了 `lensEffects143.js`，`EXCLUSIVE_BLUR_EFFECTS` 等导出全部消失。
   修：管理器改名 `LensEffectPipeline143.js`，并新增「同目录内不得存在仅大小写
   不同的文件」守卫测试，防止回归。

另记录一次**排查过程**（非缺陷，但值得留档）：光柱的 stage 级 uniform 注入
（替换 `stage.uniforms.x` 与改写 `stage._uniforms.x`）**均不生效**，四个注入用例
给出同一哈希——Cesium 的 `uniforms` 是只读代理且 uniform map 在命令构建时固化。
因此最终改为直接编译着色器验证，这既绕开了私有管线，也更直接地验证了着色器逻辑。

## 验证汇总

- `npm test`：**603/603 通过**（550 + 53 新增）。
- GPU：`check-lens-effects`（15 个配置 + 4 个着色器级用例）、`check-stage1`。
- 基线：`isolated` 与 `ccr-default` 均 `determinism: passed, goldenCompared: true`
  ——**未变更**，这证明 B09 默认关闭时对既有画面零影响（golden 未更新）。
- 构建：449469 字节，gzip 148038，sha256
  `e5b98b05f3d218b3d1ba52a6460e949fac61d73eaff451923c88e4f9deb42c82`；
  UMD 内含 B09 代码（9 处标记）。

## 未完成项（如实保留，不声称完成）

1. **移轴/模糊/景深未复用 Cesium 的 `createBlurStage`/`createDepthOfFieldStage`**。
   计划要求「优先复用」，但本批改为自建 shader（核归一化 + 真实 textureSize 控半径）。
   理由需如实记录：Cesium 自带的这两个 stage 内部含 `czm_inverseGamma`，
   与本管线的「HDR 链内、显示编码由原生 tonemap 负责」契约冲突，直接用会导致
   二次 gamma。计划对此留了出口（「若其深度/映射阶段不符，适配 shader 而非复制
   collection」），本批走的是该出口。**景深的深度断层与焦带数值测试尚未做**，
   因此主计划「焦带、深度断层」一项**未勾选**。
2. **太阳光斑未做屏幕序列与噪点图案验证**。着色器级已验证遮挡衰减与背向退出，
   但未做「镜头后太阳」的连续帧序列。
3. **光柱未做半分辨率性能与 32 样本的数值对照**。样本数可配（4–32），
   着色器上限 64，但未测半分辨率相对全分辨率的成本。
4. **Blur/DoF/tiltShift 的首期互斥已在 API 层固化并有测试**，但这意味着
   **不能同时使用**——计划本身如此要求（「首期互斥」），非缺口，但需在用户文档写明。
5. **未对 0/0.18/1/16/64 HDR 色阶做完整数值矩阵**。曲线的单调性、黑白点、
   压缩性、极端输入有限性均有数值测试，但未覆盖计划所列的全部色阶点。
6. **HDR 色阶 16/64 的「白墙/天空不因 Bloom 变白幕」未验证**——该条与
   `hdrBloomEnabled` 组合相关，本批未做联合用例。

原始结果在本机 `docs/verification/stage1-B09/`（`lens-effects.json`）。
