# TAA main quality mode and complete SMAA implementation plan

**Withdrawn / rolled back:** User reported severe window/thin-line flicker and requested the previous version. Implementation below is historical, not active. Current rebuilt SDK exactly matches pre-upgrade SHA256 `e0fffa070861e9eb5173d4761ad9199e05a6b202f782ff3e230ff8ad2db9679f`.

**Goal:** Make improved TAA the default quality mode and complete spatial SMAA the clarity alternative; activate only one AA owner.

**Architecture:** Keep the existing Cesium 1.143 HDR coordinator, jitter and selection overlay. Port licensed full SMAA spatial searches into the current three-pass adapter. Correct TAA history acceptance, add motion-aware handling where supported, and retain explicit diagnostics for unsupported cases. Preserve accepted environment appearance and unrelated workspace changes.

**Tech stack:** JavaScript, GLSL ES 3, Cesium 1.143, Node tests, Chrome WebGL2 via Playwright.

## Tasks and verification

- [x] Complete SMAA horizontal/vertical/diagonal/corner pattern handling from pinned MIT upstream; keep existing lookup orientation and final-display color contract. Test lifecycle and compile all quality variants; inspect diagonal/low-contrast fixtures.
- [x] Reproduce reversed stationary/moving variance gamma before correcting it. Audit depth/jitter/history, add color/geometry change rejection and motion support without interpreting camera stillness as scene stillness. Test moving occluders and revealed background, camera motion, thin edges, HDR highlights, and selection overlay.
- [x] Change normalized/default AA mode to TAA, preserve explicit SMAA/FXAA/off choices and single-owner switching. Keep existing API quality names, map SMAA quality to full presets, update example GUI and diagnostics where needed. Test initial activation and repeated switching.
- [x] Build SDK and run embedding/real shader compile, focused and full Node tests, real WebGL2 image sequences with fixed resolution/camera/light. Record GPU query availability, AA p50/p95, history/motion diagnostics and resource stability. Compare against saved pre-change shader/bundle without changing environment settings.
- [x] Review resulting implementation and evidence; document measured gains and remaining limits without claiming untested dynamic content support.

Evidence: `docs/verification/rendering-performance/antialiasing-2026-10-16/REPORT.md`. Development verification is complete; final user visual acceptance and a full-scene performance milestone are not implied.

## References

- SMAA GLSL: https://github.com/dmnsgn/shaders-smaa/tree/1d73155c07e1bd68a53536c5b517ece08c2cae11/packages/glsl-smaa
- Original SMAA: https://github.com/iryoku/smaa
- Three TRAA: https://github.com/mrdoob/three.js/blob/c94d808a4c773375bf221b13e61938e0aef9aea0/examples/jsm/tsl/display/TRAANode.js
- Playdead temporal (MIT): https://github.com/playdeadgames/temporal
- Intel TAA algorithm reference: https://github.com/GameTechDev/TAA

No commit, branch change, or unrelated cleanup is part of this task.
