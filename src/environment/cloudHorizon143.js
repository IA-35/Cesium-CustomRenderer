// Pitch/FOV locate the upper visible ray; range is decided against the actual
// cloud layer at the local fade distance, rather than the solid-ground horizon.
export function cloudHorizonBlend(pitch, fovy, height, radius = 6371000, cloudBase = 1600, localDistance = 40000) {
  if (![pitch,fovy,height].every(Number.isFinite)) return 0
  const smooth = t => { t=Math.max(0,Math.min(1,t));return t*t*(3-2*t) }
  // Outside the local camera neighbourhood retain the original distance cap
  // independently of orientation. Never unlock planetary clouds from orbit.
  const proximity=1-smooth((Math.max(height,0)-localDistance)/localDistance)
  if(proximity<=0)return 0
  const r=radius+Math.max(height,0),layer=radius+cloudBase,distance=localDistance*0.7
  const layerCutoff=Math.asin(Math.max(-1,Math.min(1,((layer-r)*(layer+r)-distance*distance)/(2*r*distance))))
  // Below the layer, shallow upward rays meet the cloud only in the distance;
  // the same chord threshold reverses sense. Never shrink before the solid
  // horizon leaves the view in that configuration.
  const cutoff=Math.min(layerCutoff,-Math.acos(radius/r))
  const visibleAngle = pitch + fovy * 0.5 - cutoff
  const t = Math.max(0,Math.min(1,visibleAngle / (5*Math.PI/180)))
  const steep = Math.max(0,Math.min(1,(pitch+Math.PI/3)/(Math.PI/12)))
  return t*t*(3-2*t) * steep*steep*(3-2*steep) * proximity
}

export const cloudHorizonGLSL = `
uniform float cloudHorizonBlend;
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
