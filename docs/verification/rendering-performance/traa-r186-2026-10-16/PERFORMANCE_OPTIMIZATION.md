# TAA 性能优化与建筑场景重测

日期：2026-10-16。代码与最终 SDK 已更新；没有提交或推送。

最终构建：`a5668f64bf8ce1f94aca7f7f91bb4403137888857edfa927d645ebef3a7d2695`。
对照为本次优化开始前、用户已实现的适配版本 `6c7c356d114deb2e0a0f1a7a56eb203b9f6e5da0a44eb58e3c2108b6a4e50a17`，不是更早撤回的候选。

## 最终改动

1. 当前颜色先重建一次。复用已有显示纹理存放4×4重建结果，resolve直接读取其3×3邻域，再复用同一纹理恢复显示alpha。当前颜色部分由每像素144次读取改为16+9次；增加一次绘制，不新增纹理。
2. 删除两张无采样消费者的RHI深度、对应复制及第二张显示颜色；Graph直接绑定native历史。FP32私有历史保留，`rhiHistoryBytes`兼容字段现在只统计一张显示目标。
3. 运动目标在本帧第一次实际写入前清理，无写入时resolve不读取该纹理；停止运动不反复分配/释放。
4. 每个primitive复用记录和两份独立矩阵，帧间断开时重新初始化；不引用Cesium原地更新的矩阵。

单shader内缓存6×6的实现没有交付。它在测量中增加了执行成本，最终采用上述显示目标复用方案。未修改重建核、历史接受、方差或混合公式。

## 有效性能结果

用户指出测试期间模型曾被移除，并要求不管车辆。最终结论只使用模型恢复后重新取得的 `opt-building-before` / `opt-building-after`，此前车流场景及中间缓存方案数据不纳入结论。

条件：RTX 3070、Chrome/ANGLE D3D11、1920×1080、TAA 8相位、同一固定建筑视角和冻结光照时间。两次均确认70个建筑ready，并检查实际渲染截图；`traffic=none`关闭车流，不等待车辆。树、水、云保留原默认设置。

每版300帧×3轮，frame/AA/motion作用域轮换，AA与整帧各300个有效GPU样本，CPU900个样本。无disjoint、无缺失查询、无页面/最终render错误。AA计时包括新增的颜色重建pass。

| 指标 | 优化前 | 优化后 | 解释 |
|---|---:|---:|---|
| AA GPU p50 | 2.063360 ms | 1.266688 ms | 降低38.6% |
| AA GPU p95 | 2.182144 ms | 1.270784 ms | 降低41.8% |
| AA相关纹理 | 150.293 MiB | 102.832 MiB | 减少47.461 MiB；此场景motion未分配 |
| RHI纹理数量 | 4 | 1 | 私有native历史不计入此数量 |
| 整帧GPU p50 / p95 | 7.932 / 10.669 ms | 8.214 / 9.510 ms | 不据此宣称整帧或FPS全面提升 |
| CPU提交 p50 / p95 | 9.9 / 13.6 ms | 10.1 / 13.5 ms | 未证实整体CPU提速 |

纹理数据是逻辑分配字节，不是驱动测得的整进程显存峰值。比较的是当前硬件和这一建筑视角，不外推其他GPU、4K或动态车辆负载。

[优化前报告](opt-building-before/report.json) · [优化后报告](opt-building-after/report.json) · [汇总](optimization-summary.json) · [确认建筑加载的画面](opt-building-before/campus-loaded.png) · [最终TAA画面](opt-building-after/campus-performance.png)

## 画质与回归

- 最终构建程序化夹具覆盖静止、平移、旋转、停止与遮挡变化。静止窗格p95 STD为0.667197→0.667512，栏杆0.878036→0.878036，没有出现此前那种量级的闪烁退化。
- 259张对应输出PNG比较：约99.99484%的RGBA通道值完全一致，平均绝对差0.0000531（0–255），最大差4。不是位级等价；少量差异来自分pass计算与浮点运算，不能写成“逐像素不变”。
- 同帧当前颜色重建对照通过1e-6精度检查；完整resolve的方差相减会放大浮点末位差异，因此同时保留最终显示比较和连续帧质量指标。
- 最终构建运动输入/遮挡/MASK检查无有效性不匹配；32相位Label/Billboard遮罩变化为0，pick通过，轮廓脚本正常完成。
- 无RHI直接pass也实际渲染并通过UI、pick、生命周期检查；销毁后motion texture、program、alias均释放。
- 资源/快照优化后的全量Node检查为1023项、1020通过、3跳过、0失败。随后重建pass调整运行最终29项AA专项，全部通过；GLSL检查和构建通过，最终UMD另完成上述GPU/页面验证。没有把早一阶段全量结果冒充最后shader改动后的全量重跑。

[优化前画质序列](opt-before-quality/report.json) · [最终画质/UI结果](opt-delivery-quality/report.json) · [无RHI结果](opt-delivery-no-rhi/report.json) · [像素差异](optimization-pixel-comparison.json) · [重建精度](opt-prepass-parity-fixed/report.json)

## 重测命令

```powershell
node scripts/performance/validate-traa-r186.cjs --bundle --campus --performance --buildings-only --samples 8 --size 1920x1080 --label building-performance
node scripts/performance/validate-traa-r186.cjs --bundle --samples 8 --ui --label quality-ui
node scripts/performance/validate-traa-r186.cjs --bundle --no-rhi --samples 8 --case static --ui --label direct-pass
```

GPU任务串行执行。用户最终项目交互验收与其他设备性能仍未覆盖；本轮建筑性能重测按要求关闭车辆。
