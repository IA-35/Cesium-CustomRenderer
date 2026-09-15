// Multi-scale bloom kernels, informed by Unity PostProcessing's 13-tap downsample
// and tent reconstruction. HDR input/output; exposure and tone mapping belong to Cesium.
const common = `
in vec2 v_textureCoordinates;
uniform sampler2D u_source;
vec4 bloomSample(sampler2D source, vec2 uv) {
    ivec2 size = textureSize(source, 0);
    vec2 p = uv * vec2(size) - 0.5;
    ivec2 base = ivec2(floor(p));
    vec2 f = fract(p);
    vec4 a = texelFetch(source, clamp(base, ivec2(0), size - 1), 0);
    vec4 b = texelFetch(source, clamp(base + ivec2(1,0), ivec2(0), size - 1), 0);
    vec4 c = texelFetch(source, clamp(base + ivec2(0,1), ivec2(0), size - 1), 0);
    vec4 d = texelFetch(source, clamp(base + ivec2(1), ivec2(0), size - 1), 0);
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
vec3 bloomDown(vec2 uv) {
    vec2 t = 1.0 / vec2(textureSize(u_source, 0));
    vec3 value = bloomSample(u_source, uv).rgb * 0.125;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            float weight = x == 0 || y == 0 ? 0.0625 : 0.03125;
            value += bloomSample(u_source, uv + vec2(float(x),float(y)) * t).rgb * weight;
        }
    }
    for (int y = -1; y <= 1; y += 2) {
        for (int x = -1; x <= 1; x += 2) {
            value += bloomSample(u_source, uv + vec2(float(x),float(y)) * t * 0.5).rgb * 0.125;
        }
    }
    return max(value, vec3(0.0));
}
`

export const prefilterShader = `${common}
uniform float u_threshold;
uniform float u_knee;
void main() {
    vec3 color = bloomDown(v_textureCoordinates);
    float brightness = max(max(color.r, color.g), color.b);
    float knee = max(u_threshold * u_knee, 0.00001);
    float soft = clamp(brightness - u_threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float contribution = max(soft, brightness - u_threshold) / max(brightness, 0.00001);
    out_FragColor = vec4(color * contribution, 1.0);
}
`

export const downsampleShader = `${common}
void main() { out_FragColor = vec4(bloomDown(v_textureCoordinates), 1.0); }
`

export const upsampleShader = `${common}
uniform sampler2D u_high;
void main() {
    vec2 t = 1.0 / vec2(textureSize(u_source, 0));
    vec3 value = vec3(0.0);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            float weight = float((x == 0 ? 2 : 1) * (y == 0 ? 2 : 1));
            value += bloomSample(u_source, v_textureCoordinates + vec2(float(x), float(y)) * t).rgb * weight / 16.0;
        }
    }
    // Normalize the pyramid so changing the number of levels does not multiply DC gain.
    out_FragColor = vec4(mix(bloomSample(u_high, v_textureCoordinates).rgb, value, 0.5), 1.0);
}
`

export const bloomResolveShader = `${common}
uniform sampler2D u_original;
uniform float u_strength;
void main() {
    vec4 source = texture(u_original, v_textureCoordinates);
    out_FragColor = vec4(source.rgb + u_strength * bloomSample(u_source, v_textureCoordinates).rgb, source.a);
}
`
