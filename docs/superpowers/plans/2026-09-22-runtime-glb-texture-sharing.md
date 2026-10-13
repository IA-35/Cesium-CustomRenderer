# Runtime GLB Texture Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make byte-identical embedded images and equivalent samplers share Cesium image and GPU texture cache entries across independently loaded campus GLBs without rewriting the source assets.

**Architecture:** Fetch each GLB once in the existing loader, hash embedded image buffer views before handing the same bytes to Cesium, and annotate the parsed glTF during `gltfCallback`. Install a page-scoped cache-key adapter that replaces only image identity with the content hash while preserving Cesium's sampler and WebGL-context suffixes.

**Tech Stack:** JavaScript ES modules, Web Crypto SHA-256, Cesium 1.143 `ResourceCacheKey`, Node test runner, Playwright browser verification.

---

### Task 1: Define the content-hash and cache-key contract

**Files:**
- Create: `tests/rendering/shared-glb-textures.test.mjs`
- Create: `examples/shared-glb-textures.js`

- [x] **Step 1: Write the failing test**

Create synthetic GLBs whose embedded images are equal or different. Assert that equal bytes receive equal hashes, cache keys match across different model URLs when the sampler matches, and different samplers keep separate GPU texture keys.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/rendering/shared-glb-textures.test.mjs`

Expected: FAIL because `examples/shared-glb-textures.js` does not exist.

- [x] **Step 3: Write the minimal implementation**

Implement GLB chunk parsing, SHA-256 hashing for embedded image buffer views, glTF annotation, and reversible wrappers for `ResourceCacheKey.getImageCacheKey` and `getTextureCacheKey`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/rendering/shared-glb-textures.test.mjs`

Expected: all runtime-sharing tests pass.

### Task 2: Wire sharing into campus model loading

**Files:**
- Modify: `examples/campus-glb.js`
- Modify: `examples/campus.js`
- Modify: `tests/rendering/campus-business-assets.test.mjs`

- [x] **Step 1: Write the failing integration assertions**

Assert that campus loading fetches each GLB once, passes its bytes through `Model.fromGltfAsync({ gltf, basePath })`, annotates hashes in `gltfCallback`, exposes sharing diagnostics, and destroys the adapter on page teardown.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/rendering/campus-business-assets.test.mjs`

Expected: FAIL because the runtime sharing adapter is not wired.

- [x] **Step 3: Implement the loader integration**

Create one sharing registry for the model batch, reuse the fetched GLB bytes for Cesium loading, preserve existing material normalization, return diagnostics to `window.campus`, and release wrappers on `pagehide`.

- [x] **Step 4: Run focused and full tests**

Run: `node --test tests/rendering/shared-glb-textures.test.mjs tests/rendering/campus-business-assets.test.mjs`

Run: `npm test`

Focused tests pass. The full suite reports 709/711 passing; the two failures are pre-existing campus assertions for the retired 12-Tiles configuration and the older one-model reflection allowlist.

### Task 3: Verify the real campus assets in the browser

**Files:**
- Modify only if a verified runtime defect is found.

- [x] **Step 1: Load the GLB campus route**

Open `http://127.0.0.1:8878/examples/campus.html?models=glb&imagery=none`, wait for all models, and inspect `window.campus.sharedGlbTextures.getDiagnostics()`.

- [x] **Step 2: Verify acceptance evidence**

Confirm all 70 models load, there are no page or failed-response errors, duplicate embedded images are reported as cache reuses, and the model requests are not doubled by hashing.

- [x] **Step 3: Run build verification**

Run: `npm run build`

Expected: exit code 0.
