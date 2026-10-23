# 鼠标悬停拾取与 TAA 闪帧：2026-10-19

已确认管线缺陷：正常 render 之间的 pick / pickPosition 会修改 Scene.frameState.passes；pick 空白还会把默认视图的 frustumCommandsList 改为 0。TAA 在 preRender 中读取这些尚未恢复的状态，影响下一颜色帧的 motion 和 overlay，再导致后续帧丢失历史。

本次未修改生产代码。当前工作区已有用户对阴影、车辆等文件的修改，均保留。测试运行当前 src，复用 taa-r186-fixture.js、Chrome ANGLE D3D11，640×420，固定相机，8 jitter 相位。预热后分别测试 6 种操作，再记录 5 个颜色帧。每组操作前额外运行 64 帧；鼠标仅移动、不按键、不拖拽。

## 实测

| 操作 | 拾取之后 | 下一颜色帧 | 再下一颜色帧 |
|---|---|---|---|
| 无操作 | render=true，1 视锥 | Motion 正常 | 0 个新表面 |
| 仅鼠标移动，无悬停拾取回调 | render=true，1 视锥 | Motion 正常 | 0 个新表面 |
| scene.pick 命中模型 | render=false/pick=true，1 视锥 | Motion 被禁用并 reset | 51 个静止表面被判为 newSurfaces，51 次 motion draw |
| scene.pickPosition 读取模型位置 | render=false，1 视锥 | Motion 被禁用并 reset | 同样误判 51 个新表面 |
| scene.pick 空白 | render=false/pick=true，0 视锥 | Motion 关闭、overlay 关闭 | historyValid=false，historyAge=0；resolve 后 age=1 |
| scene.drillPick 空白 | render=false/pick=true，0 视锥 | 同上 | 同样清历史 |

空白拾取中，原 historyAge=910，第一颜色帧后为 911，第二颜色帧 resolve 入口变成 0。stats.resets 一直为 1：清历史通过直接字段赋值发生，没有经过 resetHistory()，所以只看 resets 会漏报。

模型拾取中全局历史未清空，但运动快照被清空。下一帧 51 个静止表面被当成首次出现，motion.previousEyeDepth 无效，resolve 对这些表面拒绝历史，产生局部闪帧。无需真实物体运动即可触发。

最终画面也确认了闪帧：比较操作前画面与第二颜色帧，亮度差超过 16/255 的像素数，无操作和单纯移动鼠标均为 0；pick 模型为 8845，pick 空白为 8836，pickPosition 为 8603。pick 模型的最大亮度变化为 187.94/255。比较包含正常 jitter 相位差，控制组用于显示该差异本身远小于拾取触发的闪帧。

## 时序与源码

1. Cesium Picking.js:320 的 pickBegin 调用 scene.updateFrameState，随后置 passes.pick=true；pickEnd 只结束 GPU frame，不恢复颜色帧标志。pickPositionWorldCoordinates 在 Picking.js:731 也会调用 updateFrameState。
2. Scene.js:4694 先派发 preRender，之后才调用 render(scene)。render 内 Scene.js:4528–4529 才 updateFrameState 并置 passes.render=true。
3. TaaPass143.js:289 在 preRender 的 _applyJitter 内执行 motion.begin(!this._scopeReason(),...)；此时 _scopeReason 看到的是拾取遗留标志。
4. TaaMotion143.js:75 在 inactive 时执行 reset；reset 清除 records/primitiveKeys 并释放 target。恢复后 snapshot 将现有表面识别为新表面，capture 输出无效历史运动数据。
5. TaaPass143.js:277 使用 scene._view.frustumCommandsList 决定 overlay defer。空白拾取留下 0 视锥，overlay 被关闭。下次颜色视锥恢复为 1 后，278 行直接清除 historyValid/historyAge。

这与此前随 jitter 相位发生的单像素深度拒绝是两个可独立触发的缺陷：本次是拾取污染生命周期判断；前一问题是正常颜色帧内的覆盖变化被误判为显露。

## 修复应落在生命周期边界

- preRender 阶段不应使用拾取遗留的 passes 和 frustumCommandsList 作为本次颜色帧是否可启用 TAA 的依据。使用已确认的颜色帧状态，或将相关准备放到保证颜色帧状态已建立、且尚未提交几何的阶段。
- 保留真正的非颜色 pass 排除逻辑；拾取不能推进或清除颜色帧 motion/history。
- overlay 是否重新启用，不能由拾取区域内命令数量来决定，更不能因空白拾取触发 TAA 冷启动。
- 回归覆盖 pick 模型/空白、pickPosition、drillPick 及间歇 hover；同时断言年龄、运动 newSurfaces、最终连续画面和拾取准确性。单测“能拾取到对象”不足以验证后续颜色帧。

## 证据与复跑

report.json 包含操作前、操作后以及 5 帧的完整记录；PNG 为操作前及后续各颜色帧画面，编号 0 表示第一颜色帧。

从仓库根目录运行：

```powershell
node docs/verification/rendering-performance/traa-r186-2026-10-16/mouse-diagnosis-20261019/diagnose.cjs
```

使用已有本机 Playwright，启动独立浏览器与 8995 静态服务；覆盖本目录诊断结果。所有模式均固定相机，不涉及车辆。

尚未直接接入用户业务页面的 mousemove 回调，因此“用户的鼠标移动具体调用了哪种拾取”仍需业务页面证据；管线对上述拾取操作的错误响应已独立复现。没有实施正式修复或运行全量构建测试。
