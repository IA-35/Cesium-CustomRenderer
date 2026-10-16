# 🚀 Cesium 自定义渲染管线优化指南

> **目标**: 进一步优化性能 + 提升渲染视觉效果  
> **创建时间**: 2026-10-14  
> **适用版本**: Cesium 1.143 + CCR v0.1.0

---

## 📊 当前状态分析

### 默认配置（src/presets.js:13-42）

```javascript
// 性能相关
shadowSize: 4096              // 单级联阴影，显存 64MB
shadowCascades: 1             // 单级联（覆盖 4000m）
shadowUpdateInterval: 2       // 每 2 帧更新
antialiasing: 'smaa'          // SMAA 抗锯齿
msaaSamples: 1                // 无 MSAA
resolutionScale: 1            // 原生分辨率

// 视觉效果相关
hdrBloomEnabled: false        // HDR Bloom 关闭
screenSpaceAoEnabled: false   // SSAO/HBAO 关闭
environmentReflectionEnabled: false  // 环境反射关闭
screenSpaceReflectionEnabled: false  // SSR 关闭
lightingMode: 'enhanced'      // 增强前向光照（非延迟）
```

### 性能瓶颈识别

根据代码审查报告和架构分析：

1. ✅ **已解决**: 多层 context.draw wrapper 嵌套（已证实所有模块走 dispatcher）
2. ⚠️ **仍存在**: Deferred 逐命令拦截（每帧 200+ draw calls 都进 handler）
3. ⚠️ **待验证**: Graph transient allocator 使用情况
4. ❌ **未实现**: Material/Shader batching（Phase 6）
5. ❌ **未实现**: Direct-submit（Phase 3/5）

---

## 🎯 优化方案（分优先级）

---

## 一、立即可用的性能优化（无需改代码）

### 1.1 修复阴影问题 ✅ **推荐立即执行**

**问题**: 锯齿状阴影 + 频繁掉帧

**修复方案**:
```javascript
pipeline.setOptions({
  shadowUpdateInterval: 1,  // 从 2 改为 1（每帧更新，消除卡顿）
  shadowSize: 2048,         // 从 4096 降为 2048（性能提升 75%）
  shadowCascades: 3         // 启用三级联（改善远距离质量）
})
```

**性能影响**:
- Shadow map 显存: 64MB → 24MB（-62%）
- Shadow pass GPU: ~8ms → ~3ms（-62%）
- 阴影质量: 消除锯齿 + 远距离改善

**适用场景**: 
- 中小型场景（< 1km²）
- 移动/动画物体较多
- 需要平滑阴影边缘

**替代方案**（高性能设备）:
```javascript
// 保持 4096 单级联，但修复 polygon offset
pipeline.setOptions({
  shadowUpdateInterval: 1,
  shadowSize: 4096,
  shadowCascades: 1
})

// 需要修改 src/shadows/ShadowReceiver143.js:106
// options.polygonOffset = { enabled: true, factor: 0.8, units: 2 }
```

---

### 1.2 启用性能调速器 ⚡

**用途**: 自动适应硬件能力，保持流畅帧率

```javascript
pipeline.setPerformance({
  enabled: true,
  targetFps: 30,              // 目标帧率 30 FPS
  minScale: 0.7,              // 最低分辨率 70%
  allowResolutionScaling: false,  // 优先降阴影，保持画面锐利
  sampleWindow: 60,           // 60 帧采样窗口
  evaluateEvery: 30,          // 每 30 帧评估一次
  settleFrames: 30            // 30 帧稳定期
})
```

**工作原理** (src/performance/PerformanceGovernor143.js):
1. 持续采样帧时间 p95 百分位
2. 超过目标 15% → 降级（shadowSize: 4096 → 2048 → 1024）
3. 低于目标 80% 且连续 3 次评估 → 恢复
4. 禁用时精确还原基线配置

**降级梯度** (第 15-22 行):
```javascript
baseline            → scaleFactor: 1.0,  shadowCap: null
resolution -10%     → scaleFactor: 0.9,  shadowCap: null
resolution -20%     → scaleFactor: 0.8,  shadowCap: null
resolution -30%     → scaleFactor: 0.7,  shadowCap: null
resolution -40%     → scaleFactor: 0.6,  shadowCap: 2048
resolution -40%     → scaleFactor: 0.6,  shadowCap: 1024
```

