# TAA 建筑高亮滞留与 DOM 弹框抖动

日期：2026-10-20。实际验收页面 `http://127.0.0.1:81/#/campus`，TAA、1264×805、70 个建筑已加载、相机完全静止。

## 根因

1. 静止画面使用 0.003 当前帧基础权重，并在 stableCoverage 下跳过历史颜色裁剪，以保留斑马线等亚像素覆盖。原运动记录只检测矩阵变化，没有识别 Model.color、colorBlendMode、colorBlendAmount 变化。建筑高亮/恢复没有移动几何，因而旧颜色缓慢衰减，转动相机后才明显刷新。
2. 业务 ViewerUtils.pivotDomToMap 在 preRender 监听中读取相机投影。TAA 在更早的 preRender 监听中已应用 Halton 抖动，DOM 跟踪因此每帧跟着偏移。修复前固定相机连续 64 帧，横向范围 0.812 px、纵向 0.778 px。
3. HoverHighlight.releaseAll 原来没有递增异步请求版本或清空待处理位置；业务清空选择后，旧悬停结果仍可能回来。统一复用已有 clearHighlightedPick 处理。

## 修改

- `src/antialiasing/TaaMotion143.js` 在已有 primitive 快照中保存可复用的 Model 颜色与混合参数，识别原地修改和恢复。
- 颜色变化帧复用已有运动纹理和渲染路径，以 previousValid=false 拒绝该模型可见表面的旧 RGB。当前矩阵不变也会提交局部失效；静止道路等其他区域保持原历史。后续颜色稳定的帧不继续写 mask，没有添加历史纹理或全画面重置。
- 不支持精确刚性模型 motion 的命令沿用既有包围体失效路径；本次实测和保证范围是校园独立 GLB 建筑的 Model 颜色变化，不把 feature batch texture、任意自定义材质变化宣称为已经覆盖。
- 业务 `ViewerUtils.js` 的 DOM 锚点定位从 preRender 移到 postUpdate：相机已更新、TAA 尚未应用 raster jitter，避免依赖 postRender 各监听的注册顺序。隐藏、重新绑定、移除时清理同一事件的监听。
- 业务 `hoverHighlight.js` 的 releaseAll 委托 clearHighlightedPick，清空选择同样丢弃迟到的异步结果。

## GPU 输出验证

中心食堂，屏幕采样点 (450,550)，读取 TAA HDR 显示目标的 9×9 ROI 均值。相机不移动、正常颜色帧继续渲染；高亮变化和恢复时不调用 resetHistory。仅在获取独立参考颜色时主动清历史，该动作与实际变化帧分开记录。

| 项目 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 高亮进入首帧相对目标颜色误差¹ | 99.7% | 5.4% |
| 恢复首帧相对目标颜色误差¹ | 100.5% | 9.9% |
| 变化帧的局部 appearanceChanges / draws | 0 / 0 | 5 / 5 |
| 颜色稳定到第 8 帧的额外 motion draws | 0 | 0 |
| 弹框横向/纵向抖动范围（64 帧） | 0.812 / 0.778 px | 0 / 0 px |

¹ RGB 欧氏误差除以原色与参考高亮色之间的 RGB 距离；允许抖动采样和光照带来的微小差别，不是整图感知质量分数。前后各自使用同轮参考，不将跨重载时的亮度差算成修复收益。

修复后进入高亮时 historyAge 从 1804 到 1805、stableCoverage 仍 true，证明没有全局历史重置。仅中心食堂的 5 个部件写入失效信息。恢复同样只产生一次局部更新。

## 实际 UI 验证

使用真实 mouse move → 移出 → mouse click，未用调用业务回调代替鼠标操作：

- 进入后 Model 颜色变为 (0.7098,1,1,1)，appearanceChanges=5；移出后恢复白色，appearanceChanges=5。
- 历史年龄正常递增，模型不透明度保持 1。
- 点击后业务弹框显示“中心食堂”，轮廓 enabled、selected=1。
- 相机 viewMatrix 保持不变；弹框 64 帧 left/top 完全相同；未捕获 pageerror。
- 第一次真实鼠标测试被登录过期提示遮挡，已取消该提示并重测；没有读取或修改凭据。最终证据来自提示关闭后的实际鼠标测试。
- 测试结束已移出鼠标、隐藏弹框、清空选择，并解除探针监听。

## 测试和交付

- CCR 定向测试 43/43：颜色快照、局部失效、无关区域历史保留、运动记录、抖动、TAA 生命周期和轮廓深度。
- 业务定向测试 19/19：异步悬停、清空选择、弹框事件时序/重新定位/释放及已有生命周期测试。
- `npm run build` 成功。CCR.min.js SHA-256：`88924b43cc44f4599a1fa85e98cc46b55008acd3ffbff78d4db1936e810a4762`，与业务 `public/js/CCR.min.js` 一致；页面已实际加载新版，没有重打包业务 dist。

证据：before.json、after.json、summary.json、actual-ui.json、actual-popup.png。数值探针包含同步 GPU 读取，仅用于颜色验证，不用于 FPS/长帧结论。

边界：这次修复和验证的是当前 GLB 建筑 Model 高亮及共用 DOM 锚点方法；未穷举 feature batch texture、自定义动态材质、所有弹框类型或其他 GPU。没有更改静态道路的 TAA 积分权重，也没有以全局重置换取高亮响应。
