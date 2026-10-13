# 校园路网车流规则实施计划

**目标：** 追加跟车、岔路通行、路口让行、死胡同销毁和其他入口安全再生，保留独立时钟与已有循环路线。

**边界：** 图片用于理解后续校园路网形态；不从图片猜测经纬度、道路等级或可通行区域。使用调用方提供的 WGS84 有向车道中心线；每条车道在交叉路口处分段，节点 id 明确拓扑。双向道路需要两条分离的有向车道。首期不主动超车。

**模块与职责：**
- `src/traffic/trafficRoute.js`：保留闭环输入，增加内部 allowOpen 编译/采样能力；开放路线终点不取模。
- `src/traffic/trafficNetwork.js`：将 GeoJSON 有向车道编译为 routes/nodes/successors/spawnRoutes。
- `src/traffic/TrafficSimulation.js`：固定步长运动、跟车约束、路口公平预留、分支选择和安全再生事件；不管理 GPU。
- `src/traffic/TrafficSystem.js`：消费规则事件，真实移除/销毁死胡同车辆模型，异步生成新模型并保护销毁竞态。
- 示例新增可见岔路、交叉口和死胡同；旧循环示例保留可选入口；补充文档和浏览器验证。

**数据：** 清单支持 `network` 替代 `routes`，仍使用 schemaVersion 1。network 为 GeoJSON FeatureCollection，Feature.id 为车道 id，geometry 为 LineString，properties.from/to 为节点 id，spawn 标记入口，priority 为同到达时间的通行优先级，next 可限制允许的下一车道 id。端点坐标必须匹配节点，不自动连接二维线条交叉或反向车道。vehicles 继续用 routeId/speed，增加可选 length/width（米）；省略时默认车长4.5米、车宽1.8米并按scale缩放。

**规则：**
- 同车道按中心距离减去车长得到净距，目标净距包含静止间距2米和约1.2秒车头时距；有限加减速，位移硬约束防止跨越前车。
- 路口先到先行，同到达以 priority/id 决定；仅车道最前车参与请求。出口无空间时停在路口前，不占据路口。
- 只在显式相连的合法出口中分支，排除直接掉头；排队/车辆清尾前保持路口预留。短连接需要足够车长空间，否则报告数据问题。
- 无合法后继表示死胡同；产生 despawn 事件。其他入口有空间且远离离场位置时产生 spawn 事件，模型 ready 后才恢复驾驶。入口满则等待。
- 初始重复位置的车辆等待入场，避免模型重叠。再生加载失败停止该槽位并记录错误，不循环请求失败资产。

**协作 API：** `prepareTrafficNetwork(C, data, options)` 返回 `{routes: Map, nodes: Map, successors: Map, spawnRoutes: routeId[]}`；route 上包含 from/to/priority/closed。`new TrafficSimulation(C, vehicles, network)` 保持 vehicles 引用，设置 state/currentSpeed/generation 等运行字段；`advance(seconds)` 返回 `{type:'despawn'|'spawn', vehicle}` 事件数组；`activate(vehicle)` 将已完成再生加载的 spawning 车辆恢复驾驶；`getDiagnostics()` 返回统计；`destroy()` 释放规则状态。没有 network 时也启用闭环跟车。

- [x] 测试开放车道、节点/转向约束、非法数据、旧闭环兼容。
- [x] 测试快车追慢车、静止前车、循环接缝、固定步长、分支、路口竞争、出口拥堵、入口满和死胡同再生。
- [x] 接入模型销毁/重建，验证异步失败及销毁竞态。
- [x] 更新可见路网演示与数据说明。
- [x] 新测试、全量回归、SDK 构建、源码/UMD 浏览器行为与可见截图验证。
- [x] 独立代码复核，修复重要问题，报告真实校园数据与目标性能的验收边界。
