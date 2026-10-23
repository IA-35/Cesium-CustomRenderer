# 设计：RHI 收口（资源创建、绑定保护、blit、上下文丢失）

状态：批次 0、1 已实现（见第 8 节），其余未实现。日期：2026-10-23。基于 main@02468a6。

## 1. 目标与非目标

目标：让 `src/rhi/WebGLDevice143.js` 成为 CCR 自有 GPU 资源与 framebuffer 绑定状态的唯一入口。

1. 所有 CCR 自有纹理、framebuffer、渲染目标经 RHI 创建，按 owner 统一释放与统计。
2. 临时改动 GL framebuffer 绑定的代码用一个保护函数完成保存与恢复，并与 Cesium 的绑定缓存保持一致。
3. 深度/颜色拷贝（blit）只有一个实现。
4. 上下文丢失只有一个监听点，由 RHI 广播。

非目标：

- **不接管绘制执行。** DrawCommand、ShaderProgram、RenderState、派生命令、后处理 stage 仍由 Cesium 执行。
- 不改 Cesium 后处理 stage 内部的纹理（`PooledStageCache143` 已经接到渲染目标池，保持不变）。
- 不实现上下文恢复。Cesium 1.143 恢复后不会重建自己的 GPU 句柄，现有策略（停渲染循环、要求宿主重建 Viewer）不变。
- 不追求帧率。收益在一致性、可测试性和升级面。

## 2. 现状盘点

### 2.1 RHI 现在做什么

`WebGLDevice143`（89 行）只有四个入口：`createTexture`、`createFramebuffer`、`createRenderTarget`（经 `RenderTargetPool143`）、`createTransientAllocator`（给 Render Graph）。资源记录在 `resources` 集合，`destroy()` 时统一释放。

接入情况：

| 模块 | 用法 |
|---|---|
| `TaaPass143`、`TaaMotion143` | 有 RHI 走 RHI，没有就自己 `new C.Texture/Framebuffer` |
| `AtmosphereLut143` | 同上，两套路径 |
| `DeferredGeometry143`、`DeferredLighting143`、`DeferredReflectionTarget143` | 同上，两套路径 |
| `RenderGraph143` | 临时纹理经 RHI 分配器 |

### 2.2 绕过 RHI 的资源

| 类别 | 模块 | 内容 |
|---|---|---|
| 屏幕尺寸目标 | `TaaOverlay143` | 颜色 + 借用原生深度的 framebuffer |
| | `CloudTemporal143` | 云历史颜色/深度 × 双缓冲 |
| | `MaterialTarget143` | 材质 MRT（4–8 个附件）+ 透明覆盖 |
| | `DepthPyramid143` | Hi-Z 各级纹理与 framebuffer |
| | `TransparentReflection143` | 反射增量纹理与 framebuffer |
| 固定尺寸目标 | `ShadowTarget`（阴影） | 深度纹理 + framebuffer（静态层再多一份） |
| 数据纹理 | `SpatialAaPass143`（SMAA 查找表）、`noiseAtlas.js`（云噪声）、`TransparentForward143`、`DeferredLighting143`（1×1 白纹理） | 一次性上传 |
| 借用附件的别名 framebuffer | `TaaMotion143`（原生深度别名）、`DeferredGeometry143`（材质别名）、`FrameBridge143`（OIT 不透明纹理 scratch）、`TaaOverlay143` | 附件属于 Cesium，不能随 framebuffer 销毁 |
| 原生 GL 对象 | `UniformBuffer143`（UBO）、`GpuTimer`、`OcclusionCulling143`（查询） | 直接 `gl.create*` |

已经接入 RHI 的模块，在没有 RHI 时也保留了直接创建的分支，同一种资源有两套释放代码。

### 2.3 绑定保护：14 处手写

全部是同一个形状：`getParameter(READ/DRAW_FRAMEBUFFER_BINDING)` 保存，`finally` 里 `bindFramebuffer` 恢复。保存的内容不一致：

