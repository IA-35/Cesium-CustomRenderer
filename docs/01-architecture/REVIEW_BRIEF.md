# 交给外部审查者的委托说明（CCR）

> 本文件是**可以直接复制给审查者（人或模型）的委托书**。使用方式见文末「怎么用这份文件」。
> 维护约定：审查结束后请把结论回写到 `docs/verification/`，不要直接改本文件的历史段落。

---

## 0. 你要审什么

一套在 Cesium 之上**接管底层渲染管线**的独立工程（下称 CCR），不是 Cesium 插件、不是后处理库。
它通过替换 `context.draw`、拦截 `Scene.render`、自建 Render Graph，把 Cesium 的默认渲染路径换成自己的
延迟光照 + 自定义阴影 + 自定义大气/云 + 自研抗锯齿。

**核心诉求排序**（决定了什么算严重问题）：

1. **正确性**——画面不能错（阴影要锐、天空要跟着太阳走、透明排序不能崩、切换不能黑屏）
2. **交互流畅度**——目标是稳定 60 FPS，**长帧比平均帧率重要**（见 §6 的验收口径）
3. **可维护性**——Cesium 升级不能整锅翻掉

**不要做的事**：

- 不要提"改成 WebGPU"。已核实 Cesium 官方无 WebGPU 计划，且本工程 RHI 覆盖仅约 29%，跨 API 的深度共享无解。这条已经调研并否决，不要再花时间。
- 不要建议"推倒重写"。架构是有意为之的（见 §3），要改请给增量路径。
- 不要只给泛泛的最佳实践。每条结论必须能落到 `文件:行号`。
- 不要用"加了测试/截图看着挺好"当作验收。本项目已经因为这么做翻过车（§7.3）。

---

## 1. 项目事实（可以自己核）

| 项 | 值 |
|---|---|
| 仓库根 | `G:\_JavaScript\_IAsCesiumLib\cesium customRenderer` |
| 包名/版本 | `cesium-custom-renderer` / 0.1.0 |
| Cesium 版本 | **1.143.0**（严格绑定，升级风险见 §3.4） |
| Node 要求 | 22+ |
| 规模 | `src/` 127 个 `.js` / 约 20,300 行；`tests/` 129 个 `.mjs` |
| 浏览器全局 | `window.CCR`（**没有**其他别名） |
| 当前分支 | `codex/antialiasing-recovery-r186` |
| 已提交 HEAD | `bee30da`（= `master`，与 master 无差异） |
| 工作区 | **有未提交改动，见 §2 —— 审查必须以工作区为准，不要 `git checkout`** |

### 常用命令

```sh
npm install
npm test                       # node --test tests/rendering/*.test.mjs（约 1000+ 断言）
npm run build                  # 必须！生成 build/0.1.0/CCR.min.js
npm run serve                  # 默认 http://127.0.0.1:8766
```

### 陷阱：改 `src/` 不重建 = 白改

`examples/campus.js:11` 是 `import '../build/0.1.0/CCR.min.js'` —— **示例加载的是 UMD 打包产物，不是源码**。
任何 `src/` 改动都必须 `node scripts/build-rendering-sdk.cjs` 才在示例里生效。
本项目的开发者曾因此误判"改动没生效"，绕了一大圈。**你如果只是静态审查，这一点不影响；一旦要跑起来验证，先重建。**

---

## 2. 工作区状态（重要，先读这段）

`git status` 当前有 **18 个已跟踪文件被修改 + 13 个未跟踪新文件**，主体是一轮**在途的抗锯齿重做**：
把 Cesium 原生 TAA 换成 **three.js r186 TRAA 的移植版**。

未跟踪的新增（属于待审代码，不要漏掉）：

```
src/antialiasing/TaaMotion143.js
src/antialiasing/motionShaders143.js
src/antialiasing/taaR186Math143.js
src/antialiasing/reference/three-r186/{TRAANode.js,TAAUtils.js,VelocityNode.js,LICENSE,manifest.json,PORTING.md}
tests/rendering/taa-motion-r186.test.mjs
tests/rendering/taa-r186-math.test.mjs
tests/rendering/taa-r186-fixture.{html,js}
scripts/performance/validate-traa-r186.cjs
scripts/performance/compare-r186-oracle.cjs
docs/superpowers/plans/2026-10-16-antialiasing-recovery.md
docs/verification/rendering-performance/traa-r186-2026-10-16/
```

