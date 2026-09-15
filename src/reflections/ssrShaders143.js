import { cameraBlockGLSL } from '../buffers/CameraUniforms143.js'

export const reflectionCommon = `
precision highp float;
precision highp int;
uniform highp sampler2D u_depth;
uniform highp sampler2D u_material;
uniform highp sampler2D u_flags;
uniform highp sampler2D u_transparency;
uniform highp sampler2D u_specular;
uniform highp sampler2D u_response;
#ifdef CAMPUS_REFLECTION_UBO
${cameraBlockGLSL}
layout(std140) uniform CampusReflection {
    vec4 campusReflection;
};
#define u_inverseProjection campusInverseProjection
#define u_projection campusProjection
#define u_near campusClip.x
#define u_distance campusReflection.x
#define u_thickness campusReflection.y
#define u_strength campusReflection.z
#define u_maxLevel int(campusReflection.w)
#else
uniform mat4 u_inverseProjection;
uniform float u_strength;
#endif
in vec2 v_textureCoordinates;
bool reflectionInside(ivec2 p) {
    return all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, textureSize(u_depth, 0)));
}
vec3 reflectionNormal(ivec2 p) {
    vec2 xy = texelFetch(u_material, p, 0).rg * 2.0 - 1.0;
    vec3 n = vec3(xy, 1.0 - abs(xy.x) - abs(xy.y));
    if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    return normalize(n);
}
vec3 reflectionPosition(ivec2 p) {
    vec2 uv = (vec2(p) + 0.5) / vec2(textureSize(u_depth, 0));
    vec4 h = u_inverseProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    return h.xyz * (texelFetch(u_depth, p, 0).r / -h.z);
}
bool reflectionReceiver(ivec2 p) {
    if (!reflectionInside(p) || texelFetch(u_depth, p, 0).r <= 0.0 || texelFetch(u_transparency, p, 0).r > 0.0) return false;
    int flags = int(texelFetch(u_flags, p, 0).a + 0.5);
    return (flags & 3) == 3 && (flags & (16 | 32 | 64)) == 0 && texelFetch(u_specular, p, 0).a > 0.5;
}
ivec2 reflectionAnchor(ivec2 p) { return min(p * 2, textureSize(u_depth, 0) - 1); }
`