| 恢复内容 | 模块 |
|---|---|
| READ/DRAW + `_currentFramebuffer` + viewport（多数还有 pass/camera） | `DirectionalShadowPass`、`TaaMotion143`、`TaaOverlay143`、`AtmosphereLut143`、`CloudTemporal143`、`DeferredLighting143`、`FrameBridge143`、`TransparentReflection143`、`OcclusionCulling143` |
| 只有 READ/DRAW（纯 GL 操作，不经 Cesium 绘制） | `ScreenSpaceAo143`、`DepthPyramid143`、`MaterialTarget143`、`ScreenSpaceReflection143`、`SelectedIdPass143` |
| 只清 `_currentFramebuffer`，由调用方恢复 | `ShadowTarget.copyTo` |

`_currentFramebuffer` 是 Cesium Context 的私有字段，10 个文件直接读写，不在 `cesiumPrivate143.js` 网关里。

### 2.4 `framebuffer.status`：16 处检查，有潜在缓存不一致

Cesium 1.143 的 `Framebuffer.status` getter 会 `bindFramebuffer(FRAMEBUFFER, 自己)`、检查、再 `_unBind()` 绑到 `null`，但**不更新** `context._currentFramebuffer`。而 `bindFramebuffer(context, fb)` 只在 `fb !== context._currentFramebuffer` 时才真正绑定。

所以在一个 pass 中途调用 `status`，之后 Cesium 往「缓存里认为已绑定」的 framebuffer 绘制时会跳过绑定，实际画进默认 framebuffer。16 处检查中，13 处（`TaaMotion143`×2、`ScreenSpaceAo143`、`AtmosphereLut143`×2、`CloudTemporal143`、`DeferredGeometry143`×2、`DeferredLighting143`、`DeferredReflectionTarget143`、`RenderTargetPool143`、`ScreenSpaceReflection143`、`TransparentReflection143`）只有 `AtmosphereLut143` 显式清了缓存。另 3 处在 `src/channels/`：`DepthPyramid143._allocate` 1 处、`MaterialTarget143` 2 处（主目标与透明度目标），都在分配阶段，且外层自己用 `getParameter` 保存并在 `finally` 恢复 READ/DRAW 绑定（原 13 处清单漏了它们）。其余多数处在分配阶段或外层保护之内，**未复现问题**，但正确性依赖调用时机。`RenderTargetPool143.acquire` 在新建条目时检查 `status`，而它可以在帧中途被 Render Graph 和遮挡剔除调用。

### 2.5 Blit：2 处

| 位置 | 做法 |
|---|---|
| `SelectedIdPass143.prepare` | 保存 READ/DRAW 与 scissor，关 scissor，blit 深度，恢复；事先校验尺寸与格式 |
| `ShadowTarget.copyTo` | 关 scissor，blit 深度，恢复 scissor，清 `_currentFramebuffer`；绑定恢复交给调用方 |

### 2.6 上下文丢失

- 策略在 `VisualPipeline`：`preventDefault`、标记需要恢复、关闭默认渲染循环、挂起管线。
- 另有 5 个独立监听：`RenderTargetPool143`（作废全部条目）、`FrameBridge143`（卸载）、`DeferredLighting143`、`TransparentForward143`（`fail`）、`OcclusionCulling143`（`detach`）。
- 14 个文件在作用域检查里轮询 `gl.isContextLost()`。
- 没有任何测试覆盖上下文丢失。

## 3. 设计

### 3.1 资源：按 owner 分组，一种目标描述覆盖所有形状

