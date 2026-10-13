# 独立车流模块实施计划

**目标：** 三维车辆沿闭合道路循环行驶，独立于太阳时钟，支持播放、暂停、显隐、速度倍率和完整销毁。

**架构：** `src/traffic/trafficRoute.js` 负责 WGS84 路线校验、累计距离和位置采样；`src/traffic/TrafficSystem.js` 负责原生 Model、单一更新监听器和资源生命周期。公开入口从 `src/index.js` 导出。路线与模型地址由调用方提供，不进入 VisualPipeline。

**技术：** 当前 Cesium 1.143，原生 JavaScript，现有 Node 测试与 Playwright。保留当前工作区已有修改，不提交、不切换分支。

- [x] 编写路线行为测试：闭合检查、重复点、匀速距离、循环接缝和朝向；运行确认缺少模块导致失败，然后实现路线模块。
- [x] 编写系统行为测试：冻结的太阳时钟下运动、暂停恢复、显隐、倍率、加载失败回滚和加载中销毁；运行失败后实现模块。
- [x] 导出 `TrafficSystem` / `createTrafficSystem`；添加可配置校园入口、独立免外部资产演示页及原创低面数车辆 GLB。
- [x] 验证新模块测试和全量回归。保持此前 3 项校园断言失败可追踪，不因本功能改写无关预期。
- [x] 构建 SDK，真实浏览器验证移动、闭环、控件、太阳时间保持、原生/CCR、requestRender、显隐和销毁；记录截图与诊断。
- [x] 完成 API 文档，报告已验证范围及真实校园道路、车型和目标硬件性能的验收边界。

**接口约定：** `routes` 是 GeoJSON FeatureCollection，Feature 的 id 唯一，geometry 为闭合 LineString，坐标为 `[经度, 纬度, 高程米]`。`clampToGround: true` 时允许二维坐标并在加载阶段统一贴地；失败不以零高程代替。`vehicles` 的每项包含唯一 id、routeId、url、speed（米/秒）、offset（沿路线距离米），可选 scale、headingOffset（弧度）、heightOffset（米）。支持内存输入或 `manifestUrl`，清单 schemaVersion 为 1，车辆 URL 相对清单解析。

**验证标准：** 距离采样跨帧率一致，闭环首尾无位置跳变；独立时间不写 viewer.clock；隐藏/暂停后恢复无时间补跳；错误与销毁释放自身模型、监听器和等待器；车辆运动通过可选 pipeline.invalidateShadows 同步自定义阴影。首期保留现有遮挡缓存保守失效和 TAA 支持边界，不宣称动态批量实例化或交通规则仿真。
