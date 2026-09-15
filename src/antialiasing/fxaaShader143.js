// Reuse Cesium 1.143's licensed FXAA 3.11 implementation, with CCR-owned settings.
// This pass sees final display color and measures texels from the actual input.
export function fxaaShader(C, quality) {
  return `#define FXAA_QUALITY_PRESET 39
${C._shadersFXAA3_11}
in vec2 v_textureCoordinates;
uniform sampler2D colorTexture;
void main() {
    vec2 texel = 1.0 / vec2(textureSize(colorTexture, 0));
    vec4 color = FxaaPixelShader(v_textureCoordinates, colorTexture, texel,
        ${quality.fxaaSubpix}, ${quality.fxaaThreshold}, ${quality.fxaaThresholdMin});
    out_FragColor = vec4(color.rgb, texture(colorTexture, v_textureCoordinates).a);
}`
}
