# cesium-ez-tree 校园接入结果

2026-09-18：按用户要求停止自建多 Model 植被集合；用户随后允许用 ez-tree 程序化树替代 GLB，校园默认已采用程序化 Pine。

## 当前实现

- 原仓库：https://github.com/Xiaobai-grow/cesium-ez-tree，固定提交 `cbea56e4550f9b3ef9cbc96424abbdcde9ac7eb2`，源文件、MIT LICENSE、NOTICE 保存在 `vendor/cesium-ez-tree/`。
- 实际使用上游 EzTreePrimitive / EzTreeGenerator / EzTreeInstanceAttributes：共享几何、20 字节量化实例、空间单元、视锥剔除、命令缓存、分帧上传预算及释放。源码适配列表见 `vendor/cesium-ez-tree/CCR_PATCHES.md`，没有打包第二套 Cesium。
- 删除了上一轮自行拼装 instanced glTF / Blob URL / 132 个 Cesium Model 的路径。FixedTreeCollection 仅负责业务点位与上游 primitive 适配。
- 720 个采集点位，3 个类型；地面使用场景采样，失败明确报错。默认一个 primitive、84 个 80 米空间批次、六组共享几何；树干/叶片的实例保留比例均为 1，不为提速删点。
- 三种不同 seed 的 Pine 预设，按已有树高缩放。减少枝条径向/纵向细分与叶片数量，同时增大叶片卡片以保留树冠。使用上游 pine 树皮，叶片由其程序化遮罩生成，颜色为绿色。
- 默认程序化树为一个轻量几何档，不冒充四级 GLB LOD。`treeSource=glb` 仅用于对照；该路径仍有偏暗叶片与较高网格成本，未作为默认合格展示。
- 上游深度/颜色保留相同 Alpha cutout；增加 CCR 阴影投射与接收适配、主视图外树木的光照视锥补选。风暂关闭。
- 程序化材质为上游前向植被光照，不是完整 Model PBR/MRT，不能宣称已纳入延迟材质或 SSR 材质接收面。

## 复现

```powershell
npm run build
node scripts/dev-server.cjs --port 8878
```

直接打开 `http://127.0.0.1:8878/examples/campus.html` 即默认加载程序化树与草地；`?trees=none` 可关闭树木，`?treeSource=glb` 仅用于 GLB 对照。
示例沿用业务服务 `http://localhost:8083/Dongda`，`SM_NH_Shu` 保持用户禁用状态。

`npm run build` / `npm test` 自动构建以 Cesium 1.143 为外部依赖的 ez-tree 工厂。程序化运行时只取 `assets/vegetation/manifest.json`、`points.json` 和 `eztree/bark/pine_color_1k.jpg`；不请求树 GLB。

## 验证证据

`scripts/check-campus-trees.cjs`：真实校园的显隐像素差、隔离树木颜色、阴影 caster 差分和页面错误检查。测试把地面、校园、天空隐藏，只在灰背景上检查绿色树冠，避免背景绿色冒充叶片颜色。

一次结果：720 点位，0 贴地回退，6 组几何；近景显隐差 54,076 像素（4.17%），隔离画面绿色像素 146,891、亮灰像素 623；阴影 caster 显示 721、隐藏 553；无页面或 HTTP 错误。

`scripts/check-tree-performance.cjs <phase>`：固定 1912×956、相同时间/镜头/CCR 参数，启用/隐藏/再启用树木，每次预热 30 帧、采样 180 帧。

| 同机位观测 | 旧多 Model GLB | ez-tree GLB 对照 | ez-tree 程序化默认 |
| --- | ---: | ---: | ---: |
| 树木 Model 数 | 132 | 0 | 0 |
| 树木 primitive 数 | 132 Model | 1 | 1 |
| 整帧 GPU 中位数，两次启用 | 14.15 / 14.43 ms | 13.77 / 13.45 ms | 13.46 / 12.53 ms |
| 同机位主视图提交三角形 | 旧诊断未统计 | 2,440,435 | 704,632 |
| 集合几何/实例缓冲 | 旧诊断未统计 | 8.36 MB | 0.65 MB |
| 集合纹理估算 | 旧诊断未统计 | 67.11 MB | 5.59 MB |

三角形下降约 71%，缓冲下降约 92%，纹理下降约 92%，这三个比例比较的是 ez-tree GLB 与程序化两条路径。总 GPU 耗时较旧多 Model 路径仅下降约 5–13%；不能把几何压缩比例当帧率提升比例。帧间隔多数仍接近 16.7 ms；仅为 headless Chrome 同条件对照，不是用户实际前台 FPS 保证，尚未复现所有最差树冠近景/运动路径。

截图与 JSON 位于忽略目录 `docs/verification/ez-tree/`、`docs/verification/campus-trees/`。

## 已知边界

- 全量测试 669 项中 667 通过，两条校园资产断言仍期待旧端口 9528、旧 SSE 128；实际示例为 8083、32，且旧树层已被用户禁用。未修改这些业务配置以迎合旧测试。
- 当前数据规模验证为 720 株；未宣称 5k/10k 压测已通过。
- 原 GLB 和 FBX 保留。GLB 叶片白灰与高光问题不再通过“把树干改棕”宣称已修复；当前通过的是程序化替代方案。
