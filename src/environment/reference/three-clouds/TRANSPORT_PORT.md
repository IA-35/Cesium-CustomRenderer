# Cloud transport port

> 2026-10-15 P1 update: the live host now supplies Hillaire 2D T/M/Sky LUTs.
> Cloud sunlight uses LUT T; its diffuse sky uses `pi * Psi` from the committed
> multiple-scattering medium, scaled by incoming solar radiance once. The analytic
> sky/sun descriptions below remain the compatibility path when LUTs are unavailable.
> See `../hillaire/NOTICE.md`. This does not introduce full Bruneton irradiance.
> The depth pass copies authoritative current T from the lit color output; separate
> shader optimization otherwise produced small grazing-ray T differences in GPU tests.
> Cloud distance history is now R32F, with T rejection reading resolved color alpha.

Upstream: [takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4),
commit `b012ad06d858fc035d88aacfd73f092f93c994e4`, MIT, Copyright (c) 2024 Shota Matsuda.
The unchanged upstream licence is retained in [LICENSE](./LICENSE).
Read from the pinned local checkout `ccr-three-geospatial-reference-20261014`.

| Upstream file under `packages/clouds/src` | SHA-256 of inspected file | Ported elements |
| --- | --- | --- |
| [shaders/clouds.glsl](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/shaders/clouds.glsl) | `9dd69a05cfcf548d035176f33388cb8818fd567bc8cf477dab0516fae045dd83` | `shapeAlteringFunction`, `sampleWeather`, shape/detail remapping in `sampleMedia`, density profile |
| [shaders/clouds.frag](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/shaders/clouds.frag) | `feae43fe30cea8f7f9a1904dce47e4e75d0d09375c6024e3cde600925301af72` | Dual HG, scattering octaves, sky gradient, ground bounce, powder, analytical extinction integral |
| [CloudLayer.ts](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudLayer.ts) | `e57764525d5bed828f7478b7cea8941c4b75d2eb2b211cc03bee2160ef59ea69` | Default linear density profile `(0, 0, .75, .25)` |
| [CloudLayers.ts](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudLayers.ts) | `2762fe15052d3c9fac7ef55c3611d777f67ef4db03e6acce0adc9d07180a4c71` | Lower layer weather exponent 1, shape/detail amount 1, altering bias .35, filter width .6 |

The density equations live in `cloudTransportDensity.js` and are inserted into the production
shader. Numerical tests execute those emitted scalar equations and compare upstream golden
samples, including both detail regimes and the height envelope. These are arithmetic tests;
they do not establish GPU precision, atlas texture fidelity, visual acceptance or frame time.

## Adaptations and quantities

- One layer uses existing `cloudParams`: coverage, base/top altitude in metres, density scale
  in inverse metres. Base/top remain host inputs. Density scale directly sets extinction;
  unit scattering albedo makes the source/extinction ratio cancel analytically. Upstream
  separate absorption/scattering coefficients, four-layer weights and density scales are
  collapsed into this existing single-layer contract.
- Weather coverage uses the upstream height semicircle and coverage filter *before* shape
  erosion, followed by detail erosion and the upstream linear density profile. No extra
  square root, biased-shape decode or arbitrary post-coverage cap remains.
- The existing packed 64-slice atlas remains. World periods are 32 km weather,
  16 km body on each axis, and 1.2 km detail, shared with metric motion wrapping
  through `cloudSpatial143.js`. These are whole texture periods, not individual
  feature sizes: the prepared noise contains its own frequency octaves. They
  differ from upstream resolutions/repeats. Upstream cloud position is also in
  metres (ECEF); .0003 shapeRepeat means a 3333 m texture period, not a normalized
  planet radius. Existing `cloudModel=1` reduces
  detail amount to .32; normal mode uses the upstream amount 1. The host has no turbulence
  texture, mip-dependent detail switch or four independent weather texture channels.
