// Shared decoding contract. The RGBA32F fallback retains the original v0 layout.
export const geometryEncodingShader = `
vec2 geometrySign(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
vec4 encodeGeometry(vec3 normalEC, float depth) {
#ifdef GEOMETRY_PACKED_V1
  if (!(depth > 0.0 && depth <= 60000000.0)) return vec4(0.0);
  vec3 n = normalEC / (abs(normalEC.x) + abs(normalEC.y) + abs(normalEC.z));
  vec2 oct = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * geometrySign(n.xy);
  // Split scaled depth into a half-rounded high part and a half residual. One
  // half-float metre channel loses metres at campus distances and overflows at 65km.
  float scaled = depth / 1024.0;
  float high = unpackHalf2x16(packHalf2x16(vec2(scaled, 0.0))).x;
  return vec4(oct * 0.5 + 0.5, high, scaled - high);
#else
  return vec4(normalEC * 0.5 + 0.5, depth);
#endif
}
// Return decoded normal.xyz and positive eye-depth metres; zero means invalid.
vec4 decodeGeometry(vec4 encoded) {
#ifdef GEOMETRY_PACKED_V1
  if (encoded.b <= 0.0) return vec4(0.0);
  vec2 oct = encoded.rg * 2.0 - 1.0;
  vec3 n = vec3(oct, 1.0 - abs(oct.x) - abs(oct.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * geometrySign(n.xy);
  return vec4(normalize(n), (encoded.b + encoded.a) * 1024.0);
#else
  if (encoded.a <= 0.0) return vec4(0.0);
  return vec4(normalize(encoded.rgb * 2.0 - 1.0), encoded.a);
#endif
}`

// Diagnostic readback helper; rendering consumers use the same GLSL decoder.
export function decodeGeometryTexel(value, encoding) {
  if (encoding !== 'oct-normal-depth-pair-v1') {
    return value[3] > 0 ? [...value.slice(0, 3).map(v => v * 2 - 1), value[3]] : [0, 0, 0, 0]
  }
  if (value[2] <= 0) return [0, 0, 0, 0]
  let x = value[0] * 2 - 1, y = value[1] * 2 - 1
  const z = 1 - Math.abs(x) - Math.abs(y)
  if (z < 0) {
    const previousX = x
    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1)
    y = (1 - Math.abs(previousX)) * (y >= 0 ? 1 : -1)
  }
  const length = Math.hypot(x, y, z)
  return [x / length, y / length, z / length, (value[2] + value[3]) * 1024]
}
