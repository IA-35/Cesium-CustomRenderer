# Design: one gateway for Cesium private scene state (proposal 3)

Status: implemented 2026-10-22 (results in section 6). Date: 2026-10-22. Follows `DRAW_CLASSIFICATION.md` (proposal 2).

## 1. Inventory (before)

66 reads of `scene._view` / `scene._environmentState` in 21 files under `src/`, plus `_globeTranslucencyState`
in the same checks. Fields actually read:

| Group | Fields |
|---|---|
| frusta | `_view.frustumCommandsList` (20 uses, incl. `.length`) |
| scene targets | `_view.sceneFramebuffer.{framebuffer,_colorFramebuffer,idFramebuffer}`, `_view.globeDepth.{framebuffer,colorFramebufferManager}`, `_view.passState` |
| OIT | `_view.oit` and `._opaqueTexture`, `._accumulationTexture`, `._revealageTexture`, `._translucentMRTSupport` |
| environment | `useOIT` (10), `useWebVR`, `useInvertClassification`, `usePostProcessSelected`, `useGlobeDepthFramebuffer`, `clearGlobeDepth` |
| view identity | `_view` itself (FrameBridge view ids, `activeContext.view !== scene._view`) |

`_currentFramebuffer` is per context and changes per pass; it is out of scope.

## 2. Decision: live accessors, not a cached snapshot

The review proposed putting these reads behind the per-call snapshot from proposal 2. That is only correct for reads made
**inside** an `updateAndExecuteCommands` call. Roughly half of the sites run outside one: `getDiagnostics()`,
`scopeReason()`, `setOptions` support checks, `preUpdate` hooks, uniform callbacks evaluated by post-process stages. There a
call-scoped snapshot is stale. After a pick it would still describe the pick view, which Cesium has already swapped back,
and after a resize it would describe framebuffers that no longer exist.

None of the remaining sites is a per-draw hot path; proposal 2 already moved those to target kinds. Caching would therefore
add a staleness risk for no measurable gain.

So the gateway is a module of **null-safe live accessor functions**. It is the only file that names these private fields.
`SceneTargets143` keeps its per-call cache for target kinds, and builds it through the same accessors.

## 3. API

`src/scene/cesiumPrivate143.js`. Every function takes the scene and reads live.

```js
// view
viewOf(scene)                    // _view（只用于身份比较）
frustumBinsOf(scene)             // _view.frustumCommandsList
viewPassStateOf(scene)           // _view.passState
sceneColorManagerOf(scene)       // _view.sceneFramebuffer._colorFramebuffer
sceneColorFramebufferOf(scene)   // 同上 .framebuffer（等于 sceneFramebuffer.framebuffer）
selectedIdFramebufferOf(scene)   // _view.sceneFramebuffer.idFramebuffer
globeColorManagerOf(scene)       // _view.globeDepth.colorFramebufferManager
globeColorFramebufferOf(scene)   // 同上 .framebuffer（等于 globeDepth.framebuffer）
oitOf(scene)                     // _view.oit
oitOpaqueTextureOf / oitAccumulationTextureOf / oitRevealageTextureOf(scene)
oitMrtSupported(scene)           // !!_view.oit._translucentMRTSupport
oitTranslucentFramebufferOf / oitAlphaFramebufferOf(scene)
// environment
usesOit / usesWebVR / usesInvertClassification / usesPostProcessSelected /
usesGlobeDepthFramebuffer / clearsGlobeDepth / globeTranslucent(scene) -> boolean
```

Accessors are null-safe (`?.`). Where a call site relied on a missing `_view` throwing, it now sees `undefined`; every such
site already guards the result or treats an empty list as "nothing to do", and the migration keeps each site's own default
(`|| []`, `?? 0`).

## 4. Migration

Mechanical, one batch at a time, full suite after each:

| Batch | Files |
|---|---|
| A | `SceneTargets143`, `FrameBridge143`, `FrameState143`, `TransparentForward143`, `VisualPipeline` |
| B | `FrustumJitterBridge143`, `settings143`, `TaaMotion143`, `TaaOverlay143`, `TaaPass143`, `TaaSelectionDepth143` |
| C | `MaterialChannels143`, `ScreenSpaceGeometry143`, `DeferredGeometry143`, `DeferredLighting143`, `EnvironmentRenderer`, `HdrEnvironmentPass143` |
| D | `TransparentReflection143`, `SelectedIdPass143`, `DirectionalShadowPass`, `OcclusionCulling143` |

## 5. Tests

- `tests/rendering/cesium-private-gateway.test.mjs`:
  1. Each accessor returns the same object/value as the private path on a fixture scene, and `undefined`/`false` when the path is missing.
  2. Getter equivalences hold on real Cesium classes where constructible without a GL context.
  3. **Guard**: no file under `src/` other than the gateway contains `._view`, `_environmentState` or `_globeTranslucencyState`
     (vendor and reference code excluded). This keeps the upgrade surface to one file.
- Existing module tests unchanged; their fixtures still provide the private fields the gateway reads.
- Browser: campus scene renders, no console errors, diagnostics unchanged in shape.

## 6. Results (2026-10-22)

- All four batches migrated. Private-state reads in code under `src/`: 69 across 21 files before, 0 outside
  `src/scene/cesiumPrivate143.js` after. The guard test fails if one is reintroduced; run against the pre-migration
  `FrameBridge143.js` it flags all 12 of that file's reads.
- Added during migration: `oitMultipassSupported`, `oitOpaqueSamplesOf`, `usesDepthPlane`, `depthPlaneCommandOf`
  (MaterialChannels also read `useDepthPlane` and `scene._depthPlane._command`).
- Framebuffer accessors use the `framebuffer` getters (`sceneFramebuffer.framebuffer`, `globeDepth.framebuffer`). In 1.143 they
  return `_colorFramebuffer.framebuffer` and `colorFramebufferManager.framebuffer`; a test verifies this on the real classes,
  including the globe pick switch. The getters were already what `SelectedIdPass143` and `TaaOverlay143` read.
- Semantics: accessors are null-safe, so a few sites that would have thrown on a missing `_view` now see `undefined`.
  Iteration sites (`for (const bin of frustumBinsOf(s))`, `.length` reads) keep throwing exactly as before.
- Tests: `tests/rendering/cesium-private-gateway.test.mjs` (3), full suite green apart from the existing night-transport failure.
- Browser: campus scene renders, no console errors, `getRenderDiagnostics()` works under SMAA and TAA, picking gives
  75 hits with the pipeline on vs 76 off on a 90-point sweep. The selected-ID shortcut reports its native fallback because this
  scene has `clearGlobeDepth: true`, which the original code also checked.
- One unexplained page reset happened during a script that combined dispatcher uninstall/reinstall with pipeline disable/enable;
  running those steps separately did not reproduce it.
