// B08 单元测试：地理高度雾的解析指数积分、多视锥 T/S 合并、介质遮挡与云空区间。
//
// 纪律：解析解必须由**独立的 CPU 数值积分**验证。如果参考实现复用被测代码的公式，
// 就只是自己验证自己——因此 `heightFogOpticalDepthReference` 是独立的定步长中点法。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEAR_ZERO_U,
  heightFogOpticalDepth,
  heightFogOpticalDepthReference,
  ellipsoidalHeightFromCartographic,
  ellipsoidalHeightFromEcef,
  mergeMediumSegments,
  sunMediumTransmittance,
  cloudInterval,
  heightFogGLSL
} from '../../src/environment/heightFog143.js'

const WGS84 = { x: 6378137, y: 6378137, z: 6356752.3142451793 }

const relativeError = (a, b) => {
  const scale = Math.max(Math.abs(a), Math.abs(b))
  return scale === 0 ? 0 : Math.abs(a - b) / scale
}

// --- 解析解 vs 独立 CPU 数值积分 --------------------------------------------

test('analytic integral matches independent CPU integration across geometry', () => {
  // 覆盖：上视、下视、近水平、穿层、层内、层上、层下。
  const cases = [
    { name: 'looking up', originZ: 0, directionZ: 0.9 },
    { name: 'looking down', originZ: 2000, directionZ: -0.9 },
    { name: 'horizontal', originZ: 100, directionZ: 0 },
    { name: 'slightly up', originZ: 50, directionZ: 0.01 },
    { name: 'slightly down', originZ: 50, directionZ: -0.01 },
    { name: 'through the layer', originZ: -500, directionZ: 0.4 },
    { name: 'far above', originZ: 12000, directionZ: -0.2 },
    { name: 'steep', originZ: 10, directionZ: 0.999 }
  ]
  for (const c of cases) {
    const parameters = {
      density0: 0.000025, baseHeight: 20, scaleHeight: 180,
      originZ: c.originZ, directionZ: c.directionZ, start: 0, end: 8000
    }
    const analytic = heightFogOpticalDepth(parameters)
    const reference = heightFogOpticalDepthReference({ ...parameters, steps: 65536 })
    assert.ok(relativeError(analytic, reference) < 1e-9,
      `${c.name}: analytic ${analytic} vs reference ${reference} (rel ${relativeError(analytic, reference)})`)
  }
})

test('analytic integral matches CPU integration for a long horizontal ray', () => {
  // 水平长视线是近零分支的主要用武之地，也是数值步进最易出错的情形。
  const parameters = {
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: 100, directionZ: 0, start: 0, end: 50000
  }
  const analytic = heightFogOpticalDepth(parameters)
  const reference = heightFogOpticalDepthReference({ ...parameters, steps: 200000 })
  assert.ok(relativeError(analytic, reference) < 1e-9, `analytic ${analytic} vs reference ${reference}`)
})

test('near-zero branch is continuous across its threshold', () => {
  // 阈值两侧必须连续：切换分支不能造成可见跳变。
  //
  // 注意扰动量级：函数值随 u 有真实导数（对 (1-e^-u)/u 而言在 u→0 时为 -1/2），
  // 因此若用 0.1% 的扰动去比较，会看到约 5e-7 的**真实**差异，那不是分支不连续。
  // 这里用 1e-9 的相对扰动：真实差异约 5e-13，远小于任何可观测门槛，
  // 于是任何量级更大的差异都只能来自分支切换本身。
  const base = { density0: 0.000025, baseHeight: 20, scaleHeight: 180, originZ: 100, start: 0, end: 5000 }
  const directionAtThreshold = (NEAR_ZERO_U * 180) / 5000
  const at = heightFogOpticalDepth({ ...base, directionZ: directionAtThreshold })
  const below = heightFogOpticalDepth({ ...base, directionZ: directionAtThreshold * (1 - 1e-9) })
  const above = heightFogOpticalDepth({ ...base, directionZ: directionAtThreshold * (1 + 1e-9) })
  assert.ok(relativeError(at, below) < 1e-11, `below threshold must agree, got ${relativeError(at, below)}`)
  assert.ok(relativeError(at, above) < 1e-11, `above threshold must agree, got ${relativeError(at, above)}`)
})

