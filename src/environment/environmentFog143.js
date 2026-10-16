import { heightFogGLSL, heightFogOpticalDepth } from './heightFog143.js'

// Finite scene-depth fog, using the existing exponential-height model. Heights are metres
// above the tangent reference surface, never an ECEF component. The caller obtains the camera
// height from length(atmosphereOrigin) - planetRadius and the vertical slope from its local up.
// The planar helper below remains for local callers. Global rays must use the
// spherical adapter: a tangent plane extrapolates distant ground below sea level.
const MAX_DISTANCE = 20000000
const MAX_OPTICAL_DEPTH = 80

/** CPU counterpart of the GLSL adapter, checked against the independent Simpson reference. */
export function environmentFogOpticalDepth({ density0, baseHeight, scaleHeight,
  originHeight, upDotRay, distance }) {
  if (!(density0 > 0) || !(scaleHeight > 0) || !(distance > 0 && distance < MAX_DISTANCE)) return 0
  const slope = Math.max(-1, Math.min(1, upDotRay))
  const lowHeight = Math.min(originHeight, originHeight + slope * distance)
  // Reverse downward segments so the reusable integral only evaluates nonpositive exponents.
  // Taking the remaining density scale in log space prevents 0 * Infinity and overflow below
  // sea level or on a long downward ray, without clamping the requested base height.
  const path = heightFogOpticalDepth({ density0: 1, baseHeight: 0, scaleHeight,
    originZ: 0, directionZ: Math.abs(slope), end: distance })
  const logDepth = Math.log(density0) - (lowHeight - baseHeight) / scaleHeight + Math.log(path)
  return Math.exp(Math.min(logDepth, Math.log(MAX_OPTICAL_DEPTH)))
}

/** Curved finite ray, using analytic exponential integration on altitude-aware pieces. */
export function sphericalEnvironmentFogOpticalDepth({origin,direction,radius,distance,...profile}) {
  if(!(profile.density0>0&&profile.scaleHeight>0&&radius>0&&distance>0&&distance<MAX_DISTANCE))return 0
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0)
  const point=t=>origin.map((v,i)=>v+direction[i]*t)
  const sphere=r=>{
    const b=dot(origin,direction),length=Math.hypot(...origin),c=(length-r)*(length+r),h=b*b-c
    return h<0?[1e20,-1e20]:[-b-Math.sqrt(h),-b+Math.sqrt(h)]
  }
  const top=radius+Math.max(0,profile.baseHeight+12*profile.scaleHeight),hit=sphere(top)
  const start=Math.max(0,hit[0]),ground=sphere(radius)
  const finish=Math.min(distance,hit[1],ground[1]>=ground[0]&&ground[0]>0?ground[0]:distance)
  if(finish<=start)return 0
  const entry=point(start),span=finish-start,closest=Math.max(0,Math.min(span,-dot(entry,direction)))
  const at=u=>{
    if(closest<=0)return u*u*span
    if(closest>=span)return (1-(1-u)*(1-u))*span
    return u<0.5?closest*(1-(1-2*u)*(1-2*u)):closest+(span-closest)*(2*u-1)**2
  }
  let tau=0
  for(let i=0;i<16;i++){
    const a=at(i/16),b=at((i+1)/16),dt=b-a
    if(dt<=0)continue
    const heightA=Math.hypot(...point(start+a))-radius
    const heightB=Math.hypot(...point(start+b))-radius
    tau+=environmentFogOpticalDepth({...profile,originHeight:heightA,upDotRay:(heightB-heightA)/dt,distance:dt})
  }
  return Math.min(tau,MAX_OPTICAL_DEPTH)
}

/** Isotropic incident-radiance proxy: L = sourceRadiance * (1 - T), without direct sun. */
export function environmentFogTransport({ fog = true, volumetricFog = false,
  fogNoise = 0, noiseSample = 0.5, sourceRadiance = [0, 0, 0], ...parameters }) {
  if (!(fog || volumetricFog)) return { scattering: [0, 0, 0], transmittance: 1 }
  const amount = volumetricFog ? Math.max(0, Math.min(1, fogNoise)) : 0
  const modulation = 1 + amount * (2 * Math.max(0, Math.min(1, noiseSample)) - 1)
  const integrate=parameters.origin?sphericalEnvironmentFogOpticalDepth:environmentFogOpticalDepth
  const depth = integrate({ ...parameters, density0: parameters.density0 * modulation })
  const transmittance = Math.exp(-depth)
  return { scattering: sourceRadiance.map(value => Math.max(0, value) * (1 - transmittance)), transmittance }
}

