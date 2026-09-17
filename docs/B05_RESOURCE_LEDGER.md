# B05 资源与共享帧数据账本

池仅管理 CCR 自己创建的单采样目标。`PooledStageCache143` 先读取整个 AO/Bloom 阶段图，计算首次写入、最后读取和兼容槽位，再创建 lease；不是按纹理名称碰运气复用。下表中的 W/H 为实际 drawing buffer 尺寸，缩小尺寸取 ceil。

## 临时目标

| 写入 pass | 读取 | 写入格式/尺寸/samples | 活跃期与释放 |
| --- | --- | --- | --- |
| AO raw | 材质深度、法线、Hi-Z | RGBA8，W/2×H/2，1 | raw → horizontal |
| AO horizontal | raw、深度 | 同上 | horizontal → vertical |
| AO vertical | horizontal、深度 | 同上 | 保留为 AO visibility，直到下一帧/停用；可复用已消费的 raw 槽位 |
| AO resolve | 原 HDR、vertical visibility、材质 | RGBA32F，W×H，1 | 保留颜色直到下一个真正替换颜色的 HDR 消费者完成 |
| Bloom down0…3 | 原 HDR/上一 down | RGBA32F，W/2…W/16 × H/2…H/16，1 | 各自保留到对应 up 合并完成 |
| Bloom up2…0 | 较小 up/down 和对应 down | RGBA32F，W/8…W/2 × H/8…H/2，1 | 到下一级 up 或 resolve 完成；同一次读写不能别名 |
| Bloom resolve | 原 HDR、up0 | RGBA32F，W×H，1 | 到下一颜色消费者/原生 tonemap 完成 |
| 遮挡 query depth | 已知材质深度、有效标志 | DEPTH_COMPONENT/UNSIGNED_INT，W×H，1 | 本批 depth fill → 所有 bounds queries；查询发布后释放，结果对象另行保留 |

AO resolve 经环境合成消费后，与 Bloom resolve 无重叠，可共享全分辨率 RGBA32F 物理纹理。环境关闭且 AO resolve 就是 Bloom 输入时，读保留阻止复用；不改变 RGBA8/RGBA32F 格式以制造节省。实际逐 pass 的 reads、first/last、slot、尺寸和格式可从 `screenSpaceAO.pooled.getLedger()` / `hdrBloom.pooled.getLedger()` 检查。

所有 lease 仅属于创建它的 context；释放、resize、context loss 后旧 getter 抛 `Target lease expired`。失效资源仍有读保留时暂不销毁物理纹理，最后一个读者退出后统一释放 FBO 和附件。借用输入仅登记读保留，从不加入销毁列表。HDR 后续消费者抛错也会释放当前颜色 lease。最后一个生产者退出后池中存储全部释放。

## 保持原所有权的资源

| 资源/生产者 | 生命周期与读取者 | 不放入临时池的原因 |
| --- | --- | --- |
| Cesium 场景颜色、深度、MSAA、OIT 累积 | Cesium 拥有；CCR 按桥时序借读/写已验证接点 | 不拥有附件释放权，MSAA resolve 由引擎管理 |
| Compact G-buffer/增强材质重放 | 几何写 → 照明、AO、SSR、Hi-Z、query 读 | 跨 pass 活跃，支持/兼容分量契约不同 |
| Hi-Z levels | 材质深度归约 → AO/SSR/查询消费者 | 同帧多个后续消费者仍持有 |
| 延迟镜面、响应、不透明快照 | 照明写 → 不透明/透明 SSR | 透明合成结束前必须保持 |
| SSR trace/resolve、透明 delta/resolve | 原模块分配，单帧链式读写 | 本批不改变其颜色快照契约；以后若增加时间历史，仍必须专属 |
| TAA history/depth 与 ping-pong | 跨帧、相机重投影 | 明确历史，不能被 AO/Bloom 临时目标覆盖 |
| 环境 raymarch/resolve | 原 HDR 环境集合管理 | 本批只借其完成消费的时刻释放 AO 颜色 |
| 三张阴影深度图 | 每级投影 → 全帧表面/体积接收；静态时跨帧 | 静态缓存与阴影接收仍需持有 |
| SMAA、FXAA、调色及查找表 | 原模块管理；原生 tonemap 后使用 | 不属于本批线性 HDR 目标复用域 |

## 共享帧数据消费者

| 消费者 | 数据来源/布局 | 说明 |
| --- | --- | --- |
| AO、SSR、透明 SSR | 共享 `CampusCamera` 160 B：projection 0、inverseProjection 64、viewport 128、clip 144 | 旧偏移不变；每次更新比较实际 Float32 字节，同一帧修改投影立即更新 |
| PBR/Globe 阴影接收、延迟照明、透明 PBR/水 | 共享 `CCRSunFrame` 48 B：eye direction、HDR radiance、world direction | 按实际 draw 使用的 shader block 绑定，原生 shader 没有 block 时不干预 |
| 天空、雾、local/shell 云、环境 resolve | 独立共享 `CCREnvironmentFrame` 192 B：eyeToLocal、active inverseProjection、local sun、物理 sun/sky radiance、shell sun | 不同单位、参考系和 active frustum；不能塞进主相机 160 B 或引擎太阳 48 B 造成语义变化 |
| 几何/材质重放、阴影投影、Hi-Z、曝光/调色、空间 AA | 保留 Cesium automatic uniforms / 自有尺寸参数 | 回放视锥、顶点矩阵和 pass viewport 不等于主相机块，原生机制保持 |
| TAA | 保留自己的当前/历史稳定网格矩阵与 jitter | temporal 契约不等于主相机 projection；留给 B10 完整收口 |
| 实验多光源 LightUniforms | 原有独立光源列表 | B13 暂缓，不冒充已迁移的太阳消费者 |

`getFrameUniformDiagnostics()` 对共享 buffer 去重，返回当前字节、上传次数、上传字节、引用者及 view revision。底层 `UniformBuffer143` 只上传变化字节区间；不能以帧号相同为由跳过真实变化。环境局部矩阵可能存在原生正交化带来的极小浮点变化，仍如实上传；同值测试冻结的是输入矩阵，不是上传逻辑。

## 验收

`check-render-target-pool.cjs` 验证池开/关逐像素一致、真实跨效果复用、环境关闭的重叠禁止、失败重试和十轮启停/尺寸切换。`check-frame-uniforms.cjs` 直接读 GPU buffer 验证同值不重复上传、同帧投影/太阳变化立即上传及释放。两入口支持 `--umd`。`check-occlusion-boundaries.cjs` 同时验证真实 WebGL context loss 时池句柄失效和附件释放。

640×420 的 AO + Bloom 验收配置中，原生目标驻留 12,248,960 B，池化 7,679,360 B，减少 4,569,600 B（约 37.3%）；关闭环境导致输入活跃期重叠时会增加目标，不能沿用该节省比例。所有相关生产者关闭后 live leases 和驻留字节均为 0。`allocated/reused/crossReused` 为累计次数，`peakBytes` 为池存续期峰值；不能把累计 allocated 当成当前存活数量。
