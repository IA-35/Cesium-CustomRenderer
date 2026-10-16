/**
 * Cloud receiver integration. Extinction is evaluated by the visible cloud's shared
 * ccrCloudSunVisibility; this module does not implement the upstream cascaded map.
 * See reference/three-clouds/CLOUD_SHADOW_PORT.md for the HDR approximation boundary.
 */
const clamp = value => Math.max(0, Math.min(1, value))

// Numeric reference for fixtures: irradiances must use the same linear units.
export function cloudShadowTransmission({ visibility, validSurface, surfaceDistance,
  maxReceiverDistance, normalDotSun, sunIrradiance, skyIrradiance }) {
  if (!validSurface || !(surfaceDistance > 0 && surfaceDistance <= maxReceiverDistance)) return [1, 1, 1]
  const t=clamp((surfaceDistance/maxReceiverDistance-0.7)/0.3)
  const rangeWeight=1-t*t*(3-2*t)
  const cosine = Math.max(normalDotSun, 0)
  return sunIrradiance.map((value, index) => {
    const sun = Math.max(value, 0) * cosine
    const sky = Math.max(skyIrradiance[index], 0)
    return 1 - rangeWeight * (1 - clamp(visibility)) * sun / Math.max(sun + sky, 1e-6)
  })
}

// Exact only when direct is the actual direct term already included in source.
export function cloudShadowDirect(source, direct, visibility) {
  return source.map((value, index) => index === 3 ? value
    : value - Math.min(Math.max(direct[index], 0), Math.max(value, 0)) * (1 - clamp(visibility)))
}

/**
 * Append after cloudGLSL. Requires sunDirectionAtmo, ccrCloudSunVisibility and
 * ccrCloudDistanceFade; only the receiver influence fades, not the light path.
 * positionAtmo/normalAtmo use the cloud's planet-centred metre frame. The caller
 * supplies a unit normal, valid depth mask and a metric receiver distance limit.
 * Sun irradiance may include atmospheric and opaque-surface visibility; do not
 * include cloud visibility twice. Sky irradiance is already hemisphere-integrated.
 */
export function cloudShadowGLSL() {
  return `
// Direct-only composition for hosts with a separate, already shaded direct term.
vec4 ccrCloudShadowDirect(vec4 source, vec3 direct, float visibility) {
  vec3 boundedDirect = min(max(direct, vec3(0.0)), max(source.rgb, vec3(0.0)));
  return vec4(source.rgb - boundedDirect * (1.0 - clamp(visibility, 0.0, 1.0)), source.a);
}

// Combined HDR cannot expose its direct term. Estimate only the diffuse sun share;
// the sky share survives full cloud extinction. Emissive/specular are not isolated.
vec3 ccrCloudSurfaceTransmission(vec3 positionAtmo, vec3 normalAtmo,
    float surfaceDistance, float maxReceiverDistance, bool validSurface,
    vec3 sunIrradiance, vec3 skyIrradiance) {
  if (!validSurface || !(surfaceDistance > 0.0 && surfaceDistance <= maxReceiverDistance)) return vec3(1.0);
  float cosine = max(dot(normalAtmo, sunDirectionAtmo), 0.0);
  vec3 sun = max(sunIrradiance, vec3(0.0)) * cosine;
  if (max(sun.r, max(sun.g, sun.b)) <= 0.0) return vec3(1.0);
  vec3 sky = max(skyIrradiance, vec3(0.0));
  vec3 directFraction = sun / max(sun + sky, vec3(1.0e-6));
  float visibility = clamp(ccrCloudSunVisibility(positionAtmo), 0.0, 1.0);
  float rangeWeight = ccrCloudDistanceFade(surfaceDistance, maxReceiverDistance);
  return vec3(1.0) - rangeWeight * (1.0 - visibility) * directFraction;
}
`
}
