# Cloud receiver shadow integration

Reference: Shota Matsuda, `takram-design-engineering/three-geospatial`,
`packages/clouds/src/shaders/shadow.frag`, `clouds.frag`, and `clouds.glsl`.
The reference source supplied for this port is the checkout at
`ccr-three-geospatial-reference-20261014`. Its MIT notice is retained in `LICENSE`.

The upstream shadow pass marches the shared cloud extinction into cascaded sun-space
maps containing front depth, mean extinction, accumulated optical depth and a tail
estimate. It uses structured volume sampling and optional temporal reprojection.
CCR's `cloudShadow143.js` does **not** port those cascaded maps, structured sampling,
or the shadow temporal filter. Instead it calls the same `ccrCloudSunVisibility` used
to light visible clouds, starting at the actual reconstructed receiver position.
The transport module owns shell intervals, density sampling and Beer extinction;
there is no second independently tuned cloud field or camera-only shadow value.

## Receiver contract

Append `cloudShadowGLSL()` after `cloudGLSL()`. Call
`ccrCloudSurfaceTransmission(positionAtmo, normalAtmo, surfaceDistance,
maxReceiverDistance, validSurface, sunIrradiance, skyIrradiance)` on the scene's
linear HDR color **before** adding view atmosphere or visible clouds. Preserve the
source alpha when multiplying RGB by the result. Exclude invalid/background depth
with `validSurface`; distances are metres, positive and bounded by the host's
receiver distance limit. Do not turn the atmosphere's synthetic planet intersection
into a valid depth receiver. A cloud sunlight ray needs its complete shell chord,
even for grazing sunlight; the camera receiver limit must not clip that light ray.

Position and normal must be in the cloud's corrected planet-centred frame.
Prefer valid material normals transformed from eye coordinates. A depth-only
fallback uses the cross product of camera-relative surface differences, selecting
the nearer surface neighbour on each screen axis. This avoids hardware derivatives
crossing a roof/background silhouette and leaving a sunlit rim. Do not differentiate
the large planet offset. Thin/subpixel surfaces still have depth-only ambiguity;
valid material normals are preferable. A sphere radial normal is inappropriate for
building walls.

Receiver influence fades with smoothstep from 70% of the camera distance limit to
the limit (currently 35–50 km). This changes the shadow's influence, not the solar
optical-depth integration interval, and removes the former circular hard cutoff.

Sun/sky inputs must have matching linear irradiance units. The caller may include
atmospheric transmission and existing geometric shadow visibility in the sun input;
cloud visibility is applied exactly once here. Do not mix the artist-scaled
`atmosphereSunRadiance` with Cesium's scene light intensity. Sky radiance can be
converted to isotropic irradiance with `PI * skyRadiance`, but that is a lighting
approximation rather than the actual per-material environment integral.

## Exact and approximate lighting boundaries

`DeferredLighting143` computes direct PBR, indirect IBL, and emissive separately,
then writes their sum. It exposes combined scene color and optional reflection
outputs, not a separate direct-light texture. Native terrain and forward models
also enter this environment pass with combined color. Material normals and albedo
alone cannot recover direct PBR for every native material, IBL and geometric shadow.

For combined color, the helper estimates each channel's diffuse direct fraction as
`max(sunIrradiance,0)*max(dot(normal,sun),0) / (sun+max(skyIrradiance,0))`.
The multiplier is `1 - (1-cloudVisibility)*directFraction`, bounded to `[0,1]`.
Zero clouds, zero sun, back-facing normals, sky pixels and out-of-range receivers
are identity cases. Full cloud opacity preserves the **estimated** diffuse sky
fraction. This is not an exact split: emissive, specular, unlit, already shadowed
and unusual native materials can be darkened incorrectly unless masked/provided
their actual direct term. Actual ambient preservation cannot be claimed for those
materials from a combined-HDR multiplication.

Where an actual direct term is available, use
`ccrCloudShadowDirect(source, direct, cloudVisibility)`. This subtracts only the
lost direct contribution, leaves source alpha unchanged, and preserves the actual
indirect, emissive and reflection remainder. Clamp guards bound subtraction to the
positive source RGB. For future deferred integration, multiplying the existing
`direct` variable by cloud visibility **before** summing the lighting terms is the
exact insertion point and avoids an extra direct buffer. Native terrain still
needs its own direct-light hook or the documented approximation.

The receiver helper evaluates one shared sunlight march per eligible pixel. It has
no shadow cache, cascade coverage, penumbra filter, or shadow-only history. Node
tests cover the numerical composition and shader contract; they do not establish
real terrain/building visual quality, GPU cost or temporal stability.
