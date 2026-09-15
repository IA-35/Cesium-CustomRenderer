// Cesium 1.143 adapter for this example's untextured metallic/roughness tiles.
// Edits decoded material factors, preserving feature IDs and the native PBR shader.
export function applyWhiteTileMaterial(tile) {
  const visit = content => {
    if (!content) return
    for (const inner of content.innerContents || []) visit(inner)
    const model = content._model
    if (!model || model._ccrWhiteMaterialApplied) return
    const nodes = model._sceneGraph && model._sceneGraph.components.nodes
    if (!nodes) return
    let count = 0
    for (const node of nodes) for (const primitive of node.primitives || []) {
      const material = primitive.material, pbr = material && material.metallicRoughness
      if (!pbr || pbr.baseColorTexture || pbr.metallicRoughnessTexture || material.unlit) continue
      pbr.roughnessFactor = .22
      pbr.metallicFactor = 0
      count++
    }
    if (count) model.resetDrawCommands()
    model._ccrWhiteMaterialApplied = count
  }
  visit(tile.content)
}
