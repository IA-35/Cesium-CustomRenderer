# Dual GLB Grass Variants Design

Date: 2026-09-18

## Goal

Replace the bundled cesium-ez-tree grass mesh with `assets/grass/grass-10.glb` and `assets/grass/grass-17.glb`. Keep the existing 314 surveyed polygons, 6,329 deterministic grass-clump positions, fixed ENU height 3, spatial culling, instance packing and resource scheduling. Assign the two meshes in a stable 50/50 mix and allocate their shared BaseColor texture only once on the GPU.

## Verified Inputs

| Asset | Vertices | Triangles | Authored node scale | Material alpha mode |
| --- | ---: | ---: | ---: | --- |
| `grass-10.glb` | 890 | 796 | 1.0734813 | BLEND |
| `grass-17.glb` | 1,692 | 1,358 | 1 | OPAQUE |

Both files embed the same 512x512 WebP BaseColor image: SHA-256 `4480c01a37096ebd7153d33bfbfa62f553854afc13035d18ef0d8d7818303a73`. Their normal and roughness images differ. The existing ez-tree GLB vegetation shader reads BaseColor and alpha only; it does not consume normal or metallic-roughness textures. Therefore this feature shares one BaseColor GPU texture and deliberately does not upload the unused normal/roughness images.

Both meshes use Draco geometry and `EXT_texture_webp`, already supported by the pinned ez-tree loader. The loader does not apply glTF node transforms; `grass-10` therefore receives an explicit 1.0734813 instance-scale correction.

## Approaches Considered

### Separate asset groups with a shared image cache (selected)

Load each GLB as its own ez-tree asset record, split instances by a deterministic variant ID, and create command records per variant and spatial cell. Deduplicate matching BaseColor image bytes before texture creation. This reuses the upstream loader, geometry buffers, instance attributes and culling with a small extension.

The cost is up to two grass draw commands in a visible cell containing both variants. This cost must be measured and reported.

### Merge both meshes into one GLB

A merged file can share its embedded texture structurally, but the current loader would draw every primitive for every instance. Supporting per-instance mesh selection in one draw requires a geometry indirection scheme or shader discard and would add unnecessary complexity.

### Select one variant per spatial cell

This preserves one grass draw per cell, but produces visibly uniform patches and does not meet the approved per-clump 50/50 mix.

## Runtime Architecture

`GrassCollection` remains the business adapter. It assigns every sampled clump an `asset` field using a stable hash of its ID. Even hashes use `grass-10`; odd hashes use `grass-17`. The assignment is deterministic across reloads and differs by no more than one instance globally.

The collection passes the following asset table to one `EzTreePrimitive`:

```js
[
  { id: 'grass-10', url: '/assets/grass/grass-10.glb', scale: 1.0734813 },
  { id: 'grass-17', url: '/assets/grass/grass-17.glb', scale: 1 }
]
```

The primitive extends its existing `collectInstancesByAsset` path for grass, loads only assets referenced by instances, and creates one shared geometry resource per GLB. Each cell creates a command only for variants present in that cell.

No point generation, height logic or camera-distance density logic changes. The fixed height remains 3 and `clampToHeightMostDetailed` remains absent.

## Shared Texture Ownership

The GLB loader computes a lightweight bucket key from MIME type, byte length and FNV-1a hash. It then performs an exact byte comparison inside that bucket. Exact equality, rather than the hash alone, decides sharing.

Material records referencing identical image bytes are redirected to one canonical image record before decoding and texture creation. The canonical record owns the WebGL texture. Duplicate image records never create or destroy a texture. The primitive resource owner destroys the canonical texture once when the collection is removed.

Diagnostics expose `grassAssets: 2` and `sharedColorTextures: 1`. Texture byte accounting counts the canonical texture once.

## Material Contract

Both variants render through the existing ez-tree grass shader and use the shared BaseColor alpha as a cutout mask. The command uses `alphaCutoff: 0.35` for both variants, regardless of the source BLEND/OPAQUE declarations. This avoids opaque black cards and prevents order-dependent translucent grass.

The BaseColor texture is converted from sRGB by the existing shader path and multiplied by per-instance color variation. Normal and roughness maps remain unused and unallocated until the vegetation shader gains explicit support for those channels.

## Asset and Error Handling

The two source GLBs remain under the host's ignored `assets/grass/` directory and are served directly by the local example; the old copied ez-tree `grass.glb` is no longer used by `GrassCollection`. They are business assets and are not embedded into `CCR.min.js` or the npm package. Deployments must preserve the two documented URLs rather than silently substituting the upstream model.

If either referenced GLB, its Draco data or its BaseColor image fails, `GrassCollection.readyPromise` rejects and the collection enters `error`. It does not publish a partial one-variant grass field and does not wait for visible camera commands before reporting asset readiness.

## Tests and Acceptance

Unit tests must prove:

- 6,329 deterministic instance IDs split 50/50 within one instance.
- Both asset IDs reach `EzTreePrimitive`; the `grass-10` scale correction is applied only to that variant.
- Two GLBs with identical BaseColor bytes resolve to one canonical image/texture record and one destruction.
- Different image bytes never share a texture even if a hash bucket collides.
- Both source alpha modes result in `alphaCutoff: 0.35` commands.
- Fixed height 3, default density, default campus loading and the no-clamp contract remain unchanged.

Browser verification uses the default `examples/campus.html` URL. It must reach `ready` with no page, console or HTTP errors; diagnostics must report two grass assets and one shared color texture. Close and overview screenshots must show both variants, and grass visibility must create a nonzero pixel difference.

Performance verification compares the existing single lightweight grass mesh and the dual-GLB implementation with the same camera, 1280x800 drawing buffer, 6,329 instances and CCR settings. Report frame P50/P95, CPU render P50/P95, GPU P50/P95, visible draws, instances and triangles. Do not claim an FPS improvement unless the measured frame intervals improve.

## Scope Boundaries

- This change does not add normal-map or roughness-map lighting to ez-tree.
- It does not alter grass density, polygon sampling, fixed height 3, wind settings or the tree implementation.
- It does not merge meshes, simplify source geometry or introduce another instancing renderer.
- The existing lightweight upstream grass asset may remain in the vendored source for upstream compatibility, but `GrassCollection` does not select it.
