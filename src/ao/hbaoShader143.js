import { common } from './aoShaders143.js'

// Horizon-based AO: accumulate only newly occluded angles along each direction.
// Algorithm reference: NVIDIA nvpro-samples/gl_ssao/hbao.frag.glsl.
// Uses CCR's geometric tangent plane and conservative material/coverage contract.
export const hbaoShader = `${common}
void main() {
    out_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    ivec2 pixel = aoAnchor(ivec2(gl_FragCoord.xy));
    if (!aoReceiver(pixel) || aoTransparentCell(pixel)) return;
    vec3 position = aoPosition(pixel);
    vec3 normal;
    if (!aoGeometricNormal(pixel, position, normal)) return;
    if (texelFetch(u_hiz, pixel / 2, 0).a > 0.0) return;
    float radius = max(u_radius, 0.0001);
    float pixelRadius = clamp(radius * float(textureSize(u_depth, 0).y) /
        (2.0 * abs(u_inverseProjection[1][1]) * -position.z), 1.0, 64.0);
    float bias = clamp(u_bias, 0.0, 0.99);
    float occlusion = 0.0;
    for (int directionIndex = 0; directionIndex < 8; ++directionIndex) {
        float angle = float(directionIndex) * 0.7853981633974483;
        vec2 direction = vec2(cos(angle), sin(angle));
        float horizon = bias;
        for (int stepIndex = 1; stepIndex <= 8; ++stepIndex) {
            ivec2 offset = ivec2(round(direction * pixelRadius * float(stepIndex) / 8.0));
            ivec2 samplePixel = pixel + offset;
            if (!aoInside(samplePixel)) continue;
            vec4 range = texelFetch(u_hiz, samplePixel / 2, 0);
            float depth = texelFetch(u_depth, samplePixel, 0).r;
            if (range.a > 0.0 || aoTransparentCell(samplePixel) || depth < 0.0 || !aoFinite(depth)) return;
            if (range.b <= 0.0 || !aoReceiver(samplePixel)) continue;
            vec3 delta = aoPosition(samplePixel) - position;
            float distance = length(delta);
            if (distance <= 0.00001 || distance >= radius) continue;
            float elevation = dot(normal, delta / distance);
            if (elevation > horizon) {
                float falloff = 1.0 - distance * distance / (radius * radius);
                occlusion += (elevation - horizon) * falloff / (1.0 - bias);
                horizon = elevation;
            }
        }
    }
    float visibility = clamp(1.0 - u_strength * occlusion / 8.0, 0.0, 1.0);
    out_FragColor = vec4(visibility, 1.0, 0.0, 1.0);
}
`
