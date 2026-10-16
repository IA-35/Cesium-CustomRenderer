# Atmosphere continuity and cloud transport implementation plan

> **For agentic workers:** Use subagent-driven-development to implement and review the independent cloud transport, shadow and temporal tasks. Preserve existing uncommitted work; do not commit or change branches.

**Goal:** Remove the dawn/dusk atmosphere steps and connect weather density, cloud lighting, cloud shadows and cloud-specific temporal reconstruction to the running Cesium HDR environment path.

**Architecture:** Keep linear radiance and spectral transmission separate through reconstruction. Adapt the pinned three-geospatial cloud density, light transport and temporal rejection algorithms to the existing Cesium 1.143 tangent-sphere/depth contract. History belongs to the cloud renderer and resets on discontinuities; native scene TAA remains independent.

**Tech Stack:** JavaScript, GLSL ES 3/WebGL2, Cesium 1.143, pinned three-geospatial b012ad06d858fc035d88aacfd73f092f93c994e4, Node tests and real Chrome GPU captures.

## 1. Reproduce atmosphere discontinuities
- [x] Extend the existing sky capture fixture with 12 km and low-altitude dawn/noon/dusk views; retain raw floating point output and scanline derivatives.
- [x] Identify whether steps originate in light-path visibility quadrature, transmission packing or final display conversion before changing the solver.
- [x] Correct the responsible integration/representation and verify continuous HDR scanlines without changing global exposure to hide the defect.

## 2. Port cloud density and light transport
- [x] Adapt upstream weather remapping, height shaping, independent weather/shape/detail evolution and erosion; retain coverage/thickness GUI semantics.
- [x] Use sample-altitude solar transmission, sky irradiance, ground bounce, powder response and bounded multiple scattering with the same density on visible/light/shadow rays.
- [x] Add density, zero-coverage, grazing-sun and night/energy GPU checks and pinned-source documentation.

## 3. Cloud shadows
- [x] Add a shadow transport module using the same density and planet-aware shell intervals; apply at actual scene receivers in HDR and publish medium visibility to existing shaft consumers.
- [x] Preserve the estimated diffuse sky share and sky pixels; test no-cloud identity, nighttime and continuous density motion. Exact emissive/specular separation remains outside the combined HDR approximation.

## 4. Cloud temporal reconstruction
- [x] Add cloud-only colour/transmission and cloud distance inputs, independent history textures, camera/wind reprojection, neighbourhood variance clipping and depth/disocclusion rejection.
- [x] Reset on size, camera cuts, simulation-time jumps, weather/quality/origin changes and failed/bypassed frames. Verify resource release and reset counters; per-pixel rejection is tested in the shader but no GPU rejection counter is collected.
- [x] Enable stochastic ray sampling only when valid temporal reconstruction is executing.

## 5. Integration and acceptance
- [x] Integrate passes and lifecycle in EnvironmentRenderer/HdrEnvironmentPass143; report actual activation and reasons in diagnostics.
- [x] Run embedding checks, actual WebGL2 compilation/transport checks, relevant/full tests and rebuild the SDK.
- [x] Capture dawn/noon/dusk from below/inside/above clouds and camera motion; inspect actual images, not just white-pixel ratios. Record remaining limitations honestly. No performance benchmark in this phase.
