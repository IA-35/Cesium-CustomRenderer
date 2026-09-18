// B08：地理高度雾的解析指数积分，以及多视锥透明介质的 T/S 分段合并。
//
// 为什么需要这个模块（见 docs/B08_RECONNAISSANCE.md）：
// 现有 `environmentStages.js` 的 `integrateFog` 是**逐样本数值步进**
// （`FOG_STEPS` 次、步长按距离平方分布），而主计划 B08 要求基础档复用
// 「解析指数积分思想及近零 Taylor 分支」。两者差异不是性能微调：
// 数值步进的结果随步数变化，解析式则给出与步数无关的确定值，
// 后者才能作为验收基准。
//
// 关于出处的一句话必须写清楚：**本仓库没有 Tianjing 源码**（本项目是独立的 CCR SDK）。
// 因此下面的闭式解是按标准指数大气模型**自行推导**的，并用 CPU 数值积分独立对照；
// 措辞上不声称与 Tianjing 实现逐行等价，只声称采用同一数学思想。
//
// 高度语义：`heightFogDensity` 只接受**椭球高度**（米，相对 WGS84 椭球面）。
// 主计划禁止把 ECEF.y 当高度——在赤道 ECEF.y≈0 而实际海拔可能很高，
// 在中纬度 ECEF.y 又远大于海拔。椭球高度必须由大地坐标给出，见
// `ellipsoidalHeightFromCartographic`。

/**
 * 由大地坐标取椭球高度。
 *
 * 这是唯一被接受的「高度」来源：`Cartographic.height` 本身就是相对椭球面的高度。
 * 明确**不**接受 ECEF 分量——`ECEF.y` 与海拔无固定关系。
 */
export function ellipsoidalHeightFromCartographic(cartographic) {
  return cartographic.height
}

/**
 * 由 ECEF 位置与椭球面法线取椭球高度。
 *
 * 用途：从着色器里的 ECEF 位置算真实高度。做法是先取该点的椭球面法线方向，
 * 再求位置在法线上的投影与椭球面在该方向的交点距离之差。
 * 这是椭球高度的定义，不是 `position.y`。
 *
 * `surfaceNormal` 必须是单位向量（Cesium 的 `czm_geodeticSurfaceNormal` 即如此）。
 * `radii` 为椭球三半轴；对 WGS84 与 ECEF 同轴，故用分量比求得交点。
 */
export function ellipsoidalHeightFromEcef(position, surfaceNormal, radii) {
  // 沿法线从地心出发的射线与椭球面交点参数 t：
  //   ((t·n.x)/a)² + ((t·n.y)/b)² + ((t·n.z)/c)² = 1
  const nx = surfaceNormal.x / radii.x
  const ny = surfaceNormal.y / radii.y
  const nz = surfaceNormal.z / radii.z
  const denominator = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (!(denominator > 0)) return 0
  const surfaceDistance = 1 / denominator
  // 位置沿法线的投影长度（法线为单位向量时即为点积）。
  const positionDistance = position.x * surfaceNormal.x + position.y * surfaceNormal.y + position.z * surfaceNormal.z
  return positionDistance - surfaceDistance
}

/**
 * 解析高度雾的**光学深度**积分（不含相位与太阳可见性，那些在合成阶段乘上）。
 *
 * 模型：密度随椭球高度指数衰减
 *     ρ(h) = density0 · exp(-(h - baseHeight) / scaleHeight)
 * 沿直线 p(t) = origin + t·direction（t ∈ [t0, t1]，单位米）积分：
 *     h(t) = origin.z + t·direction.z          （局部 ENU 竖直分量即高度差）
 *     ρ(t) = ρ0 · exp(-(origin.z - baseHeight)/H) · exp(-k·t),  k = direction.z / H
 *     ∫ρ dt = ρ0·exp(-(origin.z-baseHeight)/H) · [exp(-k·t0) - exp(-k·t1)] / k
 *
 * 返回值是**光学深度**（无量纲），透射率 T = exp(-opticalDepth)。
 *
 * `origin`/`direction` 使用局部 ENU 坐标：原点取在地表参考点，
 * `z` 为相对该参考面的椭球高度差，`direction` 为单位向量。
 */
