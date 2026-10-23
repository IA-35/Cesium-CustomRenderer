# Design: per-call draw classification and handler filters (proposal 2)

Status: implemented 2026-10-22 (results in section 6). Date: 2026-10-22. Ordering context: `SHADER_VARIANT_REGISTRY.md` section 9.

## 1. Problem

`ContextDrawDispatcher143` calls every handler for every `context.draw`. Most handlers then re-derive the
same facts from Cesium private state:

| Handler (priority) | Its own predicate before doing anything |
|---|---|
| `globe-night-lighting` (-30) | `passes.render && !pick && !pickVoxel`, `command.pass === GLOBE` |
| `traa-r186-motion` (-30) | `passes.render && !pick && !depth`, `pass === OPAQUE`, target is `_view.sceneFramebuffer._colorFramebuffer.framebuffer` or `_view.globeDepth.colorFramebufferManager.framebuffer` |
| `taa-overlay` (-20) | `passes.render && !pick && !depth`, owner is Billboard/Label/Point, target is scene colour, globe colour or one of the two OIT FBOs |
| `selected-id` (-10) | `passes.render && !pick && !pickVoxel`, target is `_view.sceneFramebuffer.idFramebuffer` |
| `occlusion` (0) | target is scene colour or globe colour, then `shouldCull` |
| `sun-uniforms` (0) | program carries the sun UBO (cached per program) |
| `deferred-geometry` (10) | command was marked by `prepare()` (set lookup) |
| `transparent-direct-submit` (20) | opt-in option, RenderItem lookup |

Five of eight start with a pass, frame-type or target check, and four of those walk two to four levels of
`scene._view` per draw.

## 2. Facts that shape the design (verified in 1.143)

- `sceneFramebuffer.framebuffer` returns `_colorFramebuffer.framebuffer`, and `globeDepth.framebuffer` returns
  `colorFramebufferManager.framebuffer`. The handlers' different expressions name the same instances.
- `updateAndClearFramebuffers` runs at the start of every `updateAndExecuteCommands` call. It updates the
  framebuffers and sets `globeDepth.picking`, which switches `colorFramebufferManager` to a separate pick target.
- Scene calls `updateEnvironment()` and `updateAndExecuteCommands` for the render and for five pick/depth paths,
  and swaps `scene._view` around pick calls. Those calls share the frame number.
- Therefore target identity is stable **within one `updateAndExecuteCommands` call** (and the post-process draws that
  follow it), not within a frame number. `_currentFramebuffer` changes per pass and is not part of the snapshot.

## 3. Design

### 3.1 `SceneTargets143` (per scene, leased)

```js
// src/pipeline/SceneTargets143.js
export function acquireSceneTargets143(scene) -> { targets, release() }

targets.epoch           // 每次 updateAndExecuteCommands 调用加一
targets.kindOf(fb)      // 'sceneColor' | 'globeColor' | 'selectedId' | 'oitTranslucent' | 'oitAlpha' | 'default' | 'other'
targets.frameBits       // render=1, pick=2, depth=4, pickVoxel=8，取自本次调用的 frameState.passes
```

- One wrapper on `scene.updateAndExecuteCommands` increments `epoch` before calling through. It restores itself only if
  it is still the outermost owner, like `BindingScope143`.
- The snapshot is built lazily on the first query of an epoch, which is always after `updateAndClearFramebuffers`.
  It tags at most five framebuffer instances in a `Map`, cleared and refilled on rebuild.
- `kindOf(undefined)` is `'default'`. An untagged framebuffer is `'other'`. There is no slow path: anything not among the
  tagged instances is, by construction, none of the kinds handlers ask about.

### 3.2 Dispatcher filters

```js
dispatcher.attachTargets(targets)   // optional; without it, target and frame filters cannot exclude anything
dispatcher.addHandler(fn, {
  name, priority, enabled,
  passes: [C.Pass.OPAQUE],                       // command.pass must be one of these
  targets: ['sceneColor', 'globeColor'],         // kindOf(command.framebuffer || passState.framebuffer)
  frame: { render: true, pick: false, depth: false }, // required values of the frame bits
})
```

Contract: **a filter may only state conditions the handler already checks itself.** Filters are a pre-selection; removing
them must not change any decision. Handlers therefore keep their own checks; when `event.target` is defined they use it
instead of walking `scene._view`.