```js
// 每个模块拿一个 owner 作用域；release() 释放它名下全部资源。
const gpu = rhi.owner('taa.overlay')

// 渲染目标：颜色附件 0..n，可选自有深度或借用深度。尺寸可固定，也可跟随画布（scale）。
const target = gpu.createTarget({
  label: 'taa.overlay.color',
  size: { scale: 1 } | { width, height },
  color: [{ format: 'rgba16f', sampler: 'nearest' }],      // MRT 就写多个
  depth: null | { format: 'depth24' } | { borrow: nativeDepthTexture },
  pooled: false,                                            // true 时走 RenderTargetPool143（单附件、单采样）
})
target.textures[0]; target.depthTexture; target.framebuffer
target.resize(width, height)   // 跟随画布的目标由 RHI 在画布尺寸变化时统一调用
target.release()

// 数据纹理（查找表、噪声、1×1 白）
gpu.createTexture({ label, source | width/height, format, sampler })

// 借用附件的别名 framebuffer：附件永不随它销毁；附件被 Cesium 销毁后，下次 get 时自动重建。
const alias = gpu.aliasFramebuffer({ label, color: () => [...], depth: () => cesiumDepthTexture })
alias.get()   // 返回当前有效的 Framebuffer

// 原生 GL 对象（UBO、查询）仍由各自模块创建，只把销毁登记给 RHI，丢失与释放走同一条路径。
gpu.track(label, dispose)
```

- 采样器用具名预设（`'nearest'`、`'linear'`、`'linear-clamp'`），由 RHI 缓存，消除各模块里重复的 `new C.Sampler`。
- 诊断：`rhi.getDiagnostics()` 按 owner 和 label 给出纹理字节数，`RenderProfiler143` 的纹理清点改为直接读取。
- 去掉双路径：管线内模块要求必须有 RHI。独立使用和测试时用 `createStandaloneDevice143(C, scene)`，它与管线内的 RHI 是同一个类。

### 3.2 绑定保护：一个函数，两种强度

```js
// 绘制经 Cesium（会改 _currentFramebuffer）：恢复 GL 绑定 + Cesium 绑定缓存 + 可选的 uniformState。
rhi.withTargetState(fn, { viewport: true, pass: true, camera: true })

// 纯 GL 操作（blit、readPixels、自己 bindFramebuffer）：恢复 GL 绑定与 scissor，并把 Cesium 缓存置为「未知」，
// 让 Cesium 的下一次绘制一定重新绑定。
rhi.withRawFramebuffer(fn)
```

- 两者都可嵌套。内层直接执行，最外层负责保存与恢复。
- `_currentFramebuffer` 的读写移进 `cesiumPrivate143.js`（`currentFramebufferOf(context)`、`setCurrentFramebuffer(context, fb)`），网关守卫测试扩展到这个字段。之后只有 RHI 调用它们。
- `getParameter(READ/DRAW_FRAMEBUFFER_BINDING)` 在 Chrome 由客户端回答，不会造成 GPU 同步，保留。

### 3.3 完整性检查与拷贝

```js
rhi.checkComplete(framebuffer)   // 在 withRawFramebuffer 内调用 status，返回布尔值；不完整时带上格式信息抛错
rhi.copyDepth(from, to)          // 校验尺寸、格式、数据类型一致；关 scissor；绑定 READ/DRAW；blit；恢复
rhi.copyColor(from, to, { attachment = 0, filter = 'nearest' })
```

16 处 `.status` 改用 `checkComplete`，彻底消除 2.4 的缓存不一致。两处深度 blit 改用 `copyDepth`。`SelectedIdPass143` 的尺寸/格式校验移进 RHI。

### 3.4 上下文丢失

```js
rhi.lost            // 布尔值，替代 14 个文件里的 gl.isContextLost() 轮询
rhi.onLost(callback) -> off()
```

- RHI 是唯一的 `webglcontextlost` 监听者。丢失时依次：置 `lost`、作废渲染目标池、把所有 owner 的资源标为失效（`release()` 变成只清记录，不再调用已失效的 GL 删除）、按注册顺序回调 `onLost`。
- `VisualPipeline` 的策略（`preventDefault`、停渲染循环、挂起）改为注册在 `onLost` 上，行为不变。
- `FrameBridge143`、`DeferredLighting143`、`TransparentForward143`、`OcclusionCulling143` 改用 `onLost`，删除各自的监听。
- 不实现 `webglcontextrestored`。宿主重建 Viewer 时整个 RHI 一起重建。

## 4. 迁移顺序

每批之后跑全量测试，并在浏览器里看校园场景（图像、控制台、`getRenderDiagnostics().rhi`）。

