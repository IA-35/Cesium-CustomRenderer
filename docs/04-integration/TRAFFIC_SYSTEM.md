# 独立车流系统

`TrafficSystem` 使用 Cesium 1.143 原生 Model，支持沿闭合路线跟车循环，或按有向路网选择岔路、排队让行，在死胡同销毁后从其他入口重新生成。模块与 VisualPipeline 分开创建，不依赖 Vue，不修改 `viewer.clock`。路径先编译为累计距离，全部车辆共享一个 preUpdate 更新监听器；暂停、隐藏或切到后台时冻结行驶时间。

## 最小接入

```js
import { createTrafficSystem } from './src/index.js'

const traffic = createTrafficSystem({
  Cesium, viewer,
  manifestUrl: '/traffic/traffic.json',
  pipeline // 可选：让 CCR 自定义阴影在车辆移动当帧刷新
})
await traffic.readyPromise
traffic.pause()
traffic.play()
traffic.setSpeed(1.5)
traffic.setVisible(false)
console.log(traffic.getDiagnostics())
traffic.destroy() // 页面离开或校区切换时，先于管线与 Viewer 销毁
```

UMD 对应 `CCR.createTrafficSystem`、`CCR.TrafficSystem`。未提供 pipeline 时可在纯 Cesium Viewer 中运行，由宿主负责自己的阴影刷新策略。也可直接传入 `routes` 或 `network`，连同 `vehicles`，不使用 manifestUrl。浏览器中相对车辆地址按页面解析；清单中的相对地址按清单 URL 解析。Node 中需使用绝对地址。

## 数据契约

```json
{
  "schemaVersion": 1,
  "routes": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "id": "road-loop",
      "properties": {},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [123.42, 41.77, 12],
          [123.421, 41.77, 12],
          [123.421, 41.771, 12],
          [123.42, 41.771, 12],
          [123.42, 41.77, 12]
        ]
      }
    }]
  },
  "vehicles": [{
    "id": "car-1",
    "routeId": "road-loop",
    "url": "./car.glb",
    "speed": 8,
    "scale": 1,
    "heightOffset": 0,
    "headingOffset": 0
  }]
}
```

| 字段 | 含义 |
| --- | --- |
| Feature.id | 唯一、非空字符串；车辆用 routeId 引用 |
| coordinates | WGS84 `[经度, 纬度, 高程米]`，经纬度为度，高程为椭球高 |
| speed | 非负有限数，期望速度米/秒，默认 8；0 表示停放；实际速度受前车和路口限制 |
| offset | 初始沿路线距离，米；省略时同路线车辆均匀分布；负数和超过总长的距离循环归一化 |
| scale | 正数，模型缩放，默认 1 |
| length / width | 正数，车长/车宽，默认 4.5/1.8 米，再乘 scale 得到实际交通占用尺寸；应与 GLB 一致 |
| heightOffset | 相对路线高度的偏移，米，默认 0；用于轮胎底部接触道路 |
| headingOffset | 模型朝向修正，弧度，默认 0 |

路线至少三个不同顶点加闭合终点，首尾 ECEF 距离不超过 1 厘米。重复相邻点被去除；拒绝未闭合、退化、重复 id 或无效坐标，不自动添加穿过建筑的闭合边。位置按相邻点直线插值，车头通过前后各最多 1 米的采样方向平滑；转弯和坡路需要足够密集的路径点。默认按 glTF Y-up / Z-forward 约定加载；其他车头朝向使用 headingOffset 校正。

已有路网若是 EPSG:3857、CGCS2000 或局部 ENU，应在业务数据准备阶段转换到本契约。不可把投影坐标直接当作经纬度。道路模型只有网格时仍需要单独提供行驶中心线。

### 初始化贴地

`clampToGround: true` 允许二维坐标，并在加载模型前调用 `scene.clampToHeightMostDetailed` 采样道路表面。`objectsToExclude` 可排除不应参与采样的场景对象。它采样当前三维场景表面，宿主应先等道路与地面资源就绪；此接口不等价于地形服务采样。采样不支持、位置缺失或高度无效时拒绝加载，不回退到零高程。不在每帧发起贴地请求。

## 有向路网数据与通行规则

清单可用 `network` 替代 `routes`，两者不可同时提供，仍为 schemaVersion 1。network 是 GeoJSON FeatureCollection，每条 LineString 是一条有向行驶车道，至少两个坐标点。Feature.id 为唯一车道 id；properties.from / to 是起终节点 id，同一个节点的端点坐标须在 1 厘米内吻合。图上相交而未共享节点的线不会自动连接，这样可保留桥梁与不同高程道路。

