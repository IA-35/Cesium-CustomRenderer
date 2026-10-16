// Independent night sources in CCR's linear HDR scale, not SI radiance.
// Directions use the same rotated planet-centred tangent frame as the atmosphere.
export const nightLightUniformsGLSL = `
uniform vec3 moonDirectionAtmo;
uniform vec3 moonRadiance;
uniform vec3 nightSkyRadiance;
`

// Reuse the committed medium T/M for another incident direction. SkyView is
// solar-direction dependent, so it cannot be queried as a lunar sky texture.
export const nightAtmosphereGLSL = `
vec3 ccrNightAtmosphere(vec3 origin,vec3 direction,float distance) {
  if(max(max(moonRadiance.r,moonRadiance.g),moonRadiance.b)<=0.0
      && max(max(nightSkyRadiance.r,nightSkyRadiance.g),nightSkyRadiance.b)<=0.0) return vec3(0.0);
#ifdef CCR_ATMOSPHERE_LUT
  if(atmosphereLutReady) {
    vec3 start=origin*0.001;
    vec2 hit=ccrLutSphere(start,direction,ccrLutTop());
    float entry=max(hit.x,0.0),finish=min(hit.y,distance*0.001);
    if(finish<=entry)return vec3(0.0);
    vec3 throughput=vec3(1.0),radiance=vec3(0.0);
    float pr=ccrLutRayleighPhase(dot(direction,moonDirectionAtmo));
    float pm=ccrLutMiePhase(dot(direction,moonDirectionAtmo));
    for(int i=0;i<ATMOS_OUTER_STEPS;i++) {
      float t0=ccrLutPathDistance(float(i)/float(ATMOS_OUTER_STEPS),finish-entry,start+direction*entry,direction);
      float t1=ccrLutPathDistance(float(i+1)/float(ATMOS_OUTER_STEPS),finish-entry,start+direction*entry,direction);
      vec3 p=start+direction*(entry+0.5*(t0+t1));
      vec3 rayleigh,mie,extinction;ccrLutMedium(p,rayleigh,mie,extinction);
      vec3 source=(rayleigh+mie)*nightSkyRadiance;
      if(max(max(moonRadiance.r,moonRadiance.g),moonRadiance.b)>0.0) {
        vec3 moon=(rayleigh*pr+mie*pm)*ccrLutTransmittanceKm(p,moonDirectionAtmo)
          +(rayleigh+mie)*ccrLutMultipleScatteringKm(p,moonDirectionAtmo);
        source+=moon*moonRadiance;
      }
      radiance+=throughput*source*ccrLutIntegralWeight(extinction,t1-t0);
      throughput*=exp(-extinction*(t1-t0));
    }
    return radiance;
  }
#endif
  // The analytic compatibility branch has no second light LUT. Preserve a
  // bounded cool ambient medium rather than changing the golden solar integral.
  vec3 transmission=ccrAtmosphereViewTransmission(origin,direction,distance);
  return nightSkyRadiance*(vec3(1.0)-transmission);
}
`
