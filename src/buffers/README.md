# WebGL2统一缓冲基础

当前UBO已实际用于不透明SSR与透明SSR的相机和参数输入。灯光分页组件完成数据验证，尚未参与延迟照明。

| 资源 | std140内容 | GPU字节 |
| --- | --- | ---: |
| CampusCamera | 主相机projection、inverseProjection、viewport、near/far | 160 |
| CampusReflection | distance、thickness、strength、maxLevel | 16/消费者 |
| CampusLights | count头部、128个4×vec4灯记录 | 8208/页 |

Camera按scene共享，独立lease幂等释放，最后一个lease销毁buffer。当前两个反射消费者合计192字节。update读取主相机，不取重放过程的当前分段投影。相机组尚不包含view/inverseView或运动历史。

UniformBuffer143保留CPU字节镜像，只上传4字节对齐的变化范围；首次完整上传、未变零上传。withUniformBlocks查询实际布局，并避开同批shader其他active块的占用；退出时恢复program block映射、indexed range/base与generic binding。分配失败、布局不符或没有空闲点时拒绝执行。

绑定状态（block→binding、各绑定点的buffer/offset/size、generic binding、MAX_UNIFORM_BUFFER_BINDINGS）按GL上下文保存JS镜像：每项首次用到时查询一次，之后随本模块每次set/restore同步，每次draw零同步查询。实测（RTX 3070/ANGLE）`getIndexedParameter(UNIFORM_BUFFER_START/SIZE)`单次约67µs，withUniformBlocks单次145µs→0.8µs。前提：Cesium 1.143不写这些状态，本模块是唯一写入方且总会恢复；外部代码若在两次调用之间直接改UBO绑定，镜像会过期。构造与update()仍读取真实的generic binding（不在每draw路径上）。

LightUniforms143.update(lights, offset, viewMatrix)接收point/spot描述。世界position用double矩阵转眼空间，再写Float32；spot direction旋转并归一化。严格检查有限值、正radius、非负颜色/强度以及innerCos≥outerCos。打包后半径下溢到0会拒绝，非法页不改变现有CPU/GPU数据；短页清零未用槽。5000记录可分40页，但这不是5000灯照明或性能验证。

`run-uniform-buffers.cjs`执行实际GPU读回和绑定/释放检查；SSR、透明及校园脚本验证实际消费者。Profiler的`uniformBuffers`字段按buffer对象去重，独立于纹理统计。详细当前状态见plan/evidence/24-uniform-buffers-handover.md。
