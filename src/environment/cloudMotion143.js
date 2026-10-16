import { CLOUD_NOISE_PERIODS } from './cloudSpatial143.js'
const periodicOffset = (value, period) => ((value % period) + period) % period
const wrap = (field,values) => values.map((v,i)=>periodicOffset(v,CLOUD_NOISE_PERIODS[field][i]))

// Metric texture offsets wrap only after evolving each field independently. The
// unwrapped body displacement is retained for temporal reprojection across wraps.
// These velocities adapt CCR's existing motion; they are not upstream defaults.
export function resolveCloudMotion(seconds, enabled = true) {
  if (!enabled) return { weather: [0, 0, 0], shape: [0, 0, 0], detail: [0, 0, 0], displacement: [0, 0, 0] }
  const x = seconds * 8, y = seconds * 2
  const evolution = Math.sqrt(68) * Math.abs(seconds) * .25
  return {
    weather: wrap('weather',[x * .37,y * .37,0]),
    shape: wrap('shape',[x,y,-evolution]),
    detail: wrap('detail',[x * 1.73,y * 1.73,0]),
    displacement: [0 - x, 0 - y, evolution]
  }
}
