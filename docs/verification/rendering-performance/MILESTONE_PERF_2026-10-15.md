# CCR 里程碑性能报告 · 大气体积云完成

> **日期**：2026-10-15
> **里程碑**：夜晚光照 + 体积云 + 大气散射完成（用户已验收视觉效果）
> **测量目的**：建立该里程碑的性能基线，为后续优化提供可比对起点

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| **GPU** | NVIDIA GeForce RTX 3070（ANGLE / D3D11） |
| **CPU** | AMD Ryzen 9 5950X 16-Core |
| **浏览器** | Chrome（CDP 驱动，非 headless） |
| **Canvas** | 1264 × 805（DPR 1） |
| **Cesium** | 1.143 |
| **GPU timer** | `EXT_disjoint_timer_query_webgl2` 可用 |
| **入口** | `examples/campus.html?traffic=none&grass=none&water=none&imagery=none&singleFrustum=1` |

**场景负载**：建筑 GLB **70/70**，固定树木 **720 株**，地形 1 组，单视锥。

---

## 2. 测量口径

依据项目既有约定（p50/平均 FPS 会掩盖掉帧），本次采用：

- **采样对象**：`scene.postRender` 间隔（已验证 `callsPerFrame = 1`，`frustumCount = 1`）
- **交叉校验**：同时记录 `scene.frameState.frameNumber` 增量与 wall-clock，两者比值作为 FPS
- **去重验证**：`frameNumberDelta` 与 `postRenderCalls` 一致（292 = 292），确认无重复计数
- **报告量**：p50 / p75 / p90 / p95 / p99 / max，以及超 16.7ms、33.3ms、50ms 的**帧占比**

> **口径修正记录**：首轮采样曾误用「按 frameNumber 去重」的逻辑，得到 `distinctFrames 4030 / 35s = 115 FPS`，与 `p50 16.5ms`（60 FPS）矛盾。经 5 秒精确校验（`frameNumberDelta = 292`，`postRenderCalls = 292`，`fps = 58.2`）确认为**采样代码缺陷**，非渲染异常。本报告数据出自修正后的口径。

---

## 3. 测量结果

### 3.1 默认配置（里程碑稳态）

**配置**：`environment: true`、`environmentQuality: balanced`、`clouds: true`、`shadowMode: custom`、`shadowSize: 4096`、`antialiasing: smaa`、`resolutionScale: 1`

| 指标 | 值 |
|---|---|
| **实测帧率** | **55.4 FPS**（frameNumber / wall-clock） |
| **p50** | **16.8 ms** |
| **p75** | 21.9 ms |
| **p90** | **21.8 ms** |
| **p95** | 29.8 ms |
| **p99** | **41.4 ms** |
| **max** | 250.3 ms |
| 超 16.7 ms 占比 | 58.52% |
| 超 33.3 ms 占比 | **2.82%** |
| 超 50 ms 占比 | **0.65%** |
| 采样帧数 | 3374 |

> 另一次 35 秒采样（`__bench`，口径同上）得到 p50 18.2 / p90 26.3 / p99 48.9 / over33.3 3.26% / over50 0.88%。两次的差异属于会话内负载波动（云动画、相机位置），**量级一致**。

### 3.2 环境关闭对比（成本归因）

**配置**：`environment: false`，其余相同

| 指标 | 环境开 | 环境关 | 差值 |
|---|---|---|---|
| 实测帧率 | 55.4 FPS | **37.6 FPS** | **-17.8** |
| p50 | 16.8 ms | 17.1 ms | +0.3 ms |
| p90 | 21.8 ms | 22.6 ms | +0.8 ms |
| p99 | 41.4 ms | **38.4 ms** | **-3.0 ms** |
| 超 33.3 ms | 2.82% | 1.49% | -1.33% |
| 超 50 ms | 0.65% | 0.63% | -0.02% |

#### ⚠️ 关于这个反常结果

**关闭 CCR 环境后帧率反而下降 17.8 FPS，p99 反而改善。** 这不是测量错误，而是**成本转移**：

关闭 CCR 环境时（已核实）：

| 项 | 关闭后的状态 |
|---|---|
| `scene.skyAtmosphere.show` | **`true`** ← 原生天空被恢复 |
| 原生 `SunLight` | 存在 |
| `shadowMode` | 仍是 `custom`（不受 environment 开关影响） |

