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
        color = (color - 0.5) * grading.x + 0.5;
        out_FragColor = vec4(clamp(color * grading.y, 0.0, 1.0), source.a);
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
