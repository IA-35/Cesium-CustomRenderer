# B03 修复、开发与验收执行单

状态：五步已完成；结果、边界与证据见 [B03_COMPLETION.md](B03_COMPLETION.md)。

范围：基于 3199614 的既有未提交 B03 工作，保留用户工作区；亲自执行，不分派执行端 agent。沿用通用生成场景，不依赖校园或外部影像。

1. 修复审查 R1–R5：原始 shader 所有权、逐帧 uniform、能力/失败回退、直接/间接/自发光/阴影参数、销毁、桥停用。验证：对应失败测试先复现，动态阴影及生命周期实际渲染通过。
2. 延迟 SSR：由同一次延迟照明输出环境镜面和响应，复用现有 SSR tracer；不透明 SSR 在 OIT 合成前执行，透明 SSR 继续使用原有 delta/OIT 合成。旧增强来源与新延迟来源互斥。验证：镜面附件数值、SSR 开关/强度0/命中/未命中、无重复照明、玻璃后反射、两种 OIT 路径及回退。
3. 水与粒子：标准 Water/MaterialAppearance 接入 CCR 太阳与阴影；粒子 billboard 按自发光透明前向语义保留 alpha/discard/depth，不伪造不存在的表面法线。自定义 Primitive/材质不自动重光照。验证：真实 Water 和 ParticleSystem 的可见贡献、参数控制、遮挡、OIT/排序与回退。
4. 完整覆盖：两层玻璃、前后不透明、MASK、异步 tile、style、拾取/选中轮廓、OIT MRT/multipass、排序透明、无全局引擎、源/UMD及销毁恢复。修正孪生遮挡和单层0.01门槛，关闭新增模块必须触发负例失败。
5. 回归、审查与交接：B02数值与故障恢复、B01桥、默认冻结基准、SDK指纹；更新支持/兼容/拒绝矩阵并提交。MSAA延迟几何、TAA稳定性、B08云雾分段不在B03中伪称已实现。

实现复用：shaderAdapter143 PCF、reflectionShader143 的原生IBL采样契约、ssrShaders143 tracer/resolve、TransparentReflection143 delta/OIT合成、FrameBridge143、既有材质/Hi-Z和生成glTF夹具。