export const traceFunctions = `
uniform highp sampler2D u_hiz0;
uniform highp sampler2D u_hiz1;
uniform highp sampler2D u_hiz2;
uniform highp sampler2D u_hiz3;
uniform highp sampler2D u_hiz4;
#ifndef CAMPUS_REFLECTION_UBO
uniform int u_maxLevel;
uniform mat4 u_projection;
uniform float u_distance;
uniform float u_thickness;
uniform float u_near;
#endif
vec4 reflectionBounds(ivec2 pixel, int level) {
    if (level == 0) {
        float d = texelFetch(u_depth, pixel, 0).r;
        bool transparent = false;
        #ifndef REFLECTION_TRANSPARENT_RECEIVER
        transparent = texelFetch(u_transparency, pixel, 0).r > 0.0;
        #endif
        return vec4(max(d, 0.0), max(d, 0.0), d > 0.0 && !transparent ? 1.0 : 0.0, d < 0.0 || transparent ? 1.0 : 0.0);
    }
    ivec2 cell = pixel / (1 << level);
    vec4 bounds;
    if (level == 1) bounds = texelFetch(u_hiz0, cell, 0);
    else if (level == 2) bounds = texelFetch(u_hiz1, cell, 0);
    else if (level == 3) bounds = texelFetch(u_hiz2, cell, 0);
    else if (level == 4) bounds = texelFetch(u_hiz3, cell, 0);
    else bounds = texelFetch(u_hiz4, cell, 0);
    #ifdef REFLECTION_TRANSPARENT_RECEIVER
    bounds.a = float(int(bounds.a + 0.5) & 1);
    #endif
    return bounds;
}
float reflectionRayDepth(float t, vec2 inverseDepth) { return 1.0 / mix(inverseDepth.x, inverseDepth.y, t); }

// Fade while a hit approaches a visibility/trace boundary, before it becomes a
// hard miss. The resolve blends this confidence with the existing native IBL.
float reflectionHitConfidence(vec2 uv, float facing, float projectedLength, float budgetFraction, float roughness) {
    float border = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    float footprint = mix(0.08, 0.16, clamp(roughness, 0.0, 1.0));
    return smoothstep(0.0, footprint, border)
        * smoothstep(0.02, 0.18, facing)
        * smoothstep(2.0, 12.0, projectedLength)
        * (1.0 - smoothstep(0.75, 1.0, budgetFraction))
        * (1.0 - smoothstep(0.5, 0.85, roughness));
}

// Screen-linear DDA with perspective-correct depth. Coarse Hi-Z cells are skipped
// only when their whole depth interval misses; ambiguous cells descend to pixels.
vec4 traceReflection(ivec2 receiver, vec3 position, vec3 normal, float roughness) {
    vec4 miss = vec4(0.0);
    if (roughness >= 0.85 || u_distance <= 0.0) return miss;
    vec3 direction = normalize(reflect(normalize(position), normal));
    vec3 start = position + normal * max(0.02, min(u_thickness * 0.25, 0.15));
    float distanceLimit = u_distance;
    if (direction.z > 0.0) distanceLimit = min(distanceLimit, (-u_near - start.z) / direction.z);
    if (distanceLimit <= 0.02 || start.z >= -u_near) return miss;
    vec3 finish = start + direction * distanceLimit;
    vec4 clip0 = u_projection * vec4(start, 1.0), clip1 = u_projection * vec4(finish, 1.0);
    if (clip0.w <= 0.0 || clip1.w <= 0.0) return miss;
    vec2 size = vec2(textureSize(u_depth, 0));
    vec2 screen0 = (clip0.xy / clip0.w * 0.5 + 0.5) * size;
    vec2 screen1 = (clip1.xy / clip1.w * 0.5 + 0.5) * size;
    vec2 delta = screen1 - screen0;
    float lengthPixels = length(delta);
    if (lengthPixels < 2.0) return miss;
    vec2 inverseDepth = vec2(1.0 / -start.z, 1.0 / -finish.z);
    float epsilon = 0.002 / max(abs(delta.x), abs(delta.y));
    float t = 1.5 / lengthPixels;
    int level = min(5, u_maxLevel);
    int budget = int(mix(160.0, 80.0, roughness));
    for (int step = 0; step < 160; ++step) {
        if (step >= budget || t >= 1.0) return miss;
        vec2 screen = screen0 + delta * t;
        ivec2 pixel = ivec2(floor(screen));
        if (!reflectionInside(pixel)) return miss;
        float cellSize = float(1 << level);
        vec2 cell = floor(screen / cellSize);
        vec2 edge = (cell + vec2(delta.x >= 0.0 ? 1.0 : 0.0, delta.y >= 0.0 ? 1.0 : 0.0)) * cellSize;
        vec2 exitT = vec2(abs(delta.x) > 0.00001 ? (edge.x - screen0.x) / delta.x : 1.0e20,
                         abs(delta.y) > 0.00001 ? (edge.y - screen0.y) / delta.y : 1.0e20);
        float nextT = min(1.0, max(t + epsilon, min(exitT.x, exitT.y)));
        float a = reflectionRayDepth(t, inverseDepth), b = reflectionRayDepth(nextT, inverseDepth);
        vec4 bounds = reflectionBounds(pixel, level);
        bool overlap = bounds.r > 0.0 && max(a, b) >= bounds.r && min(a, b) <= bounds.g + u_thickness;
        if (bounds.a > 0.5 || overlap) {
            if (level > 0) { level--; continue; }
            if (bounds.a > 0.5) return miss;
            #ifndef REFLECTION_TRANSPARENT_RECEIVER
            if (texelFetch(u_transparency, pixel, 0).r > 0.0) return miss;
            #endif
            if (length(vec2(pixel - receiver)) > 2.0 && overlap) {
                int flags = int(texelFetch(u_flags, pixel, 0).a + 0.5);
                float facing = dot(reflectionNormal(pixel), -direction);
                if ((flags & 2) == 0 || facing <= 0.02) return miss;
                vec2 uv = (vec2(pixel) + 0.5) / size;
                float confidence = reflectionHitConfidence(uv, facing, lengthPixels, float(step) / float(budget), roughness);
                confidence *= 1.0 - smoothstep(0.85, 1.0, t);
                vec3 hitPosition = mix(start / clip0.w, finish / clip1.w, t) / mix(1.0 / clip0.w, 1.0 / clip1.w, t);
                return vec4(uv, confidence, length(hitPosition - start));
            }
        }
        t = nextT + epsilon;
        level = min(level + 1, min(5, u_maxLevel));
    }
    return miss;
}
`

