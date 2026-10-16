// Whole periodic texture volumes in metres, independent of atlas packing.
// Internal Perlin/Worley frequencies subdivide these periods into cloud features.
export const CLOUD_NOISE_PERIODS = Object.freeze({
  weather: Object.freeze([32000,32000,32000]),
  shape: Object.freeze([16000,16000,16000]),
  detail: Object.freeze([1200,1200,1200])
})

const vector = values => `vec${values.length}(${values.map(v=>v.toFixed(1)).join(',')})`
export const cloudSpatialGLSL = `
const vec2 CCR_CLOUD_WEATHER_PERIOD = ${vector(CLOUD_NOISE_PERIODS.weather.slice(0,2))};
const vec3 CCR_CLOUD_SHAPE_PERIOD = ${vector(CLOUD_NOISE_PERIODS.shape)};
const vec3 CCR_CLOUD_DETAIL_PERIOD = ${vector(CLOUD_NOISE_PERIODS.detail)};
`
