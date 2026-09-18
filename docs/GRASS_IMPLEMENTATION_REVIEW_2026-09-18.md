# 程序化草地实现审查与修复

审查对象：`assets/草地面.json`、`scripts/prepare-grass-polygons.cjs`、`src/instances/GrassCollection.js`、`examples/campus.js` 和对应测试。

## 结论

原实现会让页面长时间无响应，并在恢复后进入 90 秒超时。问题来自实例预算、场景贴地、缺失资产和错误 ready 条件的叠加；并非 GeoJSON 文件损坏。

## 高风险问题及处理

1. 原默认密度为 `1.4/㎡`，14.0402 公顷数据触发 120,000 实例上限，是 ez-tree 默认 `450/公顷` 的约 31 倍。314 个面在主线程同步拒绝采样，随后还会创建 12 万个对象。修复为 `0.045/㎡`、最多 10,000；当前生成 6,329 簇。
2. 原实现为 120,000 点建立世界坐标并一次调用 `scene.clampToHeightMostDetailed`，会阻塞页面并触发大量瓦片查询。按用户要求取消贴地，统一使用局部 ENU 高度 3。
3. 运行时请求 `/assets/grass/eztree/models/grass.glb`，原目录缺少该文件。预处理脚本现在从固定的 cesium-ez-tree 资源复制草模型。
4. ready 条件错误要求 `cachedCommandCount > 0`。初始全景距草地超过 900 米时，没有可见命令，资源虽已完成仍必然超时。现在只以 GLB 解析完成、纹理任务归零为 ready。
5. 原测试使用同步 stub、少量实例并预置 `cachedCommandCount=1`，没有覆盖真实规模、缺失文件、禁止贴地和镜头外 ready。新增了固定高度、上游密度、禁止 clamp、资源文件和镜头外 ready 回归测试。
6. `setDensity` 实际修改的是最大可见距离，命名与行为不符。已更名为 `setMaximumDistance`。
7. 初版示例只在 `?grass=1` 时加载草地，导致直接打开 `examples/campus.html` 看不到结果。现改为默认启用，`?grass=none` 作为显式关闭入口；浏览器验收使用无 `grass` 参数的默认地址。

## 运行结果

- 输入：314 个 Polygon、6,898 个顶点、14.0402 公顷。
- 输出：6,329 个草簇、137 个空间批次、1 个 EzTreePrimitive。
- 固定高度：3；`groundClamped=false`，`groundFallbacks=0`。
- 近景实际提交：2,359 个实例、36 次绘制、约 13,608 个三角形。
- 草地显隐差：476,136 像素（53.43%）；隔离画面绿色像素 310,479。
- 页面错误、控制台错误、HTTP 错误均为 0。

验证入口：`scripts/check-campus-grass.cjs`。证据位于忽略目录 `docs/verification/campus-grass/`。

## 当前边界

- 固定高度 3 是业务规则，不跟随局部地形起伏；部分面若与校园地面高程不一致，会出现埋入或浮起。
- 当前密度按“草簇”计算，不代表单根草叶。需要更密观感时应优先放大草簇覆盖或改地表材质，避免重新回到十万级实例。
- 草地使用 ez-tree 前向植被着色器，不属于完整 PBR/MRT 材质通道。
- 全量测试当前 678 项中 675 通过。两项失败为既有校园示例仍断言旧服务端口/SSE；一项为现有 TAA 相机交互断言。草地专项 8 项和浏览器验收通过，未修改这些无关模块来掩盖失败。
