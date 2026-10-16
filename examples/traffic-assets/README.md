# 车流演示资产

本目录的三款低面数车辆、地面和双向闭合路线由 `scripts/prepare-traffic-demo.cjs` 原创生成，以 CC0 提供，可替换为业务车型。

路线只是算法与渲染演示，不代表真实校园道路。车辆长 4.3 米、宽 1.8 米；glTF 使用 Y-up / Z-forward。24 辆车各有不同期望速度，范围为 6–10.6 米/秒（21.6–38.2 公里/小时）；速度顺序打散且每次加载保持一致。车辆会根据前车和路口情况减速让行，面板倍率统一调整仿真时间。

默认 `network.json` 包含十字和 T 字路口、10 条有向车道、6 个节点及4个入口；车辆到达无合法后继的尽头时销毁，在其他安全入口重新生成。`network-ground.glb` 是这张路网的演示路面。原 `traffic.json` 与 `ground.glb` 保留为双向闭合跟车路线，使用 `?mode=loop` 查看。

重新生成：`node scripts/prepare-traffic-demo.cjs`；只更新路网示例用 `--network-only`。查看：`/examples/traffic.html`。独立模块使用方式见 `docs/04-integration/TRAFFIC_SYSTEM.md`。