修改幅度较大的已跟踪文件：

```
src/antialiasing/TaaPass143.js       +241/-   （主控制器）
src/antialiasing/taaShaders143.js    +368/-   （着色器）
src/pipeline/ContextDrawDispatcher143.js
src/VisualPipeline.js
src/presets.js
src/antialiasing/settings143.js
docs/01-architecture/ARCHITECTURE.md
docs/01-architecture/API.md
```

**这意味着**：`bee30da` 里的 TAA 和磁盘上的 TAA 是两套不同算法。
如果你只看 git 内容，会审到已经作废的版本。**审 TAA 请看工作区文件 + `src/antialiasing/reference/three-r186/PORTING.md`（上游映射与偏离清单）+ `docs/verification/rendering-performance/traa-r186-2026-10-16/`（STATUS / ADAPTATION / EVIDENCE / PERFORMANCE 四份报告）。**

---

## 3. 架构：先建立地图，别一头扎进文件

`src/` 分六层，**不要从最大的文件开始读**。推荐顺序：

### 3.1 三份必读（按此顺序，共约 20 分钟）

1. **`docs/01-architecture/ARCHITECTURE.md`**（458 行，11 章）
   §2 分层表 / §4 三条主线 / §5 跨模块契约 / **§6 功能成熟度清单** / **§7 已识别问题** / §8 升级风险面。
   **§6 是重点**：它把每个效果分成「在用 / 可选 / 受限 / 未完成」四档，并写明依据。
   特别注意它的提醒：**「默认关闭 ≠ 可用」**。
2. **`src/VisualPipeline.js`**（约 1050 行的"上帝对象"）
   18 个子系统的装配点，40+ 个 `setXxx/getXxx`。先扫方法名建立索引，不要逐行读。
   关键行：`VisualPipeline.js:64` 注入 graph 的 transient allocator；`rebuildRenderGraph()` 定义全部 Graph Pass。
3. **`src/pipeline/`** —— 三条主线的交汇处，共 1152 行

### 3.2 三条主线（理解这三条，其余都是枝叶）

**① FrameBridge143 —— 帧内阶段广播**
`FRAME_BRIDGE_PHASES = ['opaqueFrame','opaqueReadHook','translucent','resolve']`

订阅者：`DeferredLighting143`（`opaqueFrame` 优先级 −100 清空 RenderItem 队列、`translucent` 执行光照）、
`TransparentForward143`、`OcclusionCulling143`（均在 `resolve`）。

**② ContextDrawDispatcher143 —— 统一 draw 拦截**
决策枚举：`new Set(['pass','replace','skip','continue'])`
实测的 7 个 handler 优先级：

| 优先级 | handler |
|---:|---|
| −30 | `globe-night-lighting` |
| −20 | `taa-overlay` |
| −10 | `selected-id` |
| 0 | `occlusion` |
| 0 | `sun-uniforms` |
| 10 | `deferred-geometry` |
| 20 | `transparent-direct-submit` |

**③ 资源三件套**
`RenderTargetPool143`（`attach/acquire/release/resize`）+ `rhi/WebGLDevice143.js`（85 行，`createTransientAllocator()`）+ `RenderGraph143`（`importResource`/`createResource`/`bindExternal`/`setTransientAllocator`）。

### 3.3 模块规模（2026-10 实测，帮你排优先级）

```
environment   4286 行 / 24 文件   ← 最大，大气 + 云塞在同一个 fragment shader 里
antialiasing  3457 行（含未提交的 TRAA）
channels      1375 行
reflections   1304 行
pipeline      1152 行
instances     1009 行
shadows        975 行
stages         928 行
traffic        852 行
lighting       804 行
diagnostics    703 行
rhi             85 行   ← 最薄，RHI 抽象覆盖度只有约 29%
```

