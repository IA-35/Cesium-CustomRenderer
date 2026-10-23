# Design: shader variants on Cesium's derived-program cache

Status: proposal, revision 2, no code yet. Date: 2026-10-22.

Revision 2 follows review comments. Changes from revision 1:
- No new registry or cache. Caching and lifetime are Cesium's `getDerivedShaderProgram` /
  `createDerivedShaderProgram`; CCR adds only a thin helper and composition rules.
- The derivation window (section 3) is now a stated hard constraint, with each module's actual timing verified.
- Risk raised for the hook relocation. Draw-time features are a separate tier instead of being forced into the window.
- Ordering relative to proposals 2–4 added (section 9).

## 1. Facts (verified against 1.143 and this repository)

- `ShaderProgram.fromCache` is cached: `ShaderCache.getShaderProgram` keys on the source text
  (`ShaderSource.getCacheKey()` for both stages plus attribute locations). Identical text yields one program.
- Compiling is still lazy: `ShaderProgram._bind()` calls `initialize2(this)`, which compiles and links on the
  first bind. The cache decides *how many* programs exist; first use decides *when* each one compiles.
- `getDerivedShaderProgram(base, keyword)` / `createDerivedShaderProgram(base, keyword, options)` key on
  `keyword + base._cachedShader.keyword`, i.e. on base identity. When the base's refcount reaches zero,
  `destroyShader` recursively destroys every derived keyword under it. Cesium uses this itself
  (`DerivedCommand` pick/depth/logDepth, `ClassificationPrimitive`, `Cesium3DTileBatchTable`).
- In CCR, one module derives through it (`GlobeNightLighting143`). `OitCompatibility143` wraps
  `createDerivedShaderProgram` to patch Cesium's own `translucentMultipass`/`alphaMultipass` sources.
  The other derived programs come from 11 `fromCache` calls across 7 files.

So the cost is not a missing cache. It is that each module builds its variant from text it assembles
itself, from whatever program the command carries at that moment. Variants do not compose by rule, they
chain by accident of order. For example, TAA motion and the MRT replay derive from the shadow-receive
variant whenever ShadowReceiver has already swapped it in.

## 2. Goals and non-goals

Goals
- Every CCR variant is created through the derived-program API, keyed on its base program's identity.
- In-place variants compose in a declared order, with declared exclusions.
- Pass variants state explicitly whether they derive from the base or from the in-place composition.
- No module destroys or prunes shader programs; Cesium's base lifetime governs.
- One place knows which variants exist, so they can be compiled ahead of first use.

Non-goals
- Changing shader transforms. The first migration of each feature must produce byte-identical text.
- A new cache, registry object or lifetime system.
- Programs not derived from a command (occlusion proxies, full-screen passes).

## 3. Hard constraint: the derivation window

Cesium's `Scene.updateDerivedCommands(command)` runs for every visible command as it is binned, every
render. If `command.dirty` (or a missing derived set) requires it, it rebuilds `derivedCommands`
(pick, depth, hdr, logDepth, OIT translucent/alpha, shadow cast/receive) **from `command.shaderProgram`
at that moment**. `createLogDepthCommand` and the OIT/HDR builders re-derive only when called, and they
are only called when the command is dirty. After the window closes, what draws is the derived command,
which holds whatever program the base had during the window.

Consequences:
1. An in-place swap that should reach Cesium's derived commands must happen before the native
   `updateDerivedCommands`, **and must set `command.dirty = true` whenever the program changes**.
2. A swap after the window only affects the exact command object being drawn, and only if it is applied to
   that object at draw time.

Actual timing of each module (verified):