| 批次 | 内容 | 风险 |
|---|---|---|
| 0 | RHI 新接口 + 单元测试 + `cesiumPrivate143` 的 `_currentFramebuffer` 访问器；不接任何模块 | 无 |
| 1 | `checkComplete` 替换 13 处 `.status`（独立的正确性修复，可单独提交）；`channels/` 的 3 处已有外层保护，留待批次 3 一并换 | 低 |
| 2 | `copyDepth` 替换两处 blit | 低 |
| 3 | 绑定保护替换 14 处手写保存/恢复 | 中：每处恢复的字段不同，要逐处对照表 2.3 |
| 4 | 资源创建：已接 RHI 的 5 个模块删掉直接创建的分支 | 低 |
| 5 | 资源创建：2.2 表中绕过 RHI 的模块逐个迁移（阴影、云时域、材质 MRT、Hi-Z、透明反射、TAA 覆盖层、数据纹理、别名 framebuffer） | 中：涉及尺寸变化和附件借用 |
| 6 | 上下文丢失统一到 RHI，删除 5 个独立监听，`isContextLost` 轮询改读 `rhi.lost` | 低 |
| 7 | 守卫测试：`src/` 中除 RHI 和网关外不再出现 `new C.Texture`、`new C.Framebuffer`、`READ_FRAMEBUFFER_BINDING`、`_currentFramebuffer`、`webglcontextlost` | 无 |

批次 1、2 不依赖其它批次，可以最先做。

## 5. 测试

单元（`tests/rendering/rhi-consolidation.test.mjs`，用记录调用的假 GL 加真实 Cesium 类）：

1. `owner().release()` 释放该 owner 名下全部资源，其它 owner 不受影响；重复 release 安全。
2. `createTarget`：MRT、自有深度、借用深度三种形状；借用的深度纹理不会被销毁。
3. 跟随画布的目标在尺寸变化时重建，固定尺寸的不动。
4. `aliasFramebuffer`：Cesium 销毁借用的附件后，下一次 `get()` 返回重建后的 framebuffer。
5. `withTargetState`：恢复 READ/DRAW、`_currentFramebuffer`、viewport、pass、camera；回调抛错也恢复；嵌套时只有最外层生效。
6. `withRawFramebuffer`：恢复 GL 绑定与 scissor，并把 Cesium 缓存置为未知，Cesium 下一次绘制一定会调用 `bindFramebuffer`。
7. **回归**：在已缓存 framebuffer X 时调用 `checkComplete(Y)`，之后 Cesium 往 X 绘制会真正重新绑定 X（复现 2.4 的问题，并证明修复有效）。
8. `copyDepth`：尺寸、格式、数据类型不一致时拒绝；scissor 和绑定都恢复。
9. 上下文丢失：只有一个监听；`lost` 置位；`onLost` 按顺序回调；丢失后 `release()` 不调用 GL 删除；渲染目标池被作废。
10. 诊断：按 owner、label 的字节数与实际创建的纹理一致。

守卫测试：批次 7 的模式在 `src/` 中只出现在 `src/rhi/` 和 `src/scene/cesiumPrivate143.js`。

现有模块测试保持不变；断言私有 framebuffer 字段的个别测试改为断言 RHI 诊断。

## 6. 风险

- **批次 3 逐处语义不同。** 有的模块必须恢复 pass 和 camera（阴影、TAA 覆盖层），有的只需 GL 绑定。迁移表必须逐处写明，测试 5、6 覆盖两种强度。
- **尺寸跟随。** 现在各模块自己判断何时重建（画布尺寸、HDR 格式、MSAA）。RHI 只统一「画布尺寸」这一个触发，其它条件仍由模块调用 `resize` 或重建目标。
- **别名 framebuffer 依赖 Cesium 附件的生命周期。** 用 `isDestroyed()` 检测失效，和现在 `TaaMotion143` 的做法一致。
- **独立使用的模块**（例如不经 `VisualPipeline` 直接使用 `GlobeNightLighting143`、`FrameBridge143`）需要 `createStandaloneDevice143`，会多一个参数，属于公开 API 变化，需在 `API.md` 说明。

## 7. 与其他提案的关系

