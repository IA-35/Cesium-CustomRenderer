// Three.js r186 TRAA, commit 9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8.
// MIT; complete upstream files, license and hashes: ./reference/three-r186/.
// r186 resolve with CCR sampling/acceptance adaptations documented in PORTING.md.
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
    // Cesium's builtin decodes logarithmic window depth before eye reconstruction.
    vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, depth);
    return -eye.z / eye.w;
}
`

export const taaDepthShader = `${taaCommon}
void main() {
    // History colour and depth share the stable display grid; motion stays raster.
    // Label the whole colour reconstruction footprint, including coverage lobes.
    ivec2 size = textureSize(depthTexture, 0);
    ivec2 base = ivec2(floor((v_textureCoordinates + u_jitterUv) * vec2(size) - 0.5));
    float closest = 1e30;
    for (int x = -1; x <= 2; ++x) for (int y = -1; y <= 2; ++y) {
        vec2 uv = (vec2(clamp(base + ivec2(x,y), ivec2(0), size-1)) + 0.5) / vec2(size);
        float eye = taaEyeDepth(uv);
        if (eye > 0.0) closest = min(closest, eye);
    }
    out_FragColor = vec4(closest == 1e30 ? 0.0 : closest, 0.0, 0.0, 0.0);
}
`

// Resolve alpha is private acquisition metadata. Restore the incoming scene's
// opacity before returning to the shared HDR chain, including transparent canvases.
const taaCubicWeightsShader = `
// Reconstruct the jittered HDR sample on the stable display grid. Neighbourhood
// statistics use the same filter/grid, avoiding phase-dependent clipping of wires.
vec4 taaCubicWeights(float t) {
    float t2 = t * t, t3 = t2 * t;
    return vec4(-0.5*t+t2-0.5*t3, 1.0-2.5*t2+1.5*t3,
        0.5*t+2.0*t2-1.5*t3, -0.5*t2+0.5*t3);
}
`
const taaCurrentReconstruction = `${taaCubicWeightsShader}
vec4 taaReconstruct(sampler2D image, vec2 uv) {
    ivec2 size = textureSize(image, 0);
    vec2 grid = uv * vec2(size) - 0.5;
    ivec2 base = ivec2(floor(grid));
    vec4 wx = taaCubicWeights(fract(grid.x)), wy = taaCubicWeights(fract(grid.y));
    vec4 value = vec4(0.0), lower = vec4(1e20), upper = vec4(-1e20);
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
        vec4 tap = texelFetch(image, clamp(base + ivec2(x-1,y-1), ivec2(0), size-1), 0);
        value += tap * wx[x] * wy[y];
        lower = min(lower, tap); upper = max(upper, tap);
    }
    return clamp(value, lower, upper);
}
`

export const taaDisplayShader = `
precision highp float;
precision highp int;
${taaCurrentReconstruction}
uniform bool u_reconstructColor;
uniform highp sampler2D colorTexture;
uniform highp sampler2D u_alphaSource;
uniform vec2 u_jitterUv;
in vec2 v_textureCoordinates;
void main() {
    if (u_reconstructColor) {
        out_FragColor = taaReconstruct(colorTexture, v_textureCoordinates + u_jitterUv);
        return;
    }
    out_FragColor = vec4(texture(colorTexture, v_textureCoordinates).rgb,
        texture(u_alphaSource, v_textureCoordinates + u_jitterUv).a);
}
`

export const taaResolveShader = `${taaCommon}
${taaCubicWeightsShader}
uniform highp sampler2D u_historyColor;
uniform highp sampler2D u_historyDepth;
uniform vec2 u_previousJitterUv;
// RG: current NDC - previous NDC, B: current eye metres, A: previous eye metres.
// B=0 is clear/static fallback; B>0,A<=0 is first-seen local invalid history.
uniform highp sampler2D u_motionTexture;
uniform bool u_hasMotionTexture;
uniform vec2 u_cameraNearFar;
uniform mat4 u_currentInverseRasterProjection;
uniform mat4 u_previousInverseRasterProjection;
uniform mat4 u_currentProjection;
uniform mat4 u_previousProjection;
uniform mat4 u_previousViewFromCurrentEye;
uniform mat4 u_currentViewFromPreviousEye;
uniform float u_historyValid;
uniform float u_acquisitionAge;
uniform float u_jitterSamples;
uniform bool u_cameraStill;
uniform float u_depthThreshold;
uniform float u_edgeDepthDiff;
uniform float u_maxVelocityLength;
uniform bool u_useSubpixelCorrection;

