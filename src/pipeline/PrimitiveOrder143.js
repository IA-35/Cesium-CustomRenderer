// Avoid shifting the entire PrimitiveCollection when a renderer proxy is
// already last. raiseToTop() is O(number of primitives), so this guard is
// intended for listeners that run from preUpdate.
export function keepPrimitiveLast(collection, primitive) {
  if (!collection || !primitive || typeof collection.raiseToTop !== 'function') return
  const list = collection._primitives
  if (Array.isArray(list)) {
    if (list[list.length - 1] === primitive) return
  } else if (Number.isFinite(collection.length) && collection.length > 0 &&
    typeof collection.get === 'function' && collection.get(collection.length - 1) === primitive) {
    return
  }
  collection.raiseToTop(primitive)
}