- Cumulus passes `t*t` to the upstream weather envelope (effective .7 rather than
  .35 height bias), retaining the real `t` for media density. The .35 envelope
  peaked at 14% of a single layer and concentrated clouds near its base; the
  cumulus envelope now peaks at 37%. Stratus retains the .35 envelope. Cumulus
  uses upstream's shapeAmount mechanism with amount 1.25, expressed as
  `shape'=1-(1-shape)*1.25` before the unchanged scalar remap. This carves real
  gaps from the prepared shape field without changing coverage. These are CCR
  single-layer calibrations; the pinned scalar golden functions remain unchanged.
- Cumulus extinction is .06 /m times the media density; stratus keeps .03 /m.
  GPU field comparisons isolate shape at .03 before applying the material change.
  This thickens cloud cores and changes actual light/shadow transmission, not
  display exposure, tonemapping, or a post-process contrast curve.
- `resolveCloudMotion(seconds, enabled)` derives independent metric weather/body/detail
  offsets from simulation time and wraps each at its own texture period. Horizontal base
  velocity is `(8,2)` m/s; weather uses .37 times, body 1 times, detail 1.73 times. Body
  vertical evolution is `-.25 * sqrt(68) * abs(seconds)` metres. The three `vec3` uniforms
  `cloudWeatherOffset`, `cloudShapeOffset`, `cloudDetailOffset` carry those offsets. The
  unwrapped body displacement is retained separately for reprojection, avoiding phase jumps
  at the former shared 64000 m wind wrap. These are CCR adapters, not upstream velocity
  defaults. ENU positions stay anchored through `cloudNoiseOrigin`, separate from the moving
  tangent-sphere origin. Legacy `cloudWind` is declared only for binding compatibility.
- View, geometry, sunlight and ground rays share one spherical-shell interval function.
  Both limb lobes are kept; the first solid planet intersection and scene distance clip
  view rays. Empty gaps are skipped in the sampling path. Sun/ground rays cover the whole
  forward cloud shell, with no former planar 6 km light cutoff. Fixed quality tap counts
  still approximate long grazing rays and do not replace upstream cascaded Beer shadows.
- View-distance LOD retains the same density field and horizon extent. Samples within
  8 km retain their original budget; a smoothstep to 40 km raises view strides to 4x
  and reduces secondary sun/ambient/ground/moon marches to two taps. Color and weighted
  depth share the same cursor, including the exact remaining final segment. Light tap
  counts are fractional with a clipped final segment, so a tap appearing/disappearing
  starts/ends with zero weight. Near lighting and receiver cloud shadows retain the
  original fixed-step integrator. No camera-distance fade is applied to secondary
  optical depth, and the atlas/detail density equations are unchanged.
- View/geometry optical density fades smoothly over the final 30% of the tier's
  camera distance limit, so source radiance approaches zero and residual T approaches
  one before truncation. Both passes use the same samples and fade. Solar/ground
  light paths retain the complete shell density; camera-range fading must not alter
  the weather field or make distant sunlight artificially transparent.
- Camera height alone drives the horizon range extension. Downward views below the
  local neighbourhood retain the tier's 30/40/50 km cap, and no orientation can
  reopen a planetary cloud layer: proximity fades the extension between one and two
  local ranges and reaches zero there (60/80/100 km complete disable by tier). Earlier
  revisions also gated on camera pitch and vertical FOV with a five-degree transition.
  That branch was removed after measurement: below 12 km the ray already meets the
  ground or the shell before the extension could apply, so the terms never changed a
  rendered pixel; only 40-80 km downward views were suppressed, which the height ramp
  covers directly. The shell/scene still clip each ray, so a steeper view cannot see
  more cloud than geometry allows.
  The extended cap is 1.5 times the sum of the ground-tangent distances from the
  camera and cloud top, putting the 70% fade onset outside the visible shell.
  The shell/scene still clip each ray. Short occupied paths retain uniform
  quadrature; long paths smoothly adopt near-dense exponential distance segments
  with their actual lengths and up to twice the view sample budget. Colour and
  geometry share the same quadrature. Sun/ground rays and the receiver shadow
  range are independent of this camera-only policy. This is not upstream's
  distance LOD/BSM scheme; no performance improvement is claimed.
