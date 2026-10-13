# 学校车流路网

本目录由用户提供的 `G:/BaiduNetdiskDownload/车流路网.json` 转换得到。原文件只读，`source.geojson` 是内容完全一致的副本。

- 67条道路中心线、512个坐标点，约15.3公里。
- 相交分段与短路口归并后：97个控制节点、143段可行驶道路、286条有向车道、20个生成入口。
- 按用户最新要求，所有143段道路统一为双车道，每方向一条3米车道，总宽6米；原始WIDTH不参与车道或路面生成，不使用单通道交替通行。
- 12条不足20米、连接相邻路口的短连接归入同一控制区。连接路径沿原道路到达选定路口节点，不用直线穿过空地。源道路全部保留显示，没有删除短尽头。
- 初始60辆车，期望速度各不相同，保留跟车、路口让行和死胡同销毁再生。

输入没有声明CRS、单行规则、桥梁层级或高程。这里按WGS84经纬度、地面交点连通解释，并统一双向双车道。`roads.glb` 提供原道路中心线位置、统一6米宽的平面预览，不代表真实校园模型贴地结果；其他实际交通规则需由业务数据补充。

`traffic.json` 可直接用于 `CCR.createTrafficSystem({Cesium, viewer, pipeline, manifestUrl})`。`conversion-report.json` 保存源文件哈希、每一步计数、短连接索引与验证结果；车辆地址相对本目录指向原创演示车型。

重新转换需要 Python、Shapely2.2.0、Node.js及本项目依赖：

```sh
python -m pip install -r scripts/campus-traffic-requirements.txt
python scripts/prepare-campus-traffic.py "G:/BaiduNetdiskDownload/车流路网.json"
```

脚本先写临时输出，运行现有路网与仿真校验器后再替换结果；校验失败保留上次有效输出。Windows下若静态服务器仍持有已中断请求的文件句柄，需先停止本示例服务器，完成转换后再启动。

默认查看 `/examples/traffic.html`；原合成岔路用 `?mode=sample`，原循环用 `?mode=loop`。点击“查看全校路网”或“近看车流”切换观察距离。