// Include after effectFlags is declared. fogParams = (extinction/metre, scaleHeight/metres,
// optional density-noise amount, reserved); fogBaseHeight uses the same height datum as origin.
// The host MUST gate this on actual finite scene depth BEFORE synthetic ground intersection:
// segment lengths alone cannot distinguish a sky ray from a surface ray. A sky ray keeps its
// accepted atmosphere/cloud transport. The depth sentinel below is an additional identity guard.
// sourceRadiance is linear HDR incident isotropic radiance (e.g. skyRadiance or irradiance / PI).
// No new exposure, direct-sun term or multiple-scattering claim is introduced. A neutral atlas
// sample is 0.5; only effectFlags.w enables its bounded modulation, sampled by the host.
export const environmentFogGLSL = `
uniform vec4 fogParams;
uniform float fogBaseHeight;
${heightFogGLSL}

float ccrHeightFogOpticalDepth(float originHeight, float upDotRay, float distance, float densityMultiplier) {
  float density = fogParams.x * densityMultiplier;
  if (!(density > 0.0) || !(fogParams.y > 0.0) || !(distance > 0.0 && distance < 20000000.0)) return 0.0;
  float slope = clamp(upDotRay, -1.0, 1.0);
  float lowHeight = min(originHeight, originHeight + slope * distance);
  float path = ccrHeightFogDepth(1.0, 0.0, fogParams.y, 0.0, abs(slope), 0.0, distance);
  float logDepth = log(density) - (lowHeight - fogBaseHeight) / fogParams.y + log(path);
  return exp(min(logDepth, log(80.0)));
}

float ccrHeightFogOpticalDepth(float originHeight, float upDotRay, float distance) {
  return ccrHeightFogOpticalDepth(originHeight, upDotRay, distance, 1.0);
}

vec4 ccrEnvironmentFogTransport(float originHeight, float upDotRay, float distance,
                              vec3 sourceRadiance, float noiseSample) {
  if (!(effectFlags.x > 0.5 || effectFlags.w > 0.5)) return vec4(0.0, 0.0, 0.0, 1.0);
  float amount = effectFlags.w > 0.5 ? clamp(fogParams.z, 0.0, 1.0) : 0.0;
  float modulation = 1.0 + amount * (2.0 * clamp(noiseSample, 0.0, 1.0) - 1.0);
  float tau = ccrHeightFogOpticalDepth(originHeight, upDotRay, distance, modulation);
  float transmittance = exp(-tau);
  return vec4(max(sourceRadiance, vec3(0.0)) * (1.0 - transmittance), transmittance);
}

vec2 ccrFogSphere(vec3 origin,vec3 direction,float radius) {
  float b=dot(origin,direction),r=length(origin);
  float h=b*b-(r-radius)*(r+radius);
  if(h<0.0)return vec2(1e20,-1e20);
  float s=sqrt(h);return vec2(-b-s,-b+s);
}
float ccrFogPathDistance(float u,float span,float closest) {
  if(closest<=0.0)return u*u*span;
  if(closest>=span)return (1.0-(1.0-u)*(1.0-u))*span;
  if(u<0.5)return closest*(1.0-(1.0-2.0*u)*(1.0-2.0*u));
  return closest+(span-closest)*(2.0*u-1.0)*(2.0*u-1.0);
}
float ccrSphericalFogOpticalDepth(vec3 origin,vec3 direction,float radius,float distance,float multiplier) {
  if(!(fogParams.x*multiplier>0.0&&fogParams.y>0.0&&distance>0.0&&distance<20000000.0))return 0.0;
  float top=radius+max(0.0,fogBaseHeight+12.0*fogParams.y);
  vec2 hit=ccrFogSphere(origin,direction,top),ground=ccrFogSphere(origin,direction,radius);
  float start=max(hit.x,0.0),finish=min(hit.y,distance);
  if(ground.y>=ground.x&&ground.x>0.0)finish=min(finish,ground.x);
  if(finish<=start)return 0.0;
  vec3 entry=origin+direction*start;
  float span=finish-start,closest=clamp(-dot(entry,direction),0.0,span),tau=0.0;
  for(int i=0;i<16;i++) {
    float a=ccrFogPathDistance(float(i)/16.0,span,closest);
    float b=ccrFogPathDistance(float(i+1)/16.0,span,closest),dt=b-a;
    if(dt<=0.0)continue;
    float heightA=length(entry+direction*a)-radius;
    float heightB=length(entry+direction*b)-radius;
    tau+=ccrHeightFogOpticalDepth(heightA,(heightB-heightA)/dt,dt,multiplier);
  }
  return min(tau,80.0);
}
vec4 ccrSphericalFogTransport(vec3 origin,vec3 direction,float radius,float distance,
    vec3 sourceRadiance,float noiseSample) {
  if(!(effectFlags.x>0.5||effectFlags.w>0.5))return vec4(0.0,0.0,0.0,1.0);
  float amount=effectFlags.w>0.5?clamp(fogParams.z,0.0,1.0):0.0;
  float modulation=1.0+amount*(2.0*clamp(noiseSample,0.0,1.0)-1.0);
  float transmittance=exp(-ccrSphericalFogOpticalDepth(origin,direction,radius,distance,modulation));
  return vec4(max(sourceRadiance,vec3(0.0))*(1.0-transmittance),transmittance);
}
`