- 和提案 1（着色器变体）互不依赖。
- `cesiumPrivate143.js` 网关扩展到 Context 级私有字段（`_currentFramebuffer`），延续提案 3 的守卫。
- 完成后，「RHI 接管绘制执行」仍不在计划内。如果将来要按 pass 局部接管（例如建筑合批的自有 primitive），这里的资源、绑定和丢失接口就是它的基础。

## 8. 进度

### 批次 0、1（2026-10-23）

- 新增 `src/rhi/framebufferState143.js` 的 `checkFramebufferComplete143(context, framebuffer)`：检查前后保存并恢复实际的 READ/DRAW 绑定。`WebGLDevice143` 重新导出它，并提供 `checkComplete(framebuffer)`；`src/index.js` 一并导出。函数单独成文件，避免 `RenderTargetPool143` 与 `WebGLDevice143` 循环引用。
- `cesiumPrivate143.js` 新增 `currentFramebufferOf(context)`、`setCurrentFramebuffer(context, fb)`（空安全）。两个访问器目前没有调用者（批次 0 有意不接模块）；`src/` 中直接读写 `_currentFramebuffer` 的 22 行代码（11 个文件；另 1 处是 `framebufferState143.js` 的注释）留给批次 3。
- 清单内 13 处 `Framebuffer.status` 检查改用 `checkFramebufferComplete143`。**更正**：HEAD 时实际有 16 处，`DepthPyramid143.js:98`、`MaterialTarget143.js:60`、`:65` 不在 2.4 的清单里，仍直接读 `.status`。三处都在分配阶段，外层自己保存并恢复 READ/DRAW，缓存不会脱节，留给批次 3。`AtmosphereLut143` 在检查后强制重新绑定的那一行保留，只把注释改成真实原因（外层可能用原生 GL 改过绑定）。
- 回归测试 `tests/rendering/rhi-framebuffer-status.test.mjs`（5 项）用 Cesium 1.143 自己的 `Context.prototype.clear` 与 `Framebuffer.prototype.status`、假 GL 复现：直接读 `status` 后，本应画进 X 的清屏落到默认 framebuffer（`['X', 'default']`）；改用新函数后为 `['X', 'X']`。实现前先确认测试失败。
- 4 个测试文件的假 GL 只有 `FRAMEBUFFER_COMPLETE`，补上真实 WebGL 必有的 `getParameter`、`bindFramebuffer` 空实现，断言未改。
- 结果：全量 1097 项，1093 通过、3 跳过，唯一失败是既有的夜间交通用例。浏览器校园场景依次打开 TAA、AO+SSR、延迟光照再恢复，渲染目标都正常分配（RHI 资源 12→20，池 5→8），控制台无错误。

## 9. 着色器后台预热与环境门控（2026-10-23）

不属于第 4 节的迁移批次，是 RHI 的新增能力，对应性能审查 P1-8（冷编译）。

### 9.1 测量结论（RTX 3070，ANGLE/D3D11，每次加载给全部着色器文本加唯一注释以绕过浏览器程序缓存）

- 冷启动前 50 s 共编译 164 个程序、约 14.7 s。最长一帧约 10 s，其中约 9.6 s 是体积云（5 个程序，单个最长 3.4 s）与大气（3 个程序）着色器，全部挤在环境首次启用的那一帧。
- 把云/大气的循环上限改成编译器无法折叠的值：大气编译快约 1 s，云几乎不变（主要成本在函数内联，不在循环展开），而环境 pass 每帧 GPU 多 0.62 ms（+23%）。**不采用。**
- `KHR_parallel_shader_compile` 后台编译 3.4 s 的云程序期间，渲染开着、关着各重复两次，帧间隔最长 17–20 ms；之后同一文本再编译只需约 12 ms（冷编译 576 ms）。

### 9.2 实现