vec4 taaCurrent(vec2 uv) {
    ivec2 size = textureSize(colorTexture, 0);
    return texelFetch(colorTexture, clamp(ivec2(uv * vec2(size)), ivec2(0), size-1), 0);
}
vec4 taaHistory(vec2 uv, float expectedEyeDepth) {
    ivec2 size = textureSize(u_historyColor, 0);
    vec2 grid = uv * vec2(size) - 0.5;
    ivec2 base = ivec2(floor(grid));
    vec4 wx = taaCubicWeights(fract(grid.x)), wy = taaCubicWeights(fract(grid.y));
    vec4 value = vec4(0.0), lower = vec4(1e20), upper = vec4(-1e20);
    float weightSum = 0.0;
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
        ivec2 pixel = clamp(base + ivec2(x-1,y-1), ivec2(0), size-1);
        float eye = texelFetch(u_historyDepth, pixel, 0).r;
        if (eye > 0.0 && expectedEyeDepth > eye + max(0.1, 0.02 * expectedEyeDepth)) continue;
        vec4 tap = texelFetch(u_historyColor, pixel, 0);
        float weight = wx[x] * wy[y];
        value += tap * weight; weightSum += weight;
        lower = min(lower, tap); upper = max(upper, tap);
    }
    // A surviving centre is guaranteed by the preceding depth test; if cubic
    // lobes cancel, use that accepted texel rather than a cross-surface sample.
    if (weightSum <= 0.00001) return texelFetch(u_historyColor, clamp(ivec2(uv * vec2(size)), ivec2(0), size-1), 0);
    return clamp(value / weightSum, lower, upper);
}
float taaPerspectiveDepth(float eyeDepth) {
    if (eyeDepth == 0.0) return 1.0;
    float near = u_cameraNearFar.x, far = u_cameraNearFar.y;
    // TSL viewZToPerspectiveDepth(-eyeDepth, near, far), not eye metres.
    return (far - near * far / eyeDepth) / (far - near);
}
vec4 taaRasterEye(vec2 uv, float eyeDepth, mat4 inverseRasterProjection) {
    vec4 ray = inverseRasterProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec3 direction = ray.xyz / ray.w;
    // Infinite sky is a direction: relative camera translation must not move it.
    return eyeDepth <= 0.0 ? vec4(normalize(direction), 0.0)
        : vec4(direction * (-eyeDepth / direction.z), 1.0);
}
float taaPreviousDepth(vec2 historyUV) {
    float eyeDepth = texture(u_historyDepth, historyUV).r;
    vec4 previousEye = taaRasterEye(historyUV + u_previousJitterUv, eyeDepth, u_previousInverseRasterProjection);
    vec4 currentEye = u_currentViewFromPreviousEye * previousEye;
    return eyeDepth <= 0.0 ? 1.0 : taaPerspectiveDepth(-currentEye.z);
}