```json
{
  "schemaVersion": 1,
  "network": {
    "type": "FeatureCollection",
    "features": [
      {"type":"Feature","id":"west-in","properties":{"from":"west","to":"junction","spawn":true,"priority":1},"geometry":{"type":"LineString","coordinates":[[123.420,41.770,12],[123.421,41.770,12]]}},
      {"type":"Feature","id":"east-out","properties":{"from":"junction","to":"east-end"},"geometry":{"type":"LineString","coordinates":[[123.421,41.770,12],[123.422,41.770,12]]}},
      {"type":"Feature","id":"north-out","properties":{"from":"junction","to":"north-end"},"geometry":{"type":"LineString","coordinates":[[123.421,41.770,12],[123.421,41.771,12]]}},
      {"type":"Feature","id":"other-in","properties":{"from":"other","to":"north-end","spawn":true},"geometry":{"type":"LineString","coordinates":[[123.423,41.771,12],[123.421,41.771,12]]}}
    ]
  },
  "vehicles": [{"id":"car-1","routeId":"west-in","url":"./car.glb","speed":8,"length":4.3,"width":1.8}]
}
```

| 路网属性 | 约定 |
| --- | --- |
| from / to | 非空节点字符串，声明车道方向和拓扑；双向道路需要两条分离的有向车道 |
| spawn | true 表示可生成车辆的入口；未显式设置时取无入边的源节点车道；全网须至少一个入口，建议多个分散入口 |
| priority | 有限数，默认0；同一到达时间按较大优先级通行，较早到达的请求优先 |
| next | 可选的合法后继车道 id 数组，可限制禁转；省略则取终节点的出边；空数组为尽头 |
| corridor | 可选的共享单通道 id；恰好两条开放反向车道使用同一id，几何点逐个反向匹配；两方向不得同时占用，含加载与车尾离开阶段 |

未获得路口通行权时，如果首选出口受阻，车辆会尝试其他合法后继，并沿用全部间距、路口和出口空间检查；取得通行权后不会临时改变出口。通用共享单通道没有全局交通调度，当所有合法出口均被对向车辆占用时可能形成互锁；本次学校路网按用户要求全部双车道，不启用corridor。

岔路只在合法后继中确定性分配，车辆多次经过时轮换选择；不直接掉头进入刚驶来的反向车道，无合法出口时按死胡同离场。初始 offset 是车道内距离，开放车道不得为负或超过车道长。双向路线的几何位置应分离；不要让相反方向共用一条中心线。单条闭环车道若与开放车道共享节点会被拒绝；环岛或环路需要在每个实际出入口拆分为开放的有向车道，避免绕过路口规则。独立闭环及旧 routes 模式仍支持。

同车道含循环接缝均启用跟车：2 米静止净距、约 1.2 秒车头时距，常规加速度 2 米/秒²、减速度 4 米/秒²；位移另加硬约束，防止低帧率或急停时穿过前车。固定 0.05 秒仿真步长使结果不依赖显示帧率。初始不安全位置的车辆隐藏并等待空位，不强行重叠渲染。

路口仅各入口最前车请求通行，先到先行，同到达时按 priority / id 排序；一次只允许一辆车占用冲突区域，出口无空间时留在入口等待，不堵在交叉点。冲突区域根据车身尺寸与相邻车道几何计算，预留持续到车尾离开冲突范围。短开放连接必须至少达到最大有效车长加 4 米，同时长度必须大于两端计算得到的冲突区域之和；不足时拒绝输入并要求合并连接段。完全重合的双向车道不支持，应先提供实际分离的车道中心线。

到达死胡同后，旧 Model 会从场景移除并真实销毁；再选择与刚离开的尽头不同、且距离场点足够远的入口。入口需要同时满足同车道净距、其他车辆车身不重叠及路口预留约束。没有安全入口时隐藏等待，保留总车辆槽位。加载新模型期间入口已被占用，其他车辆不能占据同一位置；加载就绪后从静止起步。再生加载失败会记录 respawnErrors 并停止该槽位，不循环请求失败资源。

学校路网数据接入前，需要从 CAD/GIS 提供可行驶中心线，确认坐标系、高程、道路方向、交叉口分段、禁转和生成入口。当前图片只作结构参考，不作为坐标或道路连通性依据。

## 控制与生命周期

| 接口 | 行为 |
| --- | --- |
| readyPromise | 所有车辆模型真正 ready 后完成；清单、路径或模型失败时拒绝并回收已附加模型 |
| play() / pause() | 独立车流计时的继续 / 暂停；不改变太阳时间和时间轴 |
| setSpeed(multiplier) | 非负仿真时间倍率；0 冻结车辆规则；各车期望 speed 保持不变 |
| setVisible(boolean) | 控制显隐；隐藏期间不累计行驶距离 |
| getDiagnostics() | 状态、总槽位数、在途/就绪模型数、路线长度、跟车/路口等待/再生状态、累计离场再生数和错误 |
| destroy() | 可重复调用；取消清单请求、等待器和监听器，销毁自身模型，释放路线记录 |