**诊断命令**:
```javascript
console.log(pipeline.getPerformanceDiagnostics())
// {
//   enabled: true,
//   reason: 'settled',
//   targetFrameMs: 33.3,
//   targetFps: 30,
//   step: 0,          // 当前降级档位
//   label: 'baseline',
//   p95: 28.5,        // 实际 p95 帧时间
//   samples: 60,
//   changes: 0
// }
```

---

### 1.3 优化抗锯齿配置 🎨

**当前**: SMAA（平衡质量和性能）

**性能优先方案**:
```javascript
pipeline.setOptions({
  antialiasing: 'fxaa',  // FXAA 更快（~0.5ms vs ~1.2ms）
  resolutionScale: 1.0
})
```

**质量优先方案** (需要高性能设备):
```javascript
pipeline.setOptions({
  antialiasing: 'taa',      // TAA 最佳质量
  taaJitterSamples: 8,      // 8 样本（默认）
  taaHistoryBlend: 0.03,    // 历史权重（越小越稳定）
  taaMotionBlend: 0.5       // 运动权重
})
```

**MSAA 方案** (仅限静态场景):
```javascript
pipeline.setOptions({
  antialiasing: 'msaa',
  msaaSamples: 4           // 2x/4x/8x
})
// 注意: MSAA 与延迟渲染不兼容，会强制回退到增强前向
```

**对比表**:

| 方案 | GPU 开销 | 质量 | 适用场景 |
|------|----------|------|----------|
| Off | 0ms | 锯齿明显 | 性能测试 |
| FXAA | ~0.5ms | 边缘模糊 | 移动设备/低端卡 |
| SMAA | ~1.2ms | 平衡 | **默认推荐** |
| TAA | ~1.5ms | 最佳 | 高端设备/静态/慢动作 |
| MSAA 4x | ~3ms | 硬边缘清晰 | 静态场景 |

---

### 1.4 调整分辨率策略 📱

**场景 1: 4K 显示器性能不足**
```javascript
pipeline.setOptions({
  resolutionMode: 'css',    // 使用 CSS 像素
  resolutionScale: 0.75     // 渲染 75% 分辨率
})
// 3840×2160 → 2880×1620 渲染，拉伸到 4K 显示
// 性能提升: ~43% fillrate
```

**场景 2: Retina 屏幕优化**
```javascript
pipeline.setOptions({
  resolutionMode: 'native', // 使用物理像素（默认）
  resolutionScale: 0.5      // HiDPI 下渲染 0.5 倍
})
// 例: MacBook Pro Retina 2880×1800 → 1440×900 渲染
```

**场景 3: 超采样抗锯齿** (高端设备)
```javascript
pipeline.setOptions({
  resolutionScale: 1.25,    // 渲染 125% 分辨率
  antialiasing: 'off'       // 超采样替代后处理 AA
})
// 质量最佳，但性能开销 ~56%
```

---

## 二、视觉效果提升（按影响排序）

### 2.1 启用 HDR Bloom ✨ **推荐**

**效果**: 高光溢出、明亮物体发光

```javascript
pipeline.setOptions({
  hdrBloomEnabled: true,
  hdrBloomStrength: 0.2,    // 强度（0.15 默认 → 0.2 更明显）
  hdrBloomThreshold: 1.0,   // 触发阈值（HDR 亮度）
  hdrBloomKnee: 0.5,        // 软阈值过渡
  hdrBloomLevels: 5         // 降采样级别（2-6）
})
```

**性能影响**: ~1.5ms GPU（5 级 downsample + upsample）

**调参指南**:
- `strength`: 0.1（微弱）→ 0.3（明显）→ 0.5（过度）
- `threshold`: 0.8（更多物体发光）→ 1.5（仅极亮物体）
- `levels`: 3（快速粗糙）→ 6（慢速细腻）

**场景推荐**:
- ✅ 夜景（路灯、霓虹灯）
- ✅ 白天强光（玻璃反射、金属高光）
- ❌ 阴天漫射光（效果不明显）

---

