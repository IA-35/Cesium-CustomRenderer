# Dual GLB Grass Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the surveyed grass field with `grass-10.glb` and `grass-17.glb` in a deterministic 50/50 mix while sharing their identical BaseColor GPU texture.

**Architecture:** `GrassCollection` assigns a stable asset ID and authored scale to each existing grass clump. The pinned `EzTreePrimitive` groups grass by asset and cell, while `EzTreeGltfAsset` canonicalizes byte-identical BaseColor image records before texture creation. One primitive retains upstream culling, packed instance buffers and resource budgets.

**Tech Stack:** CesiumJS 1.143, vendored cesium-ez-tree, glTF 2.0 Draco/WebP, Node test runner, Playwright/CDP browser checks.

---

### Task 1: Deterministic dual-variant assignment

**Files:**
- Modify: `src/instances/GrassCollection.js`
- Modify: `tests/rendering/grass-collection.test.mjs`

- [ ] **Step 1: Write the failing assignment test**

Add a real collection test whose runtime captures `options.grassAssets` and instances. Assert two absolute asset URLs, 100 sampled instances split 50/50, stable repeated IDs, and scale correction only on `grass-10`:

```js
assert.deepEqual(primitive.grassAssets.map(asset => asset.id), ['grass-10', 'grass-17'])
assert.equal(instances.filter(item => item.asset === 'grass-10').length, 50)
assert.equal(instances.filter(item => item.asset === 'grass-17').length, 50)
assert.ok(instances.filter(item => item.asset === 'grass-10').every(item => item.scale.x > baseScale(item)))
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/rendering/grass-collection.test.mjs`

Expected: FAIL because the primitive receives no `grassAssets` and instances have no `asset`.

- [ ] **Step 3: Implement the minimal adapter**

Add a stable FNV-1a selector over `grass-${index}` and pass:

```js
const grassAssets = [
  { id: 'grass-10', url: new URL('grass-10.glb', this.polygonsUrl).href, scale: 1.0734813213348389 },
  { id: 'grass-17', url: new URL('grass-17.glb', this.polygonsUrl).href, scale: 1 },
]
```

Set `instance.asset` from hash parity and multiply its existing Cartesian scale by the selected asset scale. Add `grassAssets` to diagnostics.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/rendering/grass-collection.test.mjs`

Expected: all grass collection tests pass.

### Task 2: Reuse ez-tree asset grouping for grass

**Files:**
- Modify: `vendor/cesium-ez-tree/src/EzTree/EzTreePrimitive.js`
- Modify: `vendor/cesium-ez-tree/src/ccr-entry.js`
- Modify: `tests/rendering/ez-tree-integration.test.mjs`

- [ ] **Step 1: Write failing primitive behavior tests**

Export a pure helper `groupGrassAssets(instances, assets)` from the CCR entry. Test that it returns two groups, rejects a referenced missing asset, preserves all instances, and forces cutoff 0.35:

```js
const groups = runtime.groupGrassAssets(instances, assets)
assert.equal(groups.get('grass-10').instances.length, 2)
assert.equal(groups.get('grass-17').instances.length, 1)
assert.equal(groups.get('grass-10').alphaCutoff, 0.35)
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/rendering/ez-tree-integration.test.mjs`

Expected: FAIL because `groupGrassAssets` is not exported.

- [ ] **Step 3: Implement multi-asset command records**

Add `grassAssets` to `EzTreePrimitive` options. In `buildResources`, load each referenced asset. In `addGroundAssetRecords`, replace the single `grass` record with groups from `collectInstancesByAsset`, then call the existing `addGltfAssetCommandRecords` per group with:

```js
{ cutoutType: CUTOUT_GRASS, alphaCutoff: 0.35,
  maximumDistance: primitive.maximumGrassDistance,
  minimumLodRatio: primitive.grassMinimumLodRatio }
```

Retain the upstream bundled grass asset only when no explicit `grassAssets` are supplied.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/rendering/ez-tree-integration.test.mjs tests/rendering/grass-collection.test.mjs`

Expected: both suites pass and all instances belong to one asset group.

### Task 3: Share byte-identical BaseColor textures

**Files:**
- Modify: `vendor/cesium-ez-tree/src/EzTree/EzTreeGltfAsset.js`
- Modify: `vendor/cesium-ez-tree/src/EzTree/EzTreePrimitive.js`
- Modify: `vendor/cesium-ez-tree/src/ccr-entry.js`
- Modify: `tests/rendering/ez-tree-integration.test.mjs`

- [ ] **Step 1: Write failing canonicalization tests**

Export `canonicalizeImageRecords(records)`. Build records with identical bytes and a deliberate same-hash/different-bytes bucket. Assert exact-byte equality shares one owner while different bytes remain separate:

```js
const result = runtime.canonicalizeImageRecords(records)
assert.equal(result.unique.length, 2)
assert.equal(records[1].primitiveRecords[0].material.imageRecord, records[0].primitiveRecords[0].material.imageRecord)
assert.notEqual(records[2].primitiveRecords[0].material.imageRecord, records[0].primitiveRecords[0].material.imageRecord)
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/rendering/ez-tree-integration.test.mjs`

Expected: FAIL because canonicalization does not exist and both GLBs would create textures.

- [ ] **Step 3: Implement exact-byte texture sharing**

Implement MIME/length/FNV buckets plus exact `Uint8Array` comparison. Redirect primitive material references before `processImageRecord`. Track canonical image records in primitive resources and destroy those textures once; prevent duplicate asset records from owning/destroying the same texture.

Publish `sharedColorTextures` in `GrassCollection.getDiagnostics()` from the primitive resource cache.

- [ ] **Step 4: Verify GREEN and lifecycle**

Run: `node --test tests/rendering/ez-tree-integration.test.mjs tests/rendering/grass-collection.test.mjs`

Expected: one shared image record for the two real BaseColor images and idempotent destruction.

### Task 4: Asset, browser, performance and documentation acceptance

**Files:**
- Modify: `scripts/check-campus-grass.cjs`
- Modify: `docs/API.md`
- Modify: `docs/GRASS_IMPLEMENTATION_REVIEW_2026-09-18.md`
- Generate: `docs/verification/campus-grass/report.json`
- Generate: `docs/verification/campus-grass/performance.json`

- [ ] **Step 1: Extend browser assertions**

Require `grassAssets === 2`, `sharedColorTextures === 1`, nonzero draws for both variant IDs, no HTTP errors for either GLB, fixed height 3, and visible pixel difference.

- [ ] **Step 2: Build and run default-page acceptance**

Run:

```powershell
npm run build
$env:CCR_TEST_PORT='8878'
node scripts/check-campus-grass.cjs
```

Expected: exit 0; default `examples/campus.html` reaches ready with two assets and one shared texture.

- [ ] **Step 3: Record fixed-camera performance**

Measure the same 1280x800 overview and close cameras before/after with 6,329 instances. Record frame/CPU/GPU P50/P95, draws, submitted instances and triangles. Do not change density to improve the result.

- [ ] **Step 4: Update documentation and verify**

Document the two host GLB URLs, 50/50 assignment, shared BaseColor scope, ignored normal/roughness maps, draw-call tradeoff and measured results.

Run:

```powershell
node --test tests/rendering/grass-collection.test.mjs tests/rendering/ez-tree-integration.test.mjs
git diff --check -- src/instances/GrassCollection.js vendor/cesium-ez-tree scripts/check-campus-grass.cjs docs/API.md
```

Expected: tests and diff check exit 0.
