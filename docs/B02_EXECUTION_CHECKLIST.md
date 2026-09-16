# B02 implementation checklist (2026-09-16)

Scope: generic Cesium 1.143 standard PBR opaque/MASK models. Keep application compatibility adapters outside src. Preserve existing uncommitted generic-scope work.

- [x] R1 metric eye-depth reconstruction and independent numerical position tests.
- [x] R2/R7/R8 partial setters, consumer-owned dependencies, restartable failure state.
- [x] R3/R4 injected engine, cached owned FBO/programs, lifecycle tests.
- [x] Four-slot inline G-buffer: intercept supported main color commands, share native depth/stencil, keep native pick/shadow commands.
- [x] Preserve unsupported opaque colors via invalidation; conservative whole-frame fallback for unavailable OIT, MSAA, unsupported passes or downstream SSR/TAA contracts.
- [x] Per-environment-group lighting using native model SH/probe/factor/reference-frame inputs. No fabricated global environment.
- [x] Compact layout: FLOAT native XYZ normal/roughness, FLOAT emissive+flags/group, FLOAT metric depth/eye XY/metalness, half-float albedo. Independent R8 transparency. Higher precision preserves numerical parity; four color slots, not four total textures.
- [x] Reuse shadow PCF; compute AO before lighting and skip legacy whole-color AO modulation in active deferred frames.
- [x] Strict seven-material fixture, known shared lighting controls, unsupported/transparent compatibility, main draw counts and four-slot capability tests.
- [x] Full regression, independent review, docs/evidence/build and Git commit.

Native depth is shared by the inline geometry FBO. Supported geometry produces material data once in the main opaque pass; no native forward lighting or material replay for those draws. Compatibility geometry retains native rendering plus conservative data invalidation. Deferred remains opt-in. B03 still owns full transparent-lighting and SSR integration; unavailable combinations retain enhanced rendering with explicit diagnostics.

Current results and explicit remaining cross-mode work: [B02_COMPLETION.md](B02_COMPLETION.md). Independent native-reference review is performed locally; no execution agent delegation.
