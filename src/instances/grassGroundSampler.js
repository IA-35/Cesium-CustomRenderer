// Grid ground sampling for grass roots.
//
// Why: sampling the ground once per polygon puts a whole lawn on one plane, so
// clumps float or sink wherever the surveyed ground slopes. Sampling every clump
// is far too slow (scene.sampleHeight renders a pick frustum per call), so the
// ground is sampled on a coarse grid and each root is bilinearly interpolated.
//
// Pitfall: scene.sampleHeight returns the first surface hit from above, which can
// be a tree canopy or a lamp post. A plane is fitted to the samples and the
// sample furthest above it is dropped and the plane refitted, until every
// remaining sample is close to the plane. A plane (not a median) is used so that
// genuinely sloped lawns keep their slope. Dropped/missing corners use the plane.

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0))

// Least-squares plane z = a + b*x + c*y; falls back to the mean height when the
// points are collinear.
function fitPlane(points) {
  const n = points.length
  let sx = 0, sy = 0, sz = 0
  for (const p of points) { sx += p.x; sy += p.y; sz += p.z }
  const mx = sx / n, my = sy / n, mz = sz / n
  let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz
    xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz
  }
  const det = xx * yy - xy * xy
  if (Math.abs(det) < 1e-9) return { at: () => mz }
  const b = (xz * yy - yz * xy) / det
  const c = (yz * xx - xz * xy) / det
  return { at: (x, y) => mz + b * (x - mx) + c * (y - my) }
}

// Drops the worst outlier one at a time, never more than half of the samples.
function robustPlane(points, maximumRise, maximumDrop) {
  let inliers = points
  let plane = fitPlane(inliers)
  const minimumKept = Math.max(3, Math.ceil(points.length / 2))
  while (inliers.length > minimumKept) {
    let worst = -1
    let worstExcess = 0
    inliers.forEach((p, index) => {
      const residual = p.z - plane.at(p.x, p.y)
      const excess = residual > 0 ? residual - maximumRise : -residual - maximumDrop
      if (excess > worstExcess) { worstExcess = excess; worst = index }
    })
    if (worst < 0) break
    inliers = inliers.filter((_, index) => index !== worst)
    plane = fitPlane(inliers)
  }
  return { plane, inliers: new Set(inliers) }
}

/**
 * Samples a polygon's ground on a grid and writes interpolated root heights.
 *
 * @param {object} options
 * @param {object} options.C Cesium namespace.
 * @param {object} options.scene Cesium scene (sampleHeight must be supported).
 * @param {object} options.modelMatrix Local ENU -> world matrix.
 * @param {object} options.inverseModelMatrix World -> local ENU matrix.
 * @param {object[]} options.instances Grass instances with local translations (mutated: z is written).
 * @param {number} options.spacing Grid spacing in metres.
 * @param {number} options.sampleBudget Remaining sampleHeight calls allowed.
 * @param {object[]} [options.objectsToExclude] Primitives ignored by sampleHeight.
 * @param {number} [options.rootOffset=0.02] Lift above the sampled surface, metres.
 * @param {number} [options.maximumRise=0.8] Samples higher than median+this are obstacles.
 * @param {number} [options.maximumDrop=4] Samples lower than median-this are holes.
 * @param {() => boolean} [options.isCancelled] Stops sampling early.
 * @returns {Promise<{samples: number, fallback: boolean}>} fallback=true when nothing usable was sampled.
 */
export async function sampleGrassGroundGrid(options) {
  const { C, scene, modelMatrix, inverseModelMatrix, instances } = options
  const rootOffset = options.rootOffset ?? 0.02
  const maximumRise = options.maximumRise ?? 0.8
  const maximumDrop = options.maximumDrop ?? 4
  const isCancelled = options.isCancelled || (() => false)
  if (!instances.length) return { samples: 0, fallback: true }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const instance of instances) {
    const { x, y } = instance.translation
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  // Widen the grid when the polygon would exceed the remaining budget.
  let spacing = Math.max(1, options.spacing)
  const cornerCount = s => (Math.floor((maxX - minX) / s) + 2) * (Math.floor((maxY - minY) / s) + 2)
  while (cornerCount(spacing) > options.sampleBudget && spacing < 512) spacing *= 1.5
  if (cornerCount(spacing) > options.sampleBudget) return { samples: 0, fallback: true }

  // Only corners touched by an instance are sampled; lawns are often thin strips.
  const needed = new Set()
  const cellOf = instance => [
    Math.floor((instance.translation.x - minX) / spacing),
    Math.floor((instance.translation.y - minY) / spacing),
  ]
  for (const instance of instances) {
    const [i, j] = cellOf(instance)
    needed.add(`${i},${j}`).add(`${i + 1},${j}`).add(`${i},${j + 1}`).add(`${i + 1},${j + 1}`)
  }

  const heights = new Map()
  const local = new C.Cartesian3()
  const world = new C.Cartesian3()
  const cartographic = new C.Cartographic()
  let samples = 0
  for (const key of needed) {
    if (isCancelled()) return { samples, fallback: true }
    const [i, j] = key.split(',').map(Number)
    local.x = minX + i * spacing
    local.y = minY + j * spacing
    local.z = 0
    C.Matrix4.multiplyByPoint(modelMatrix, local, world)
    C.Cartographic.fromCartesian(world, C.Ellipsoid.WGS84, cartographic)
    const sampled = scene.sampleHeight(cartographic, options.objectsToExclude)
    samples++
    if (Number.isFinite(sampled)) {
      cartographic.height = sampled + rootOffset
      C.Cartographic.toCartesian(cartographic, C.Ellipsoid.WGS84, world)
      heights.set(key, C.Matrix4.multiplyByPoint(inverseModelMatrix, world, local).z)
    }
    if (samples % 48 === 0) await yieldToBrowser()
  }

  if (!heights.size) return { samples, fallback: true }
  const points = [...heights].map(([key, z]) => {
    const [i, j] = key.split(',').map(Number)
    return { key, x: i * spacing, y: j * spacing, z }
  })
  const { plane, inliers } = robustPlane(points, maximumRise, maximumDrop)
  const kept = new Map([...inliers].map(p => [p.key, p.z]))
  const heightAt = key => {
    if (kept.has(key)) return kept.get(key)
    const [i, j] = key.split(',').map(Number)
    return plane.at(i * spacing, j * spacing)
  }

  for (const instance of instances) {
    const [i, j] = cellOf(instance)
    const tx = (instance.translation.x - minX) / spacing - i
    const ty = (instance.translation.y - minY) / spacing - j
    const bottom = heightAt(`${i},${j}`) * (1 - tx) + heightAt(`${i + 1},${j}`) * tx
    const top = heightAt(`${i},${j + 1}`) * (1 - tx) + heightAt(`${i + 1},${j + 1}`) * tx
    instance.translation.z = bottom * (1 - ty) + top * ty
  }
  return { samples, fallback: false }
}