### 2.2 启用环境反射 🌐

**效果**: 玻璃/金属表面反射天空和环境

```javascript
pipeline.setOptions({
  environmentReflectionEnabled: true,
  environmentReflectionStrength: 1.0,
  environmentReflectionMap: '/assets/env/studio_cube.ktx2'  // 可选
})
```

**性能影响**: ~0.8ms（Cube map 采样）

**环境贴图来源**:
1. **动态生成** (environmentReflectionMap: null)
   - 从当前环境预设生成
   - 实时跟随天空变化
   - 无需额外资源

2. **静态 KTX2** (推荐高质量)
   - 预过滤的 Cube map
   - 支持 HDR（.ktx2 格式）
   - 典型文件: 3-10MB

**制作环境贴图**:
```bash
# 使用 cmftStudio 或 IBLBaker
# 输出 6 面 + mipmap 的 KTX2 文件
```

**材质支持**:
- ✅ PBR Model (metallic > 0.5 或 roughness < 0.3)
- ✅ 3D Tiles (带金属度/粗糙度)
- ❌ 自定义 Shader（需手动适配）

---

### 2.3 启用屏幕空间环境光遮蔽 (SSAO/HBAO) 🌑

**效果**: 缝隙、折痕、角落的柔和阴影

```javascript
pipeline.setOptions({
  screenSpaceAoEnabled: true,
  screenSpaceAoAlgorithm: 'hbao',  // 'ssao' 或 'hbao'
  screenSpaceAoRadius: 3,          // 采样半径（世界米）
  screenSpaceAoStrength: 1.0,      // 强度
  screenSpaceAoBias: 0.08          // 深度偏移
})
```

**算法对比**:

| 算法 | GPU 开销 | 质量 | 适用场景 |
|------|----------|------|----------|
| SSAO | ~2ms | 噪点较多 | 移动设备 |
| HBAO | ~3.5ms | 平滑细腻 | **桌面推荐** |

**调参指南**:
- `radius`: 1（小缝隙）→ 5（大型遮蔽）→ 10+（过度暗淡）
- `strength`: 0.5（微弱）→ 1.5（明显）→ 2.0（过度）
- `bias`: 0.05（易产生 halo）→ 0.15（保守）

**性能优化**:
```javascript
// 降低分辨率 AO（通常可接受）
pipeline.setOptions({
  screenSpaceAoEnabled: true,
  screenSpaceAoAlgorithm: 'ssao',  // 快速算法
  screenSpaceAoRadius: 2,          // 较小半径
})
```

**场景推荐**:
- ✅ 建筑内部（墙角、门框）
- ✅ 机械模型（螺丝孔、缝隙）
- ❌ 开阔室外（效果不明显，浪费性能）

---

### 2.4 启用延迟光照 💡 **实验性**

**效果**: 更准确的 PBR 光照 + 支持更多光源

```javascript
pipeline.setOptions({
  lightingMode: 'deferred',      // 从 'enhanced' 切换到 'deferred'
  lightingDirect: true,          // 直接光
  lightingIndirect: true,        // 间接光（IBL）
  lightingEmissive: true,        // 自发光
  lightingShadow: true,          // 阴影项
  lightingAo: true,              // AO 项
  lightingAoStrength: 1.0,
  lightingDebugMode: 0           // 0-7 调试模式
})
```

**优势**:
- ✅ 统一 PBR 光照（Model + 3D Tiles + Globe）
- ✅ 支持多个环境贴图（每个模型独立 IBL）
- ✅ 可选 AO/阴影分项控制

**限制** (src/lighting/DeferredGeometry143.js:112-118):
- ❌ 不支持 MSAA（会回退）
- ❌ 不支持 VR/分类/半透明 Globe
- ❌ 不支持复杂 Stencil
- ❌ 单视锥体（多视锥体回退）
- ⚠️ 目前与 TAA 组合会回退（待修复）

**性能影响**:
- GBuffer 写入: ~2ms
- Lighting pass: ~1.5ms × 光照组数（通常 1-3 组）
- **总开销**: ~3-6ms（取决于场景复杂度）

