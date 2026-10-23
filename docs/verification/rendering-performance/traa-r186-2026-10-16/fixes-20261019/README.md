# TAA 覆盖闪烁与拾取闪帧修复验收

状态：接续已有修改，完成源码、回归脚本、文档及 UMD 构建更新。以下最终校园与 bundle 回归均使用 SHA256 `f3c80278edc05796abf236b8d7801b01352ddd02ce3b57458e6ce05825e1a9af`，与 build/0.1.0/manifest.json 一致。

## 最终实现

- 深度历史为 RG32F，记录重建足迹最近/最远眼深；最远通道为 0 表示包含天空。中心历史判断与历史逐 tap 过滤采用一致语义。
- 相机及去 jitter 投影、已提交不透明几何的集合/矩阵、场景时间均不变时，按覆盖范围接受历史，继续融合当前样本，避免单帧方差盒清除漏采的细几何和同深度细纹理。没有冻结旧颜色，也没有增加 AA 模式或配置开关。
- 出现、消失、物体移动、相机/投影改变或场景时间变化时恢复最近深度拒绝及原方差裁剪。几何集合检测复用 Motion 快照，两个 Set 交换复用，包含不支持速度 shader 的不透明提交。
- 删除未完成版本的天空直接保留旧颜色分支；采样年龄仍放在私有历史 alpha，按最近 texel 读取，避免插值不同像素的年龄。对外 alpha 从原场景恢复。
- preRender 准备即将开始的颜色帧，不读取拾取遗留 passes 来停用 Motion；overlay 使用最近已确认颜色帧的视锥状态。实际 resolve 仍排除拾取/深度帧、多视锥等不兼容情况。
- 核对了 `_execute` 的重建→resolve→深度写入→显示 alpha 恢复顺序，以及 `_copyToRhi` 与无 RHI display stage。现有目标复用方式保留，通过实际 GPU 输出检查。

静态累积属于明确记录的 CCR 适配，非逐公式不变的 Three.js r186。它依赖上述稳定性检查；动态时保留官方裁剪核心及 CCR 的严格米制拒绝。

## 最终校园包验证

70 个建筑 ready，检查截图确认模型实际显示；车辆关闭，固定视角和时间，640×420，8 相位，预热 640 帧后采集 64 帧。NVIDIA RTX 3070 / Chrome ANGLE D3D11。

| 指标 | 修复前 | 最终包 |
|---|---:|---:|
| 原屋顶问题像素 (267,309) 亮度标准差 | 64.13798 | 0.07398 |
| 同像素亮度峰谷差 | 152.50259 | 0.42520 |
| 最终包全图峰谷差超过 10/255 的像素 | — | 0 |
| 最终包全图最大亮度标准差 | — | 2.86604 |

亮度单位为 0–255，像素坐标为左下原点。全图仍有低幅度时间变化，不代表每个像素完全不变。

基线：../flicker-diagnosis-20261019/campus-before-20261019.json。
最终数据：campus-current-bundle.json；实际画面：campus-current-bundle.png；机器可读汇总：summary.json。

## 有断言的 GPU 回归

`scripts/performance/check-taa-regressions.cjs --bundle` 验证：

- pick 模型、pick 空白、pickPosition、drillPick 后连续三个颜色帧，历史年龄逐帧增加、Motion 保持 active、newSurfaces=0。
- 物体从实体背景及天空背景前消失，下一帧历史 RGB 与当前重建 RGB 的最大误差均为 0；没有依赖长期保留旧颜色来消除闪烁。
- 小点在实体背景/天空上持续累积，HDR 最大标准差分别为 0.000451/0.000546。相对 8 相位当前输入算术平均的亮度增量，保留约 90.3%/76.4%；此指标用于防止以擦除细节换取稳定，不是空间超采样真值或无损证明。保留的 r186 亮度加权本身会影响平均辐射值。
- 私有采样年龄未泄漏到显示 alpha，显示 opacity=1。
- 移动刚体产生 Motion draw 且退出稳定累积；相机移动恢复动态保护。

最终包数据：regressions-bundle.json。无 RHI 直接 stage 路径在本轮通过相同类型回归，见 regressions-no-rhi.json；该路径检查在最终 shader 简化前完成。

已有 motion harness 的平移、旋转、Z 方向、组合、启停、出现、遮挡、MASK 和不支持 shader 等 10 个 source 用例均无有效速度匹配错误。生命周期启停、多视锥降级/恢复及 resize 通过，见 ../fixes-motion-20261019/report.json。该测试验证速度及生命周期，不能单独当作所有动态场景无拖影的证明。

## 检查与代价

- 本轮全量 Node：1036 passed，3 skipped，0 failed。后续局部收尾后最终相关测试：39/39 passed。
- npm run build 成功；最终 bundle 的拾取/覆盖/显露断言通过，包哈希已核对。
- git diff --check 无差异格式错误。
- 沿用原历史目标数量，深度从单通道变双通道；1080p 额外 7.91 MiB 逻辑显存。没有重新跑完整 GPU 性能基准，不宣称 FPS 提升。
- 用户原有阴影、车辆等工作区改动保留；构建产物包含当前完整工作区。没有提交或推送。

## 复跑

在仓库根目录执行（需要本机既有 Playwright、Chrome）：

```powershell
node scripts/performance/check-taa-regressions.cjs --bundle
node scripts/performance/check-taa-regressions.cjs --no-rhi
node docs/verification/rendering-performance/traa-r186-2026-10-16/fixes-20261019/diagnose.cjs --campus --bundle --variants=current
```

脚本分别使用 8996/8994 端口，不修改生产参数。最终校园数据以带 `-bundle` 的文件为准；本目录其它临时 source 数据记录了开发过程，不替代最终包结果。

## 未覆盖边界

尚未在用户原业务窗口、原分辨率以及其它 GPU/浏览器完成验收。透明动画、仅在 GPU 内变形或材质内部变化且未改变场景时间的内容，仍缺少完整运动/变化语义；不能把当前刚体与静态建筑验证扩大为这些内容也无拖影。手动改变材质/灯光但绕过管线通知的场景，需调用现有 resetTaaHistory() 让历史重新采样。
