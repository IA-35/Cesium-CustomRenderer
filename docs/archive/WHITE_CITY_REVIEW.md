# 城市白模与 SSR 过渡

## 2026-09-15：新增井冈山白模 3D Tiles

示例新增的 `assets/井冈山建筑物_tiles/tileset.json` 在瓦片加载时，通过限定Cesium 1.143的示例适配器调整无贴图PBR材质：roughness 0.22、metallic 0，保留原白色、建筑ID和数据文件。示例的适配器位于 `examples/white-tiles-material.js`，修改解码后的材质并重建绘制命令，不修改原始b3dm。

SSR材质捕获允许原生批次ID/CPUStyling路径，但只对feature.color严格为白色的片元启用；有实际业务改色的片元保留原生效果。颜色检查在原生CPUStyling阶段执行，避免改变ModelFS结构或引用另一个函数的局部变量。

已显式开启viewer.shadows与tileset.shadows，沿用示例的native阴影模式；环境参考原点移到新增瓦片集中心。加载操作放在pipeline和调试句柄创建之后，避免异步结果访问未初始化对象。新增瓦片句柄为whiteCity.tileset。

验证：385项Node测试通过、构建通过；真实3D Tiles视图中154,834个有效接收像素、2,277个SSR命中，阴影pass有21条命令。临时全局红色样式使有效接收像素为0，恢复后回到154,834；无渲染错误。证据为 `docs/verification/white-tiles-review.json` 和 `white-tiles-pbr.png`，复验脚本 `scripts/check-white-tiles.cjs`。这是指定本地资产的检查，不代表所有3D Tiles材质均支持。

2026-09-14。依据用户指定 Tianjing examples/scene2.html / scene2.js 的日间白模、HDR Bloom、SSR与CubeMap组合；不包括夜间扫描条纹效果。原参考场景使用在线OSM，当前本地示例使用参考工程 city-set-draco.glb 的材质衍生副本，不是同一城市资产的逐像素复刻。

## 实现

- 新增 examples/white-city.html/js：完整街区模型，非金属白色PBR（建筑roughness 0.22）、原生环境反射、HBAO、HDR Bloom、SSR、SMAA。提供SSR/Bloom开关、曝光、Bloom强度、近景和全景。模型改色只在副本中完成；不自动覆盖宿主白模材质。
- SSR新增 reflectionHitConfidence：屏幕边缘、命中擦边角度、极短投影射线、预算耗尽前平滑降低置信度。命中后仍按confidence替换原生镜面项，失效时保留原生IBL。
- resolve置信度上限受中心射线约束。之前中心将失效时，周围强命中可能让最终反射仍明显，下一帧中心失效后整块退出；新GPU回归先复现该问题再通过修复。
- 不从邻域复活未知/被挡射线，不加无运动向量的历史缓存。遮挡、反射信息离开屏幕等情况仍有SSR本质边界；环境回退并不能提供正确的屏幕外建筑倒影。未宣称任意相机轨迹完全无突变。

## 验证与产物

`npm test`：384项通过；`npm run build`通过。
`scripts/check-white-city.cjs`：SSR数值回归22项、置信度过渡5项通过；连续18个相机角度都存在SSR命中，整圈8个方位运行有效，最终画面SSR开关像素对比确认有贡献，页面/渲染错误0。证据 `docs/verification/white-city-review.json` 与 `white-city-final.png`。

运行 `node scripts/dev-server.cjs --port 8877`，访问 `http://127.0.0.1:8877/examples/white-city.html`。
本地城市副本可通过 scripts/prepare-white-city.cjs 重建；资产不嵌入SDK。

最新 CCR.min.js 293,552字节，gzip 100,521字节；SHA256 `569df2949e04af58528cd6eabae6266a07e806a0c0c7f2937c0229104080decf`。尚未提交或推送。
