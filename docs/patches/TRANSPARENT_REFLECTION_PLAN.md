# 透明反射与前向合成实施计划

目标：逐层为PBR透明表面增加SSR，保留原生透明度和前向排序/OIT语义，向阶段1玻璃/水面反射要求推进。主阶段的其他要求保持不变。

方案：新增可选第七个共享RGBA16F附件保存原生不透明颜色，避免追踪读取已经混入透明物的主画面。透明反射在原生透明渲染后重放片元至signed-delta FLOAT目标，并在HDR priority6合成（不透明SSR5→透明6→AO10→环境20）。原透明颜色和alpha由Cesium控制，不将所有透明对象压成最近一层。

- sorted：沿原生已排序的每视锥命令数组远→近重放，输出反射差值与原alpha，以原alpha衰减后方delta。未支持反射的前透明物输出0差值与alpha，仍遮挡后方修正。
- OIT：重放输出delta×alpha×原czm_alphaWeight；合成借原生累计权重与revealage换算，覆盖MRT/multipass，原生透明附件不被修改。
- 深度：使用同帧线性不透明深度手动拒绝后方片元；未知深度保守旁路。透明射线忽略其自身屏幕覆盖，命中颜色只来自独立不透明附件。仍未实现透明物之间的递归反射或折射。

实施文件：MaterialTarget143/MaterialChannels143/materialShader143按需7附件；reflectionInstrumentation显式allowBlend（默认行为不变）；transparentReflectionShader143和TransparentReflection143；VisualPipeline/presets/preview与Profiler接入。普通4附件与不透明SSR6附件保持兼容，7槽不足或分配失败保留6槽能力。

验收：真实透明PBR镜面非零反射、alpha与原生未命中色保留、前后叠层、OIT/sorted/multipass一致的delta权重、移动/非log多视锥/奇数resize/启停释放；新opaqueColor与实际未合透明颜色相符；原不透明SSR、AO、Hi-Z和透明覆盖回归。Node/静态资源校验/生产构建完成后更新交接。不使用只测最近层或关OIT的结果宣称所有透明合成完成。

所有权明确的子任务按已授权subagent-driven-development工作流并行实现；GPU由主任务串行执行。没有新依赖下载或对业务模型的修改。
