# B07–B12 详细执行计划

> 配套 [阶段一完整开发计划](STAGE1_COMPLETION_PLAN.md) 的 B07–B12 部分。本文只补充主计划正文没有的「前置调查 / 执行步骤 / 可验证产出 / 风险」增量，不重复主计划的验收清单。每批的复选框与验收线仍以主计划为准。

> 进度前提（2026-09-17）：B00–B06 已实现并经历两轮审查，代码与测试落地于分支 `codex/stage1-b04-b06` 未提交工作区。B04 三级级联阴影默认已回退为单级联（`shadowCascades:1, shadowSize:4096`）。下一轮执行入口为 B07。

---

## 修订后的跨批次依赖链

```
B07 ← B03 + B04 + B05   （SSR 主体已在 B03 完成，B07 只补 Primitive/水面/积水）
B08 ← B03 + B04 + B05 + B06   （B08 产出介质遮挡/透射率数据）
B09 ← B03 + B08   （光柱/光斑消费 B08 遮挡数据，不重复实现）
B10 ← B03 + B07 + B08 + B09   （TAA 从「Bloom 后」迁移到「稳定 HDR 后」）
B11 ← B04–B10
B12 ← B11
```

---

## B07：SSR 水面/湿地与 Primitive 材质覆盖（收窄版）

### 现状

SSR 主体已在 B03 落地：

- `src/reflections/ScreenSpaceReflection143.js`（不透明 trace/resolve、Hi-Z 消费、环境镜面替换）
- `src/reflections/TransparentReflection143.js`（透明 PBR 反射）
- `src/reflections/ssrShaders143.js`（trace/resolve shader）

B07 的剩余工作是**收窄的材质覆盖补齐**：把标准 PBR `Model` 之外的普通 `Primitive`、水平水面、局部积水接入同一次 SSR 求值，**不重做 trace/resolve 算法**。

### 前置调查（先于编码）

1. **Globe water mask 来源**：查 `node_modules/@cesium/engine/Source/Scene/Globe.js` 中 `waterMask` 的可用性与采样方式，确认 1.143 是否暴露像素级水掩码；不可用则此项降级为「显式标记未接入」，不能静默跳过。
2. **Primitive 材质提取**：对照 R04 的 `EnvironmentLighting143.js` 与 `materialShader143.js`，确认普通 `Primitive` 的法线/roughness/反射响应如何从材质实例提取（而不是从 G-buffer）。
3. **冻结白模绕行基线**：跑 `scripts/check-white-tiles.cjs`，记录 SSR 关/开的基础 PBR 色差值，作为 B03 门槛（≤0.01 绝对 / ≤2% 相对）的延续基准，先证明确有差异再动手。

### 执行步骤

1. 新增 `src/reflections/PrimitiveReflection143.js`：把普通 Primitive 的材质法线/roughness/反射响应接入现有 SSR 求值。
2. 水面/积水 receiver：定义独立契约——水面法线动画与反射采样同一次，透明前向背景与深度来自 B03，不照搬 Tianjing `scene._reflectTexture`。
3. 新增 `tests/rendering/ssr-surfaces-fixture.js`：标准玻璃、水平水面、局部积水三夹具 + Globe water mask 夹具。
4. 验证：卫星影像、feature style、白模/透明 OIT、粗糙度梯度、相机旋转/俯仰/近远变化。

### 可验证产出

- 三类表面（玻璃/水面/积水）均真实响应材质反射，SSR miss 连续回退。
- SSR 关/开的基础 PBR 色差值满足 B03 阈值（≤0.01 / ≤2%）。
- 水面外影像不变灰。

### 风险

- `globe.waterMask` 若在 1.143 不可用，此项如实保留未完成，不能仅凭白模样例关闭 B07。
- 普通 Primitive 的材质求值若与 Model 差异过大（非标准 PBR），可能超出「最小覆盖」范围，需在夹具里显式划定支持边界。

---

## B08：全局地理高度雾 + 介质遮挡数据

### 现状

`src/environment/EnvironmentRenderer.js`、`environmentStages.js`、`cloudShell143.js`、`HdrEnvironmentPass143.js` 已有体积雾与云，`environmentState.js` 已有 `fogScaleHeight`/`fogBaseHeight`。缺失的是：

- 地理高度一致的解析积分（禁止 ECEF.y 当高度）
- 透明片元分段介质（多视锥 T/S 合并）
- 像素级太阳遮挡/透射率数据（供 B09 光柱/光斑）

### 前置调查