export function heightFogOpticalDepth({
  density0, baseHeight, scaleHeight, originZ, directionZ, start = 0, end
}) {
  if (!(scaleHeight > 0) || !(density0 > 0) || !(end > start)) return 0
  const k = directionZ / scaleHeight
  const base = density0 * Math.exp(-(originZ - baseHeight) / scaleHeight)
  const t0 = start, t1 = end
  const length = t1 - t0
  // 分支必须按 u = k·length（无量纲的「整段光学厚度尺度」）判定，
  // **不能**只按 k 判定。这是一个真实缺陷：k 很小但视线很长时（例如
  // k=1e-4、length=5000，则 u=0.5），级数在 u³ 处截断的误差约 u⁴/120≈5e-4，
  // 与指数式出现 5e-4 量级的分歧——而「k 小」本身并不蕴含「u 小」。
  const u = k * length
  if (Math.abs(u) < NEAR_ZERO_U) {
    // u → 0 时 (exp(-k·t1)-exp(-k·t0))/k 出现 0/0 与灾难性相消。
    // 该区间的级数：∫ = base·exp(-k·t0)·length·(1 - u/2 + u²/6 - u³/24 + ...)
    const series = 1 - u / 2 + (u * u) / 6 - (u * u * u) / 24
    return base * Math.exp(-k * t0) * length * series
  }
  return base * (Math.exp(-k * t0) - Math.exp(-k * t1)) / k
}

/**
 * 近零分支的切换阈值，按**无量纲量 u = k·(t1-t0)** 判定（不是按 k）。
 *
 * 取值依据（两侧误差量级必须都远低于验收门槛）：
 *   * 级数侧（|u| < 1e-3）：截断到 u³ 的误差 ~ u⁴/120 = 8.3e-15；
 *   * 指数侧（|u| ≥ 1e-3）：`exp(-k·t0)-exp(-k·t1)` 的相对相消误差
 *     ~ eps/u ≈ 2.2e-16/1e-3 = 2.2e-13。
 * 两侧都在 1e-13 以下，远优于任何目视或数值验收门槛，且中间留有量级余量。
 * 该阈值与 GLSL 侧必须一致，并有测试锁定（阈值连续性 + CPU 数值积分对照）。
 */
export const NEAR_ZERO_U = 1e-3

/**
 * CPU 数值积分参考：定步长**复合 Simpson 公式**。
 *
 * 这是**独立参考实现**，用来验证上面的闭式解，而不是复用它的代码路径。
 *
 * 为什么用 Simpson 而不是中点法：中点法的误差是 O(n⁻²)。对一条 k=0.005、
 * t∈[0,8000] 的视线，中点法即使 65536 步也只有约 1.5e-8 的相对精度——
 * 这个量级与被验证对象的真实误差同阶，会把「参考不够准」误报成「解析式有问题」
 * （实测中就先出现了这种假阳性）。Simpson 是 O(n⁻⁴)，同样步数下精度高出
 * 十几个数量级，足以作为独立基准。
 */
export function heightFogOpticalDepthReference({
  density0, baseHeight, scaleHeight, originZ, directionZ, start = 0, end, steps = 4096
}) {
  if (!(scaleHeight > 0) || !(density0 > 0) || !(end > start) || !(steps > 0)) return 0
  // Simpson 需要偶数个区间。
  const intervals = steps % 2 === 0 ? steps : steps + 1
  const step = (end - start) / intervals
  const density = t => density0 * Math.exp(-(originZ + directionZ * t - baseHeight) / scaleHeight)
  let sum = density(start) + density(end)
  for (let i = 1; i < intervals; i++) {
    sum += density(start + i * step) * (i % 2 === 0 ? 2 : 4)
  }
  return (sum * step) / 3
}

/**
 * 多视锥透明介质的 T/S 分段合并。
 *
 * 契约（主计划给定）：`T = T1·T2`、`S = S1 + T1·S2`。
 * 语义：段 1 在近处、段 2 在其后，S 是**已累积的散射辐亮度**，T 是透射率。
 * 合并后的散射必须先让段 1 的散射透过的段 2 不再衰减（因此是 `S1 + T1·S2`
 * 而不是 `T2·S1 + S2`），否则近处的雾会被远处的雾错误地再乘一次衰减。
 *
 * **前提**：两段的米制距离区间必须不重叠且有序。
 * 主计划明确警告：不同视锥的非线性 depth 不能直接比较——调用方必须先把
 * 各段统一到 B02 的米制 `eyeDepth`（`MaterialChannels143` 的
 * `depthContract: 'positive=known eye metres; ...'`）再调用本函数。
 * 本函数对区间重叠会显式报错，而不是静默给出错误结果。
 */