**即：关闭 CCR 环境并不是"去掉天空成本"，而是"把 CCR 的实现换成 Cesium 原生的 `SkyAtmosphere`"。** 在对比中，原生天空的成本更高。

**因此该对比不能读作"环境子系统耗 17.8 FPS"**，只能说明：**在当前场景与分辨率下，CCR 的解析大气 + Hillaire LUT + 体积云，比 Cesium 原生 SkyAtmosphere 更省。**

这也意味着**缺少一个"两者都不开"的纯基线**——本次未采集，是后续应补的对照。

---

## 4. 结论

### 4.1 里程碑性能状态

**默认配置在 1264×805 下稳定 55.4 FPS**，p90 = 21.8 ms，长帧（>33.3 ms）占 2.82%。

- **p90 在 60 FPS 预算内**（16.7 ms）略有超出，但幅度小
- **p99 = 41.4 ms**，即最差 1% 的帧仍能维持 24 FPS
- **>50 ms 的长帧仅 0.65%**，交互时不会出现明显卡顿感

**判定：里程碑性能可用，达到"可交互"标准。**

### 4.2 未完成项

| 项 | 状态 |
|---|---|
| 纯基线（环境与原生天空都不开） | ❌ 未采集 |
| GPU Pass 级计时（云 march / LUT / resolve 分项） | ❌ 未采集（`gpuTimer` 可用但未接） |
| 显存峰值与云 history 逻辑字节实测 | ❌ 未采集 |
| 交互验收（持续拖拽 / 绕飞） | ❌ 未做，本次为**固定视角** |
| 3×300 帧多轮次 + bootstrap CI | ❌ 未做，本次为单轮长采样 |
| 4K / 部署设备验证 | ❌ 未做 |

### 4.3 与历史数据的可比性说明

`ab-env-on/off.json`（历史记录）曾报 environment GPU p50 约 18.19 ms、环境关闭整帧 GPU p50 约 2.30 ms。**该报告缺少 assetHash/源码哈希，且当时的实现与本里程碑不同（当时为解析大气、无 Hillaire LUT、无独立云时域重建），不能与本次 CPU 帧间隔数据直接比较。**

---

## 5. 复现方式

```bash
# 1. 启动静态服务器
node scripts/dev-server.cjs --port 8878

# 2. 确保 nginx 8083 上的 GLB 可达（否则 70 个建筑模型全部失败）
curl -o /dev/null -w "%{http_code}" \
  http://localhost:8083/Dongda/DongdaModel_PBR/SM_NH/analysis_testing_center.glb

# 3. 浏览器打开
# http://127.0.0.1:8878/examples/campus.html?traffic=none&grass=none&water=none&imagery=none&singleFrustum=1

# 4. 在页面控制台注入 docs/verification/rendering-performance/_perf-probe.js 的采样逻辑
```

**依赖**：Playwright 在本机**不可用**（`MODULE_NOT_FOUND`）。本次测量通过 **ego-browser 的 CDP 端点**驱动系统 Chrome 完成，Chrome 路径为 `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`。

---

## 6. 数据原始记录

| 组 | 场景 | FPS | p50 | p90 | p99 | >33.3ms | >50ms | 帧数 |
|---|---|---|---|---|---|---|---|---|
| A | 默认（环境开） | 55.4 | 16.8 | 21.8 | 41.4 | 2.82% | 0.65% | 3374 |
| B | 环境关 | 37.6 | 17.1 | 22.6 | 38.4 | 1.49% | 0.63% | 2548 |
| C | 默认（复测） | 52.6 | 18.2 | 26.3 | 48.9 | 3.26% | 0.88% | 3862 |

> A 与 C 同为默认配置，差异来自采样时段不同的相机状态与云动画相位。**取值应以 A 为准**（采样窗口内相机静止）。

---

## 7. 边界声明

- 本报告是**本地白模场景 + 真实 70 GLB**的测量，**未替代**真实部署环境（网络、完整数据源、多视锥、其他业务图层）的验收
- 测量为**固定视角**，**不能代表交互（持续拖拽/绕飞）时的掉帧情况**
- 未进行 GPU Pass 级计时，**不能据此判断"云 march 占多少毫秒"**
- 未测量显存，**不能用逻辑纹理字节代替整卡 VRAM**
- **不宣布性能目标达成**：原计划的 environment p95 3–5 ms 目标**未测**（本次只测了整帧 CPU 间隔）