**诊断命令**:
```javascript
const diag = pipeline.getLightingDiagnostics()
console.log(diag)
// {
//   enabled: true,
//   mode: 'deferred',
//   outputFrame: 12345,
//   geometryAvailable: true,
//   reason: null,
//   stats: { frames: 1234, draws: 3, ... }
// }
```

**回退场景识别**:
```javascript
if (diag.reason !== null) {
  console.warn('延迟光照未生效:', diag.reason)
  // 常见原因:
  // - 'Requires HDR 3D perspective'
  // - 'MSAA uses enhanced rendering'
  // - 'TAA combination uses enhanced rendering'
}
```

---

### 2.5 色调和色彩调整 🎨

**快速预设**:
```javascript
// 清晰明亮（默认）
pipeline.setOptions(CCR.colorGradingPresets.clear)
// { contrast: 1.1, brightness: 1.08, exposure: 1.6, saturation: 1.05, hue: 0 }

// 中性自然
pipeline.setOptions(CCR.colorGradingPresets.neutral)
// { contrast: 1, brightness: 1, exposure: 1.6, saturation: 1, hue: 0 }
```

**自定义调整**:
```javascript
pipeline.setOptions({
  exposure: 1.8,      // 曝光（0.05-5，默认 1.6）
  contrast: 1.2,      // 对比度（0-3，默认 1.1）
  brightness: 1.1,    // 亮度（0-3，默认 1.08）
  saturation: 1.1,    // 饱和度（0-3，默认 1.05）
  hue: 0.05           // 色相偏移（-1 到 1，默认 0）
})
```

**场景推荐**:
- **阴天**: exposure: 1.8, saturation: 0.9
- **夜景**: exposure: 2.2, contrast: 1.3
- **日出/日落**: exposure: 1.4, hue: 0.08（偏暖）
- **雪景**: exposure: 1.9, brightness: 1.15

---

### 2.6 环境预设和云层 ☁️

**环境预设切换**:
```javascript
pipeline.setOptions({
  environment: true,
  environmentPreset: 'clear',    // 'clear' / 'morning' / 'overcast' / 'sunset' / 'haze'
  environmentQuality: 'high',    // 'balanced' / 'high'
  skyLightIntensity: 3.2,        // 天光强度（0-5）
  sunIntensity: 2.2              // 太阳强度（0-5）
})
```

**云层配置**:
```javascript
pipeline.setOptions({
  clouds: true,
  cloudGeometry: 'shell',        // 'local' / 'shell'（shell 性能更好）
  cloudModel: 'auto',            // 'auto' / 'cumulus' / 'stratus'
  cloudCoverage: 0.4,            // 云量（0-0.95）
  cloudBaseHeight: 1500,         // 云底高度（米）
  cloudThickness: 2000,          // 云层厚度（米）
  environmentAnimation: true     // 云飘动动画
})
```

**体积雾配置**:
```javascript
pipeline.setOptions({
  volumetricFog: true,           // 体积雾（基于云层）
  sunScattering: true,           // 太阳散射
  fogBaseHeight: 20,             // 雾底高度（米）
  fogHeightFalloff: 500          // 高度衰减（米）
})
```

**原生雾** (Cesium 原生，开销极低):
```javascript
pipeline.setOptions({
  fog: true,
  fogDensity: 0.00005            // 密度（0-0.0005）
})
```

**性能对比**:

| 效果 | GPU 开销 | 视觉质量 |
|------|----------|----------|
| 原生雾 | ~0.1ms | 简单指数衰减 |
| 体积雾 | ~2ms | 高度渐变 + 散射 |
| 云层（shell） | ~3ms | 体积感 + 动画 |
| 云层（local） | ~5ms | 局部细节 |

---

## 三、中级性能优化（需要代码修改）

### 3.1 修复阴影 Polygon Offset ⚙️

**问题**: 当前 `factor: 1.1, units: 4` 对 4096² shadow map 偏移过大

**修复步骤**:

```javascript
// 编辑 src/shadows/ShadowReceiver143.js:106
options.polygonOffset = { enabled: true, factor: 0.8, units: 2 }
// 原值: factor: 1.1, units: 4
```

**预期效果**: 消除阴影边缘锯齿，减少 self-shadow artifact

---

