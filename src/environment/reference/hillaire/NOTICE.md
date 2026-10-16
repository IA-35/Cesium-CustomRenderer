# Hillaire atmosphere adaptation

The LUT backend and GLSL port in `../../AtmosphereLut143.js` and
`../../hillaireAtmosphereGLSL143.js` adapt the atmosphere implementation of
[Xiaobai-grow/webgpu-cesium](https://github.com/Xiaobai-grow/webgpu-cesium),
revision `68032f3a574f136470dd13960cf6350070a3026b`, licensed under Apache-2.0.
The upstream license is included as `LICENSE`. The pinned source files copied
into this directory preserve their upstream attribution and comments:

- `HillaireAtmosphere.ts`: LUT dimensions, dependency order, invalidation and lifecycle structure.
- `common.wgsl`: sphere intersections, kilometre-space geometry, transmittance parameterization and phase functions.
- `transmittance.wgsl`: optical-depth integration into a 256 by 64 texture.
- `multiscatter.wgsl`: Fibonacci angular quadrature and 32 by 32 LUT layout.
- `skyview.wgsl`: 192 by 108 sky texture and separated view/light integration.

The underlying technique is Sebastien Hillaire, *A Scalable and Production Ready
Sky and Atmosphere Rendering Technique*, EGSR 2020.

## Changes in CCR

This is a GLSL fragment-pass port for WebGL2, with no WebGPU compute dependency.
The medium retains CCR's existing atmosphere reference: Rayleigh/Mie/absorption
coefficients, exponential scale heights, Rayleigh-weighted ozone bell and runtime
aerosol multiplier/anisotropy. Runtime metre-space tangent-sphere coordinates are
converted to kilometres only inside LUT math. The caller supplies a WGS84-derived
tangent-sphere radius and camera height; the backend never treats ellipsoid ECEF
length as geodetic height.

The upstream midpoint multiple-scattering approximation is replaced by integrated
single-scattered radiance and isotropic scattering transfer over 64 directions and
32 samples, including Lambertian ground bounce, followed by the Hillaire geometric
series `Psi = L2 / (1 - fms)`. Ground shadow explicitly gates sunlight. Sky uses 40
view samples, T/M lookups, exact constant-segment integration and a continuous
geometric-horizon parameterization. Production sun queries do not march sun rays.
T/M/Sky quadrature concentrates samples around the ray segment's closest approach
to the planet: ascending rays sample densely at entry, descending rays at exit,
and tangent rays split at their minimum altitude. This also covers orbital cameras
by clipping the view integration to the actual atmosphere entry/ground exit.

All stored radiance is normalized to unit incoming unattenuated solar radiance.
CCR multiplies its calibrated solar radiance once after sampling; exposure and
tone mapping remain outside these LUTs. The multi-scattering approximation is
isotropic; `pi * Psi` is an approximate diffuse sky irradiance for cloud lighting,
not an exact hemispherical integration of Sky-View.

The sky LUT contains atmosphere along downward directions up to ground contact;
Cesium continues to own visible terrain/globe radiance. No artificial ground
colour, night sky, stellar contribution, exposure, solar disc, day fade or cloud
weather colour is baked into the LUTs.

Two allocated versions of each attachment allow atomic publication of all texture
references, medium uniforms and invalidation keys after successful execution.
Sky-only updates swap their own attachment without rerendering T/M. A failed
update retains the previous complete published version and retries next frame.
RGBA16F is preferred; RGBA32F is used if half float is unsupported/incomplete.
Manual bilinear filtering handles devices without the corresponding float-linear
texture capability.
Context loss discards the dead GPU versions; restoration must complete a fresh
T/M/Sky build before the backend advertises readiness again.