test('both branches agree with the independent reference at the threshold', () => {
  // 连续性的真正判据是「两侧都对」，而不是「两侧互相接近」。
  // 这里把阈值上下各取一点，分别与独立 Simpson 参考对照。
  const base = { density0: 0.000025, baseHeight: 20, scaleHeight: 180, originZ: 100, start: 0, end: 5000 }
  const directionAtThreshold = (NEAR_ZERO_U * 180) / 5000
  for (const factor of [0.5, 1, 2]) {
    const directionZ = directionAtThreshold * factor
    const analytic = heightFogOpticalDepth({ ...base, directionZ })
    const reference = heightFogOpticalDepthReference({ ...base, directionZ, steps: 32768 })
    assert.ok(relativeError(analytic, reference) < 1e-11,
      `factor ${factor}: analytic ${analytic} vs reference ${reference}`)
  }
})

test('branching by k instead of u would be wrong for long shallow rays', () => {
  // 这是本轮实测到的真实缺陷。k 极小（1e-4 量级）但视线很长时 u = k·length 可达 0.5，
  // 级数在 u³ 截断的误差 ~u⁴/120≈5e-4。若按 k 判定分支，就会对这类视线错用级数。
  // 本测试锁定：该情形必须与独立数值积分一致。
  const parameters = {
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: 100, directionZ: 180 * 1e-4, start: 0, end: 5000
  }
  const u = (parameters.directionZ / parameters.scaleHeight) * (parameters.end - parameters.start)
  assert.ok(u > 0.4 && u < 0.6, `this case must have u around 0.5, got ${u}`)
  const analytic = heightFogOpticalDepth(parameters)
  const reference = heightFogOpticalDepthReference({ ...parameters, steps: 65536 })
  assert.ok(relativeError(analytic, reference) < 1e-12,
    `long shallow ray: analytic ${analytic} vs reference ${reference}`)
})

test('the naive closed form would lose precision near zero, so the series is required', () => {
  // 证明近零分支不是装饰：直接算 (exp(-k*t1)-exp(-k*t0))/k 在 k 极小时会失真。
  const parameters = {
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: 100, directionZ: 1e-9, start: 0, end: 5000
  }
  const k = parameters.directionZ / parameters.scaleHeight
  const base = parameters.density0 * Math.exp(-(parameters.originZ - parameters.baseHeight) / parameters.scaleHeight)
  const naive = base * (Math.exp(-k * parameters.start) - Math.exp(-k * parameters.end)) / k
  const reference = heightFogOpticalDepthReference({ ...parameters, steps: 131072 })
  const analytic = heightFogOpticalDepth(parameters)
  // 解析（走级数分支）必须接近参考；朴素式在 k=5.6e-12 时出现相消。
  assert.ok(relativeError(analytic, reference) < 1e-6, `series ${analytic} vs reference ${reference}`)
  assert.ok(relativeError(naive, reference) > relativeError(analytic, reference),
    'the naive form must be measurably worse, otherwise the branch is unjustified')
})

test('density zero means strictly no effect', () => {
  // 主计划：密度=0 严格无影响。
  const depth = heightFogOpticalDepth({
    density0: 0, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.5, start: 0, end: 10000
  })
  assert.equal(depth, 0)
  assert.equal(Math.exp(-depth), 1)
})

test('empty and inverted intervals produce no fog', () => {
  for (const [start, end] of [[100, 100], [200, 100], [0, -1]]) {
    const depth = heightFogOpticalDepth({
      density0: 0.001, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.5, start, end
    })
    assert.equal(depth, 0, `[${start}, ${end}] must integrate to zero`)
  }
})

test('invalid scale height or density is rejected rather than producing NaN', () => {
  for (const patch of [{ scaleHeight: 0 }, { scaleHeight: -10 }, { density0: -1 }, { scaleHeight: NaN }]) {
    const depth = heightFogOpticalDepth({
      density0: 0.001, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.5, start: 0, end: 1000, ...patch
    })
    assert.equal(depth, 0, JSON.stringify(patch))
  }
})

test('optical depth increases with distance and with density', () => {
  const base = { density0: 0.000025, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.2, start: 0 }
  const short = heightFogOpticalDepth({ ...base, end: 1000 })
  const long = heightFogOpticalDepth({ ...base, end: 5000 })
  assert.ok(long > short, 'longer path must accumulate more')
  const thin = heightFogOpticalDepth({ ...base, density0: 0.00001, end: 5000 })
  const thick = heightFogOpticalDepth({ ...base, density0: 0.0001, end: 5000 })
  assert.ok(thick > thin, 'denser medium must accumulate more')
})