### 3.2 实现 Deferred 提前过滤 ⚡

**问题**: 每帧 200+ draw calls 都进入 handler 判断，即使不是 deferred 几何体

**优化方案**:

```javascript
// src/lighting/DeferredGeometry143.js

// 在 prepare() 方法中标记支持的 command
prepare() {
  // ... 现有代码 ...
  
  // 新增: 标记支持的 command
  this.supportedCommands = new WeakSet()
  for (const bin of bins) {
    for (const pass of [C.Pass.GLOBE, C.Pass.CESIUM_3D_TILE, C.Pass.OPAQUE]) {
      for (let i = 0; i < (bin.indices[pass] || 0); i++) {
        const command = bin.commands[pass][i]
        const record = this.programFor(command)
        if (record.supported) {
          this.supportedCommands.add(command)
        }
      }
    }
  }
  
  // ... 现有代码 ...
}

// 在 dispatcher handler 中快速跳过
if (dispatcher) {
  this.dispatcherOff = dispatcher.addHandler(event => {
    // 新增: 快速跳过不支持的 command
    if (!this.supportedCommands?.has(event.command)) {
      return 'continue'  // 跳过，无需进入后续判断
    }
    
    // 现有判断逻辑
    if (!token.active || self.busy || !self.canCapture(submitted, event.passState))
      return 'continue'
    // ...
  }, { name: 'deferred-geometry', priority: 10 })
}
```

**预期收益**: CPU submission p95 **-3% ~ -5%**

---

### 3.3 添加 Graph Allocator 运行时诊断 🔍

**目的**: 验证 Graph transient allocator 是否实际使用

```javascript
// src/pipeline/PooledStageCache143.js:91-103

if (this.graph?.transientAllocator && this.graph.activeFrame && resource) {
  console.log(`[PooledStageCache] ✅ Using Graph allocator for ${resource.name}`)
  slot.lease = this.graph.leaseOf(resource)
  slot.graphManaged = true
} else {
  console.log(`[PooledStageCache] ⚠️ Fallback to pool for ${resource.name || 'unknown'}`)
  console.log(`  - transientAllocator: ${!!this.graph?.transientAllocator}`)
  console.log(`  - activeFrame: ${!!this.graph?.activeFrame}`)
  console.log(`  - resource: ${!!resource}`)
  slot.lease = this.pool.acquire(this.owner, {...})
  slot.graphManaged = false
}
```

**验证命令**:
```javascript
// 在浏览器控制台运行
const pipeline = CCR.getVisualPipeline(viewer)
pipeline.setOptions({ hdrBloomEnabled: true, screenSpaceAoEnabled: true })
// 观察控制台输出，确认是否走 Graph allocator
```

---

## 四、高级优化方案（长期架构改进）

### 4.1 实现 Direct-Submit（Phase 3）

**当前状态**: Deferred 仍走 `context.draw` 逐命令拦截

**目标架构**:
```javascript
// RenderItem 批次提交，而不是逐 command 调用 executor

// 伪代码
const items = itemQueue.flush()  // 收集所有 RenderItem
const batches = planRenderBatches143(items)  // 按材质/状态分组

for (const batch of batches) {
  executor.executeBatch(batch, context, passState)  // 批次提交
}
```

**预期收益**: 
- CPU submission p95 **-5% ~ -8%**
- 支持后续 Material batching

---

### 4.2 实现 Material Batching（Phase 6）

**目标**: 合并相同材质的 draw call

```javascript
// 伪代码
const batchKey = generateBatchKey(command)
// batchKey = { program, uniformBlock, textureBindings, renderState }

const batches = groupBy(commands, cmd => generateBatchKey(cmd))

for (const [key, commands] of batches) {
  // 一次 bind program/uniform/texture
  bindBatchState(key)
  
  // 逐 command 只提交 vertex buffer
  for (const cmd of commands) {
    drawVertices(cmd)
  }
}
```

**预期收益**: 
- 200 draw calls → ~50-80 batches
- CPU submission p95 **-10% ~ -15%**

---

## 五、性能诊断工具

### 5.1 RenderProfiler143 使用

