# 测试目录

长期回归测试与可复用夹具集中在 `rendering/`，不要与一次性运行产物混放。

- `rendering/*.test.mjs`：Node 自动回归，运行 `npm test`；pretest 会生成 vendor 运行时。
- `rendering/*fixture*.js`、`*fixture*.html` 及场景辅助模块：真实浏览器检查所用的合成场景、数值夹具和公用函数。
- `rendering/baselines/`：当前按目标/配置维护的正式 golden，保留在 Git；只允许显式更新，清理缓存时不要删除。
- `scripts/check-*.cjs`：可复用的 GPU、生命周期、性能及 SDK 检查入口。
- `docs/verification/`：本地运行报告目录，默认不入 Git。JSON/Markdown 报告可保留；截图、动图、日志、临时脚本与模型副本按需清理。

常用入口：

```powershell
npm test
npm run build
node scripts/dev-server.cjs --port 8877
# 另一个终端中，CESIUM_PLAYWRIGHT 指向已安装的 Playwright 模块
$env:CCR_TEST_PORT = '8877'
node scripts/check-stage1.cjs
node scripts/check-frame-bridge.cjs
node scripts/check-pipeline-review-fixes.cjs
```

GPU 检查需真实 WebGL 环境。校园实景检查需要自备 `assets/` 数据；默认 Node 回归使用合成夹具，不依赖本机校园私有文件。

2026-09-19 已移除停用的 `rendering/stage1-baseline.json` 和依赖历史 SDK 快照的 `scripts/check-campus-shadow-motion.cjs`。它们仍可从 Git 历史取回。当前阴影检查使用 `check-solar-shadow-motion.cjs`、`check-volume-shadow-filter.cjs` 等长期入口。