1. 核对现有雾的 `fogBaseHeight`/`fogHeightFalloff` 是否已按地理高度语义，确认与 B08「禁止 ECEF.y 当高度」的具体差异点。
2. 读 Tianjing `heightFog.js` 的 `CalculateLineIntegralShared` 与近零 Taylor 分支（R12 已定位），确认可抽取的解析指数积分公式。

### 执行步骤

1. 新增 `src/environment/heightFog143.js`：解析指数积分（含近零 Taylor 分支），用 CPU 数值积分做独立参考。
2. 多视锥透明分段：`T=T1*T2`、`S=S1+T1*S2`，接入 B01 深度契约；先过单透明层解析测试，再验证 OIT 近似叠层。
3. **介质遮挡/透射率产出**：沿视线到太阳积分累计介质，产出像素级太阳遮挡数据。此数据用材质深度/Hi-Z（B02 产出），不依赖 B06 对象级可见性。
4. 云/雾交叠同视线分段合成；深度引导上采样防轮廓穿透。
5. 全球位置测试：校园、赤道、接近极区、跨经度、山区、云下/中/上、高空俯视、地平线连续移动。

### 可验证产出

- 任意经纬度同一高度语义一致，无跨原点跳变。
- 透明前后积分不重复；高空不形成整层灰幕/海量云采样。
- 遮挡/透射率数据与独立 CPU 积分对照在误差内。

### 风险

- 多视锥透明分段合并是最大难点：不同视锥的非线性 depth 不能直接比较，必须先统一到米制距离再合并 T/S。
- 云空区间必须直接退出，避免无效 raymarch 循环（延续现有 cloudShell 契约）。

---

## B09：Tonemap + 镜头效果 + 光柱/光斑

### 现状

`src/stages/colorGrading.js` 已有显示调色。缺失 `toneMapping143.js`（多曲线）与 `lensEffects143.js`（镜头效果）。

### 前置调查

1. 确认 Cesium 自带 `AcesTonemappingStage`/`ReinhardTonemapping`/`FilmicTonemapping`（R13 已定位），确认「只映射一次」时关闭原生 tonemap 的正确时机。
2. 核对 Epic 官方 Filmic 说明，确定 `unrealFilmicApprox` 的 film 形状/中灰/白点校准参数；本地 Cesium FILMIC 是 Uncharted 2，两者来源不同，不宣称 1:1 UE。

### 执行步骤

1. 新增 `src/stages/toneMapping143.js`：ACES/Reinhard/Filmic + `unrealFilmicApprox`（明确标注 Uncharted 2 出处）。
2. 新增 `src/stages/lensEffects143.js`：
   - 移轴（双向 9-tap，核归一化，真实 textureSize 控像素半径）
   - 泛焦模糊/景深（优先复用 `createBlurStage`/`createDepthOfFieldStage`）
   - 色差（显示阶段径向 R/B 偏移，alpha 不偏移）
   - 太阳光斑（太阳屏幕位置 + 深度/云透射率遮挡，背向太阳退出）
   - Light Shaft（**消费 B08 产出的介质遮挡/透射率**，半分辨率径向积分，32 样本）
3. 所有新增效果默认关闭，强度 0 为 identity。
4. 数值测试：HDR 色阶 0/0.18/1/16/64、焦带、深度断层、镜头后太阳、建筑遮日、云遮日、resize。

### 可验证产出

- 每效果独立开关 + identity 测试。
- 色调映射单调、曝光语义确定；白墙/天空不因 Bloom 变白幕。
- 光柱/光斑不透墙（依赖 B08 遮挡数据）。

### 风险

- `blur`/`depthOfField`/`tiltShift` 三者首期互斥，启用一个必须明确反馈另外两项的实际状态，交互规则需在 API 层固化。
- 「只映射一次」若无法保证，该曲线不可启用。

---

## B10：TAA 稳定性收口 + AA 组合

### 现状

`src/antialiasing/TaaPass143.js`、`taaShaders143.js`、`FrustumJitterBridge143.js` 已存在，当前是「Bloom 后 TAA」。

### 前置调查

1. 复跑静态边缘、亚像素细线、树叶 MASK、匀速移动相机、相机 cut、动态物体，保存连续帧（不只看单截图）。
2. 确认 B01/B02 使用的投影与颜色/深度完全对应，真实 drawingBuffer 归一化。

### 执行步骤