```javascript
const pipeline = CCR.getVisualPipeline(viewer)
const profiler = pipeline.getProfiler()

// 启用 GPU 计时
profiler.setEnabled(true)

// 运行 60 帧
setTimeout(() => {
  const stats = profiler.getDiagnostics()
  console.table(stats.passes)
  
  // 输出示例:
  // ┌─────────┬──────────────┬─────────┬─────────┬─────────┐
  // │ (index) │     name     │  count  │  p50    │  p95    │
  // ├─────────┼──────────────┼─────────┼─────────┼─────────┤
  // │    0    │ 'shadow'     │   60    │  3.2ms  │  4.1ms  │
  // │    1    │ 'geometry'   │   60    │  2.1ms  │  2.8ms  │
  // │    2    │ 'lighting'   │   60    │  1.5ms  │  2.0ms  │
  // │    3    │ 'postproc'   │   60    │  1.2ms  │  1.6ms  │
  // └─────────┴──────────────┴─────────┴─────────┴─────────┘
}, 2000)
```

### 5.2 性能基线测量

```bash
# 使用现有测量脚本
node scripts/performance/measure-rendering-baseline.cjs \
  --url "http://localhost:8080/examples/campus.html" \
  --frames 300 \
  --warmup 60 \
  --output docs/verification/rendering-performance/baseline-current.json
```

### 5.3 显存使用诊断

```javascript
const pipeline = CCR.getVisualPipeline(viewer)

// RHI 诊断
const rhiDiag = pipeline.rhi?.getDiagnostics()
console.log('RHI Resources:', rhiDiag)

// Pool 诊断
const pool = pipeline.getRenderTargetPool()
console.log('Pool Stats:', pool.getDiagnostics())

// 输出示例:
// {
//   live: 3,              // 存活资源数
//   pool: {
//     entries: 12,        // 池中条目数
//     allocated: 8,       // 已分配
//     retired: 2,         // 已退休
//     bytes: 134217728,   // 128MB
//     owners: ['rhi', 'ao', 'bloom']
//   }
// }
```

---

## 六、推荐配置方案

### 6.1 高性能桌面（RTX 3060+）

```javascript
pipeline.setOptions({
  // 抗锯齿
  antialiasing: 'taa',
  taaJitterSamples: 8,
  
  // 阴影（三级联）
  shadowSize: 4096,
  shadowCascades: 3,
  shadowUpdateInterval: 1,
  shadowDistance: 6000,
  
  // 视觉效果
  hdrBloomEnabled: true,
  hdrBloomStrength: 0.2,
  screenSpaceAoEnabled: true,
  screenSpaceAoAlgorithm: 'hbao',
  environmentReflectionEnabled: true,
  
  // 延迟光照（可选）
  lightingMode: 'deferred',
  
  // 调速器（保持 60 FPS）
  performance: { enabled: true, targetFps: 60 }
})
```

**预期性能**: 1080p @ 60 FPS，1440p @ 45-60 FPS

---

### 6.2 中端桌面（GTX 1660 / RX 5600）

```javascript
pipeline.setOptions({
  // 抗锯齿
  antialiasing: 'smaa',
  
  // 阴影（单级联）
  shadowSize: 2048,
  shadowCascades: 1,
  shadowUpdateInterval: 1,
  shadowDistance: 4000,
  
  // 视觉效果
  hdrBloomEnabled: true,
  hdrBloomStrength: 0.15,
  screenSpaceAoEnabled: true,
  screenSpaceAoAlgorithm: 'ssao',
  
  // 调速器
  performance: { enabled: true, targetFps: 30, minScale: 0.7 }
})
```

**预期性能**: 1080p @ 30-45 FPS

---

### 6.3 移动/低端设备

```javascript
pipeline.setOptions({
  // 抗锯齿
  antialiasing: 'fxaa',
  resolutionScale: 0.75,
  
  // 阴影
  shadowSize: 1024,
  shadowCascades: 1,
  shadowUpdateInterval: 2,
  shadowDistance: 2000,
  
  // 关闭高级效果
  hdrBloomEnabled: false,
  screenSpaceAoEnabled: false,
  environmentReflectionEnabled: false,
  clouds: false,
  volumetricFog: false,
  
  // 调速器
  performance: { 
    enabled: true, 
    targetFps: 30, 
    minScale: 0.6,
    allowResolutionScaling: true 
  }
})
```

