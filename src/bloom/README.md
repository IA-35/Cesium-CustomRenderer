# 多尺度 HDR Bloom

通过 `pipeline.setHdrBloom({ enabled:true, strength:0.15, threshold:1, knee:0.5, levels:5 })` 启用。默认关闭；strength 0–2，threshold 0–20（曝光前线性 HDR），knee 0–1，levels 2–6 整数。`getHdrBloomDiagnostics()` 返回当前有效性、资源估算、实际层数和失败原因。

13-tap 降采样与软阈值提取高光，逐级降采样后通过 tent 上采样重建。层间混合归一化，避免增加层数时整体亮度成倍增加。最终只向源 RGB 添加泛光，保留源 alpha。使用 FLOAT 目标与显式双线性插值，不要求浮点线性过滤扩展。

执行顺序：SSR → AO → 环境 → Bloom → TAA → 原生 tonemap/后处理。启用时抑制管线所管理的原生 Bloom，关闭后恢复其请求；外部工具重新开启原生 Bloom 时本效果旁路。不会更改 gamma、曝光、相机、分辨率或业务模型。

低于软阈值下界的区域中性；零强度直接借用原图。修改层数重建自有链；resize 由 Cesium collection 重建目标；关闭、暂停、销毁释放资源。绘制失败旁路原图并锁定，显式关/开后才重试。默认5层共10个阶段，FBO 允许由 Cesium 按依赖复用；诊断 bytes 为去重后的活动纹理逻辑总量，不等于进程显存。
