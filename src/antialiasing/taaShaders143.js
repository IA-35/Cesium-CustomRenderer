// Stable display-grid TAA. Raster samples move; output and history texels do not.
export const taaCommon = `
precision highp float;
precision highp int;
uniform highp sampler2D colorTexture;
uniform highp sampler2D depthTexture;
uniform highp sampler2D u_surfaceDepth;
uniform bool u_hasSurfaceDepth;
uniform vec2 u_jitterUv;
in vec2 v_textureCoordinates;

float taaRawDepth(vec2 uv) {
    float depth = texture(depthTexture, uv).r;
    if (u_hasSurfaceDepth) depth = min(depth, czm_unpackDepth(texture(u_surfaceDepth, uv)));
    return depth;
}
float taaEyeDepth(vec2 uv) {
    float depth = taaRawDepth(uv);
    if (!(depth > 0.0 && depth < 1.0)) return 0.0;
    // The builtin preserves log-depth precision at campus/Globe distances.
    vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, depth);
    return -eye.z / eye.w;
}
vec3 taaEyePosition(vec2 uv, out bool background) {
    float distance = taaEyeDepth(uv);
    background = distance <= 0.0;
    vec4 ray = czm_inverseProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec3 direction = ray.xyz / ray.w;
    return background ? normalize(direction) : direction * (-distance / direction.z);
}
`

export const taaDepthShader = `${taaCommon}
void main() {
    out_FragColor = vec4(taaEyeDepth(v_textureCoordinates + u_jitterUv), 0.0, 0.0, 0.0);
}
`

export const taaResolveShader = `${taaCommon}
uniform highp sampler2D u_historyColor;
uniform highp sampler2D u_historyDepth;
uniform mat4 u_prevViewFromCurrent;
uniform mat4 u_prevProjection;
uniform vec4 u_taaBlend;
uniform float u_historyValid;
uniform float u_staticFrames;

// A stationary silhouette alternates between foreground and background samples.
// Retain bounded coverage history there, but still reject a newly exposed region
// once the old surface has left this immediate depth neighbourhood.
bool depthBoundary(vec2 uv, float center) {
    vec2 texel = 1.0 / vec2(textureSize(depthTexture, 0));
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        float adjacent = taaEyeDepth(uv + vec2(x,y) * texel);
        if ((center == 0.0) != (adjacent == 0.0) ||
            abs(adjacent-center) > max(0.1, u_taaBlend.w * max(center,adjacent))) return true;
    }
    return false;
}

// Catmull-Rom reconstructs current samples without the permanent blur of a
// bilinear prefilter. Clamp negative lobes to the local source colour range.
vec4 cubicWeights(float t) {
    float t2 = t * t, t3 = t2 * t;
    return vec4(-0.5*t + t2 - 0.5*t3, 1.0 - 2.5*t2 + 1.5*t3,
        0.5*t + 2.0*t2 - 1.5*t3, -0.5*t2 + 0.5*t3);
}
vec3 reconstruct(sampler2D image, vec2 uv) {
    ivec2 size = textureSize(image, 0);
    vec2 grid = uv * vec2(size) - 0.5;
    ivec2 base = ivec2(floor(grid));
    vec4 wx = cubicWeights(fract(grid.x)), wy = cubicWeights(fract(grid.y));
    vec3 value = vec3(0.0);
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
        value += texelFetch(image, clamp(base + ivec2(x-1,y-1), ivec2(0), size-1), 0).rgb * wx[x] * wy[y];
    }
    return max(value, vec3(0.0));
}
void main() {
    ivec2 size = textureSize(colorTexture, 0);
    ivec2 pixel = clamp(ivec2(gl_FragCoord.xy), ivec2(0), size - 1);
    vec2 outputUV = (vec2(pixel) + 0.5) / vec2(size);
    vec2 uv = outputUV + u_jitterUv;
    ivec2 sourcePixel = clamp(ivec2(uv * vec2(size)), ivec2(0), size-1);
    vec2 grid = uv * vec2(size) - 0.5;
    ivec2 base = ivec2(floor(grid));
    vec4 wx = cubicWeights(fract(grid.x)), wy = cubicWeights(fract(grid.y));
    vec3 current = vec3(0.0);
    vec3 lower = vec3(1.0e20), upper = vec3(-1.0e20);
    // Cover both sides of the cubic footprint throughout the jitter cycle.
    // These bounds validate history; they do not blur the current image.
    for (int y = -2; y <= 2; ++y) for (int x = -2; x <= 2; ++x) {
        vec3 neighbour = texelFetch(colorTexture, clamp(sourcePixel + ivec2(x,y), ivec2(0), size-1), 0).rgb;
        lower = min(lower, neighbour); upper = max(upper, neighbour);
        // Reuse this fetch for reconstruction instead of gathering another 4x4.
        ivec2 tap = sourcePixel + ivec2(x,y) - base + 1;
        if (all(greaterThanEqual(tap, ivec2(0))) && all(lessThan(tap, ivec2(4)))) current += neighbour * wx[tap.x] * wy[tap.y];
    }
    current = clamp(current, lower, upper);
    bool background;
    vec3 eye = taaEyePosition(uv, background);
    vec4 previousEye = u_prevViewFromCurrent * vec4(eye, background ? 0.0 : 1.0);
    vec4 clip = u_prevProjection * previousEye;
    vec2 previousUV = clip.xy / clip.w * 0.5 + 0.5;
    vec2 motion = (previousUV - outputUV) * vec2(size);
    // Do not repeatedly filter a stationary history because of ECEF matrix roundoff.
    if (length(motion) < 0.001) previousUV = outputUV;
    bool inside = clip.w > 0.0 && all(greaterThanEqual(previousUV, vec2(0.0))) && all(lessThanEqual(previousUV, vec2(1.0)));
    float expectedDepth = background ? 0.0 : -previousEye.z;
    float storedDepth = texture(u_historyDepth, previousUV).r;
    float tolerance = max(0.1, u_taaBlend.w * max(expectedDepth, storedDepth));
    bool sameSurface = background ? storedDepth == 0.0 : storedDepth > 0.0 && abs(storedDepth - expectedDepth) <= tolerance;
    bool stationary = u_staticFrames > 0.0 && length(motion) < 0.001;
    bool coverageHistory = !sameSurface && stationary && depthBoundary(uv, background ? 0.0 : -eye.z);
    if (u_historyValid < 0.5 || !inside || (!sameSurface && !coverageHistory)) {
        out_FragColor = vec4(current, 1.0);
        return;
    }
    vec3 history = reconstruct(u_historyColor, previousUV);
    float blend = mix(u_taaBlend.x, u_taaBlend.y, clamp(length(motion) / max(u_taaBlend.z, 1.0), 0.0, 1.0));
    float contrast = max(max(upper.r-lower.r, upper.g-lower.g), upper.b-lower.b);
    if (stationary && contrast > 0.15) {
        // Longer accumulation only on settled high-contrast pixels. Camera
        // movement resets this confidence; fresh frames still ramp up quickly.
        blend = min(blend, max(u_taaBlend.x / 6.0, 1.0 / (u_staticFrames + 1.0)));
    }
    out_FragColor = vec4(mix(clamp(history, lower, upper), current, blend), 1.0);
}
`