**预期性能**: 720p @ 30 FPS

---

### 6.4 4K 显示器优化

```javascript
pipeline.setOptions({
  // 分辨率策略
  resolutionMode: 'css',
  resolutionScale: 0.75,  // 渲染 2880×1620，拉伸到 4K
  antialiasing: 'smaa',
  
  // 阴影
  shadowSize: 2048,
  shadowCascades: 1,
  
  // 视觉效果
  hdrBloomEnabled: true,
  screenSpaceAoEnabled: true,
  screenSpaceAoAlgorithm: 'ssao',
  
  // 调速器
  performance: { enabled: true, targetFps: 30 }
})
```

**预期性能**: 4K @ 30 FPS（等效 ~1620p 渲染）

---

## 七、性能优化检查清单

### 7.1 首次优化步骤

- [ ] 应用 Priority 0 修复（阴影更新间隔、polygon offset）
- [ ] 启用性能调速器（`targetFps: 30`）
- [ ] 选择合适的抗锯齿方案
- [ ] 调整阴影配置（size/cascades/distance）
- [ ] 测量基线性能（`measure-rendering-baseline.cjs`）

### 7.2 视觉效果提升步骤

- [ ] 启用 HDR Bloom（夜景/高光场景）
- [ ] 配置环境反射（玻璃/金属材质）
- [ ] 启用 SSAO/HBAO（建筑内部/细节场景）
- [ ] 调整色调和色彩（exposure/contrast/saturation）
- [ ] 配置云层和体积雾（室外场景）

### 7.3 中级优化步骤

- [ ] 修复阴影 polygon offset（代码修改）
- [ ] 实现 Deferred 提前过滤（代码修改）
- [ ] 验证 Graph allocator 使用情况（添加诊断日志）
- [ ] 对比优化前后性能（基线 JSON 对比）

### 7.4 长期架构改进

- [ ] 实现 Direct-Submit（Phase 3）
- [ ] 实现 Material Batching（Phase 6）
- [ ] 优化 TAA 历史采样（解决时间抖动）
- [ ] 完成 Phase 0 基线冻结

---

## 八、常见问题和解决方案

### Q1: 启用延迟光照后画面变暗？

**原因**: 延迟光照使用精确的 PBR 公式，与增强前向光照的近似值不同

**解决方案**:
```javascript
pipeline.setOptions({
  lightingMode: 'deferred',
  exposure: 1.8,        // 增加曝光
  sunIntensity: 2.5,    // 增加太阳强度
  skyLightIntensity: 3.5  // 增加天光强度
})
```

---

### Q2: TAA 出现重影或抖动？

**原因**: 历史混合参数不适合当前场景

**解决方案**:
```javascript
// 快速运动场景
pipeline.setOptions({
  antialiasing: 'taa',
  taaHistoryBlend: 0.05,      // 增加（降低历史权重）
  taaMotionBlend: 0.7,        // 增加（更快响应运动）
  taaVelocityThreshold: 8     // 降低（更敏感）
})

// 静态场景
pipeline.setOptions({
  antialiasing: 'taa',
  taaHistoryBlend: 0.02,      // 降低（更稳定）
  taaMotionBlend: 0.3,        // 降低（更多历史）
  taaVelocityThreshold: 16    // 增加（更保守）
})
```

---

### Q3: SSAO 出现光晕或过暗？

**原因**: `bias` 或 `radius` 参数不当

**解决方案**:
```javascript
// 光晕（halo）→ 增加 bias
pipeline.setOptions({
  screenSpaceAoEnabled: true,
  screenSpaceAoBias: 0.12,    // 从 0.08 增加到 0.12
  screenSpaceAoRadius: 2      // 同时减小半径
})

// 过暗 → 降低 strength
pipeline.setOptions({
  screenSpaceAoEnabled: true,
  screenSpaceAoStrength: 0.7  // 从 1.0 降到 0.7
})
```

---

### Q4: 性能调速器一直降级？

**诊断**:
```javascript
const diag = pipeline.getPerformanceDiagnostics()
console.log('当前档位:', diag.step, diag.label)
console.log('p95 帧时间:', diag.p95, 'ms')
console.log('目标帧时间:', diag.targetFrameMs, 'ms')
```