- `src/rhi/ShaderWarmup143.js`：`warm(texts)` 只提交编译与链接、从不查询会阻塞的 LINK_STATUS；`isReady(keys)` 轮询 `COMPLETION_STATUS_KHR`，完成后删掉临时程序。没有扩展、上下文丢失、链接失败或超过 20 s 一律视为就绪，交还 Cesium 按原样编译。`viewportQuadTexts143` 生成与 Cesium（`PostProcessStage` → `createViewportQuadCommand` → `ShaderCache`）逐字一致的最终文本。`WebGLDevice143.shaderWarmup` 按需创建一份，随设备销毁。
- `HdrEnvironmentPass143`：启用时预热环境 stage 树（按当前帧 `LOG_DEPTH`）、云时域两个全屏 pass、大气 LUT 三个 pass；就绪前 `_execute` 直接返回原生颜色（原因 `shaders warming`）并请求下一帧，就绪后清空 key，之后零开销。`EnvironmentRenderer` 从 RHI 注入预热实例。
- 测试：`tests/rendering/shader-warmup.test.mjs`（9 项，其中两项与 Cesium 自己生成的文本逐字比对）、`hdr-environment.test.mjs` 新增 2 项门控测试。

### 9.3 浏览器结果（校园场景，加载后 75 s）

| | 冷缓存、无门控（原行为） | 冷缓存、门控 | 热缓存、门控 |
|---|---|---|---|
| 环境着色器编译 | 9,766 ms | 64 ms | 56 ms |
| 全部编译 | 15.2 s | 5.3 s | 0.76 s |
| 最长一帧 | 10,067 ms（云/大气） | 983 ms（阴影投射） | 301 ms（启动，无编译） |
| 超过 500 ms 的帧 | 5 | 4 | 0 |
| 环境开始显示 | 10.8 s（卡住之后） | 5.1 s（后台预热 4.0 s） | 1.0 s（预热同帧完成） |

「无门控」通过对页面隐藏 `KHR_parallel_shader_compile` 实现，等价于改动前的行为。冷缓存下剩余的长帧来自阴影投射变体（每批约 1 s）和 19 个未标记程序（单个最长约 0.85 s），属于下一步。

### 9.4 阴影投射变体预热（2026-10-23）

- `ShadowReceiver143.castProgram(source)`：投影程序的唯一创建入口，`cast()` 与预热共用，保证预热的正是将来绘制的同一份文本。
- `DirectionalShadowPass`：`update()` 看到新的投影源程序就交给 `ShaderWarmup143`（每个源程序一次，早于进入光源视锥）；`readyCasters()` 跳过仍在后台编译的投影体并请求下一帧，有跳过时不复用上一帧阴影。
- 只预热还不够：预热让编译命中浏览器程序缓存，但 Cesium 首次绑定仍在主线程重编，冷启动实测中位 16 ms、p90 21 ms。几十个投影体同时就绪会在同一帧编译（一帧 37 个、484 ms）。因此每次阴影重画最多放行 `MAX_CASTER_LINKS_PER_FRAME = 3` 个新程序，同一次重画的后续级联不重复计数。
- 测试：`tests/rendering/shadow-caster-warmup.test.mjs`（6 项）。

| | 冷缓存、仅环境门控（9.3） | 冷缓存、预热、不限量 | 冷缓存、预热 + 每帧 3 个 | 热缓存、预热 + 每帧 3 个 |
|---|---|---|---|---|
| 投影程序主线程编译（134 个） | 2,948 ms（最长 41 ms） | 1,913 ms（最长 39 ms） | 1,681 ms（最长 31 ms） | 673 ms（最长 28 ms） |
| 含投影编译的最长一帧 | 983 ms（其中投影 922 ms） | 517 ms（其中投影 484 ms） | 167 ms（其中投影 64 ms） | 100 ms（其中投影 32 ms） |
| 超过 500 ms 的帧 | 4 | 3 | 3（均为未标记程序） | 0 |
| 投影体全部画出 | — | 9.8 s | 10.3 s | 5.9 s |

稳态投影体 521 个、跳过 0，与改动前一致。剩余的长帧来自 19 个未标记程序（单个最长约 0.9 s，加载后 2–4 s）。另有一次冷启动出现 91 个阴影接收程序共 10.5 s 编译（最长一帧 7.3 s），重跑两次均为 3 个；与此前一次 73 个的现象相同，原因未查明，与本改动无关（接收程序不经过投影路径）。
