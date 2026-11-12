export default `
in vec3 v_normalEC;
in vec3 v_positionEC;
in vec2 v_st;
in vec4 v_color;
in float v_windWeight;

uniform float u_cutoutType;
uniform float u_alphaCutoff;
uniform bool u_alphaFromColor;
uniform sampler2D u_barkColorTexture;
uniform vec2 u_barkTextureScale;
uniform bool u_useBarkTexture;
uniform sampler2D u_assetColorTexture;
uniform bool u_useAssetColorTexture;
uniform bool u_assetColorPremultiplied;
uniform bool u_roundedLeafNormals;
// CCR grass realism: x normal bend toward ground, y root brightness, z tip tint, w back-light.
uniform vec4 u_grassShading;

float ezTree_leafMask(vec2 st)
{
    vec2 p = st * 2.0 - 1.0;
    p.y += 0.12;
    float body = 1.0 - dot(p * vec2(0.78, 1.08), p * vec2(0.78, 1.08));
    float tip = smoothstep(-0.2, 0.85, st.y);
    return body * tip;
}

float ezTree_grassMask(vec2 st)
{
    float center = abs(st.x - 0.5) * 2.0;
    float height = 1.0 - st.y;
    float taper = 1.0 - smoothstep(0.1, 1.0, height);
    return 1.0 - smoothstep(max(0.08, taper), 1.0, center);
}

float ezTree_flowerMask(vec2 st)
{
    if (st.y < 0.0) {
        return 1.0;
    }

    vec2 p = st * 2.0 - 1.0;
    float petal = 1.0 - dot(p * vec2(0.92, 1.28), p * vec2(0.92, 1.28));
    float center = 1.0 - smoothstep(0.0, 0.22, length(p));
    return max(petal, center);
}

void main()
{
    float mask = 1.0;
    vec4 assetTexel = vec4(1.0);
    if (u_useAssetColorTexture) {
        assetTexel = texture(u_assetColorTexture, v_st);
        // Filter premultiplied texels, then restore straight color for opaque cutout lighting.
        if (u_assetColorPremultiplied) {
            assetTexel.rgb /= max(assetTexel.a, 0.0001);
        }
        mask = u_alphaFromColor
            ? max(assetTexel.r, max(assetTexel.g, assetTexel.b))
            : assetTexel.a;
    } else if (u_cutoutType > 2.5) {
        mask = ezTree_flowerMask(v_st);
    } else if (u_cutoutType > 1.5) {
        mask = ezTree_grassMask(v_st);
    } else if (u_cutoutType > 0.5) {
        mask = ezTree_leafMask(v_st);
    }

    if (mask < u_alphaCutoff) {
        discard;
    }

#ifdef SHADOW_MAP
    out_FragColor = vec4(1.0);
    return;
#endif
    vec3 albedo = v_color.rgb;
    if (u_useAssetColorTexture) {
        albedo *= czm_srgbToLinear(assetTexel.rgb);
    } else if (u_cutoutType < 0.5 && u_useBarkTexture) {
        vec2 barkSt = vec2(
            v_st.x * u_barkTextureScale.x,
            v_st.y / max(u_barkTextureScale.y, 0.001)
        );
        albedo *= czm_srgbToLinear(texture(u_barkColorTexture, barkSt).rgb);
    }

    vec3 normalEC = normalize(
        u_roundedLeafNormals
            ? v_normalEC
            : (gl_FrontFacing ? v_normalEC : -v_normalEC)
    );
    // CCR grass: thin cards facing random directions light up as speckles, and an
    // evenly lit blade reads as a sticker. Bend normals toward the ground normal,
    // darken roots (self-occlusion inside the clump) and warm the tips.
    // v_windWeight is the normalised blade height (0 root, 1 tip) for grass assets.
    bool ccr_isGrass = u_cutoutType > 1.5 && u_cutoutType < 2.5;
    float ccr_bladeHeight = clamp(v_windWeight, 0.0, 1.0);
    if (ccr_isGrass) {
        vec3 groundNormalEC = normalize(czm_normal * vec3(0.0, 0.0, 1.0));
        normalEC = normalize(mix(normalEC, groundNormalEC, u_grassShading.x));
        albedo *= mix(u_grassShading.y, 1.0, smoothstep(0.0, 0.75, ccr_bladeHeight));
        albedo = mix(albedo, albedo * vec3(1.18, 1.12, 0.78), smoothstep(0.55, 1.0, ccr_bladeHeight) * u_grassShading.z);
    }
    float diffuse = max(dot(normalEC, normalize(czm_lightDirectionEC)), 0.0);
    // This marker is adapted by CCR's shadow receiver; ambient stays unshadowed.
    float ccr_ezTreeVisibility = 1.0;
    float wrap = 0.38 + diffuse * 0.62 * ccr_ezTreeVisibility;
    vec3 color = albedo * (vec3(0.38) + czm_lightColor * diffuse * 0.62 * ccr_ezTreeVisibility);
    if (u_cutoutType > 2.5 && v_st.y < 0.0) {
        color = vec3(0.22, 0.48, 0.18) * wrap;
    }
    color += albedo * 0.08 * v_windWeight;
    if (ccr_isGrass) {
        // Back-light transmission: looking toward the sun, thin tips glow.
        float ccr_backLight = pow(max(dot(normalize(v_positionEC), normalize(czm_lightDirectionEC)), 0.0), 3.0);
        color += albedo * czm_lightColor * ccr_backLight * u_grassShading.w * ccr_bladeHeight * ccr_ezTreeVisibility;
    }

    // Match Cesium Model: HDR targets store linear light; SDR targets store sRGB.
#ifndef HDR
    color = czm_linearToSrgb(color);
#endif
    out_FragColor = vec4(color, v_color.a);
}
`;