### 3.4 升级风险面（`ARCHITECTURE.md` §8）

对 Cesium 私有 API 的实测依赖计数：`frameState` 123 处、`_gl` 69、`shaderProgram` 62、`_view` 45、
`uniformState` 45、`postProcessStages` 28、`context.draw` 23。
GLSL 自研约 6,850 行。**升级评估请看这些数字，不要靠直觉。**

---

## 4. 审查任务（按优先级，请分组交付）

### 组 A · 正确性：找出会出画面错误的路径（最高优先级）

**A1 锯齿状阴影**（用户最初报告的两个问题之一，至今未根治）

入口：`src/shadows/DirectionalShadowPass.js`（级联阴影）、`src/shadowMap143.js`、`src/shadowBias143.js`、`src/shadows/shadowUniforms143.js`。
关注：级联间过渡、阴影贴图分辨率与视锥拟合的匹配、PCF 核与 `shadowBias143.js` 的深度偏置是否互相打架、
`shouldReuseShadowFrame` 复用缓存时阴影矩阵是否与当前帧视锥一致。

**A2 长帧 / 掉帧**（另一个原始问题）

入口：`src/diagnostics/RenderProfiler143.js`（GPU timer）、`RenderTargetPool143`、`RenderGraph143` 的 transient 分配。
关注：每帧是否发生纹理/FBO 重建、资源池是否真的复用、Graph 的 alias 是否有浪费、是否存在 GPU stall（readPixels / 同步等待）。
**请给出"哪条路径在什么条件下会分配/释放"的明确结论，不要只说"可能有开销"。**

**A3 延迟光照路径的回退覆盖**

`src/lighting/DeferredGeometry143.js:105-119` 的 `scopeReason()` 有 **8 条**回退条件，任一命中即整帧退回增强前向。
请检查：这 8 条是否覆盖了全部会让延迟路径出错的场景？**回退是静默的**，用户看不到，是否应该上报诊断？

**A4 TAA（在途代码，见 §2）**

重点不是"公式对不对"，而是**边界**：`src/antialiasing/reference/three-r186/PORTING.md` 明确列了
CCR 相对上游的偏离（米制深度拒绝、RGBA32F 颜色历史、启动 EMA 校正、局部采样年龄存 alpha 等）。
请判断这些偏离是否可能引入新的错误，以及 **在哪些场景下这套 TRAA 会失效但不会报错**
（报告自己承认：透明/蒙皮/实例仍非完整运动支持，`unsupported=0` 不能推断全场景运动支持）。

### 组 B · 结构：已经识别但未修的问题

`ARCHITECTURE.md` §7 已列，**请先读它们再判断我漏了什么**：

- **7.1 模块环 `channels ⇄ reflections`**
  `src/channels/MaterialChannels143.js:3` → `primitive...PrimitiveReflection143.js`；
  `src/reflections/transparentReflectionShader143.js:1` → `src/channels/reflectionShader143.js`。
  两边交换的都是 `export function` 着色器生成器，仅在函数体内调用，**运行时无害但确是 ES module 环**。
- **7.2 反向依赖 `pipeline → shadows`**
  `src/pipeline/TransparentForward143.js:3` → `shadows/shadowUniforms143.js`。
  根因判断：`TransparentForward143` 是**具体效果**而非基础设施，放错了目录。
- **7.3 `pipeline/` 职责混杂**、**7.4 RHI 太薄**（85 行 vs 29 处直连 `new C.Texture`/`new C.Framebuffer`）、
  **7.5 `environment/` 巨型**、**7.6 `VisualPipeline.js` 上帝对象**

**对 7.6 的额外说明**：曾计划把 40 个 `setXxx` 改成注册表驱动，**评估后主动撤回**——
每个方法都有独特逻辑（`setScreenSpaceAO` 有 updateNativeAO 时序、`setHdrBloom` 有所有权交接、
`setEnvironmentReflections` 要同时关 SSR、`setLensEffects` 有 20 键白名单），表驱动收益低风险高。
如果你认为还有更低风险的拆法，请给具体方案；如果只是想"它太长"，那不用提了。

