// CPU reference for the GPU interval contract. Coordinates are in the ellipsoid's
// normalized spherical space, in metres; direction is unit length in that space.
export function cloudShellIntervals(origin, direction, radius, base, top, limit = 20000000) {
  const length = Math.hypot(...origin), height = length - radius
  const b = origin.reduce((sum, value, index) => sum + value * direction[index], 0)
  const roots = altitude => {
    const c = (height - altitude) * (2 * radius + height + altitude)
    const d = b * b - c
    if (d < 0) return null
    const q = -b - (b >= 0 ? 1 : -1) * Math.sqrt(d)
    if (Math.abs(q) < 1e-12) return [0, 0]
    return [q, c / q].sort((a, b) => a - b)
  }
  const outer = roots(top)
  if (!outer) return []
  const start = Math.max(0, outer[0])
  let end = Math.min(limit, outer[1])
  const earth = roots(0)
  if (earth && earth[0] >= 0) end = Math.min(end, earth[0])
  if (end <= start) return []
  const inner = roots(base)
  if (!inner || inner[1] <= start || inner[0] >= end) return [start, end]
  const result = []
  if (inner[0] > start) result.push(start, Math.min(end, inner[0]))
  if (inner[1] < end) result.push(Math.max(start, inner[1]), end)
  return result
}

// Stable quadratic c=(height-boundary)*(2R+height+boundary) avoids subtracting
// two ~4e13 squares near the ground. Positions below are camera-relative.
export const cloudShellGLSL = `
uniform mat3 eyeToShell;
uniform vec3 shellUp;
uniform vec2 shellRadiusHeight;
uniform vec3 shellNoiseOrigin;
uniform vec3 sunDirectionShell;

vec2 shellFadeRange() {
    // Fixed view-distance budget at every altitude, including views from orbit.
    return vec2(12000.0, 50000.0);
}
float shellDistanceVisibility(vec3 p) {
    vec2 range = shellFadeRange();
    return 1.0 - smoothstep(range.x, range.y, length(p));
}

float shellAltitude(vec3 p) {
    float r = shellRadiusHeight.x + shellRadiusHeight.y;
    float delta = 2.0 * r * dot(shellUp, p) + dot(p, p);
    return shellRadiusHeight.y + delta / (sqrt(max(r * r + delta, 0.0)) + r);
}
bool shellRoots(vec3 p, vec3 direction, float altitude, out vec2 roots) {
    float h = shellAltitude(p);
    float b = (shellRadiusHeight.x + shellRadiusHeight.y) * dot(shellUp, direction) + dot(p, direction);
    float c = (h - altitude) * (2.0 * shellRadiusHeight.x + h + altitude);
    float d = b * b - c;
    if (d < 0.0) return false;
    float q = -b - (b >= 0.0 ? 1.0 : -1.0) * sqrt(d);
    if (abs(q) < 0.000001) { roots = vec2(0.0); return true; }
    roots = vec2(min(q, c / q), max(q, c / q));
    return true;
}
vec4 shellIntervals(vec3 direction, float base, float top, float limit) {
    vec2 outer;
    if (!shellRoots(vec3(0.0), direction, top, outer)) return vec4(0.0);
    float start = max(outer.x, 0.0);
    float finish = min(outer.y, limit);
    vec2 earth;
    if (shellRoots(vec3(0.0), direction, 0.0, earth) && earth.x >= 0.0) finish = min(finish, earth.x);
    if (finish <= start) return vec4(0.0);
    vec2 inner;
    if (!shellRoots(vec3(0.0), direction, base, inner) || inner.y <= start || inner.x >= finish) return vec4(start, finish, 0.0, 0.0);
    vec4 result = vec4(0.0);
    if (inner.x > start) result.xy = vec2(start, min(finish, inner.x));
    if (inner.y < finish) result.zw = vec2(max(start, inner.y), finish);
    return result;
}
`
