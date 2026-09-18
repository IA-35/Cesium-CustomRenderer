# cesium-ez-tree integration

Upstream: https://github.com/Xiaobai-grow/cesium-ez-tree
Pinned commit: cbea56e4550f9b3ef9cbc96424abbdcde9ac7eb2 (MIT, copyright TJ 2026).
Original LICENSE and NOTICE.md are retained. The src directory is upstream source with the following local adaptations; it is not a new instancing renderer.

- Engine imports are externalized by scripts/build-eztree-runtime.cjs into a factory accepting the host Cesium 1.143 namespace. No second engine is bundled.
- External tree GLBs use the existing EzTreeGltfAsset parser, image loading, geometry buffers and EzTreePrimitive command/instance packing/cache/job budgets. A treeAssets option extends the existing ground-asset route.
- Four geometry LODs are tagged by node extras during asset preparation and selected per upstream spatial cell with hysteresis. Fixed surveyed trees always keep full instanceCount; upstream density thinning is not used for these trees.
- Prepared geometry is in metres with no remaining node transforms. Authored vertex COLOR_0/1 are not interpreted as albedo or opacity (upstream GLB path reads POSITION/NORMAL/TEXCOORD_0/indices).
- Cesium-compatible Y-up/Z-forward to ENU axis correction, linear base-color sampling, opaque/masked color consistency and lightweight two-sided foliage lighting.
- CCR shadow flags, receiver marker and light-view command selection retain alpha-tested silhouettes, including available offscreen cells. Wind is disabled for the fixed-tree integration.
- Generated runtime.js is rebuilt from these sources; it must not be edited manually.

The campus default is now the upstream procedural Pine generator with three seeded presets, reduced branch tessellation/leaf-card budgets and original bark texture. A `treePresets` option permits caller-provided upstream preset objects. Instance density is held at 1.0 for both branch and leaf records; all surveyed points remain. This default has one lightweight geometry level, not four GLB levels. External GLB remains an explicit comparison path; its dark leaf appearance has not been accepted for default use.

This remains a forward vegetation shader, not the full Cesium Model PBR material pipeline. Native/CCR appearance, frame time, model/resource counts and actual tree/shadow pixel evidence must be verified before claiming integration success.
