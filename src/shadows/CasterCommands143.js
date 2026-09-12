// PrimitiveCollection.updateForPass does not check ancestor visibility. Traverse
// explicitly so hidden campus groups cannot keep casting shadows from old tiles.
export default function selectLightTiles(collection, frameState, passState) {
  if (collection.show === false) return
  for (let i = 0; i < collection.length; i++) {
    const primitive = collection.get(i)
    if (primitive.show === false) continue
    if (typeof primitive.get === 'function' && typeof primitive.length === 'number') {
      selectLightTiles(primitive, frameState, passState)
    } else if (typeof primitive.updateForPass === 'function') {
      primitive.updateForPass(frameState, passState)
    }
  }
}