- `atmosphereSunRadiance` is the same unattenuated directional source used by CCR's analytic
  atmosphere, in its linear HDR normalization, rather than calibrated SI radiance. Its use
  as the directional solar irradiance input matches that atmosphere's directional-light
  convention. Sunlight is attenuated once from each cloud sample to atmosphere exit using
  `ccrAtmosphereLightTransmittance`, including planetary night occlusion. The camera's
  `ccrSunRadiance()` estimate is not reused for sun extinction.
- With Hillaire ready, the cloud uses calibrated mean radiance `Psi` from M. Existing
  `ccrLutSkyIrradiance` supplies `E=pi*Psi*atmosphereSunRadiance*environmentSkyScale`;
  the isotropic cloud source recovers `E/pi`, reusing that lookup. Applying upstream
  `1/(4*pi)` to this hemispheric estimate incorrectly produced `Psi/4`: upstream's
  Bruneton scalar-irradiance input has a different angular definition. The fallback keeps
  representative `ccrSkyRadiance()` and its previous `pi*L/(4*pi)` estimate. Ground bounce
  uses albedo .3, Lambertian `1/pi`, uncovered direct sun projected onto local up, the same
  shell density extinction downward, and upstream isotropic scattering. Ground atmospheric
  irradiance is approximated by the cloud sample input; terrain albedo is absent.
- Dual HG uses upstream `.7`, `-.2`, mix `.5`. Eight scattering octaves, matching the pinned
  default quality preset, halve contribution,
  optical depth and anisotropy each time. Powder uses upstream `.8` and `150 m` constants;
  it depends on local inverse-metre extinction, never the view step length.
  The former three-octave truncation lost almost all indirect solar scattering at grazing
  cloud optical depths 50--100. This adds five exp and ten HG pow evaluations per lit sample,
  without additional density/light-march samples; GPU cost has not been benchmarked.
- The Hillaire mean-radiance cloud source now follows the same density upward and
  downward to the spherical layer boundaries. Two vertical rays represent two
  hemispheres. Their eight-octave isotropic transmission sums are normalized to
  visibility=1 in empty medium, preserving the input radiance scale without a
  brightness floor. Existing height gradient remains. M already includes the
  ground hemisphere, so LUT mode does not add a second diffuse ground bounce;
  analytic fallback retains its previous ground approximation. This is a cloud
  ambient-occlusion closure, not full directional sky integration or a new
  multiple-scattering solver. LUT mode adds one net secondary density march per
  lit view sample compared with the former separate ground march; GPU cost is
  unmeasured. See CLOUD_STRUCTURE_LIGHTING_FIX_2026-10-15.md for numerical and
  actual-page evidence and remaining visual limitations.
- Additional `cloudFrame = (frameIndex, temporalActive)` enables pixel/frame hash jitter
  only while cloud history is accepted. Otherwise the quadrature is fixed at midpoint .5.
  This hash is not upstream spatiotemporal blue noise; STBN assets are not added.
- `ccrCloudGeometry(origin, direction, sceneDistance)` returns `(weightedCloudDistance, T)`
  with no light marches. It shares exactly the view march density, sample locations, early
  termination and zero-coverage identity. Depth is weighted by the extinction contribution
  `T_before * (1-T_step)` and returns `sceneDistance` if empty. This opacity-weighted mean
  differs from upstream's residual-transmittance-weighted aerial-perspective proxy. Directions
  must be unit vectors in the existing metric tangent-sphere frame.

The transport port does not include upstream WebGL render targets, MRT setup, shadow cascades,
STBN, temporal upsampling, multilayer controls, haze or Bruneton LUT runtime. Host integration
and GPU/visual/performance acceptance are separate from these density and lighting equations.