export const traceShader = `${reflectionCommon}
uniform highp sampler2D colorTexture;
${traceFunctions}
void main() {
    out_FragColor = vec4(0.0);
    ivec2 p = reflectionAnchor(ivec2(gl_FragCoord.xy));
    if (u_strength <= 0.0 || !reflectionReceiver(p)) return;
    float roughness = texelFetch(u_response, p, 0).a;
    vec4 hit = traceReflection(p, reflectionPosition(p), reflectionNormal(p), roughness);
    if (hit.z > 0.0) {
        ivec2 target = min(ivec2(hit.xy * vec2(textureSize(u_depth, 0))), textureSize(u_depth, 0) - 1);
        out_FragColor = vec4(texelFetch(colorTexture, target, 0).rgb, hit.z);
    }
}`

export const resolveShader = `${reflectionCommon}
uniform highp sampler2D colorTexture;
uniform highp sampler2D u_reflection;
void main() {
    vec4 original = texture(colorTexture, v_textureCoordinates);
    out_FragColor = original;
    ivec2 p = min(ivec2(v_textureCoordinates * vec2(textureSize(u_depth, 0))), textureSize(u_depth, 0) - 1);
    if (u_strength <= 0.0 || !reflectionReceiver(p)) return;
    // A blocked/missing center ray keeps its native environment reflection.
    // Neighbor filtering must not resurrect rays rejected by visibility tests.
    float centerConfidence = texelFetch(u_reflection, p / 2, 0).a;
    if (centerConfidence <= 0.0) return;
    vec3 position = reflectionPosition(p), normal = reflectionNormal(p);
    vec4 response = texelFetch(u_response, p, 0);
    vec2 halfPosition = vec2(p) * 0.5;
    ivec2 base = ivec2(floor(halfPosition));
    vec3 sum = vec3(0.0);
    float weightSum = 0.0, confidenceSum = 0.0;
    int radius = response.a > 0.15 ? 2 : 1;
    for (int y = -2; y <= 2; ++y) for (int x = -2; x <= 2; ++x) {
        if (abs(x) > radius || abs(y) > radius) continue;
        ivec2 q = base + ivec2(x, y);
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, textureSize(u_reflection, 0)))) continue;
        ivec2 samplePixel = reflectionAnchor(q);
        if (!reflectionReceiver(samplePixel)) continue;
        vec3 offset = reflectionPosition(samplePixel) - position;
        float separation = abs(dot(offset, normal));
        float joint = exp(-separation / max(0.02, -position.z * 0.002)) * pow(max(dot(normal, reflectionNormal(samplePixel)), 0.0), 32.0);
        joint *= exp(-abs(response.a - texelFetch(u_response, samplePixel, 0).a) * 24.0);
        vec2 pixelDelta = vec2(q) - halfPosition;
        float weight = joint * exp(-dot(pixelDelta, pixelDelta) / mix(0.6, 4.0, response.a));
        vec4 value = texelFetch(u_reflection, q, 0);
        sum += value.rgb * value.a * weight;
        confidenceSum += value.a * weight;
        weightSum += weight;
    }
    if (confidenceSum <= 0.00001 || weightSum <= 0.00001) return;
    vec3 radiance = sum / confidenceSum;
    float confidence = clamp(min(centerConfidence, confidenceSum / weightSum) * u_strength, 0.0, 1.0);
    vec3 nativeSpecular = texelFetch(u_specular, p, 0).rgb;
    out_FragColor = vec4(max(original.rgb + confidence * (radiance * response.rgb - nativeSpecular), vec3(0.0)), original.a);
}`
