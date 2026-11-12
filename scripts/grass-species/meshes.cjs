// Procedural meshes for the grass species, authored in glTF Y-up metres with the
// patch centre on the ground at the origin.
//
// Why individual blades instead of photo cards: a card holding a picture of a
// whole clump only looks right from the side. Seen from above, three cards around
// a triangle show up as a triangle outline. Scattered, leaning blades have no
// dominant silhouette from any angle.
//
// Why arc-length curves: a blade bent by moving its tip sideways stretches and
// shows hard folds at the few segment joints. Real blades keep their length and
// curve progressively more toward the tip, so the centreline is integrated from a
// bend angle that grows along the blade, then sampled with enough segments.
const { createRandom, ATLAS_REGIONS } = require('./atlas.cjs')

const UP = [0, 1, 0]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = a => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / length, a[1] / length, a[2] / length]
}
const horizontal = angle => [Math.cos(angle), 0, Math.sin(angle)]
const angleOf = vector => Math.atan2(vector[2], vector[0])
const range = (random, [min, max], power = 1) => min + (max - min) * Math.pow(random(), power)

// How far the edge normals tilt away from the face normal. A grass blade is
// folded along its midrib, so light falls off across its width instead of the
// whole ribbon shading as one flat plastic strip.
const MIDRIB_FOLD = 0.45
const INTEGRATION_STEPS = 8

class MeshBuilder {
  constructor() {
    this.positions = []
    this.normals = []
    this.uvs = []
    this.indices = []
  }

