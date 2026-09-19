# 工作区清理 · 2026-09-19

范围仅 `cesium customRenderer`，不修改渲染算法，不清理分支或真实资产。

## 已清理

- 删除已停用的单文件基准 `tests/rendering/stage1-baseline.json`，保留 `tests/rendering/baselines/` 中正式基准。
- 删除仅用于历史前后对照、依赖本机旧 SDK 快照的 `scripts/check-campus-shadow-motion.cjs`；长期阴影检查入口继续保留。
- 清理 `docs/verification/` 中生成的日志、帧图、动图、临时探针、模型副本、压缩副本和补丁快照。
- 删除 `build/.generated/` 编译中间文件、过期 `build/CCR-0.1.0.zip` 以及根目录旧单测日志。

本地生成产物共清理 **986 个文件、516,654,049 字节（约 492.72MiB）**，清除 34 个空目录。构建验证会重建 `.generated`；验证完成后再次移除中间文件。

## 保留

- 长期回归测试、数值/GPU 夹具、正式 golden 和可复用检查脚本。
- `docs/verification/` 中 137 份 JSON、8 份 Markdown 报告，以及已入 Git 的整合/审查摘要。生成图像和临时探针已清理；曾纳入版本控制的旧脚本仍可从 Git 历史查阅。
- `build/0.1.0/` 当前 SDK 交付包及 manifest。
- `assets/` 私有数据、依赖目录、编辑器设置、所有本地开发分支。

测试目录与运行产物的用途见 [tests/README.md](../tests/README.md)。当前修复和整合状态仍以 [INTEGRATION_2026-09-18.md](INTEGRATION_2026-09-18.md) 为准；本次清理不将既有未完成功能标为完成。

## 清理后验证

- `npm test`：692/692 通过，0 失败、0 跳过。
- `npm run build`：通过；构建后再次清空中间目录，保留完整 `build/0.1.0/`。
- SDK 仍为 567454 字节，SHA-256 与清理前完全一致：`974dd46c86a8546bd2dea645be88d41452ee575c724acf376bbadcb10a1d5de5`。
- gzip 解压结果与 JS 相同；manifest 的全部源文件哈希一致。