// TAAUtils.clipAABB clips the RGB box-centred ray, not each channel separately.
vec4 taaClipAABB(vec4 currentColor, vec4 historyColor, vec4 minColor, vec4 maxColor) {
    vec3 pClip = (maxColor.rgb + minColor.rgb) * 0.5;
    vec3 eClip = (maxColor.rgb - minColor.rgb) * 0.5 + 1e-7;
    vec4 vClip = historyColor - vec4(pClip, currentColor.a);
    vec3 absUnit = abs(vClip.xyz / eClip);
    float maxUnit = max(absUnit.x, max(absUnit.y, absUnit.z));
    return maxUnit > 1.0 ? vec4(pClip, currentColor.a) + vClip / maxUnit : historyColor;
}
vec4 taaVarianceClipping(ivec2 pixel, ivec2 size, vec4 currentColor, vec4 historyColor, float gamma) {
    // TRAANode's 3x3 RGB moments, evaluated on the reconstructed display grid.
    vec4 moment1 = currentColor;
    vec4 moment2 = currentColor * currentColor;
    const ivec2 offsets[8] = ivec2[8](ivec2(-1,-1), ivec2(-1,1), ivec2(1,-1), ivec2(1,1),
        ivec2(1,0), ivec2(0,-1), ivec2(0,1), ivec2(-1,0));
    for (int i = 0; i < 8; ++i) {
        vec2 neighborUV = (vec2(clamp(pixel + offsets[i], ivec2(0), size-1)) + 0.5) / vec2(size);
        vec4 neighbor = max(taaCurrent(neighborUV), 0.0);
        moment1 += neighbor;
        moment2 += neighbor * neighbor;
    }
    vec4 mean = moment1 / 9.0;
    vec4 variance = sqrt(max(moment2 / 9.0 - mean * mean, 0.0)) * gamma;
    vec4 minColor = mean - variance, maxColor = mean + variance;
    return taaClipAABB(clamp(mean, minColor, maxColor), historyColor, minColor, maxColor);
}
float taaSubpixelCorrection(vec2 velocityUV, vec2 size) {
    vec2 phase = abs(fract(velocityUV * size));
    vec2 weight = max(phase, 1.0 - phase);
    return (1.0 - weight.x * weight.y) / 0.75;
}
vec4 taaFlickerReduction(vec4 currentColor, vec4 historyColor, float currentWeight) {
    vec4 compressedCurrent = currentColor / (max(currentColor.r, max(currentColor.g, currentColor.b)) + 1.0);
    vec4 compressedHistory = historyColor / (max(historyColor.r, max(historyColor.g, historyColor.b)) + 1.0);
    // r186 ColorAdjustment.luminance + ColorManagement LinearSRGB coefficients.
    const vec3 luminanceCoefficients = vec3(0.2126, 0.7152, 0.0722);
    float weightCurrent = currentWeight / (dot(compressedCurrent.rgb, luminanceCoefficients) + 1.0);
    float weightHistory = (1.0 - currentWeight) / (dot(compressedHistory.rgb, luminanceCoefficients) + 1.0);
    // Compression is solely for weights; output keeps original HDR radiance.
    return (currentColor * weightCurrent + historyColor * weightHistory) / max(weightCurrent + weightHistory, 0.00001);
}
void main() {
    ivec2 size = textureSize(colorTexture, 0);
    vec2 uv = v_textureCoordinates;
    ivec2 pixel = clamp(ivec2(uv * vec2(size)), ivec2(0), size-1);
    vec4 currentColor = taaCurrent(uv);
    if (u_historyValid < 0.5) {
        out_FragColor = vec4(currentColor.rgb, 1.0);
        return;
    }

    // Dilate over the actual current-colour reconstruction footprint. A raw 3x3
    // misses the fourth row/column and resets partially covered wires to one sample.
    float closestDepth = 2.0, farthestDepth = -1.0;
    float closestEyeDepth = 0.0;
    ivec2 closestPixel = pixel;
    ivec2 reconstructionBase = ivec2(floor((uv + u_jitterUv) * vec2(size) - 0.5));
    for (int x = -1; x <= 2; ++x) for (int y = -1; y <= 2; ++y) {
        ivec2 neighbor = clamp(reconstructionBase + ivec2(x,y), ivec2(0), size-1);
        vec2 neighborUV = (vec2(neighbor) + 0.5) / vec2(size);
        float eyeDepth = taaEyeDepth(neighborUV);
        float depth = taaPerspectiveDepth(eyeDepth);
        if (depth < closestDepth) {
            closestDepth = depth;
            closestPixel = neighbor;
            closestEyeDepth = eyeDepth;
        }
        farthestDepth = max(farthestDepth, depth);
    }
    vec2 closestUV = (vec2(closestPixel) + 0.5) / vec2(size);
    vec4 currentEye = taaRasterEye(closestUV, closestEyeDepth, u_currentInverseRasterProjection);
    vec4 currentClip = u_currentProjection * currentEye;
    vec4 previousClip = u_previousProjection * (u_previousViewFromCurrentEye * currentEye);
    vec2 velocityNDC = currentClip.xy / currentClip.w - previousClip.xy / previousClip.w;
    float expectedPreviousEyeDepth = closestEyeDepth > 0.0
        ? -(u_previousViewFromCurrentEye * currentEye).z : 0.0;
    bool localValid = previousClip.w > 0.0;
    if (u_hasMotionTexture) {
        vec4 objectMotion = texelFetch(u_motionTexture, closestPixel, 0);
        // Float32 surface quantization tolerance, separate from history thresholds.
        float surfaceTolerance = max(0.0001, closestEyeDepth * 0.000002);
        bool visibleMotion = objectMotion.z > 0.0 && closestEyeDepth > 0.0
            && abs(objectMotion.z - closestEyeDepth) <= surfaceTolerance;
        if (visibleMotion) {
            velocityNDC = objectMotion.xy;
            expectedPreviousEyeDepth = objectMotion.w;
            localValid = objectMotion.w > 0.0;
        }
    }
    // Three uses top-left UV and (0.5,-0.5). Cesium's bottom-left UV is
    // (NDC+1)*0.5, so both axes multiply by positive 0.5.
    vec2 offsetUV = velocityNDC * 0.5;
    vec2 historyUV = uv - offsetUV;
    bool inBounds = all(greaterThanEqual(historyUV, vec2(0.0))) && all(lessThanEqual(historyUV, vec2(1.0)));
    bool edge = farthestDepth - closestDepth > u_edgeDepthDiff;
    bool disocclusion = closestDepth - taaPreviousDepth(historyUV) > u_depthThreshold;
    // Root-camera perspective depth loses discrimination far from a tiny near
    // plane. Compare in previous-eye metres too; motion.w handles rigid Z motion.
    float storedEyeDepth = texture(u_historyDepth, historyUV).r;
    bool relativeDisocclusion = storedEyeDepth > 0.0 && (closestEyeDepth == 0.0 ||
        expectedPreviousEyeDepth > storedEyeDepth + max(0.1, 0.02 * expectedPreviousEyeDepth));
    bool hasValidHistory = localValid && inBounds && (edge || !disocclusion) && !relativeDisocclusion;
    if (!hasValidHistory) {
        // A finite revealed surface starts acquisition again. Empty sky still
        // rejects the old RGB immediately, but keeps sample age: a subpixel wire
        // can miss the entire raster footprint for one Halton phase.
        float age = closestEyeDepth == 0.0 && inBounds
            ? clamp(texture(u_historyColor, historyUV).a + 1.0, 1.0, max(u_jitterSamples, 32.0)) : 1.0;
        out_FragColor = vec4(currentColor.rgb, age);
        return;
    }

    vec4 historyColor = taaHistory(historyUV, expectedPreviousEyeDepth);
    // A locally rejected/new surface reacquires its own jitter samples even
    // after the camera has been still for minutes. No extra history target.
    float acquisitionAge = min(u_acquisitionAge, max(1.0, historyColor.a));
    historyColor.a = currentColor.a;
    float motionFactor = clamp(length((uv - historyUV) * vec2(size)) / u_maxVelocityLength, 0.0, 1.0);
    // A fixed low floor filters the Halton phase response, independent of camera
    // stillness/contrast. Bias-correct the first 32 samples after start/stop;
    // motion and subpixel response remain r186's, rather than freezing history.
    const float baseWeight = 0.003;
    float currentWeight = acquisitionAge < max(u_jitterSamples, 32.0)
        ? baseWeight / (1.0 - pow(1.0 - baseWeight, acquisitionAge + 1.0)) : baseWeight;
    if (u_useSubpixelCorrection) currentWeight += taaSubpixelCorrection(offsetUV, vec2(size)) * 0.25;
    currentWeight = clamp(currentWeight + motionFactor, 0.0, 1.0);
    bool coherentHistory = u_cameraStill && length(offsetUV * vec2(size)) < 0.001;
    float varianceGamma = mix(0.5, coherentHistory || farthestDepth == 1.0 ? 2.0 : 1.0,
        (1.0 - motionFactor) * (1.0 - motionFactor));
    vec4 clippedHistoryColor = taaVarianceClipping(pixel, size, currentColor, historyColor, varianceGamma);
    out_FragColor = vec4(taaFlickerReduction(currentColor, clippedHistoryColor, currentWeight).rgb,
        min(acquisitionAge + 1.0, max(u_jitterSamples, 32.0)));
}
`
