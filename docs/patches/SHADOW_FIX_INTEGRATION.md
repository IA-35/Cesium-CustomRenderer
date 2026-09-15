# 阴影修复合入主开发

用户在“修复模型三角阴影”会话中明确要求：将阴影修复合并到“cesium可视化渲染管线交接1”的主开发。日期：2026-09-09。

两个会话当前共享 `C:/Users/Administrator/.openclaw/workspace/dongdakeshihua/ruoyi-ui` 工作目录和 `codex/cesium-visual-pipeline` 分支。改动已经在同一工作区，不需要跨分支 cherry-pick 或再次复制覆盖；本次未创建 Git 提交。

## 纳入的修复

1. 白墙平铺三角自阴影：PCF各采样点按接收面深度梯度补偿，并对齐实际NEAREST纹素中心。用户已明确验收。
2. 阴影边缘锯齿/色带：保留上述补偿，改用带纹素内双线性插值的3×3 tent核，以4×4共16次唯一深度采样实现连续过渡。用户要求将该轮结果一起纳入主开发。

生产改动在 `src/rendering/cesium/shadows/shaderAdapter143.js`，阴影文档在同目录README。`tests/rendering/shadow-plane-fixture.html` 包含8项自阴影用例和2项边缘连续性用例；`shadow-fixture.html?shadowChecks=1` 可运行既有11项GPU阴影检查及蒙皮回归。

## 验证与边界

本会话最近验证：100/100 Node测试、10项平面/边缘GPU测试、11项既有阴影GPU检查及蒙皮动画均通过；生产构建退出码0，392项Cesium资源哈希通过。主会话继续修改代码时，须以其最终集成结果重新验证，不将本清单当作未来代码的通过证明。

详情：
- [三角自阴影修复](evidence/12-shadow-acne-validation.md)
- [阴影边缘修复](evidence/13-shadow-edge-validation.md)
- [GPU数值](evidence/13-shadow-edge-gpu-results.json)

保留主开发现有环境、调色、SMAA/MSAA和业务修改。没有改模型资产、默认阴影覆盖范围或贴图尺寸。采样从9次增加到16次，未做本轮60秒正式性能验收；不宣称PCSS、完整业务回归或性能门槛通过。`plan/`仍为本地忽略目录。

## 交接时文件指纹（SHA-256）

`shadow-fixture.html`含主开发先前的其他测试入口，以整个文件当前内容记录指纹；不要用旧副本覆盖。

| 文件 | SHA-256 |
| --- | --- |
| `src/rendering/cesium/shadows/shaderAdapter143.js` | `9ef475a7eb918d1c0058d56bd90ae2518656719edddace1c15f5423bbcf628c0` |
| `src/rendering/cesium/shadows/README.md` | `e3ac016b0b02c2370393bb3faa69deacd9e5f5d69a0bdbb9c0d455fbb5d655cc` |
| `tests/rendering/shadow-plane-fixture.html` | `f1943e857e6e673f611561b6ec85e632d7ee5b6c7ac38f21989754211cfe64b2` |
| `tests/rendering/shadow-fixture.html` | `5df485155bd98e22a3d99e9f62cd3047226aedb9a0d20a6f39e8b599fee11dcb` |