| Module | What it changes | When | In the window? |
|---|---|---|---|
| `ShadowReceiver143` | `command.shaderProgram`/`uniformMap` | its `updateDerivedCommands` wrapper, before native | yes. It does **not** set `dirty` on a program swap; it works today because the first swap precedes the first derivation. Latent bug if a command was derived before receive was enabled. |
| `TransparentForward143` | `command.shaderProgram`/`uniformMap` (`assign`, line 174) | `applyTo` from FrameBridge's `onRenderItem`, dispatched inside FrameBridge's `updateDerivedCommands` wrapper before native | yes, and it sets `dirty = true` |
| `GlobeNightLighting143` | program/uniforms of the command being drawn | dispatcher handler at draw time, restored by `deferRestore` | no, by design: it patches the already-derived command that executes |
| `MaterialChannels143`, `DeferredGeometry143`, `TaaMotion143`, `TransparentReflection143`, shadow cast | a `shallowClone` for their own pass | execute time | not applicable: they never change the command |

Two corrections to the review comments: TransparentForward is inside the window (FrameBridge exists for
exactly that reason), and MaterialChannels never swaps the command's program. The only draw-time in-place
feature is GlobeNightLighting.

## 4. Design

### 4.1 Three tiers

| Tier | Applied | Derives from | Members |
|---|---|---|---|
| **Window** (in-place) | inside `updateDerivedCommands`, before native; sets `dirty` on change | base program | shadow receive, transparent forward |
| **Draw** (in-place) | dispatcher handler at draw time, restored after the draw | the program being executed | globe night |
| **Pass** (clone) | execute time | `base` or `window` composition, declared per pass | shadow cast, TAA motion, MRT replay, deferred geometry (3), transparent reflection |

Composition order is fixed by tier, then by `order` within the window tier: base, then window features,
then Cesium's own derived keywords (logDepth, hdr, OIT), then draw features. Draw features always see a
program that already contains the window composition, which is what GlobeNightLighting does today.

### 4.2 Helper, not registry

```js
// src/shaders/derivedVariant143.js（约 60 行）
// 在 Cesium 派生缓存上取或建一个变体。keyword 统一加 'ccr:' 前缀，避免与 Cesium 自己的
// pick/depth/logDepth/translucentMultipass 冲突。transform 返回 null 表示该基程序不支持，结果按基程序缓存。
export function derivedVariant143(context, base, keyword, transform) -> ShaderProgram | null

// 记录每个变体是由哪些特性组成的，供 SunUniforms 等查询，不再扫描 defines。
export function variantInfo143(program) -> { base, features: string[], ubo: Set<string> } | undefined

// 窗口层：唯一的 updateDerivedCommands 入口，按 order 组合窗口特性，程序变化时置 dirty。
export function acquireWindowComposer143(C, scene) -> {
  defineFeature({ name, order, excludes, enabled(frame), applies(command, base), options(command, base),
                  transform(sources, base, command), uniforms(command), ubo }),
  baseOf(program),
  release()
}
```

- `derivedVariant143` is `getDerivedShaderProgram` then, on miss, `createDerivedShaderProgram`, plus a
  per-base negative cache for unsupported transforms. Nothing else.
- The window composer replaces ShadowReceiver's wrapper and the transform part of FrameBridge's dispatch.
  It keeps one record per command (`base`, `baseUniforms`, `program`, `uniforms`, `owned`) and follows the
  existing ownership contract: if someone else changed the command's program or uniform map, it gives up
  ownership and never overwrites it.
- A window composition's keyword is `ccr:w:` + `name(options)` joined in `order`. A pass variant's keyword is
  `ccr:p:<pass>:<options>` derived from `base` or from the window composition.
- `excludes` replaces `shouldReceive: () => !isTransparentForwardActive()` and `restoreTranslucent()`.
  The exclusion is counted in diagnostics.

### 4.3 Per-frame cost

