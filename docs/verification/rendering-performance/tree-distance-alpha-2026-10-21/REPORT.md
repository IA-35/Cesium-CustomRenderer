# 有限距离与叶片 alpha 验证（2026-10-21）

用户指定：业务叶片 1500m / 枝干 2000m，叶片预乘 alpha，cutoff 0.12。

## 实现

- FixedTreeCollection 不再强制 Infinity / minimum ratio 1；透传距离与 near/minimum ratio。
- 外部 GLB 原先在 addGroundAssetRecords 写死 Infinity，现按 MASK 叶片与非 MASK 枝干分别连接距离选项。
- 业务同时对固定点、面撒点传入：叶 max1500 / near600 / min0.35；枝 max2000 / near800 / min0.5。
- GLB MASK 图像预乘解码及上传；ImageBitmap 使用 premultiplyAlpha:true（仅设置 Texture.preMultiplyAlpha 不足以改变 ImageBitmap）。shader 采样后除以 alpha 还原 RGB，再参与 cutout 光照。纹理去重比较包含预乘方式。
- 有纹理叶片 cutoff 上限0.12，保留原本更低的材质阈值；不透明枝干仍为0。

## 自动验证

- 修复前：阈值、有限默认距离、业务距离透传三个用例失败（0.35 != 0.12；Infinity != 6000；Infinity != 1500）。
- 修复后：fixed-tree-collection / ez-tree-integration / tree-lod-selector，21/21通过。
- 业务语法检查及 tests/*.cjs，32/32通过。
- npm run build 成功。build/0.1.0/CCR.min.js 已同步到业务 public/js/CCR.min.js。
- 构建 SHA256：5628e6cf5b25797821b47d281161d20bbdada8f6422cf2f764b6cec9c264dda4。

## WebGL 验证

业务 http://127.0.0.1:81/#/campus 跳转登录页，无法验证实际校园视图或帧率。
使用同页面已加载的 Cesium 1.143.0 / CCR 建立临时独立 Viewer，加载真实 01_cypress.glb，100棵、单批次、无地球和建筑。验证结束销毁 Viewer 与临时 DOM。

读取实际 command.uniformMap，而非仅改 record 属性：

- 枝干：cutoff=0、texture.preMultiplyAlpha=false、u_assetColorPremultiplied=false。
- 叶片：cutoff=0.12、texture.preMultiplyAlpha=true、u_assetColorPremultiplied=true。
- 记录叶 max1500/near600/far1500/min0.35，枝 max2000/near800/far2000/min0.5。

| 相机到批次球面距离 m | 提交枝干实例 | 提交叶片实例 | 提交三角形 |
|---:|---:|---:|---:|
| 220 | 100 | 100 | 980000 |
| 1100 | 88 | 64 | 713600 |
| 1600 | 67 | 0 | 241200 |
| 2100 | 0 | 0 | 0 |

## 限制

有限最大距离之外确实裁除；1500m 外至2000m内可能只剩枝干，枝叶独立抽稀也可能产生裸杆。距离为批次包围球表面距离，并非逐树测距。
预乘仅改善颜色滤波，不改变 mipmap 的 alpha 覆盖率。0.12 阈值真实生效，但未完成实际校园近/中/远视觉验收。
未测实际校园的 p90/p99、>33.3ms/>50ms 长帧比例；不能承诺回收大部分帧率。
未重新构建业务生产 dist，未运行全量 CCR 测试；本次仅运行相关21项与业务32项。
