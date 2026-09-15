const pcf = `
uniform sampler2D campus_shadowDepth;
uniform mat4 campus_eyeToShadow;
uniform vec4 campus_shadowParams;
float campus_shadowVisibility(vec3 position, vec3 normal) {
    if (campus_shadowParams.w < 0.5) return 1.0;
    float texelWorld = campus_shadowParams.y;
    vec3 n = normalize(normal);
    vec4 receiverClip = campus_eyeToShadow * vec4(position, 1.0);
    vec3 receiverUV = receiverClip.xyz / receiverClip.w * 0.5 + 0.5;
    // Neighboring PCF texels lie at different depths on a sloping receiver.
    // Use the geometric plane, before the material-normal offset, and evaluate
    // derivatives before the per-fragment coverage branch.
    vec3 plane = cross(dFdx(receiverUV), dFdy(receiverUV));
    vec2 depthGradient = vec2(0.0);
    if (abs(plane.z) > 0.0001 * length(plane)) depthGradient = -plane.xy / plane.z;
    vec4 clip = campus_eyeToShadow * vec4(position + n * texelWorld * 0.35, 1.0);
    vec3 uv = clip.xyz / clip.w * 0.5 + 0.5;
    if (any(lessThan(uv, vec3(0.0))) || any(greaterThan(uv, vec3(1.0)))) return 1.0;
    float slope = 1.0 - abs(dot(n, normalize(czm_lightDirectionEC)));
    float bias = (0.03 + texelWorld * 0.2 * slope) / campus_shadowParams.z;
    // Bilinearly interpolate comparison results, not stored depths. A [1,2,1]
    // tent convolved with the subtexel weights needs only 4x4 unique texels.
    vec2 grid = uv.xy / campus_shadowParams.x - 0.5;
    vec2 fraction = fract(grid);
    vec2 base = floor(grid);
    vec4 weightsX = vec4(1.0 - fraction.x, 2.0 - fraction.x, 1.0 + fraction.x, fraction.x);
    vec4 weightsY = vec4(1.0 - fraction.y, 2.0 - fraction.y, 1.0 + fraction.y, fraction.y);
    float visibility = 0.0;
    for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
            // NEAREST stores depth at the texel center, not the requested UV.
            vec2 sampleUV = (base + vec2(float(x), float(y)) - 0.5) * campus_shadowParams.x;
            sampleUV = clamp(sampleUV, vec2(0.5 * campus_shadowParams.x), vec2(1.0 - 0.5 * campus_shadowParams.x));
            float stored = texture(campus_shadowDepth, sampleUV).r;
            float receiverDepth = uv.z + dot(depthGradient, sampleUV - uv.xy);
            visibility += weightsX[x] * weightsY[y] * step(receiverDepth - bias, stored);
        }
    }
    // Fade the last two texels instead of leaving a hard coverage boundary.
    float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    return mix(1.0, visibility / 16.0, smoothstep(0.0, 2.0 * campus_shadowParams.x, edge));
}
`

export function receiverSource(C, source, globe = false) {
  if (globe && source.sources.some(text => text.includes('czm_geodeticSurfaceNormal(v_positionMC'))) {
    // Globe imagery has no separable PBR specular term. Attenuate its surface
    // lighting before atmospheric composition, retaining an ambient floor.
    const factor = 'mix(0.35, 1.0, campus_shadowVisibility(v_positionEC, normalEC))'
    const sources = source.sources.map(text => text
      .replaceAll('vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);',
        `vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity * ${factor}, color.a);`)
      .replace('vec4 finalColor = color;', `vec4 finalColor = vec4(color.rgb * ${factor}, color.a);`))
    return new C.ShaderSource({ defines: source.defines.slice(), sources: [pcf, ...sources] })
  }
  const marker = 'vec3 directColor = lightColorHdr * directLighting;'
  if (!source.defines.includes('LIGHTING_PBR')) return null
  if (!source.sources.some(text => text.includes(marker))) return null
  const sources = source.sources.map(text => text
    .replace(marker, 'vec3 directColor = lightColorHdr * directLighting * campus_shadowVisibility(position, normal);')
    .replace('vec3 color = lightColorHdr * directReflection;',
      'vec3 color = lightColorHdr * directReflection * campus_shadowVisibility(position, normal);')
    .replace('material.diffuse = color;', `material.diffuse = color;
      #ifdef HAS_NORMALS
      if (campus_shadowParams.w > 1.5) material.diffuse = vec3(campus_shadowVisibility(attributes.positionEC, material.normalEC));
      #endif`))
  return new C.ShaderSource({ defines: source.defines.slice(), sources: [pcf, ...sources] })
}

export function casterSources(C, program) {
  const vs = program.vertexShaderSource
  const fs = program.fragmentShaderSource
  const depthDefines = defines => [...defines.filter(d => d !== 'LOG_DEPTH' && d !== 'LOG_DEPTH_READ_ONLY'), 'SHADOW_MAP']
  return {
    vertexShaderSource: new C.ShaderSource({ defines: depthDefines(vs.defines), sources: vs.sources.slice() }),
    fragmentShaderSource: new C.ShaderSource({
      defines: depthDefines(fs.defines),
      sources: [...fs.sources.map(text => C.ShaderSource.replaceMain(text, 'campus_depth_main')
        .replace('lightingStage(material, attributes);', '/* Depth pass retains alpha, not lighting. */')),
        'void main() { campus_depth_main(); out_FragColor = vec4(1.0); }']
    })
  }
}
