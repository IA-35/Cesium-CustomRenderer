// Deterministic screen-space AO. Resolve attenuates non-emissive HDR lighting,
// including direct light; it does not isolate Cesium's IBL contribution.
export const common = `
uniform highp sampler2D u_depth;
uniform highp sampler2D u_material;
uniform highp sampler2D u_flags;
uniform highp sampler2D u_hiz;
uniform highp sampler2D u_transparency;
uniform mat4 u_inverseProjection;
uniform float u_radius;
uniform float u_strength;
uniform float u_bias;
in vec2 v_textureCoordinates;

bool aoInside(ivec2 pixel) {
    ivec2 size = textureSize(u_depth, 0);
    return all(greaterThanEqual(pixel, ivec2(0))) && all(lessThan(pixel, size));
}
bool aoFinite(float value) { return !isnan(value) && !isinf(value); }
bool aoTransparentCell(ivec2 pixel) {
    ivec2 base = (pixel / 2) * 2;
    for (int y = 0; y < 2; ++y) {
        for (int x = 0; x < 2; ++x) {
            ivec2 covered = base + ivec2(x, y);
            if (aoInside(covered) && texelFetch(u_transparency, covered, 0).r > 0.0) return true;
        }
    }
    return false;
}
bool aoReceiver(ivec2 pixel) {
    if (!aoInside(pixel)) return false;
    if (texelFetch(u_transparency, pixel, 0).r > 0.0) return false;
    float depth = texelFetch(u_depth, pixel, 0).r;
    float flagsValue = texelFetch(u_flags, pixel, 0).a;
    if (!aoFinite(depth) || depth <= 0.0 || !aoFinite(flagsValue)) return false;
    int flags = int(flagsValue + 0.5);
    return (flags & 3) == 3 && (flags & (16 | 32 | 64)) == 0;
}
vec3 aoNormal(ivec2 pixel) {
    vec2 oct = texelFetch(u_material, pixel, 0).rg * 2.0 - 1.0;
    vec3 normal = vec3(oct, 1.0 - abs(oct.x) - abs(oct.y));
    vec2 direction = vec2(normal.x >= 0.0 ? 1.0 : -1.0, normal.y >= 0.0 ? 1.0 : -1.0);
    if (normal.z < 0.0) normal.xy = (1.0 - abs(normal.yx)) * direction;
    return normalize(normal);
}
vec3 aoPosition(ivec2 pixel) {
    vec2 uv = (vec2(pixel) + 0.5) / vec2(textureSize(u_depth, 0));
    vec4 projected = u_inverseProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec3 ray = projected.xyz / projected.w;
    return ray * (texelFetch(u_depth, pixel, 0).r / -ray.z);
}
ivec2 aoAnchor(ivec2 halfPixel) {
    return min(halfPixel * 2, textureSize(u_depth, 0) - 1);
}
bool aoTangent(ivec2 pixel, ivec2 axis, vec3 position, out vec3 tangent) {
    bool positive = aoReceiver(pixel + axis);
    bool negative = aoReceiver(pixel - axis);
    if (!positive && !negative) return false;
    vec3 forward = positive ? aoPosition(pixel + axis) - position : vec3(0.0);
    vec3 backward = negative ? position - aoPosition(pixel - axis) : vec3(0.0);
    tangent = positive && (!negative || abs(forward.z) <= abs(backward.z)) ? forward : backward;
    // A distant neighbor cannot establish the receiver's local surface plane.
    float tangentLengthSquared = dot(tangent, tangent);
    return tangentLengthSquared > 1.0e-12 && tangentLengthSquared <= u_radius * u_radius;
}
bool aoGeometricNormal(ivec2 pixel, vec3 position, out vec3 normal) {
    vec3 horizontal;
    vec3 vertical;
    if (!aoTangent(pixel, ivec2(1, 0), position, horizontal) ||
        !aoTangent(pixel, ivec2(0, 1), position, vertical)) return false;
    normal = cross(horizontal, vertical);
    float lengthSquared = dot(normal, normal);
    if (!aoFinite(lengthSquared) || lengthSquared <= 1.0e-12) return false;
    normal *= inversesqrt(lengthSquared);
    if (dot(normal, -position) < 0.0) normal = -normal;
    return true;
}
float aoJointWeight(ivec2 samplePixel, vec3 position, vec3 geometricNormal, vec3 materialNormal) {
    if (!aoReceiver(samplePixel)) return 0.0;
    vec3 delta = aoPosition(samplePixel) - position;
    float threshold = max(0.02, u_radius * 0.05);
    if (abs(dot(geometricNormal, delta)) > threshold) return 0.0;
    float agreement = dot(materialNormal, aoNormal(samplePixel));
    if (agreement < 0.85) return 0.0;
    return pow(max(agreement, 0.0), 16.0);
}
`