**解决方案**:
1. 降低目标帧率: `targetFps: 30` → `targetFps: 24`
2. 允许分辨率缩放: `allowResolutionScaling: true`
3. 手动降低基线质量（关闭 AO/Bloom/反射）

---

### Q5: 显存占用过高？

**诊断**:
```javascript
const pool = pipeline.getRenderTargetPool()
const diag = pool.getDiagnostics()
console.log('池显存:', (diag.bytes / 1024 / 1024).toFixed(1), 'MB')
console.log('已分配条目:', diag.entries)
```

**解决方案**:
```javascript
// 降低阴影分辨率
pipeline.setOptions({
  shadowSize: 2048,      // 从 4096 降到 2048（-75% 显存）
  shadowCascades: 1      // 单级联
})

// 降低渲染分辨率
pipeline.setOptions({
  resolutionScale: 0.75  // 减少 ~44% framebuffer 显存
})

// 关闭高级效果
pipeline.setOptions({
  hdrBloomEnabled: false,        // 省略 bloom 降采样链
  screenSpaceAoEnabled: false,   // 省略 AO buffers
  depthPyramidEnabled: false     // 省略深度金字塔
})
```

---

## 九、性能监控仪表盘

### 实时监控代码

```javascript
// 在浏览器控制台运行
const pipeline = CCR.getVisualPipeline(viewer)
let lastTime = performance.now()
let frames = []

viewer.scene.postRender.addEventListener(() => {
  const now = performance.now()
  const delta = now - lastTime
  lastTime = now
  
  frames.push(delta)
  if (frames.length > 120) frames.shift()
  
  if (frames.length === 120) {
    const sorted = frames.slice().sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]
    
    console.log(`[性能监控] p50: ${p50.toFixed(1)}ms | p95: ${p95.toFixed(1)}ms | p99: ${p99.toFixed(1)}ms`)
    
    const perfDiag = pipeline.getPerformanceDiagnostics()
    if (perfDiag.enabled) {
      console.log(`[调速器] 档位: ${perfDiag.step}/${perfDiag.maxStep} (${perfDiag.label})`)
    }
  }
})
```

---

## 十、总结

### 性能优化优先级

1. **立即执行** (Priority 0):
   - 修复阴影更新间隔（`shadowUpdateInterval: 1`）
   - 启用性能调速器
   - 选择合适的抗锯齿

2. **本周完成** (Priority 1):
   - 实现 Deferred 提前过滤（代码修改）
   - 验证 Graph allocator 使用情况
   - 建立性能基线

3. **长期改进** (Priority 2):
   - 实现 Direct-Submit
   - 实现 Material Batching
   - 完成 Phase 0-6 架构完善

### 视觉效果提升优先级

1. **普适场景**: HDR Bloom（夜景/高光）
2. **建筑/室内**: SSAO/HBAO
3. **玻璃/金属**: 环境反射
4. **室外大场景**: 云层 + 体积雾
5. **特定风格**: 色调调整（exposure/contrast）

### 预期性能提升汇总

| 优化项 | CPU p95 | GPU p50 | 显存峰值 |
|--------|---------|---------|----------|
| 阴影修复 (Priority 0) | +2% | -62% | -62% |
| Deferred 过滤 (Priority 1) | -3~-5% | 0% | 0% |
| Direct-Submit (Priority 2) | -5~-8% | 0% | 0% |
| Material Batching (Priority 2) | -10~-15% | 0% | 0% |
| **总计（全部完成）** | **-16~-26%** | **-62%** | **-62%** |

---

**文档版本**: v1.0  
**最后更新**: 2026-10-14  
**下次更新**: 优化方案实施后（预计 2026-10-21）

---

**需要帮助？**
- 📖 查看完整 API 文档: [docs/01-architecture/API.md](../01-architecture/API.md)
- 🐛 问题诊断: [docs/verification/CODE_REVIEW_2026-10-14.md](../verification/CODE_REVIEW_2026-10-14.md)
- 📊 性能基线: `scripts/performance/measure-rendering-baseline.cjs`