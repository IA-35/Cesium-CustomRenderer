// ParticleSystem owns an internal BillboardCollection; it is world-space
// content, not a POI layer. Share the same classification across render paths.
export function particleBillboards(C, collection, result = new Set()) {
  if (!collection) return result
  for (let i = 0; i < collection.length; i++) {
    const primitive = collection.get(i)
    if (C.ParticleSystem && primitive instanceof C.ParticleSystem && primitive._billboardCollection) {
      result.add(primitive._billboardCollection)
    } else if (C.PrimitiveCollection && primitive instanceof C.PrimitiveCollection) {
      particleBillboards(C, primitive, result)
    }
  }
  return result
}