  /**
   * Adds a strip along a centreline (base first). The UV rectangle's top edge
   * (rect[1]) maps to the last point, i.e. the tip.
   * @param {number[][]} centreline Points from base to tip.
   * @param {number[]|number[][]} widthDirections One unit vector, or one per point (twist).
   * @param {number[]} widths Full width per point.
   * @param {number[]} rect [uLeft, vTop, uRight, vBottom]
   */
  addStrip(centreline, widthDirections, widths, rect) {
    const first = this.positions.length / 3
    const last = centreline.length - 1
    const directionAt = i => (Array.isArray(widthDirections[0]) ? widthDirections[i] : widthDirections)
    centreline.forEach((point, i) => {
      const widthDirection = directionAt(i)
      const tangent = sub(centreline[Math.min(i + 1, last)], centreline[Math.max(i - 1, 0)])
      const face = normalize(cross(widthDirection, tangent))
      const half = scale(widthDirection, widths[i] / 2)
      const v = rect[3] + (rect[1] - rect[3]) * (i / last)
      for (const [side, u] of [[-1, rect[0]], [1, rect[2]]]) {
        this.positions.push(...add(point, scale(half, side)))
        this.normals.push(...normalize(add(face, scale(widthDirection, side * MIDRIB_FOLD))))
        this.uvs.push(u, v)
      }
    })
    for (let i = 0; i < last; i++) {
      const a = first + i * 2
      this.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  build() {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint16Array(this.indices),
    }
  }
}

/**
 * Integrates a centreline of constant length whose angle from vertical goes from
 * `startAngle` to `startAngle + bend` with curvature concentrated toward the tip.
 * Angles past 90 degrees make the tip droop below its highest point.
 */
function curvedCentreline({ base, leanDirection, length, startAngle = 0, bend, segments, exponent = 1.6, minimumHeight = 0 }) {
  const points = [base]
  const steps = segments * INTEGRATION_STEPS
  const ds = length / steps
  let point = base
  for (let i = 1; i <= steps; i++) {
    const s = (i - 0.5) / steps
    const angle = startAngle + bend * Math.pow(s, exponent)
    point = add(add(point, scale(UP, Math.cos(angle) * ds)), scale(leanDirection, Math.sin(angle) * ds))
    if (point[1] < minimumHeight) point = [point[0], minimumHeight, point[2]]
    if (i % INTEGRATION_STEPS === 0) points.push(point)
  }
  return points
}

// Width direction per point, rotating gradually about the vertical: blades twist.
const twistedDirections = (baseAngle, twist, count) =>
  Array.from({ length: count }, (_, i) => horizontal(baseAngle + twist * Math.pow(i / (count - 1), 1.3)))

// A blade bending over its flat face toward `leanDirection`, like real grass.
function addBlade(builder, random, { base, length, width, bend, leanDirection, segments }) {
  const centreline = curvedCentreline({ base, leanDirection, length, startAngle: bend * 0.08, bend, segments, minimumHeight: 0.003 })
  const widthAngle = angleOf(leanDirection) + Math.PI / 2 + (random() - 0.5) * 0.5
  const directions = twistedDirections(widthAngle, (random() - 0.5) * 0.9, centreline.length)
  const rect = ATLAS_REGIONS.blades[Math.floor(random() * ATLAS_REGIONS.blades.length)]
  builder.addStrip(centreline, directions, centreline.map(() => width), rect)
}

function scatteredBlades(seed, options) {
  return scatteredBladesInto(new MeshBuilder(), createRandom(seed), options).build()
}

function scatteredBladesInto(builder, random, { count, radius, length, width, bend, segments }) {
  for (let i = 0; i < count; i++) {
    const r = radius * Math.sqrt(random())
    const angle = random() * Math.PI * 2
    const outward = horizontal(angle)
    const jitter = horizontal(random() * Math.PI * 2)
    addBlade(builder, random, {
      base: [r * outward[0], 0, r * outward[2]],
      length: range(random, length, 1.3),
      width: range(random, width),
      bend: range(random, bend),
      leanDirection: normalize(add(scale(outward, 0.7), scale(jitter, 0.8))),
      segments,
    })
  }
  return builder
}

// Fine lawn grass: small tuft cards (each a fan of ~11 blades) at random angles
// over a ~0.55 m patch, plus a few loose blades. Many small cards give lawn-like
// blade density with no large card whose outline could show from above.
function createLawnPatch() {
  const random = createRandom(101)
  const builder = new MeshBuilder()
  for (let i = 0; i < 18; i++) {
    const r = 0.27 * Math.sqrt(random())
    const angle = random() * Math.PI * 2
    const facing = random() * Math.PI * 2
    // Cards bend over their face so a top-down view sees blades, not card edges.
    const centreline = curvedCentreline({
      base: [r * Math.cos(angle), 0, r * Math.sin(angle)],
      leanDirection: horizontal(facing + Math.PI / 2 + (random() - 0.5) * 0.6),
      length: range(random, [0.12, 0.22], 1.2),
      startAngle: 0.05,
      bend: range(random, [0.35, 1.05]),
      segments: 3,
      minimumHeight: 0.003,
    })
    const width = range(random, [0.14, 0.22])
    // Constant width on purpose: a card that narrows toward the root makes each
    // segment a trapezoid, and per-triangle UV interpolation then kinks the
    // diagonal blades of the fan texture into zigzags. The fan shape is in the texture.
    const directions = twistedDirections(facing, (random() - 0.5) * 0.3, centreline.length)
    builder.addStrip(centreline, directions, centreline.map(() => width), ATLAS_REGIONS.tuft)
  }
  return scatteredBladesInto(builder, random, {
    count: 2, radius: 0.27, length: [0.13, 0.24], width: [0.012, 0.018], bend: [0.5, 1.3], segments: 4,
  }).build()
}

// Coarse unmown grass: narrow, long blades that arch over and droop at the tip.
const createTallPatch = () => scatteredBlades(202, {
  count: 12, radius: 0.16, length: [0.24, 0.44], width: [0.014, 0.022], bend: [0.7, 2.4], segments: 5,
})

// Plantain/dandelion rosette: leaves rise from one crown and arch back to the ground.
function createBroadleafRosette() {
  const random = createRandom(303)
  const builder = new MeshBuilder()
  const leaf = (angle, length, width, elevation, droop) => {
    const direction = horizontal(angle)
    const centreline = curvedCentreline({
      base: [direction[0] * 0.008, 0.004, direction[2] * 0.008],
      leanDirection: direction,
      length,
      startAngle: Math.PI / 2 - elevation,
      bend: droop,
      segments: 3,
      exponent: 1.2,
      minimumHeight: 0.004,
    })
    const directions = twistedDirections(angle + Math.PI / 2, (random() - 0.5) * 0.4, centreline.length)
    builder.addStrip(centreline, directions, centreline.map(() => width), ATLAS_REGIONS.broadleaf)
  }
  const outer = 7
  for (let i = 0; i < outer; i++) {
    leaf((i / outer) * Math.PI * 2 + (random() - 0.5) * 0.5, range(random, [0.1, 0.16]), range(random, [0.055, 0.075]),
      range(random, [0.35, 0.75]), range(random, [0.4, 0.8]))
  }
  for (let i = 0; i < 2; i++) leaf(random() * Math.PI * 2, range(random, [0.06, 0.08]), 0.04, 1.0, 0.5)
  return builder.build()
}

// Clover: trifoliate leaves on short stems, leaflets held nearly flat.
function createCloverCluster() {
  const random = createRandom(404)
  const builder = new MeshBuilder()
  for (let i = 0; i < 9; i++) {
    const r = 0.14 * Math.sqrt(random())
    const angle = random() * Math.PI * 2
    const node = [r * Math.cos(angle), 0.03 + random() * 0.06, r * Math.sin(angle)]
    builder.addStrip([[node[0], 0, node[2]], node], horizontal(random() * Math.PI), [0.006, 0.006], ATLAS_REGIONS.blades[0])
    const turn = random() * Math.PI * 2
    const size = 0.036 + random() * 0.01
    for (let k = 0; k < 3; k++) {
      const direction = horizontal(turn + (k * Math.PI * 2) / 3)
      const tilt = 0.1 + random() * 0.25
      const tip = add(add(node, scale(direction, size * Math.cos(tilt))), scale(UP, size * Math.sin(tilt)))
      builder.addStrip([node, tip], horizontal(turn + (k * Math.PI * 2) / 3 + Math.PI / 2), [size, size], ATLAS_REGIONS.clover)
    }
  }
  return builder.build()
}

const SPECIES_MESHES = Object.freeze({
  lawn: createLawnPatch,
  tall: createTallPatch,
  broadleaf: createBroadleafRosette,
  clover: createCloverCluster,
})

module.exports = { SPECIES_MESHES, MeshBuilder, curvedCentreline }
