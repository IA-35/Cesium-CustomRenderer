# Fixed Tree Instancing Implementation Plan

> Superseded on 2026-09-18 by the user's explicit cesium-ez-tree direction and procedural-tree fallback. The custom multi-Model runtime and instancedGltf builder were removed. Current implementation and validation are recorded in `docs/EZ_TREE_INTEGRATION_2026-09-18.md`; historical checkboxes below do not describe the new backend.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the 720 surveyed WGS84 tree points in the CCR campus scene with three real tree prototypes, GPU instancing, four mutually exclusive LODs, ground clamping, stable variation, and CCR-compatible Cesium Model commands.

**Architecture:** A Node asset-preparation script validates each source GLB, converts centimeter mesh positions to meters, and emits four small glTF descriptors sharing one binary buffer and one PNG per prototype. Runtime code validates the point export, groups points by type and ENU spatial cell, injects `EXT_mesh_gpu_instancing` attributes into each selected LOD descriptor, loads the resulting models through Cesium 1.143, and switches one visible LOD per batch using projected size with hysteresis.

**Tech Stack:** Node.js 22+, CesiumJS 1.143, glTF 2.0, `EXT_mesh_gpu_instancing`, Node test runner, CCR UMD build.

---

### Task 1: Validate and normalize real vegetation assets

**Files:**
- Create: `scripts/prepare-fixed-tree-assets.cjs`
- Create: `tests/rendering/prepare-fixed-tree-assets.test.mjs`
- Generate locally: `assets/vegetation/manifest.json`
- Generate locally: `assets/vegetation/points.json`
- Generate locally: `assets/vegetation/<prototype>/model.bin`
- Generate locally: `assets/vegetation/<prototype>/leaf.png`
- Generate locally: `assets/vegetation/<prototype>/lod0.gltf` through `lod3.gltf`

- [x] **Step 1: Write failing asset-preparation tests**

Test exported helpers against a synthetic GLB and the real point JSON. Assert four LOD node names, one selected child per descriptor, meter-scaled POSITION values and bounds, external shared resources, exact point counts, no duplicates, and a manifest containing the three explicit type mappings.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/rendering/prepare-fixed-tree-assets.test.mjs`

Expected: FAIL because `scripts/prepare-fixed-tree-assets.cjs` does not exist.

- [x] **Step 3: Implement the normalizer**

Implement `parseGlb`, `validatePointExport`, `normalizePrototype`, and `prepareFixedTreeAssets`. Scale every POSITION accessor by the source root's uniform `0.01` transform, clear that root scale, keep the root but retain only the selected LOD child in each descriptor, externalize the shared BIN and PNG, and reject files without exactly `LOD0`–`LOD3`.

The CLI must accept:

```powershell
node scripts/prepare-fixed-tree-assets.cjs `
  --models "G:\_Assets\植物" `
  --points "C:\Users\Administrator\.openclaw\workspace\dongdakeshihua\ruoyi-ui\src\views\IAsCesiumLib\Geo-Scatter_Export_geographic_positions_with_type.json" `
  --output assets/vegetation
```

- [x] **Step 4: Run the focused test and real preparation**

Expected: 12 LOD descriptors, three shared BIN files, three shared leaf PNGs, 720 copied points, and `manifest.json` with no warnings.

### Task 2: Build deterministic point batches and four-level LOD selection

**Files:**
- Create: `src/instances/fixedTreeData.js`
- Create: `src/instances/lodSelector.js`
- Create: `tests/rendering/fixed-tree-data.test.mjs`
- Create: `tests/rendering/tree-lod-selector.test.mjs`

- [x] **Step 1: Write failing data tests**

Cover JSON schema rejection, `[longitude, latitude]` order, type mapping, 192 m ENU grid grouping, stable FNV-1a variation, and preservation of all 720 IDs. Cover four LOD thresholds `[96, 40, 16]` pixels with 15% hysteresis so repeated samples near a boundary do not alternate.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/rendering/fixed-tree-data.test.mjs tests/rendering/tree-lod-selector.test.mjs`

Expected: FAIL because the instance modules do not exist.

- [x] **Step 3: Implement pure data and LOD helpers**

Expose `validateFixedTreePoints`, `buildFixedTreeBatches`, `stableTreeVariation`, `projectedTreePixels`, and `selectTreeLod`. Keep these modules free of browser and Cesium dependencies so their contracts are deterministic and unit-testable.

- [x] **Step 4: Run focused tests**

Expected: all fixed-tree data and LOD selector tests pass.

### Task 3: Generate instanced glTF descriptors at runtime

**Files:**
- Create: `src/instances/instancedGltf.js`
- Create: `tests/rendering/instanced-gltf.test.mjs`

- [x] **Step 1: Write failing glTF builder tests**

Assert that the builder resolves external BIN/PNG URIs to absolute URLs, appends aligned TRANSLATION/ROTATION/SCALE buffers and accessors, adds `EXT_mesh_gpu_instancing` once, maps ENU `[east,north,up]` to the Cesium 1.143 glTF Y-up input `[north,up,east]`, preserves the MASK material, and never mutates its prototype input.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/rendering/instanced-gltf.test.mjs`

