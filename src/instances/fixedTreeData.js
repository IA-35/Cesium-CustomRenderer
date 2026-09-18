const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

export function validateFixedTreePoints(data, typeMap) {
  const order = data?.coordinateSystem?.geographicPositionOrder
  if (!Array.isArray(order) || order[0] !== 'longitude' || order[1] !== 'latitude') throw new Error('Fixed tree points must declare [longitude, latitude] order')
  const origin = data.coordinateSystem?.origin
  if (!Number.isFinite(origin?.longitude) || !Number.isFinite(origin?.latitude)) throw new Error('Fixed tree points require a finite WGS84 origin')
  if (!Array.isArray(data.objects)) throw new Error('Fixed tree objects must be an array')
  if (data.summary?.objectCount !== undefined && data.summary.objectCount !== data.objects.length) throw new Error('Fixed tree objectCount does not match objects')
  const ids = new Set()
  const points = data.objects.map(item => {
    if (!own(typeMap, item.type)) throw new Error(`Unknown tree type: ${item.type}`)
    if (typeof item.object !== 'string' || !item.object) throw new Error('Tree id must be a non-empty string')
    if (ids.has(item.object)) throw new Error(`Duplicate tree id: ${item.object}`)
    ids.add(item.object)
    if (!Array.isArray(item.relativePosition) || item.relativePosition.length !== 2 || !item.relativePosition.every(Number.isFinite)) throw new Error(`Invalid ENU position: ${item.object}`)
    if (!Array.isArray(item.geographicPosition) || item.geographicPosition.length !== 2 || !item.geographicPosition.every(Number.isFinite)) throw new Error(`Invalid geographic position: ${item.object}`)
    return {
      id: item.object,
      type: item.type,
      prototypeId: typeMap[item.type],
      east: item.relativePosition[0],
      north: item.relativePosition[1],
      up: Number.isFinite(item.height) ? item.height : 0,
      geographicPosition: [...item.geographicPosition]
    }
  })
  return { origin: { longitude: origin.longitude, latitude: origin.latitude }, points }
}

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function stableTreeVariation(id) {
  const hash = fnv1a(id)
  const heading = (hash / 0x100000000) * Math.PI * 2
  const scaleHash = fnv1a(`${id}:scale`)
  const scale = 0.92 + (scaleHash / 0xffffffff) * 0.16
  return { heading, scale }
}
