export default function createColorGrading(Cesium, getOptions, isActive = () => true) {
  return new Cesium.PostProcessStage({
    name: 'campus_visual_color',
    fragmentShader: `
      uniform sampler2D colorTexture;
      uniform vec4 grading;
      uniform bool gradingActive;
      in vec2 v_textureCoordinates;
      void main() {
        vec4 source = texture(colorTexture, v_textureCoordinates);
        if (!gradingActive) { out_FragColor = source; return; }
        vec3 color = source.rgb;
        // Cesium 1.143 has already tone-mapped this input. No second gamma/exposure.
        float angle = grading.w * 3.14159265;
        vec3 axis = normalize(vec3(1.0));
        color = color * cos(angle) + cross(axis, color) * sin(angle)
          + axis * dot(axis, color) * (1.0 - cos(angle));
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(vec3(luminance), color, grading.z);
        // Endpoint-preserving display contrast and brightness. Linear gain + clamp
        // used to turn every tone-mapped channel above ~0.887 into flat white
        // with the clear preset, erasing cloud silver-lining and horizon detail.
        color = clamp(color, 0.0, 1.0);
        if (grading.x <= 0.0) color = vec3(0.5);
        else {
          vec3 lower = 0.5 * pow(2.0 * color, vec3(grading.x));
          vec3 upper = 1.0 - 0.5 * pow(2.0 * (1.0 - color), vec3(grading.x));
          color = mix(lower, upper, step(vec3(0.5), color));
        }
        if (grading.y <= 0.0) color = vec3(0.0);
        else {
          // The denominator lies between 1 and brightness. Keep that bound
          // explicit so driver reassociation cannot round it to zero at white.
          vec3 denominator = max((1.0 - color) + color * grading.y, vec3(min(1.0, grading.y)));
          color = (color * grading.y) / denominator;
        }
        out_FragColor = vec4(color, source.a);
      }`,
    uniforms: {
      gradingActive: isActive,
      grading: () => {
        const o = getOptions()
        return new Cesium.Cartesian4(o.contrast, o.brightness, o.saturation, o.hue)
      }
    }
  })
}
