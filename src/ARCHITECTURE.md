# CCR 渲染后端分层

CCR 保留 Cesium 作为数据与场景生产者，但把渲染提交拆成明确边界：

- `src/core/`：FrameState、资源句柄和跨模块契约，不依赖具体 Cesium 效果。
- `src/rhi/`：WebGL2 资源、RenderTarget lease、销毁和 context 生命周期。
- `src/renderer/`：RenderItem、Pass 编译和 Render Graph 执行。
- `src/scene/`：Cesium 场景、瓦片、相机和 DrawCommand 收集适配；不得创建 CCR transient 资源。
- `src/environment/`：HDR、环境光和 tone mapping 执行接点。
- 现有 `ao/`、`lighting/`、`antialiasing/` 等目录是迁移中的效果模块，逐步只依赖上述契约。

迁移规则：

1. Cesium 负责数据遍历、可见性、相机和命令收集。
2. Scene adapter 将 Cesium 命令转换成 `FrameState143` 与 `RenderItem143`。
3. Renderer 通过 Render Graph 声明资源和 Pass。
4. RHI 负责 CCR 自有 WebGL 资源的租约与销毁。
5. 能力矩阵决定 requested / active / effective mode；任何回退都必须进入诊断。
