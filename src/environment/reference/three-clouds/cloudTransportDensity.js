// Scalar single-layer port of three-geospatial b012ad06d858fc035d88aacfd73f092f93c994e4:
// packages/clouds/src/shaders/clouds.glsl sampleWeather/sampleMedia.
// MIT, Copyright (c) 2024 Shota Matsuda. See LICENSE and TRANSPORT_PORT.md in this directory.
export const cloudTransportDensityGLSL = `
float ccrCloudRemapClamped(float value, float low, float high) {
  return clamp((value - low) / max(high - low, 0.00001), 0.0, 1.0);
}

float ccrCloudHeightScale(float heightFraction) {
  float biased = pow(heightFraction, 0.35);
  float x = clamp(biased * 2.0 - 1.0, -1.0, 1.0);
  return 1.0 - x * x;
}

float ccrCloudWeatherDensity(float heightFraction, float localWeather, float coverage) {
  if (heightFraction <= 0.0 || heightFraction >= 1.0 || coverage <= 0.0) return 0.0;
  float heightScale = ccrCloudHeightScale(heightFraction);
  float factor = 1.0 - coverage * heightScale;
  // Upstream default weatherExponent=1, coverageFilterWidth=0.6.
  return ccrCloudRemapClamped(mix(localWeather, 1.0, 0.6), factor, factor + 0.6);
}

float ccrCloudMediaDensity(float heightFraction, float weather, float shape, float detail, float detailAmount) {
  // Keep the Perlin-Worley distribution; upstream remaps the weather field by shape,
  // rather than decoding shape as a linear threshold or taking sqrt of final density.
  float density = ccrCloudRemapClamped(weather, 1.0 - shape, 1.0);
  float modifier = mix(pow(detail, 6.0), 1.0 - detail,
    ccrCloudRemapClamped(heightFraction, 0.2, 0.4));
  density = ccrCloudRemapClamped(density * 2.0, modifier * detailAmount * 0.5, 1.0);
  // Upstream default DensityProfile(0, 0, 0.75, 0.25).
  return clamp(density * (0.75 * heightFraction + 0.25), 0.0, 1.0);
}
`