export function mergeMediumSegments(near, far, { tolerance = 1e-6 } = {}) {
  if (!near || !far) return near || far || { transmittance: 1, scattering: [0, 0, 0] }
  if (far.start < near.end - tolerance) {
    throw new Error(`medium segments overlap: near ends ${near.end}, far starts ${far.start}`)
  }
  const transmittance = near.transmittance * far.transmittance
  const scattering = [
    near.scattering[0] + near.transmittance * far.scattering[0],
    near.scattering[1] + near.transmittance * far.scattering[1],
    near.scattering[2] + near.transmittance * far.scattering[2]
  ]
  return { transmittance, scattering, start: near.start, end: far.end }
}

/**
 * 沿视线到太阳的累计介质透射率（介质遮挡数据，供 B09 光柱/光斑消费）。
 *
 * 与场景几何无关：只用材质深度/Hi-Z（B02 产出）确定视线终点，
 * **不**依赖 B06 的对象级可见性。这是计划明确的分工。
 *
 * 返回逐通道透射率与标量遮挡率（1 - T），供光柱径向积分使用。
 */
export function sunMediumTransmittance({ density0, baseHeight, scaleHeight, originZ, directionZ, distance }) {
  const opticalDepth = heightFogOpticalDepth({
    density0, baseHeight, scaleHeight, originZ, directionZ, start: 0, end: distance
  })
  const transmittance = Math.exp(-opticalDepth)
  return { opticalDepth, transmittance, occlusion: 1 - transmittance }
}

/**
 * 云空区间判定：沿视线与 [base, top] 的相交区间。
 *
 * 延续 `cloudShell` 契约：区间为空时必须**直接退出**，不做无效 raymarch。
 * 返回 null 表示该视线不与云层相交。命中时返回米制区间，
 * 供调用方与雾段一起按 T/S 合并。
 */
export function cloudInterval({ originZ, directionZ, base, top, maxDistance }) {
  if (!(top > base)) return null
  const limit = Number.isFinite(maxDistance) ? maxDistance : Infinity
  if (Math.abs(directionZ) < 1e-12) {
    // 完全水平：只有起点本身在云层高度带内才有介质，且区间为整个可见距离。
    if (originZ < base || originZ > top) return null
    return limit > 0 && Number.isFinite(limit) ? { start: 0, end: limit } : null
  }
  const a = (base - originZ) / directionZ
  const b = (top - originZ) / directionZ
  const start = Math.max(Math.min(a, b), 0)
  const end = Math.min(Math.max(a, b), limit)
  // 空区间直接退出（主计划要求：云空区间无无效 raymarch 循环）。
  if (!(end > start)) return null
  return { start, end }
}

/** 供 GLSL 侧使用的解析积分实现，与上面的 JS 闭式解**同一公式**。 */
export const heightFogGLSL = `
// 地理高度雾的解析光学深度。originZ 是相对参考面的椭球高度（米），
// directionZ 是单位视线方向的竖直分量。绝不使用 ECEF.y 作为高度。
float ccrHeightFogDepth(float density0, float baseHeight, float scaleHeight,
                        float originZ, float directionZ, float t0, float t1) {
    if (scaleHeight <= 0.0 || density0 <= 0.0 || t1 <= t0) return 0.0;
    float k = directionZ / scaleHeight;
    float base = density0 * exp(-(originZ - baseHeight) / scaleHeight);
    // 按无量纲量 u = k * (t1 - t0) 分支，而不是按 k：k 小并不蕴含 u 小
    // （长视线可以让 u 达到 0.5 量级，此时级数截断误差不可接受）。
    // 阈值与 JS 侧 NEAR_ZERO_U 一致（有测试锁定）。
    float length = t1 - t0;
    float u = k * length;
    if (abs(u) < 1.0e-3) {
        float series = 1.0 - u * 0.5 + u * u / 6.0 - u * u * u / 24.0;
        return base * exp(-k * t0) * length * series;
    }
    return base * (exp(-k * t0) - exp(-k * t1)) / k;
}
`