Expected: FAIL because the builder does not exist.

- [x] **Step 3: Implement the descriptor builder**

Use one appended data-URI buffer per batch and return a Blob URL plus a revoke callback. The source geometry and texture URLs remain stable and shared; no geometry or image bytes are copied into the generated descriptor.

- [x] **Step 4: Run focused tests**

Expected: all instanced glTF tests pass.

### Task 4: Implement the Cesium collection lifecycle

**Files:**
- Create: `src/instances/FixedTreeCollection.js`
- Modify: `src/index.js`
- Create: `tests/rendering/fixed-tree-collection.test.mjs`

- [x] **Step 1: Write failing lifecycle tests**

Use a small Cesium/model stub to assert loading state, four model objects per batch with only one shown, request-render on LOD changes, `setVisible`, diagnostic counts, late-load cancellation, Blob URL revocation, primitive removal, and idempotent `destroy`.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/rendering/fixed-tree-collection.test.mjs`

Expected: FAIL because `FixedTreeCollection` is not implemented.

- [x] **Step 3: Implement `createFixedTreeCollection`**

Load and validate the manifest and points; optionally call `scene.clampToHeightMostDetailed` before batching; build an ENU model matrix at the declared origin; create Cesium Models for all four LOD descriptors per batch; update LOD once per `scene.preUpdate`; and expose `readyPromise`, `setVisible`, `getDiagnostics`, and `destroy`.

- [ ] **Step 4: Run focused and full unit tests**

Run: `node --test tests/rendering/fixed-tree-collection.test.mjs` and `npm test`.

Expected: focused tests pass and no existing rendering test regresses.

Status: focused vegetation tests pass. Full `npm test` remains red on two pre-existing `campus-business-assets` assertions for the old `9528` URL / `maximumScreenSpaceError: 128` contract; the current example uses `8083` / `32`, and `SM_NH_Shu` has now been intentionally removed.

### Task 5: Integrate the campus example and browser verification

**Files:**
- Modify: `examples/campus.js`
- Create: `scripts/check-campus-trees.cjs`
- Modify: `docs/API.md`
- Modify: `scripts/rendering-sdk-README.md`

- [x] **Step 1: Add the campus tree lifecycle**

Load `/assets/vegetation/manifest.json` after campus tiles settle, create the collection with ground clamping, expose it as `window.campus.trees`, and add a lil-gui folder showing visibility, total instances, submitted batches, and current LOD counts. A missing local asset directory must show a clear status message without breaking the rest of the campus example.

- [x] **Step 2: Build the UMD artifact**

Run: `npm run build`.

Expected: `build/0.1.0/CCR.min.js` exports `createFixedTreeCollection`; the manifest remains engine-free and names only external Cesium 1.143.

- [x] **Step 3: Run browser verification**

Start the existing dev server and run `node scripts/check-campus-trees.cjs`. Assert 720 instances, three prototypes, at least two observed LOD levels along the camera route, one visible LOD per batch, no Cesium render errors, no duplicate object IDs, and correct collection cleanup.

- [x] **Step 4: Inspect visual evidence**

Capture road-level, oblique campus, and high-altitude screenshots. Check root contact, spacing, leaf alpha, model scale, LOD stability, custom shadow participation, HBAO/material channels, SMAA/TAA behavior, and absence of four-LOD overlap.

- [ ] **Step 5: Run final verification**

Run: `npm test`, `npm run build`, and `node scripts/check-campus-trees.cjs`.

Expected: all commands exit 0; diagnostics and screenshots are retained in ignored local evidence output.

Status: build, focused tests, and `scripts/check-campus-trees.cjs` exit 0. The full-suite blocker is recorded in Task 4 rather than hidden.
