# 保序绑定去重与树木跨集合纹理共享

日期：2026-10-21。实际验证页面：`http://127.0.0.1:81/#/campus`，1264×805，TAA，建筑、水面、两组实例化树和 60 辆车辆已加载。工作树中的已有改动保留，包括树木集合内部图片去重、叶片 alpha 处理等；本轮在其基础上增加跨集合 GPU 纹理所有权。

## 修改

- RenderItem 用 WeakMap 区分 framebuffer 对象；支持 `command.framebuffer ?? passState.framebuffer`。采集时目标未定则标记 unresolved，不能据此合批。布局描述不再代替目标身份。
- Planner 保留输入顺序，分组包含 source pass、frustum、pass index 和目标身份；不改公共排序器。保留可选扩展描述，不编造未提供的纹理/材质信息。
- Planner 的实际绑定次数及降幅为 null，noRegression 为 not-measured。绑定去重效果由同步提交范围内的真实请求/下发次数确定。
- BindingScope143 在 `scene.updateAndExecuteCommands` 的颜色提交内去重 useProgram/activeTexture/bindTexture；范围覆盖该同步调用内的绘制，不冒称只统计不透明 pass。每个 draw、uniform、framebuffer 和原顺序保留。阴影复用同一实现；嵌套作用域不重复安装；finally 恢复函数；删除纹理/程序使对应缓存失效。此功能通过现有 materialBatchingEnabled 控制，默认开启。
- Dispatcher 将 draw 提交计为 drawCalls，旧 materialBinds 为 null；uniform 计数覆盖标量、向量和矩阵入口。采样脚本和 ledger 保留未采样的 null，避免 Number(null) 转为 0。
- 树木图片使用现有内容哈希及逐字节校验，在同一个 WebGL context 内共享 Texture。MIME 和预乘 alpha 策略隔离，保留该导入器已有固定 sampler、RGBA 和 mipmap 规则。按实际图片记录引用计数，最后一个所有者释放才销毁纹理。
- 建筑已有 SharedGlbTextureCache 继续使用，页面诊断记录 444 张内嵌图片、390 个唯一内容、54 次重复；这些是内容统计，不是本轮新增的 GPU 节省。

## 同实例 A/B/A/B

四轮各预热 90 帧、采样 300 帧。相机固定，车辆暂停，环境动画关闭；测试结束恢复原设置。外层 GL 计数在去重层之后记录实际下发，范围为整个采样帧。context 保持 `37c0660a-546b-43fe-b6c1-e6e6a54c099b`。

| 每 300 帧 | 关闭 | 开启 | 变化 |
|---|---:|---:|---:|
| useProgram | 248100 | 113100 | -54.4% |
| bindTexture | 947400 | 303000 | -68.0% |
| draw 调用 | 247800 | 247800 | 相同 |

两轮调用数量完全重复。关闭 CPU 均值分别 15.726 / 15.020ms；开启 14.866 / 15.445ms。没有稳定明显的 CPU/FPS 提升证据，不把调用下降等同于帧率提升。该场景的总 draw 数没有通过此功能减少。

内部同步作用域单帧计数为 program 811→361、texture 3078→930；它与全帧口径不同，两个降幅不能混用。materialBatchingActive 现在从真实去重结果返回 active=true，表示绑定调用减少，不表示完成几何合并或 atlas。

## 画面和纹理生命周期

TAA HDR 输出全图对照平均绝对差约 7.83e-6。另增加半透明 Model、建筑染色、选中轮廓并强制阴影失效：off→off 平均差 8.69e-6，off→on 1.00e-5，on→on 2.78e-8。异步拾取四次均返回同一建筑，OIT 开启、轮廓 selected=1、TAA motion 未失败，GL 方法恢复原引用。画面存在时间采样，不能将这些结果表述为逐像素完全相等。

两组树合计 28 个图片引用：修复前 26 个 Texture、86682274 字节；修复后 13 个 Texture、43341137 字节，物理纹理分配约 82.7→41.3MiB。通过实际 Texture 对象身份和 sizeInBytes 去重统计，不是整卡 VRAM。

销毁第一组后，13 个共享纹理仍存活，第二组继续提交 56 个 draw；销毁最后一组后全部释放。重新加载恢复 1496 株树，仍为 13 个 Texture、43341137 字节。不同内容、alpha 策略、context 和强制哈希碰撞均有单测。

证据：bindings-ab.json、pixel-parity.json、tree-ownership.json。页面验证后恢复原动画、车流与选中状态，移除临时半透明模型和探针。

## 验证边界

绑定及相关诊断定向测试 94 项通过；纹理共享、现有 GLB 共享及 ez-tree 测试通过。之后补充 unresolved 目标、哈希碰撞、ledger 未采样 null 的测试也通过。SDK 构建成功并同步至业务 public/js/CCR.min.js，业务 dist 未重建。

全量执行时共 1073 项：1069 通过、3 跳过、1 失败。失败为已有 night-transport.test.mjs 对 `ccrCloudLightOpticalDepth(position, moonDirectionAtmo)` 的两参数源码断言；当前距离 LOD 云实现已有第三个 sampleCount 参数，本轮未修改云源码或该断言。最后新增的一个哈希碰撞测试单独验证通过，未再次重复全套测试。

未实施全校园纹理图集或新的几何实例化；本轮资源级优化是跨树木集合的真实纹理共享，继续复用现有树木实例化和车型材质打包。未验证其他 GPU、长时间运行或所有自定义第三方 GL 插件。原生绑定计数减少的收益已证实，GPU 时间与稳定 FPS 收益仍需单独评估。
