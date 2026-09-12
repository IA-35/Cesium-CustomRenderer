# 独立工程审查与 CCR 更名

公开提交准备更新：已移除源码/产物示例中的固定ion token，默认采用免token数据集；校园预览的业务服务地址改为参数输入。本地Git已关联目标仓库，历史验证备份及截图不随代码提交。下文为初次审查时点记录。

2026-09-12。目标目录 `G:/_JavaScript/_IAsCesiumLib/cesium customRenderer`。本目录没有Git元数据，本轮未初始化仓库或提交。原产物备份为`verification/ccr-before-rename.zip`，同步前3个源文件保留在`verification/ccr-before-source/`，旧名称JS移到`verification/legacy-umd/`。

## 已处理

1. **浏览器命名统一为CCR。** 原独立构建实际使用CesiumCustomRenderer，已将构建常量、文件名、UMD示例和文档改成CCR。源码示例也使用CCR模块命名空间并公开window.CCR。实际浏览器确认旧全局名称均不存在。内部shader/UBO标识符及setCampusOrigin没有破坏性改名。
2. **补齐迁移遗漏的兼容修复。** 与当前宿主逐文件比较，源树65文件完整，但VisualPipeline、colorGrading、TaaPass遗漏最近的修补。已同步：关闭增强时保留恒等颜色传递；TAA回退FXAA改在preUpdate应用；主管线不再覆盖TAA拥有的回退状态。都是已有验证修复，不是重新开发算法。测试同步验证“执行中不切换输出目标”。
3. **Node版本声明。** 原根包写>=18，安装的cesium@1.143.0明确要求>=22.0.0。已将package.json及lock根元数据统一到>=22。
4. **UMD/CommonJS边界。** 原目录继承根type=module，require旧UMD得到空导出。现在构建目录自动生成type=commonjs的package.json；实际require CCR.min.js得到33个导出及正确版本。
5. **文档时效。** 原README的“65文件零改动、与当前宿主逐字节一致”不再准确。根README已改为当前独立工程说明，旧说明归档；内部README标注宿主历史路径不是当前可执行命令。

## 当前验证

- 修改前后均在本目录执行npm test：373/373通过。日志`verification/ccr-review-tests-before.log`和`ccr-review-tests.log`。
- npm run build通过，manifest名称CCR，文件CCR.min.js及gzip，Cesium未内嵌，SMAA数据URL内嵌。
- CommonJS直接加载成功，VERSION=0.1.0，CESIUM_VERSION=1.143.0，createVisualPipeline为函数。
- 新增`scripts/check-browser-sdk.cjs`。使用免token官方数据，在本目录服务器验证源码和UMD两条路径：CCR全局、无旧全局、registry、SMAA、TAA、关闭恢复和重新启用全部通过，无页面/渲染错误。UMD源码侧加载0、外部SMAA图片请求0。
- 浏览器证据：`verification/ccr-browser-review.json`、`ccr-source-verified.png`、`ccr-umd-verified.png`。本轮没有验证内置ion token的权限，未以其执行OSM请求。

## 未关闭的审查项

### P2：示例切换存在异步请求竞态

`examples/index.html`和`scripts/rendering-sdk-example.html`的showDataset在await加载后直接添加结果，没有请求序号/取消判定。快速选择两个数据集时，旧请求晚返回可再次加入场景并覆盖tileset引用，导致当前按钮与实际数据不一致、后续只移除其中一份数据。建议添加加载代际标记；过期结果及时destroy。这是代码审查结论，本轮未做故障延迟注入复现，未修改示例的加载逻辑。

### P2：npm产物未包括UMD，且源码/UMD导出并不完全相同

`npm pack --dry-run`确认不含build产物和scripts。当前通过根包导入得到src/index.js，不能把README里的本地build路径当成npm包内容。LightUniforms143、RenderProfiler143和版本常量只在构建时追加，源码入口没有同样导出。若要发布npm双格式包，应先确定exports/files和公开接口。本轮按用户要求交付浏览器CCR，未擅自改变npm发布策略。

### P2：完整GPU回归没有随抽取迁移

原工程的run-*.cjs和GPU fixture不在此目录；本轮只补了基础浏览器加载/启停检查。`373`是当前Node测试数量，不能据此宣称TAA边缘画质、SSR辐射一致性、移动物体、多个视锥和全部释放路径在新工程再次验收。应逐步迁移不依赖业务资源的合成GPU夹具。

### 已处理：示例固定ion token与旧业务服务默认值

提交前已将ion token改为调用方注入；`tests/rendering/preview.html`的模型、影像和周边模型地址改由参数提供。历史备份保留在本地并被Git忽略。

### P2：开发服务器仍有输入与目录重定向边界

`scripts/dev-server.cjs`中的decodeURIComponent没有捕获异常，非法编码路径可能终止进程；已有index.html的目录未带斜杠时，当前分支直接返回文件，相对脚本可能解析到错误父目录。建议加入400响应和目录重定向测试。仅本地开发服务器范围，本轮未修改或进行崩溃注入。

### 既有边界

源码SMAA资源路径依赖当前开发服务器别名，迁移到其他服务器需相同映射或显式部署资源；UMD因内嵌查找表不受此限制。指定校园资产的材质/植被兼容正则仍存在。Cesium固定1.143且使用若干内部适配点，不能按跨版本通用引擎宣传。原项目的完整延迟照明/多光源等未完成项没有因独立抽取而完成。

结论：CCR更名与基础独立运行已验证，可作为当前开发SDK使用；完整发布配置、GPU回归和上述示例/服务器问题仍应继续处理。
