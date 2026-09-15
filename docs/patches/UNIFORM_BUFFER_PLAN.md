# 共享相机与渲染参数UBO实施计划

目标：将真实WebGL2 UBO接入当前SSR/透明SSR，建立后续延迟光照使用的相机和参数缓冲基础；继续保留5000+光源、分块延迟、环境/光源分组等完整要求，不能把此基础当作阶段1或全部UBO完成。

实现：UniformBuffer143拥有GPU buffer与CPU字节镜像，按4字节对齐的变化范围上传，静态数据不重复传输。共享CameraUniforms143以scene为单位引用计数，std140布局160字节（projection64、inverse64、viewport16、clip16）；反射参数另用16字节组（distance/thickness/strength/maxLevel）。

绑定：仅对自有shader的已知uniform block操作，验证GPU报告尺寸，使用末尾两个可用绑定点并保存/恢复原indexed range/base及generic UNIFORM_BUFFER绑定。保留CesiumShaderProgram延迟编译及普通uniform路径，Node替身/不支持环境不伪装UBO运行。实际WebGL2生产路径使用UBO定义，原shader字符串默认ordinary uniform便于独立数值回归。

验收：GLSL实际读取矩阵/参数与CPU布局一致、不同程序共享、静止帧零上传、局部更新准确、外部绑定/异常恢复、按scene共享与释放、SSR和透明反射颜色/alpha/生命周期不回归。更新Profiler统计UBO实际字节/上传；全量Node、静态包哈希、构建与GPU证据后写交接。

此方案不会把光源遍历留在主片元循环中作为5000灯完成证明。下一阶段需要实际材质/albedo、light-list/culling与延迟光照消费者，将统一缓冲应用到真实多光源路径，并进行正式帧时核验。