`enabled()` is evaluated once per render call (section 9's snapshot provides the boundary). Per command,
`applies()` results and the merged uniform map are cached on the record and recomputed only when the base,
the uniform map identity or the enabled mask changes. Steady state: one Map lookup and an integer compare.

### 4.4 Prewarming

Unchanged in intent from revision 1, now framed on Cesium's lazy compile:
- `compile: 'budgeted'` returns no variant until a pump has linked it (`program._bind()` with
  `CURRENT_PROGRAM` saved and restored, as in `TransparentForward143.programFor`), within a per-frame budget.
- Fallbacks: window feature not ready keeps the previous composition; shadow cast skips the command for that
  refresh; TAA motion uses the existing `captureUnsupported` path. The MRT replay stays `immediate`.
- A window feature switching from fallback to its variant is a program change, so it sets `dirty` and costs
  one re-derivation of that command's Cesium derived set. That cost is part of the budget decision.

## 5. GlobeNightLighting: options

| Option | Change | Cost |
|---|---|---|
| A (recommended) | Stays in the draw tier. Already on the derived API; only its keyword gets the `ccr:` prefix and it registers `variantInfo`. | none; it keeps re-patching per draw on the GLOBE pass at night |
| B | Moves into the window tier, enabled while `nightWeight > 0` | every on/off transition dirties every globe tile command and re-derives its logDepth/hdr/pick set |

Option A keeps the draw-time capability that its uniform restore and per-frame activation rely on. Option B is
only worth it if the per-draw handler cost shows up after proposal 2.

## 6. Migration order

| Step | Change | Risk |
|---|---|---|
| 0 | `derivedVariant143` + `variantInfo143` + tests. No consumer. | none |
| 1 | Pass variants that already derive from the right program: shadow cast (`base`), MRT replay, deferred geometry, transparent reflection, TAA motion (all `window` for now, byte-identical). Drops their `fromCache`, prunes and destroy calls. | low |
| 2 | Set `dirty = true` on every ShadowReceiver program swap, with a test for "receive enabled after first derivation". Independent bug fix; can land before anything else. | low |
| 3 | Window composer owns `updateDerivedCommands`; ShadowReceiver and TransparentForward become window features together, with `excludes`. FrameBridge keeps RenderItem dispatch but stops being the patch point. | **high**: both in-place features and the hook move in one step, because they share the window and the exclusion |
| 4 | GlobeNightLighting option A; SunUniforms reads `variantInfo` | low |
| 5 | Budgeted compile for shadow cast, TAA motion, window features | medium: visible fallback for new objects |
| 6 | Per pass, evaluate `base` instead of `window` with screenshot parity | visual, case by case |

Step 3 cannot be split per feature: shadow receive and transparent forward both target translucent commands
and their exclusion is one rule. It needs a feature flag (`shaderComposer: 'legacy' | 'window'`) so both
paths can be compared on the same frame during review.

## 7. Tests

Unit (`tests/rendering/derived-variant.test.mjs`, `tests/rendering/window-composer.test.mjs`), against a fake
ShaderCache that follows 1.143's `_cachedShader` / `derivedKeywords` contract:
1. Same base and keyword return the same program; `transform` runs once per base and keyword.
2. A `null` transform is cached as unsupported per base.
3. Releasing the base releases every CCR variant and Cesium derivatives built on it; no CCR code calls `destroy()`.
4. Keywords never collide with Cesium's (`pick`, `depth`, `logDepth`, `translucentMultipass`, `alphaMultipass`).
5. Window order is independent of registration order and of which module started first.
6. `excludes`: when both apply, transparent forward wins and the exclusion is counted.
7. **Dirty rule**: every program change sets `command.dirty`; a command derived before a feature was enabled gets the
   feature in its logDepth/hdr/OIT derived commands on the next window pass.
8. Ownership: a foreign program or uniform map change makes the record give up ownership; nothing is overwritten.
9. Steady state performs no transform call and no allocation.
10. Pass `from: 'base'` ignores the window composition; `from: 'window'` uses it; neither uses a draw-tier program.
11. `variantInfo(program).ubo` answers the sun-UBO question without reading `defines`.
12. Budget: pump respects the budget with a fake clock and always makes progress; fallback then switch sets `dirty` once.

Parity: before each step, snapshot the vertex/fragment text each module produces today for the fixture programs in
`custom-shadow`, `transparent-forward`, `globe-night-lighting`, `material-channels` and `taa-motion-r186` tests;
the migrated path must be byte-identical.

Browser, each step, `examples/campus.html`: no console errors, screenshot parity for steps 0–4, variant counts by tier
in diagnostics, and from step 5 the number of programs linked per frame during the first 10 s after load.

## 8. Risks

- **Step 3 moves two in-place features and the hook together.** Mitigated by the legacy/window flag and parity tests.
- **Private API**: `_cachedShader`, `createDerivedShaderProgram`, `_bind`. Already used here; the 1.143 pin stays.
- **`OitCompatibility143` wraps `createDerivedShaderProgram`.** Our calls pass through its hook; it only touches
  `translucentMultipass`/`alphaMultipass`, which are Cesium's keywords, so the `ccr:` prefix keeps them apart. Test 4 covers it.
- **Variants live until the base dies.** Runtime-toggled options accumulate at most 2^k per base; if diagnostics show
  growth, use `replaceDerivedShaderProgram` for options that are exclusive in time.
- **Budgeted fallback is visible** for a few frames on newly visible objects; opt-in per feature.

## 9. Ordering with proposals 2–4

Agreed order: **4 → 2 (absorbing 3) → this proposal**.

- **Proposal 4 (Render Graph)** is independent and small. Each `beginFrame` currently runs `describe()` → `compile()` →
  `_hash()` (a full `JSON.stringify`, before the early return) and builds `_diagnostics` three times (in `compile`, at the end
  of `beginFrame`, and in `endFrame`). Fix both: a structural version bumped by `addPass`/`createResource`/`importResource`/
  `bind`/`reset`, and diagnostics built only when read. Note the graph is not purely descriptive: `EnvironmentGraph143` and
  `PooledStageCache143` run real passes, GPU timing and transient leases through `executePass`; the VisualPipeline graph's
  passes have `execute: null`. The fix must keep `executePass`, lifecycles and leases unchanged.
  **Done 2026-10-22.** The per-frame path compares a structural version plus the net external-binding set; diagnostics
  (including `hash`) are built only in `describe()`. External bindings are compared as a set rather than counted, because the
  environment graph binds and unbinds about 124 times per frame. `beginFrame`/`endFrame` now return a light summary
  (`label`, `frame`, `version`, `passes`) instead of full diagnostics. Microbenchmark: 16–19 µs → 2.5 µs per graph per frame;
  in the campus scene, 0 recompiles over 99 frames.
- **Proposal 2 (classification)** should tag framebuffer *instances* (WeakMap), not snapshot the current binding. Two
  constraints found in Cesium:
  - Cesium calls `updateEnvironment()` before each `updateAndExecuteCommands`: the render path and five pick/depth paths,
    which share the frame number. `updateAndClearFramebuffers` runs at the start of each call. So the snapshot must be keyed
    per `updateAndExecuteCommands` call (an epoch from the existing wrapper), not per `frameNumber`, and built after the
    framebuffers update.
  - A framebuffer missing from the tag map (resize, new OIT target) takes the slow path once and is tagged.
  **Done 2026-10-22**, see `DRAW_CLASSIFICATION.md`.
- **Proposal 3 (gateway)** is the read side of that snapshot. `_currentFramebuffer` stays per draw; `_view.*`,
  `_environmentState.*` and `_gl` move into the per-call snapshot.
- **`textureLayout`** is not filled by target classification: target and pass are already in the batch key as
  `framebufferKey`/`framebufferLayout`. `textureLayout` describes sampler bindings from the uniform map and needs its own
  source, plausibly `variantInfo` plus the material's texture identities. It is currently never set (`createRenderItem143` is
  called without it).
- This proposal uses the snapshot for one thing: deciding window-feature `enabled()` once per render call.