加载最多并发 4 辆；真实模型初始化等待超时为 90 秒。原生 Model 的正在进行的加载不能强制取消，但销毁后或同行车辆失败后才返回的模型会立即释放，不再附加到场景。模块不删除其他场景对象。宿主必须在 Viewer 销毁前调用 destroy。

支持 `requestRenderMode: true`：行驶期间请求连续画面，暂停/隐藏/速度为零后停止主动持续请求。后台可见性变化会重置时间基线，避免返回页面后车辆补跳。

## 示例和校园入口

- 学校路网默认入口：`/examples/traffic.html`；UMD：`?sdk=umd`。使用本次提供的67条道路中心线转换的路网，60辆原创演示车型。原24车合成十字/T字示例用 `?mode=sample`，原闭合跟车示例用 `?mode=loop`。
- 校园集成：`/examples/campus.html` 默认加载学校路网60辆车；`?traffic=none` 关闭，`?traffic=<车流清单URL>` 替换。等待地面、建筑和周边模型就绪后，排除建筑/植被/水面采样道路高程；右侧“道路车流”提供播放、倍率、显隐、近景、全景与高程诊断。
- 运行时校园接入：`await campus.loadTraffic('/traffic/traffic.json')`；实例在 `campus.traffic`。
- 原创示例资产位于 `examples/traffic-assets/`，可用 `node scripts/prepare-traffic-demo.cjs` 重建。示例路线不代表真实校园路网。
- 学校数据、转换报告、精确源文件副本和平面道路预览位于 [examples/campus-traffic/README.md](../../examples/campus-traffic/README.md)。转换脚本 `scripts/prepare-campus-traffic.py` 使用Shapely/GEOS处理交点，运行现有仿真校验后才发布输出；未修改用户原始文件。

## 验证与边界

```sh
node --test tests/rendering/traffic-*.test.mjs
npm run build
node scripts/dev-server.cjs --port 8766
# 按本机位置设置 CESIUM_PLAYWRIGHT，必要时设置 CCR_BROWSER_EXECUTABLE。
node scripts/check-traffic.cjs
node scripts/check-traffic-network.cjs
node scripts/check-traffic-network.cjs --school
```

浏览器检查覆盖源码/UMD、冻结的太阳时间、连续行驶、暂停、倍率、显隐、原生/CCR 切换、车辆拾取、闭环接缝和销毁；结果在 `docs/verification/traffic/`。10/50/100 辆的短帧间隔采样只记录本地演示观察，不表示真实校园或目标设备的性能验收。

当前是一车一个 Model，已包含跟车、路口让行和尽头再生，不包含主动超车、红绿灯、目的地寻路、轮胎动画和动态 GPU 批量实例化。避让基于车道拓扑及给定车长/车宽，不自动识别建筑、行人或任意障碍物。传入 pipeline 时，每次位移会令自定义阴影失效，保证同步，同时增加全场阴影刷新成本。现有遮挡缓存会因移动模型保守失效，TAA 缺少物体速度通道；示例使用 SMAA，真实场景中仍须复测这些影响。本功能没有修改渲染管线或遮挡缓存策略。

### 2026-10-09 初版实测记录（路网扩展前）

- 新模块回归 18/18 通过；包含立即销毁、贴地等待期间销毁及同行模型失败后迟到模型释放。独立复核发现的路线保留竞态已复现并修复，复核通过。
- 全量 741 项，738 通过、3 失败，均为开发前已存在的 campus-business-assets 清单/环境反射配置断言。
- SDK 构建成功，117 个源码哈希与构建清单一致，UMD 导出 TrafficSystem / createTrafficSystem。
- 本机 Chrome 源码及 UMD 演示均通过：24 辆实际 ready，冻结太阳时钟时移动，暂停、倍率、显隐、原生/增强切换、拾取、循环接缝和完整模型/监听器清理。
- RTX 3070 / 1440×900，10/50/100 辆各 60 个帧间隔短测，平均约 16.7 毫秒。采样很短且为合成路线，不构成真实校园或目标设备 60 FPS 验收。
- 校园配置入口在现有地面 Tiles 加示例路线条件下通过，真实校园道路对齐尚未验收。默认 GLB 模式的既有清单文件 `SM_NH_JZXG.glb` 在本地 `/assets/campus-glb-release/` 与原 `http://localhost:8083/DongdaModel_PBR/` 服务均返回 404；未更改这些既有资产或清单。浏览器脚本默认检查地面 Tiles，可用 CCR_TRAFFIC_CAMPUS_URL 指定完整业务场景。