export const aoShader = `${common}
void main() {
    out_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    ivec2 pixel = aoAnchor(ivec2(gl_FragCoord.xy));
    if (!aoReceiver(pixel)) return;
    vec3 position = aoPosition(pixel);
    vec3 normal;
    if (!aoGeometricNormal(pixel, position, normal)) return;
    vec4 centerRange = texelFetch(u_hiz, pixel / 2, 0);
    if (centerRange.a > 0.0 || aoTransparentCell(pixel)) return;
    float depth = -position.z;
    float radius = max(u_radius, 0.0001);
    float pixelRadius = clamp(radius * float(textureSize(u_depth, 0).y) /
        (2.0 * abs(u_inverseProjection[1][1]) * depth), 1.0, 64.0);
    float bias = clamp(u_bias, 0.0, 0.99);
    float occlusion = 0.0;
    for (int directionIndex = 0; directionIndex < 8; ++directionIndex) {
        float angle = float(directionIndex) * 0.7853981633974483;
        vec2 direction = vec2(cos(angle), sin(angle));
        for (int radialIndex = 1; radialIndex <= 4; ++radialIndex) {
            ivec2 offset = ivec2(round(direction * pixelRadius * (float(radialIndex) / 4.0)));
            ivec2 samplePixel = pixel + offset;
            if (!aoInside(samplePixel)) continue;
            vec4 range = texelFetch(u_hiz, samplePixel / 2, 0);
            float sampleDepth = texelFetch(u_depth, samplePixel, 0).r;
            if (range.a > 0.0 || aoTransparentCell(samplePixel) || sampleDepth < 0.0 || !aoFinite(sampleDepth)) return;
            if (range.b <= 0.0 || range.r > depth + radius || range.g < depth - radius) continue;
            if (!aoReceiver(samplePixel)) continue;
            vec3 delta = aoPosition(samplePixel) - position;
            float distance = length(delta);
            if (distance <= 0.00001 || distance >= radius) continue;
            float contribution = max(dot(normal, delta / distance) - bias, 0.0) / (1.0 - bias);
            occlusion += contribution * (1.0 - distance / radius);
        }
    }
    float visibility = clamp(1.0 - u_strength * occlusion / 32.0, 0.0, 1.0);
    out_FragColor = vec4(visibility, 1.0, 0.0, 1.0);
}
`

export const bilateralShader = `${common}
uniform highp sampler2D u_visibility;
uniform vec2 u_axis;
void main() {
    out_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    ivec2 halfPixel = ivec2(gl_FragCoord.xy);
    ivec2 pixel = aoAnchor(halfPixel);
    vec2 center = texelFetch(u_visibility, halfPixel, 0).rg;
    if (center.g <= 0.0 || !aoReceiver(pixel)) return;
    vec3 position = aoPosition(pixel);
    vec3 geometricNormal;
    if (!aoGeometricNormal(pixel, position, geometricNormal)) return;
    vec3 materialNormal = aoNormal(pixel);
    float total = 0.0;
    float weightSum = 0.0;
    for (int tap = -2; tap <= 2; ++tap) {
        ivec2 neighbor = halfPixel + ivec2(u_axis) * tap;
        if (any(lessThan(neighbor, ivec2(0))) || any(greaterThanEqual(neighbor, textureSize(u_visibility, 0)))) continue;
        vec2 value = texelFetch(u_visibility, neighbor, 0).rg;
        if (value.g <= 0.0) continue;
        float kernel = tap == 0 ? 6.0 : (abs(tap) == 1 ? 4.0 : 1.0);
        float weight = kernel * aoJointWeight(aoAnchor(neighbor), position, geometricNormal, materialNormal);
        total += value.r * weight;
        weightSum += weight;
    }
    float visibility = weightSum > 0.0 ? total / weightSum : 1.0;
    out_FragColor = vec4(visibility, center.g, 0.0, 1.0);
}
`

export const resolveShader = `${common}
uniform highp sampler2D colorTexture;
uniform highp sampler2D u_visibility;
void main() {
    vec4 source = texture(colorTexture, v_textureCoordinates);
    out_FragColor = source;
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    if (!aoReceiver(pixel)) return;
    vec3 position = aoPosition(pixel);
    vec3 geometricNormal;
    if (!aoGeometricNormal(pixel, position, geometricNormal)) return;
    vec3 materialNormal = aoNormal(pixel);
    // Half-resolution texels represent full-resolution integer anchors 0, 2, 4...
    vec2 halfPosition = vec2(pixel) * 0.5;
    ivec2 base = ivec2(floor(halfPosition));
    vec2 fraction = fract(halfPosition);
    float total = 0.0;
    float weightSum = 0.0;
    for (int y = 0; y < 2; ++y) {
        for (int x = 0; x < 2; ++x) {
            ivec2 neighbor = base + ivec2(x, y);
            if (any(greaterThanEqual(neighbor, textureSize(u_visibility, 0)))) continue;
            vec2 value = texelFetch(u_visibility, neighbor, 0).rg;
            if (value.g <= 0.0) continue;
            vec2 bilinear = mix(vec2(1.0) - fraction, fraction, vec2(float(x), float(y)));
            float weight = bilinear.x * bilinear.y * aoJointWeight(aoAnchor(neighbor), position, geometricNormal, materialNormal);
            total += value.r * weight;
            weightSum += weight;
        }
    }
    float visibility = weightSum > 0.0 ? clamp(total / weightSum, 0.0, 1.0) : 1.0;
    vec3 emission = min(max(texelFetch(u_flags, pixel, 0).rgb, vec3(0.0)), max(source.rgb, vec3(0.0)));
    out_FragColor = vec4(emission + (source.rgb - emission) * visibility, source.a);
}
`