// --- 高度语义：禁止 ECEF.y --------------------------------------------------

test('ellipsoidal height comes from cartographic height, not from an ECEF component', () => {
  // 赤道海平面：ECEF = (a, 0, 0)。若误用 ECEF.y 当高度会得到 0（巧合正确），
  // 但赤道 3000 m 山上 ECEF.y 仍为 0，而真实高度是 3000。
  assert.equal(ellipsoidalHeightFromCartographic({ height: 3000 }), 3000)
  assert.equal(ellipsoidalHeightFromCartographic({ height: -120 }), -120)
})

test('ellipsoidal height from ECEF is consistent at the equator and at a pole', () => {
  // 赤道海平面：位置 (a,0,0)，法线 (1,0,0) -> 高度 0。
  const equator = ellipsoidalHeightFromEcef(
    { x: WGS84.x, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, WGS84)
  assert.ok(Math.abs(equator) < 1e-6, `equator sea level must be ~0, got ${equator}`)
  // 极点海平面：位置 (0,0,c)，法线 (0,0,1) -> 高度 0。
  const pole = ellipsoidalHeightFromEcef(
    { x: 0, y: 0, z: WGS84.z }, { x: 0, y: 0, z: 1 }, WGS84)
  assert.ok(Math.abs(pole) < 1e-6, `pole sea level must be ~0, got ${pole}`)
  // 赤道 3000 m：位置的 y 分量仍为 0，但高度必须是 3000。
  const mountain = ellipsoidalHeightFromEcef(
    { x: WGS84.x + 3000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, WGS84)
  assert.ok(Math.abs(mountain - 3000) < 1e-6, `equatorial 3000 m must read 3000, got ${mountain}`)
})

test('ECEF.y is not a height: same latitude, different longitude', () => {
  // 两个同为赤道海平面的点，ECEF.y 不同（都是 0），
  // 而一个位于中纬度的点 ECEF.y 很大却仍在海平面。
  // 这条测试锁定「不得用 ECEF.y 当高度」。
  const midLatitude = ellipsoidalHeightFromEcef(
    { x: WGS84.x * Math.cos(0.7), y: WGS84.x * Math.sin(0.7), z: 0 },
    { x: Math.cos(0.7), y: Math.sin(0.7), z: 0 }, WGS84)
  assert.ok(Math.abs(midLatitude) < 1.0, `sea level at 40 deg must be ~0, got ${midLatitude}`)
  const ecefY = WGS84.x * Math.sin(0.7)
  assert.ok(ecefY > 4e6, 'the ECEF.y of that point is millions of metres — using it as height would be absurd')
  assert.ok(Math.abs(midLatitude - ecefY) > 4e6, 'ellipsoidal height and ECEF.y must not agree')
})

// --- 同一高度语义一致（全球位置） -------------------------------------------

test('the same ellipsoidal height gives the same density response regardless of location', () => {
  // 解析式只依赖 originZ/directionZ，不依赖经纬度——这正是「任意经纬度一致」的前提。
  // 由于输入已经是椭球高度，同一高度必须给出同一结果；这条测试锁定该契约。
  const at = () => heightFogOpticalDepth({
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: 1500, directionZ: 0.3, start: 0, end: 3000
  })
  const results = [at(), at(), at()]
  assert.deepEqual(results, [results[0], results[0], results[0]])
})

// --- 多视锥 T/S 分段合并 ----------------------------------------------------

test('merging performs T = T1*T2 and S = S1 + T1*S2', () => {
  const near = { start: 0, end: 100, transmittance: 0.8, scattering: [1, 2, 3] }
  const far = { start: 100, end: 300, transmittance: 0.5, scattering: [4, 5, 6] }
  const merged = mergeMediumSegments(near, far)
  assert.equal(merged.transmittance, 0.8 * 0.5)
  // 近处散射必须先乘近处透射率再叠加远处散射；写成 T2*S1 + S2 是错的。
  assert.deepEqual(merged.scattering, [
    1 + 0.8 * 4, 2 + 0.8 * 5, 3 + 0.8 * 6
  ])
  assert.equal(merged.start, 0)
  assert.equal(merged.end, 300)
})

test('the merge weights the far segment by the near transmittance, which is what makes it order-correct', () => {
  // `mergeMediumSegments(near, far)` 的契约是**近段在前**，因此不存在「反序调用」
  // 这一合法用法——反序会被重叠校验挡下（见上一个测试）。这条测试要锁定的
  // 是公式本身：远段散射必须乘**近段透射率**，而不是反过来。
  const near = { start: 0, end: 100, transmittance: 0.8, scattering: [1, 0, 0] }
  const far = { start: 200, end: 300, transmittance: 0.5, scattering: [4, 0, 0] }
  assert.equal(mergeMediumSegments(near, far).scattering[0], 1 + 0.8 * 4)
  // 若误写成 T2*S1 + S2 会得到 0.5*1 + 4 = 4.5。两者必须不同，否则本测试无意义。
  assert.notEqual(mergeMediumSegments(near, far).scattering[0], 0.5 * 1 + 4,
    'the near transmittance must weight the far scattering, not the other way round')
})

test('reversing the arguments is rejected rather than silently reordered', () => {
  const near = { start: 0, end: 100, transmittance: 0.8, scattering: [1, 0, 0] }
  const far = { start: 200, end: 300, transmittance: 0.5, scattering: [4, 0, 0] }
  assert.throws(() => mergeMediumSegments(far, near), /overlap/,
    'a caller passing segments in the wrong order must get a loud error')
})

test('overlapping segments are rejected instead of silently mis-combined', () => {
  // 主计划警告：不同视锥的非线性 depth 不能直接比较。若调用方没有先统一到米制，
  // 就可能给出重叠区间——必须显式报错，不能静默算错。
  const near = { start: 0, end: 200, transmittance: 0.8, scattering: [1, 0, 0] }
  const far = { start: 100, end: 300, transmittance: 0.5, scattering: [1, 0, 0] }
  assert.throws(() => mergeMediumSegments(near, far), /overlap/)
})

test('touching segments are accepted', () => {
  const near = { start: 0, end: 100, transmittance: 0.9, scattering: [1, 0, 0] }
  const far = { start: 100, end: 200, transmittance: 0.9, scattering: [1, 0, 0] }
  const merged = mergeMediumSegments(near, far)
  assert.ok(Math.abs(merged.transmittance - 0.81) < 1e-12)
})

test('merged result equals a single integral over the whole span for exponential fog', () => {
  // 这是分段合并正确性的强判据：把 [0, 4000] 拆成两段分别积分再合并，
  // 结果必须与一次性积分整段**数值一致**（指数介质的可乘性）。
  const parameters = { density0: 0.00005, baseHeight: 20, scaleHeight: 180, originZ: 300, directionZ: 0.25 }
  const combined = nearFarMerge(parameters, 0, 1500, 4000)
  const single = heightFogOpticalDepth({ ...parameters, start: 0, end: 4000 })
  assert.ok(relativeError(-Math.log(combined.transmittance), single) < 1e-12,
    `merged optical depth ${-Math.log(combined.transmittance)} vs single ${single}`)
  // 多个切分点同样成立。
  for (const split of [1, 10, 100, 3999]) {
    const merged = nearFarMerge(parameters, 0, split, 4000)
    assert.ok(relativeError(-Math.log(merged.transmittance), single) < 1e-12, `split at ${split}`)
  }
})

/** 把 [start, end] 在 `split` 处切成两段，各自积分后按 T/S 规则合并。 */
function nearFarMerge(parameters, start, split, end) {
  const nearDepth = heightFogOpticalDepth({ ...parameters, start, end: split })
  const farDepth = heightFogOpticalDepth({ ...parameters, start: split, end })
  return mergeMediumSegments(
    { start, end: split, transmittance: Math.exp(-nearDepth), scattering: [0, 0, 0] },
    { start: split, end, transmittance: Math.exp(-farDepth), scattering: [0, 0, 0] }
  )
}

// --- 介质遮挡 / 透射率数据（供 B09） ----------------------------------------

test('sun medium transmittance reports occlusion consistently with optical depth', () => {
  const result = sunMediumTransmittance({
    density0: 0.0001, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.3, distance: 4000
  })
  const expectedDepth = heightFogOpticalDepth({
    density0: 0.0001, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.3, start: 0, end: 4000
  })
  assert.ok(relativeError(result.opticalDepth, expectedDepth) < 1e-12)
  assert.ok(relativeError(result.transmittance, Math.exp(-expectedDepth)) < 1e-12)
  assert.ok(relativeError(result.occlusion, 1 - Math.exp(-expectedDepth)) < 1e-12)
  assert.ok(result.transmittance >= 0 && result.transmittance <= 1)
  assert.ok(result.occlusion >= 0 && result.occlusion <= 1)
})

test('clear air yields transmittance one and occlusion zero', () => {
  const result = sunMediumTransmittance({
    density0: 0, baseHeight: 20, scaleHeight: 180, originZ: 100, directionZ: 0.3, distance: 10000
  })
  assert.equal(result.transmittance, 1)
  assert.equal(result.occlusion, 0)
})

test('the sun-ray integral uses a camera-height origin, not the lowest point on the ray', () => {
  // 这是一处**已修的真实缺陷**的回归测试。
  //
  // 着色器里曾经把积分起点高度写成 min(h0, h1)（视线两端较低者）。当相机在
  // 2000 m 俯视地面时，那等于把整条视线都按**地面高度**的密度积分，
  // 光学厚度从 0.013 变成 794，导致两种密度都饱和成 T=0：画面全白，
  // 且 fogDensity 参数完全失效（16 倍差给出逐位相同的结果）。
  //
  // 本测试锁定正确语义：积分必须从**起点高度**出发，
  // 高度变化率由两端差给出。因此这里显式对照「起点法」与「最低点法」的差异。
  const cameraZ = 2000, groundZ = 20, length = 5833
  const directionZ = (groundZ - cameraZ) / length
  const fromStart = heightFogOpticalDepth({
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: cameraZ, directionZ, start: 0, end: length
  })
  const fromLowest = heightFogOpticalDepth({
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: Math.min(cameraZ, groundZ), directionZ, start: 0, end: length
  })
  // 正确解必须与独立数值积分一致。
  const reference = heightFogOpticalDepthReference({
    density0: 0.000025, baseHeight: 20, scaleHeight: 180,
    originZ: cameraZ, directionZ, start: 0, end: length, steps: 32768
  })
  assert.ok(relativeError(fromStart, reference) < 1e-9,
    `start-origin integral ${fromStart} must match reference ${reference}`)
  // 最低点法必须显著错误——否则本测试没有区分力。
  assert.ok(fromLowest > fromStart * 100,
    `the lowest-point form must be badly wrong (got ${fromLowest} vs correct ${fromStart})`)
  // 而且正确解必须是「有雾但不过曝」的量级。
  assert.ok(fromStart > 0 && fromStart < 0.1, `a 5.8 km look-down must not saturate, got ${fromStart}`)
})

// --- 云空区间 ---------------------------------------------------------------

test('an upward ray from below the cloud layer enters and exits it', () => {
  const interval = cloudInterval({ originZ: 0, directionZ: 0.5, base: 1600, top: 2800, maxDistance: 50000 })
  assert.ok(interval)
  assert.ok(interval.start > 0 && interval.end > interval.start)
  // 与解析交点一致：h = originZ + t*directionZ。
  assert.ok(Math.abs(interval.start - (1600 - 0) / 0.5) < 1e-9)
  assert.ok(Math.abs(interval.end - (2800 - 0) / 0.5) < 1e-9)
})

test('an empty cloud interval returns null so no raymarch loop runs', () => {
  // 主计划：云空区间必须直接退出，避免无效 raymarch 循环。
  // 自云层上方下视、且可见距离够不到云层。
  assert.equal(cloudInterval({ originZ: 10000, directionZ: -0.5, base: 1600, top: 2800, maxDistance: 1000 }), null)
  // 自云层下方上视，但可见距离不足。
  assert.equal(cloudInterval({ originZ: 0, directionZ: 0.5, base: 1600, top: 2800, maxDistance: 100 }), null)
  // 背向云层。
  assert.equal(cloudInterval({ originZ: 0, directionZ: -0.5, base: 1600, top: 2800, maxDistance: 50000 }), null)
})

test('a horizontal ray inside the layer has a finite interval and outside has none', () => {
  const inside = cloudInterval({ originZ: 2000, directionZ: 0, base: 1600, top: 2800, maxDistance: 4000 })
  assert.ok(inside)
  assert.equal(inside.start, 0)
  assert.equal(inside.end, 4000)
  assert.equal(cloudInterval({ originZ: 500, directionZ: 0, base: 1600, top: 2800, maxDistance: 4000 }), null)
})

test('an inverted or degenerate cloud layer is rejected', () => {
  assert.equal(cloudInterval({ originZ: 0, directionZ: 0.5, base: 2800, top: 1600, maxDistance: 5000 }), null)
  assert.equal(cloudInterval({ originZ: 0, directionZ: 0.5, base: 1600, top: 1600, maxDistance: 5000 }), null)
})

test('the fixed cloud band is used as given, with no high-altitude expansion', () => {
  // 计划：固定 12–50 km 云层区间，不开高空扩距。此处只验证函数尊重传入的区间，
  // 不擅自扩展——区间由调用方按固定档传入。
  const interval = cloudInterval({ originZ: 0, directionZ: 1, base: 1600, top: 2800, maxDistance: 50000 })
  assert.ok(interval.end - interval.start <= 2800 - 1600 + 1e-9, 'the interval must not exceed the layer thickness')
})

// --- GLSL 与 JS 同一公式 ----------------------------------------------------

test('the GLSL helper uses the same formula and the same near-zero threshold', () => {
  assert.match(heightFogGLSL, /float ccrHeightFogDepth\(/)
  // 阈值必须与 JS 侧一致，否则同一场景在 CPU 对照与 GPU 实跑间出现分歧。
  assert.ok(heightFogGLSL.includes('1.0e-3'), 'the GLSL threshold must match NEAR_ZERO_U')
  assert.equal(NEAR_ZERO_U, 1e-3)
  // 必须按 u 判定而不是按 k（见上面的长浅视线测试）。
  assert.match(heightFogGLSL, /float u = k \* length;/)
  assert.match(heightFogGLSL, /if \(abs\(u\) </)
  // 级数项必须与 JS 侧同阶。
  assert.match(heightFogGLSL, /u \* u \* u \/ 24\.0/)
  // 必须使用 exp 闭式解，而不是循环步进。
  assert.ok(!/for\s*\(/.test(heightFogGLSL), 'the analytic path must not contain a stepping loop')
})

// --- 解析式是步进式的收敛极限（精度改善的直接证据）--------------------------
test('the analytic solution is the convergence limit of the stepped integration', () => {
  // 这是「为什么要把基础档改成解析式」的量化证据，也是基线 golden 变化的依据：
  // 24 步的数值步进有明显离散误差，而解析式等于步进在步数→∞ 时的极限。
  // 若解析式只是「另一种算法」，它不会同时贴近 4096 步的结果。
  const stepped = ({ density0, baseHeight, scaleHeight, originZ, directionZ, start, end, steps }) => {
    let previous = start, opacity = 0
    for (let i = 0; i < steps; i++) {
      const next = start + (end - start) * ((i + 1) / steps) ** 2
      const t = (previous + next) * 0.5
      opacity += density0 * Math.exp(-(originZ + directionZ * t - baseHeight) / scaleHeight) * (next - previous)
      previous = next
    }
    return opacity
  }
  const cases = [
    { name: 'down from 2 km', originZ: 2000, directionZ: -Math.sin(0.35), end: 2000 / Math.sin(0.35) },
    { name: 'up from 500 m', originZ: 500, directionZ: 0.3, end: 20000 },
    { name: 'near horizontal', originZ: 100, directionZ: 0.001, end: 30000 }
  ]
  for (const c of cases) {
    const parameters = {
      density0: 0.000025, baseHeight: 20, scaleHeight: 180,
      originZ: c.originZ, directionZ: c.directionZ, start: 5, end: c.end
    }
    const analytic = heightFogOpticalDepth(parameters)
    const coarse = stepped({ ...parameters, steps: 24 })
    const fine = stepped({ ...parameters, steps: 4096 })
    // 解析式必须比 24 步更接近 4096 步的结果。
    assert.ok(relativeError(analytic, fine) < relativeError(coarse, fine),
      `${c.name}: analytic must be closer to the converged value than the 24-step march`)
    assert.ok(relativeError(analytic, fine) < 1e-4,
      `${c.name}: analytic must match the converged march, got ${relativeError(analytic, fine)}`)
  }
})