### 组 C · 测试覆盖的真实缺口

`tests/` 有 129 个文件、1000+ 断言，**但测试数量不等于场景验收**。请找出"看起来有测试、实际没覆盖"的地方。

**已知确定缺口（请从这里开始）**：

- **遮挡剔除：有单元测试，缺集成验证**
  `tests/rendering/occlusion-culling.test.mjs` 确实存在（4 用例：视锥内外与近平面 fail-open、代理包围球
  保守性、两次同态隐藏才生效、安装失败回退 `scene.context.draw` 与 `primitives`）。所以"从未被验证"
  这个说法**不正确**。真实缺口是集成层：没有 dispatcher `skip` 的端到端断言、没有 query 超时
  fail-open 断言（`src/visibility/OcclusionCulling143.js:97-99` 的 `stats.timeouts` 零覆盖）、
  没有停用后重新启用的验证。默认 `occlusionCullingEnabled: false` 仍然意味着它未在真实场景里跑过。
- `direct-submit` / `batcher` 各仅 1 个测试文件
- 延迟光照：仅 2 个测试文件使用 `lightingMode: 'deferred'`

请再自己找：哪些 `if (xxx)` 分支从未被测试触达、哪些 fallback 路径是"写了但永远进不去"。

### 组 D · 只提一次就够的低价值项

MSAA、FXAA、色调映射这三个已经核实清楚，**不必再花篇幅**：

- **MSAA**：实现完整（`selectMsaaSamples` 真查设备格式），但 `src/antialiasing/settings143.js:36-45`
  `resolveMsaaPolicy` 只在 `antialiasing:'msaa'` 时生效，其他模式一律降为 1；且与 TAA 互斥
  （`TaaPass143.js:273`）；默认 1；无独立测试文件。「受限」而非「可用」。
- **FXAA**：复用 Cesium 内置 FXAA 3.11，`FXAA_QUALITY_PRESET 39`（社区确认为 EXTREME QUALITY **最高**档）。
  它对不足 1 像素的结构原理上无效 —— 这是**形态学方法的上限**，不是实现 bug。不要再建议"调高 FXAA 质量"。
- **色调映射**：默认 ACES，**单独开启不改变画面**（别把"开关无副作用"误判为"功能失效"）。

---

## 5. 已经实测确认的事实（不要重复验证，但可以质疑）

以下是逐行核对/实测过的结论，可作为你的出发点：

- **大气是 shadertoy wlBXWK 的忠实移植**
  底本入库 `src/environment/reference/shadertoy_wlBXWK.glsl`（MIT, © 2019 Dimas Leenman），
  差异清单 `src/environment/reference/PORTING_DIFFERENCES.md`。曾有四个常数抄错
  （`ABSORPTION_BETA`、`G`、`HEIGHT_ABSORPTION`、`ABSORPTION_FALLOFF`）已修正。
  **如果发现新的偏离，那是有价值的发现。**
- **大气与场景的合成是分离式的**：raymarch 只算介质（`sceneColor = vec3(0.0)`），
  resolve 阶段 `out_FragColor = vec4(radiance + original.rgb * transmittance, original.a)`。
  历史上曾写成 `original.rgb + environment.rgb * original.a`（纯加法），导致近景过曝，已修。
- **关闭 CCR 环境后帧率会下降**（55.4 → 37.6 FPS）。
  原因不是"环境便宜"，而是关掉后 `scene.skyAtmosphere.show` 恢复 true，换成了更贵的 Cesium 原生 SkyAtmosphere。
  **不要把这条对比读成"环境耗 17.8 FPS"。**
- **夜间没有月光**：`src/` 全目录 `moon|月光|lunar` 零匹配。三个参考源（shadertoy 底本、
  three-geospatial、webgpu-cesium）都没有月光照明；Cesium 官方 `Cesium.Moon` 文档明写
  "Use the sun as the only light source"（只显示月相，不提供照明）。
  所以夜间全黑是**已知未实现**，不是 bug。