Per draw:
1. If no active handler has a filter, nothing is classified (today's path).
2. Otherwise compute `pass`, `kind` and `frameBits` once, form an integer key
   (`pass | kindIndex << 5 | frameBits << 8`), and take the handler list for that key from a cache. The cache is cleared
   whenever a handler is added or removed.
3. Without attached targets, `kind` and `frameBits` are "unknown", and unknown matches every target and frame filter.
4. The event carries `event.target` (kind or `undefined`) and `event.frameBits`.

### 3.3 Handler migration

| Handler | Filter | Uses `event.target` |
|---|---|---|
| `traa-r186-motion` | `passes: [OPAQUE]`, `targets: sceneColor/globeColor`, `frame: {render, !pick, !depth}` | yes, in `isSceneColor` |
| `taa-overlay` | `targets: sceneColor/globeColor/oitTranslucent/oitAlpha`, `frame: {render, !pick, !depth}` | yes |
| `selected-id` | `targets: selectedId`, `frame: {render, !pick, !pickVoxel}` | yes |
| `occlusion` | `targets: sceneColor/globeColor` | yes |
| `globe-night-lighting` | `passes: [GLOBE]`, `frame: {render, !pick, !pickVoxel}` | no target check today |
| `sun-uniforms`, `deferred-geometry`, `transparent-direct-submit` | none: their predicate is not about pass/target/frame | — |

`selected-id` currently also clears `pass.owners` on every draw while post-process selection is off. With the filter, that
reset only happens on ID-pass draws. That is safe: `owners` is only read for ID-pass draws, and `prepare()` resets it at
the first ID draw of each frame.

The non-dispatcher fallback hooks (`context.draw = this.hook`) are unchanged.

## 4. Relation to proposal 3

`SceneTargets143` is the start of the gateway: target identity and frame type move behind it. Moving the remaining
`scene._view` / `_environmentState` reads is proposal 3 and is out of scope here.

## 5. Tests

`tests/rendering/scene-targets.test.mjs`
1. Kinds for each tagged instance, `'default'` for no framebuffer, `'other'` for an untagged one.
2. A new `updateAndExecuteCommands` call re-tags: after the scene swaps `_view` or `globeDepth.picking` flips the manager,
   the next call reports the new instances; within a call the snapshot is built once.
3. Frame bits follow the passes of the current call.
4. Release restores `updateAndExecuteCommands` only if it is still ours; a foreign outer wrapper stays.

`tests/rendering/context-draw-dispatcher.test.mjs`
5. A filtered handler is not called for non-matching pass, target or frame; an unfiltered handler is always called.
6. Without attached targets, target/frame filters do not exclude (pass filters still do).
7. The handler list cache is invalidated when a handler is added or removed mid-session.
8. Equivalence: for each migrated handler, over a matrix of pass × target × frame bits, the decision with filters equals the
   decision with filters removed.

Benchmark: 1700 draws per frame with the eight handlers' realistic predicates, before and after.

Browser, `examples/campus.html`: no console errors, normal image, handler call counts per frame from dispatcher diagnostics
(new `handlerCalls` counter) before and after.

## 6. Results (2026-10-22)

Implemented as designed: `src/pipeline/SceneTargets143.js`, filters in `ContextDrawDispatcher143`, attached by
`VisualPipeline`. Five handlers migrated (TAA motion, TAA overlay, selected ID, occlusion, globe night). Tests:
`tests/rendering/scene-targets.test.mjs` (6), full suite green apart from the existing night-transport failure.

Campus scene, TAA on, camera moving, filters on vs off on the same page (alternated twice):

| | handler calls / frame | dispatches / frame | frames in 3 s |
|---|---|---|---|
| filters off | 2,111–2,121 | ~525 | 179–181 |
| filters on | 403 | ~525 | 180–181 |

Equivalence check in the same scene: TAA motion classified 70 supported / ~70 unsupported surfaces per frame in both
modes. Default SMAA setup (two filtered handlers): 150 → 56 handler calls per frame.

CPU: in a Node microbenchmark with eight handlers and 1,700 draws, the time per frame is unchanged within noise
(0.20–0.34 ms both ways). The handlers already rejected non-matching draws cheaply, and the route lookup costs about what
the skipped calls saved. A last-key cache in front of the lookups did not measurably help and was removed. The value of this
change is fewer per-draw `scene._view` walks (only matching draws reach them) and one shared target classification for
proposal 3, not frame time.
