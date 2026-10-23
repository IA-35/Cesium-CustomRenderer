// Camera height alone decides how far the cloud layer may extend. Orientation is
// deliberately not an input: every ray is already clipped against the real shell
// and the scene depth, so a downward view cannot see more cloud than geometry
// allows, while a horizon view keeps the extension. Measured on the campus scene
// the former pitch/FOV terms changed nothing below 12 km; they only suppressed
// the layer for 40-80 km downward views, which this height ramp covers directly.
export function cloudHorizonBlend(height, localDistance = 40000) {
  if (!Number.isFinite(height)) return 0
  const smooth = t => { t=Math.max(0,Math.min(1,t));return t*t*(3-2*t) }
  // Outside the local camera neighbourhood retain the original distance cap
  // independently of orientation. Never unlock planetary clouds from orbit.
  return 1-smooth((Math.max(height,0)-localDistance)/localDistance)
}

export const cloudHorizonGLSL = `
uniform float cloudHorizonBlend;
float ccrCloudDistanceLod(float distance) {
  return smoothstep(8000.0,40000.0,distance);
}
float ccrCloudNextSample(float cursor,float sampleCount,float distance) {
  return min(cursor+mix(1.0,4.0,ccrCloudDistanceLod(distance)),sampleCount);
}
float ccrCloudViewRange(vec3 origin) {
  if(cloudHorizonBlend<=0.0)return CLOUD_MAX_DISTANCE;
  float radius=atmosphereParams.x;
  float height=max(length(origin-CCR_PLANET_POS)-radius,0.0);
  float top=max(cloudParams.z,0.0);
  // The longest unoccluded segment touches the solid planet horizon, then
  // reaches the far cloud shell. Keep the fade outside that physical extent.
  float horizon=sqrt(height*(2.0*radius+height))+sqrt(top*(2.0*radius+top));
  return mix(CLOUD_MAX_DISTANCE,max(CLOUD_MAX_DISTANCE,1.5*horizon),cloudHorizonBlend);
}
float ccrCloudViewPathDistance(float u,float pathLength) {
  float samplingBlend=cloudHorizonBlend*clamp(pathLength/CLOUD_MAX_DISTANCE-1.0,0.0,1.0);
  if(samplingBlend<=0.0)return u*pathLength;
  float scale=CLOUD_MAX_DISTANCE*0.15;
  float concentrated=scale*(exp(u*log(1.0+pathLength/scale))-1.0);
  return mix(u*pathLength,concentrated,samplingBlend);
}
`