- **云层噪声图集有固有精度损失**：`src/environment/volumetricClouds143.js` 的 `ccrCloudNoise3D`
  用 `mod(point, 64.0)` 把 64 个 Z 切片排进 8×8 图集（每 tile 66px），有效特征尺寸再除以 8
  （shape 8km → 1km、detail 2km → 250m），而云层默认厚度仅 1200m。
  上游 three-geospatial 用真 `Texture3D`，无此分割。**这是已知的架构债，不是笔误。**

---

## 6. 验收口径（给结论时的硬要求）

本项目对性能结论有明确纪律，请遵守：

1. **必须给 p90 / p99 与长帧占比**，不能只给平均 FPS 或 p50。
   实测有 p90≈37ms 而 p50≈20ms 的情形，平均值会把掉帧完全掩盖。
2. **采样要交叉校验**。曾经出现过"按 frameNumber 去重"导致算出 115 FPS、
   而 p50 16.5ms（实际应 60 FPS）的自相矛盾。正确做法是 `postRender` 间隔 + frameNumber 增量双向核对，
   先验证 `callsPerFrame === 1`、`frustumCount === 1`。
3. **区分「代码存在」和「路径生效」**。本项目历史上出过两次误判，都是因为只读了局部文件就下架构级结论：
   - 曾断言"四个模块仍在替换 `context.draw`、多层 wrapper 嵌套"→ 实际全是
     `if (dispatcher) {...} else context.draw = hook` 的双路径，运行时走 handler 分支。
   - 曾断言"Graph 的 allocator 没注入"→ 实际 `src/VisualPipeline.js:64` 早就注入了。
   **教训：任何"架构级"结论，必须追溯到初始化点和调用链，不能只看定义处。**
4. **不要用"测试通过 + 截图看着还行"代替验收**。TAA 那次就是这么判的，
   结果用户一上手就说拖影不可接受，报告被改成"用户实测不达标"。

### 当前性能基线（供参照，非验收标准）

RTX 3070 / Ryzen 9 5950X / Chrome / canvas 1264×805 DPR1 / 建筑 GLB 70 + 固定树木 720 + 单视锥：

```
55.4 FPS   p50 16.8ms   p90 21.8ms   p99 41.4ms
超 33.3ms 占 2.82%      超 50ms 占 0.65%     共 3374 帧
```

报告：`docs/verification/rendering-performance/MILESTONE_PERF_2026-10-15.md`
（该报告已明确标注未完成项：纯基线、GPU Pass 级计时、显存实测、**交互验收**、3×300 帧多轮）

---

## 7. 交付格式

请按这个结构给结论，方便我直接转成待办：

```
## 结论摘要
（3-5 条，按严重度排序，每条一句话）

## 发现（逐条）
### [严重度: 高/中/低] 一句话标题
- 位置：文件:行号（必须）
- 现象/触发条件：
- 为什么是问题：
- 证据：（代码引用 / 实测数据 / 上游对照）
- 建议：（给增量修法，不要重写）
- 置信度：已确认 / 待验证（若是待验证，说明怎么验证）

## 我无法判断的
（明确列出需要我提供运行环境或业务信息才能定的问题，不要猜）
```

**请务必单独给出一节「我不同意你判断的地方」** —— 我在 §5 列的那些"已确认事实"，
和 `ARCHITECTURE.md` §6/§7 的判断，都欢迎被推翻。**只有给证据就行。**

---

## 8. 怎么用这份文件

- **Claude Code / 能读仓库的 agent**：直接把本文件路径给它，说"按这份委托书审"。
- **聊天式模型（不能读文件）**：不要整份贴 —— 太长。按需分三次：
  1. 先贴 §0–§4（背景 + 任务），让它先给**审查计划**；
  2. 你确认计划合理后，再按它要的文件逐个贴代码；
  3. 最后贴 §5–§7（已知事实 + 交付格式）。
- **任何情况都不要让它 `git checkout` / `git stash` / 改代码**。当前工作区有未提交的在途改动，
  它是审查对象，不是垃圾。需要它验证的话，让它只读、只在临时目录里跑脚本。