### 2026-10-09 路网规则扩展实测

- 交通相关测试 60/60 通过；独立复核通过，覆盖跟车急停/循环接缝、分支、公平路口让行、出口拥堵、入口满、小夹角合流/分流、尽头再生、模型迟到/失败及销毁。
- 全量 783 项，780 通过、3 失败，仍为原有校园清单/环境反射配置断言，没有新增失败。
- SDK 构建成功，119 个源码哈希与清单一致。源码和 UMD 路网页面分别观察约480个显示帧，同车道净距不低于2米，未检测到车辆矩形占用重叠；两者均观察到11次车道转换及13次旧模型真实销毁/新模型再生。
- 固定步长回归对10车道/24车示例运行120秒模拟，每0.05秒检查车辆占用，未发现重叠并完成多次再生。该结果只针对合成示例和回归输入，不能替代真实学校路网的坐标、拓扑与高密度验收。
- 最终浏览器证据位于 `docs/verification/traffic-network/report.json` 和对应截图；旧循环与校园入口复验仍由 `scripts/check-traffic.cjs` 记录。
- 旧循环源码/UMD 控件、拾取、闭合衔接与清理复验通过；校园地面 Tiles + 示例路网独立冷启动通过。批量规模测试后在同一浏览器进程打开校园页曾出现 assetsReady 等待超时（车流已ready且持续运行、无加载/页面错误）；因此校园检查使用独立冷启动，未把该结果扩展为完整应用长期资源稳定性验收。

### 学校 GeoJSON 接入与统一双车道

用户文件 `G:/BaiduNetdiskDownload/车流路网 (2).json` 含56条中心线、448个点，约14.0公里。源文件及副本SHA-256一致，原文件未修改。按0.01米精度网格处理交点后得到126段/92节点，7条近邻路口短连接归入控制区，最终为118段道路、84个控制节点、236条有向车道和22个生成入口；1条短终端道路标为不驱动，全部源道路都有来源追踪。

按用户最新指令，原始WIDTH不控制道路生成：全部道路统一双车道，每方向3米，总宽6米，60辆演示车。没有提供高程或层级标记，因此这里按同一地面层级和WGS84经纬度处理；校园页会在现有地面资源加载后重新采样道路高程，独立路面预览为平面高程。真实校园模型上的高程对齐仍需地面资源或测量高程；其他单行/禁转规则可继续通过数据补充。

转换脚本使用Shapely2.2.0/GEOS完成交点处理和受约束三角化；Python转换回归6/6通过，交通回归70/70通过，SDK构建通过。全量797项中794通过，3项仍为原有校园配置断言。更新学校路网600秒仿真逐0.05秒检查车身占用；发生几何冲突时车辆退回等待状态并隐藏，避免穿透，60辆车保持槽位。该结果针对当前数据与车辆数，不等同于任意密度的生产交通仿真验收。

默认页面 `/examples/traffic.html` 已使用这份学校数据；`?mode=sample` 和 `?mode=loop` 保留原示例。可在校园页使用 `?traffic=/examples/campus-traffic/traffic.json`，或通过 `campus.loadTraffic()` 加载该清单。详细转换报告在 [examples/campus-traffic/conversion-report.json](../../examples/campus-traffic/conversion-report.json)。

### 2026-10-10 校园场景车流效果

`campus.html` 默认启用学校车流，沿用当前校园的地面高度和70个建筑GLB，不加载独立演示的平面路面。接入适配器位于 `examples/campus-traffic-placement.js`，不改变SDK的严格高度契约。每约10米及全部路口端点采样高程，按128点分批请求。相同路口共享高度；未命中位置优先使用同道路两端有效采样插值，无两端采样时使用邻近有效地面高度，绝不默认为0。取样和补齐结果保存在 `campus.trafficPlacement`，不改原清单。

实际页面 `http://127.0.0.1:8766/examples/campus.html` 验证：70建筑、720树木、2水面与60辆车加载完成，无页面异常或HTTP失败；实际模型矩阵位移、屏幕拾取、暂停、显隐、倍率和近景/全景通过，太阳时钟未被车流推进。2404个采样位置中2280个直接命中，124个未命中，其中83个使用邻近采样，最远约95.6米；这些缺口区域的高度属于估计，不能宣称全网精确贴地。新增4项适配测试通过，全量797项中794通过，3项仍为原有校园配置断言。证据在 `docs/verification/campus-traffic-integration/`。
