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
  // Avalanche sequential object identifiers before mapping them to an angle.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

export function stableTreeVariation(id) {
  const hash = fnv1a(id)
  const heading = (hash / 0x100000000) * Math.PI * 2
  const heightScale = 0.82 + (fnv1a(`${id}:height`) / 0xffffffff) * 0.36
  const crownScale = 0.84 + (fnv1a(`${id}:crown`) / 0xffffffff) * 0.36
  return { heading, scale: heightScale, heightScale, crownScale }
}