1. 从「Bloom 后 TAA」迁移到「稳定 HDR 后再镜头效果/Bloom」，A/B 对比无额外曝光/alpha 变化。
2. 相机历史同一坐标空间；多视锥暂不盲目复用单视锥历史，保持显式 FXAA 回退并说明原因。
3. 可刚体追踪对象提供上帧 model 变换（motion/reprojection）；蒙皮/透明/变形像素走 reactive/reject mask。
4. 回归 FXAA/SMAA 三质量档、MSAA 实际样本、TAA 启停/resize/切模式/相机 cut、B09 镜头效果组合。

### 可验证产出

- 静态收敛后边缘位置峰峰值 ≤0.25px，连续亮度无周期跳闪。
- 静态细线对比 SMAA 参考损失 ≤10%。
- 相机 cut 当帧丢弃旧历史，移动遮挡后的旧轮廓 ≤2 帧消退。

### 风险

- 动态对象 motion vector 是最大难点：无有效速度的对象不宣称时间稳定增强（主计划已明确此边界）。
- 不能通过降低分辨率/增大模糊核让抖动指标变好。

---

## B11：生命周期 + 能力降级 + 默认策略

### 现状

各新模块已有 `destroy`/`isDestroyed`/所有权管理，但缺统一的能力矩阵与 context-loss 全链路验证。

### 执行步骤

1. 能力矩阵：4/6/8 MRT 槽、浮点附件不可用、OIT 两模式、MSAA 支持交集、非 3D、多视锥；诊断含 `requested/active/reason/generation`。
2. 默认策略：CCR 管理天空/环境/阴影/HDR/SMAA；延迟模式通过 B01–B03/覆盖矩阵后才候选默认；HBAO/SSR/Bloom 按预设显式开启。
3. 生命周期：20 轮启停、嵌套暂停、resize、2 个 Viewer 独立操作、tile 异步到达、外部 wrapper、错误后再次启用。
4. `WEBGL_lose_context` 丢失/恢复全链路验证：generation 重置、纹理/program/UBO/query 重建、旧异步回调不复活。
5. 30 分钟交互压力测试：资源数/字节/query 不单调增长。

### 可验证产出

- 无新增 pageerror/GL 错误，无过期纹理/双重释放。
- 恢复后真实渲染输出通过颜色与拾取检查（仅 `isDestroyed`/`valid` 返回值不算画面恢复证据）。

### 风险

- 30 分钟压力测试需开工前固化「交互脚本」与「漂移阈值」（建议：资源数/字节允许 ±5% 波动但禁止单调上升），否则不可复现。

---

## B12：通用场景矩阵验收 + SDK 候选产物

### 现状

`build-rendering-sdk.cjs`、`check-browser-sdk.cjs`、`check-stage1.cjs` 已存在，缺固定负载的三配置性能验收与完整发布清单。

### 执行步骤

1. 固定 1920×1080、目标硬件/浏览器、资产 hash、时间/镜头轨迹/曝光，三配置（隔离基线 / CCR 默认 / 效果组合）。
2. 预热 ≥30 秒，前台连续记录每条轨迹 60 秒、重复 3 轮；窗口失焦/配置或资产变化/GPU disjoint 整组作废。
3. 性能起始线（候选值）：CCR 默认 ≥30FPS 且 P95≤33.3ms；效果组合帧耗时增量 ≤2×。GPU 分项、CPU 帧时间、资源峰值、draw/三角形一并记录。
4. 源码 ESM 与 UMD 一致性：导出 CCR、效果/依赖资源、API、图像一致；manifest 记工作树 hash。
5. `npm pack --dry-run` 核对 ESM 包内容；离线最小消费者验证 UMD。
6. 画质逐条验收 + 交互（拾取/选中、瓦片加载、缩放/旋转、近远切换）。

### 可验证产出

- 验收报告每条目标有证据链接，无未解释画质缺陷。
- 性能门槛达到或明确未达（未达不进入完成状态）。
- B13 仍暂缓时，产物名称和说明不得称「原始目标全部完成」。

### 风险

- 性能门槛是候选值，首轮实测后须在验收报告记录旧/新阈值及原因，不得静默放宽。
- 提交/推送/发布单独执行，构建完成不代表已发布。

---

## 执行纪律（沿用主计划）

- 每批先增加能揭示缺口的测试/夹具，确认旧实现确实不满足，再最小实现并运行对应检查。
- 不得把测试变为仅断言源码包含某字符串。
- 阈值属预先制定的验收线；调整须记录原因与旧/新阈值。
- 每批证据存 `docs/verification/stage1-Bxx/`，公开摘要写进非忽略的 docs 文件。
