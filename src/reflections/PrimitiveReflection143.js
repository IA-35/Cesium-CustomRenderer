// B07: 把标准 PBR Model 之外的普通 Primitive 接入 CCR 的材质通道 / SSR 接收端契约。
//
// 为什么必须是独立适配器，而不是放宽 materialShader143 的判据：
// materialShader143.materialSources() 要求同时命中 Cesium 打包的 ModelFS 与
// MaterialStageFS，因为 B02 的 DeferredLighting 需要 czm_modelMaterial
// (baseColor/roughness/metallic/normalEC/occlusion/emissive) 才能着色。
// 普通 Primitive 走的是**另一套着色模型**，实测四个真实 Primitive
// （Color 不透明 / Water 半透明 / Water 不透明 / NormalMap）全部命中
// AllMaterialAppearanceFS、使用 czm_material 结构体并调用 czm_phong，
// 四个命令**没有一个**命中 ModelFS 或 czm_modelMaterial。
//
// 因此本模块的纪律是：
//   1. 不伪装成标准 PBR。绝不设置 STANDARD_PBR_VALID(512) —— DeferredLighting143
//      的片元着色器（deferredLightingShader143.js 第 36 行）以该位为 discard 判据，
//      保持不设置即可让普通 Primitive 继续使用原生前向着色，不被延迟光照二次照亮。
//   2. 只提供反射/AO 消费者真正读取的字段：法线、roughness、视深度、透明覆盖，
//      以及环境反射响应。没有环境镜面就是没有，不编造一个「已有的环境反射」。
//   3. shininess → roughness 与 specular → F0 是**近似换算**，对外明确标注，
//      不宣称与 Model 路径数值等价。

export const PRIMITIVE_REFLECTION_VERSION = 1

// 普通 Primitive 的 appearance 片元着色器。三者都提供 v_positionEC 与
// v_normalEC（Ellipsoid 变体没有 v_normalEC 插值，但有 czm_materialInput）。
//
// 实测得到的真实结构（docs/B07_RECONNAISSANCE.md，浏览器 dump）：
// 命令的 fragmentShaderSource.sources 是**两段**，且 appearance 主体并不单独成段——
// Cesium 把材质定义（czm_getMaterial）与 appearance 主体**拼进了同一段 source**：
//
//   source 0 = [材质定义] + [appearance 主体（main 已被重命名为 czm_log_depth_main）]
//   source 1 = void main(){ czm_log_depth_main(); czm_writeLogDepth(); }
//
// 因此定位不能要求「整段等于 appearance 模板」，必须按**主体子串**在段内查找；
// 同时 `main` 在 log-depth 变体下会被改名为 `czm_log_depth_main`，
// 所以只按函数体（输出语句）定位，不依赖函数名。
const appearanceNames = ['_shadersAllMaterialAppearanceFS', '_shadersEllipsoidSurfaceAppearanceFS',
  '_shadersTexturedMaterialAppearanceFS', '_shadersBasicMaterialAppearanceFS']

// 这些材质把 shininess 当作输入，换算到 GGX 粗糙度用 Blinn-Phong 的标准近似
// α = sqrt(2/(s+2))。B03 的透明前向水面路径（transparentForwardShader143.js
// ccr_waterLighting）已经使用同一式子，故两处保持一致，避免同一水面在
// 前向着色与反射响应之间出现两套粗糙度尺度。
export const ROUGHNESS_FROM_SHININESS = 'clamp(sqrt(2.0/(max(shininess,0.0)+2.0)),0.04,1.0)'

// 水面 F0 取 0.02（水的垂直入射反射率量级）；其他材质按 specular 强度缩放同一基数。
// 这是把 Phong 的标量高光强度映射到电介质 F0 的近似，不是物理等价换算。
export const F0_FROM_SPECULAR = 'vec3(0.02)*clamp(specular,0.0,1.0)'

const declarations = `
precision highp float;
layout(location = 1) out vec4 ccr_primitiveEmissiveFlags;
layout(location = 2) out float ccr_primitiveDepth;
layout(location = 3) out float ccr_primitiveCoverage;
float ccr_primitiveRoughness(float shininess) { return ${ROUGHNESS_FROM_SHININESS}; }
vec3 ccr_primitiveF0(float specular) { return ${F0_FROM_SPECULAR}; }
vec2 ccr_primitiveOctNormal(vec3 normalEC) {
    float magnitude = abs(normalEC.x) + abs(normalEC.y) + abs(normalEC.z);
    vec3 n = magnitude > 0.0 ? normalEC / magnitude : vec3(0.0, 0.0, 1.0);
    vec2 direction = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    vec2 oct = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * direction;
    return oct * 0.5 + 0.5;
}
`

/**
 * 在某个 source 段内定位 appearance 主体。
 *
 * 返回 `{ index, start, end }`：主体在 `sources[index]` 中占据的字符区间。
 *
 * 为什么不能直接拿引擎模板做子串匹配：Cesium 的 `ShaderSource.replaceMain`
 * 会把入口函数改名（log-depth 变体下 `main` → `czm_log_depth_main`），
 * 于是模板原文在真实命令里**已经不存在**。实测确认：
 * `src0.includes(未改名模板) === false`。若按原文匹配，真实命令会被全部拒绝，
 * B07 对任何开启 log-depth 的场景（Cesium 默认开启）都完全不生效。
 *
 * 因此改为按**不随改名变化的结构锚点**定位：appearance 主体的起点是它自己的
 * 插值声明（`in vec3 v_positionEC;` 等），终点是 `#endif` 后的收尾花括号。
 * 同时校验区间内确实含 `czm_getMaterial` 与输出语句，避免框错范围。
 */
const appearanceAnchors = [/_shadersAllMaterialAppearanceFS/, /_shadersEllipsoidSurfaceAppearanceFS/,
  /_shadersTexturedMaterialAppearanceFS/, /_shadersBasicMaterialAppearanceFS/]

function appearanceStage(C, sources) {
  const stages = appearanceNames.map(name => C[name])
    .filter(stage => typeof stage === 'string' && stage.trim())
    .map(stage => stage.trim())
  if (!stages.length) return null
  const found = []
  for (const [index, source] of sources.entries()) {
    for (const stage of stages) {
      // 1) 优先尝试原文匹配（未开启 log-depth 时引擎保留 main）。
      let start = source.indexOf(stage)
      let end = start < 0 ? -1 : start + stage.length
      if (start < 0) {
        // 2) 原文不匹配时，用「插值声明开头 + 无 main 的变体」重建可匹配的形式。
        //    replaceMain 只改函数名，其余文本逐字节不变，因此把模板里的 main 签名
        //    也换成改名后的形式即可继续子串匹配，且仍是唯一匹配。
        const renamed = stage.replace(/\bvoid\s+main\s*\(/, 'void czm_log_depth_main(')
        if (renamed !== stage) {
          start = source.indexOf(renamed)
          end = start < 0 ? -1 : start + renamed.length
        }
      }
      if (start < 0) continue
      // 同一种形式出现两次说明结构超出预期，拒绝而不是猜。
      const probe = source.slice(start, end)
      if (source.indexOf(probe, start + probe.length) >= 0) return null
      found.push({ index, start, end, text: probe })
    }
  }
  if (found.length !== 1) return null
  const match = found[0]
  // 区间必须自洽：含材质求值与至少一个颜色输出语句。
  if (!/czm_getMaterial\s*\(/.test(match.text)) return null
  if (!/out_FragColor\s*=/.test(match.text)) return null
  return match
}

/**
 * 判断一个命令的片元着色器是否是我们支持的普通 Primitive appearance。
 *
 * 返回 `{ supported, family, reason }`。`reason` 在不受支持时给出可统计的具体原因，
 * 便于调用方把兼容对象**计数**而不是静默跳过。
 */
export function primitiveReflectionSupport(C, program) {
  const unsupported = reason => ({ supported: false, family: null, reason })
  const vs = program && program.vertexShaderSource
  const fs = program && program.fragmentShaderSource
  if (!vs || !fs || !Array.isArray(fs.sources) || fs.pickColorQualifier) return unsupported('no fragment sources')
  const defines = new Set((fs.defines || []).map(define => define.trim().split(/\s+/)[0]))
  const allDefines = new Set([...defines, ...(vs.defines || []).map(define => define.trim().split(/\s+/)[0])])
  // 拾取、阴影投射与 OIT 派生包装会覆盖主颜色输出，不能改写。
  if (fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main|czm_out_FragColor)\b/.test(source))) {
    return unsupported('derived wrapper')
  }
  // 已经被 CCR 别的适配器接管过的程序不再二次改写。
  if (defines.has('CESIUM_REDIRECTED_COLOR_OUTPUT') ||
    fs.sources.some(source => /layout\s*\(\s*location\s*=\s*[1-9]/.test(source))) return unsupported('already redirected')
  if (['METADATA_PICKING_ENABLED', 'SHADOW_MAP', 'OIT'].some(define => defines.has(define))) return unsupported('picking/shadow/OIT variant')
  const stage = appearanceStage(C, fs.sources)
  if (!stage) return unsupported('not a supported appearance')
  const text = stage.text
  // 必须有可用的视空间法线与视空间位置插值，否则拿不到真实法线/深度。
  if (!/\bv_normalEC\b/.test(text) && !/czm_materialInput\s+materialInput/.test(text)) return unsupported('no eye-space normal')
  if (!/\bv_positionEC\b/.test(text)) return unsupported('no eye-space position')
  // FLAT 是同一份文本上的 define；两个分支同时存在，按 define 选择改写目标。
  const flat = defines.has('FLAT')
  const phong = /out_FragColor\s*=\s*czm_phong\s*\(normalize\(positionToEyeEC\),\s*material,\s*czm_lightDirectionEC\);/.test(text)
  const flatOutput = /out_FragColor\s*=\s*vec4\(material\.diffuse\s*\+\s*material\.emission,\s*material\.alpha\);/.test(text)
  if (flat ? !flatOutput : !phong) return unsupported('no usable color output')
  return { supported: true, family: flat ? 'appearanceFlat' : 'appearance', reason: null, stage, flat, allDefines }
}

/**
 * 生成普通 Primitive 的 MRT 片元源。
 *
 * 关键约束（与 materialShader143 一致，便于共用同一套消费者）：
 *   * location 0 = 八面体编码法线 + roughness + metallic(0)，写入 RGBA8 目标；
 *   * location 1 = emissive + 整数 flags（低 10 位），**不含** group ID，
 *     因此消费者走八面体解码分支而不是紧凑 native-XYZ 分支；
 *   * location 2 = 正米制视深度，取 -v_positionEC.z（不是 window depth）；
 *   * location 3 = 透明覆盖，不透明路径恒为 0；
 *   * location 4/5 = 环境反射镜面与响应（仅 reflection 开启时）。
 *
 * 原生 Phong 颜色不丢弃：opaqueColor 开启时原样写入对应附件，供 B03 的透明合成
 * 与其它消费者作为「不透明背景色」使用。
 */
export function primitiveReflectionSources(C, program, { reflection = false, opaqueColor = false, albedo = false } = {}) {
  const support = primitiveReflectionSupport(C, program)
  if (!support.supported) return null
  const fs = program.fragmentShaderSource
  const source = fs.sources[support.stage]
  // flags 只含低 10 位：SURFACE(1) | NORMAL_VALID(2) | EMISSIVE_VALID(8)。
  // 刻意不含 STANDARD_PBR_VALID(512)，见文件头纪律 1。
  const flags = 1 | 2 | 8
  // 反射响应：rgb = F0，a = roughness。
  // 刻意**不**在此处新造一条粗糙度衰减曲线：traceReflection 已经用
  // response.a 选取半径与预算，reflectionHitConfidence 也已经按 roughness
  // 做 smoothstep 衰减，粗糙度因此沿既有置信度机制生效。
  const reflectionWrites = reflection ? `
    ccr_primitiveSpecular = vec4(ccr_primitiveF0(material.specular), 1.0);
    ccr_primitiveResponse = vec4(ccr_primitiveF0(material.specular), ccr_primitiveRoughness(material.shininess));` : ''
  // 原生 Phong 结果保持不丢弃：opaqueColor 开启时写入对应附件，
  // 供 B03 透明合成等消费者当作「不透明背景色」。
  const colorCapture = opaqueColor ? 'ccr_primitiveOpaqueColor = nativeColor;' : ''
  const albedoWrite = albedo ? '\n    ccr_primitiveAlbedo = vec4(material.diffuse, 1.0);' : ''
  const albedoFlag = albedo ? '\n    campus_primitiveFlags += 256.0;' : ''
  const helper = `
void ccr_primitiveOutputs(czm_material material, vec4 nativeColor, float eyeDepth) {
    // 用 material.normal 而不是调用点的 normalEC：czm_material.normal 是
    // czm_getMaterial 已经求值过的材质法线（含法线贴图扰动），NormalMap 材质
    // 的真实法线只在这里拿得到；默认材质也由 getDefaultMaterial 填成 normalEC。
    //
    // eyeDepth 必须以**参数**传入，不能在函数体里直接引用视空间位置插值：
    // 本 helper 插在整份着色器最前面，而该插值由后面的 appearance 段声明。
    // GLSL 要求先声明后使用，直接引用会编译失败（实测报错 undeclared identifier）。
    // 这类缺陷只在真实 GPU 编译时暴露，纯文本单元测试测不出来。
    vec3 ccr_primitiveNormal = material.normal;
    float campus_primitiveFlags = ${flags}.0;${albedoFlag}
    if (!(dot(ccr_primitiveNormal, ccr_primitiveNormal) > 1.0e-12) || any(isinf(ccr_primitiveNormal))) {
        ccr_primitiveNormal = vec3(0.0, 0.0, 1.0);
        campus_primitiveFlags -= 2.0;
    } else {
        ccr_primitiveNormal = normalize(ccr_primitiveNormal);
    }
    out_FragColor = vec4(ccr_primitiveOctNormal(ccr_primitiveNormal), ccr_primitiveRoughness(material.shininess), 0.0);
    ccr_primitiveEmissiveFlags = vec4(material.emission, campus_primitiveFlags);
    ccr_primitiveDepth = eyeDepth;
    ccr_primitiveCoverage = 0.0;${reflectionWrites}${albedoWrite}
    ${colorCapture}
    // nativeColor 在关闭 opaqueColor 时仍然参与求值：原生结果必须在调用点
    // 先行算出，这里用一个永不成立的分支引用它，避免编译器把 czm_phong
    // 判定为死代码而改变与原生路径的求值差异。
    if (nativeColor.a < -1.0) out_FragColor.a = 0.0;
}`

  const phongCall = /out_FragColor\s*=\s*czm_phong\s*\(normalize\(positionToEyeEC\),\s*material,\s*czm_lightDirectionEC\);/
  const flatCall = /out_FragColor\s*=\s*vec4\(material\.diffuse\s*\+\s*material\.emission,\s*material\.alpha\);/
  // FLAT 是**同一个着色器文本上的 define**，不是另一份源：
  //   #ifdef FLAT
  //       out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
  //   #else
  //       out_FragColor = czm_phong(...);
  //   #endif
  // 两个分支的文本同时存在，但只有一个会被编译。因此必须按 FLAT define 选择要改写的
  // 那一行——若按文本出现顺序固定挑 phong，在 FLAT 变体上改写的是一段**不被编译**的
  // 代码，结果整个 MRT 附件一个都不写（flags 保持清空值），而着色器仍然编译通过，
  // 形成不会被任何断言发现的静默缺口。
  const active = support.flat ? flatCall : phongCall
  const expression = support.flat
    ? 'vec4(material.diffuse + material.emission, material.alpha)'
    : 'czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC)'
  // 只在定位到的 appearance 主体**区间内**替换：该 source 段还包含材质定义
  // （czm_getMaterial），区间外的同名文本不属于 appearance 主体，不能动。
  const { index, start, end } = support.stage
  const segment = fs.sources[index]
  const body = segment.slice(start, end)
  if (!active.test(body)) return null
  const patchedBody = body.replace(active, `{
    vec4 ccr_primitiveColor = ${expression};
    ccr_primitiveOutputs(material, ccr_primitiveColor, -v_positionEC.z);
}`)
  if (patchedBody === body) return null
  const patched = segment.slice(0, start) + patchedBody + segment.slice(end)

  const fragmentShaderSource = fs.clone()
  fragmentShaderSource.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  fragmentShaderSource.sources = fs.sources.map((text, position) => position === index ? patched : text)
  // helper 必须在调用它的 stage 之前声明：GLSL 与 C 一样要求先声明后使用，
  // 只拼接调用点而不插入定义会直接编译失败。
  fragmentShaderSource.sources.unshift(`${declarations}${helper}`)
  if (reflection) {
    fragmentShaderSource.sources.unshift('layout(location = 4) out vec4 ccr_primitiveSpecular;\nlayout(location = 5) out vec4 ccr_primitiveResponse;')
  }
  if (opaqueColor) fragmentShaderSource.sources.unshift('layout(location = 6) out vec4 ccr_primitiveOpaqueColor;')
  if (albedo) {
    const location = 4 + (reflection ? 2 : 0) + (opaqueColor ? 1 : 0)
    fragmentShaderSource.sources.unshift(`layout(location = ${location}) out vec4 ccr_primitiveAlbedo;`)
  }
  return { vertexShaderSource: program.vertexShaderSource, fragmentShaderSource }
}

/**
 * Globe water mask 的接收端契约来源。
 *
 * 实测（docs/B07_RECONNAISSANCE.md）：只有自定义 TerrainProvider 且
 * `hasWaterMask === true` 时，globe 命令的 uniform map 才有真实的 `u_waterMask`
 * 纹理；`CustomHeightmapTerrainProvider` 的 `hasWaterMask` 硬编码为 false，不可用。
 * 采样必须照抄 GlobeFS 的 y 翻转，否则掩码上下颠倒。
 *
 * 契约边界（对应主计划「Globe 保留影像颜色，非水地面不擅自金属化」）：
 *   * 影像/水体颜色**完全保留**，写入 opaqueColor 供透明合成使用；
 *   * 只有 water mask > 0.5 的片元成为反射接收端（flags 置 SURFACE|NORMAL_VALID
 *     且反射响应非零）；非水地面 flags 保持 0，既不参与 SSR 也不被金属化；
 *   * 法线使用 GlobeFS 自身计算的地表法线插值，不另造一套。
 */
export function globeWaterSources(C, program, { reflection = false, opaqueColor = false } = {}) {
  const vs = program && program.vertexShaderSource
  const fs = program && program.fragmentShaderSource
  if (!vs || !fs || !Array.isArray(fs.sources)) return null
  const defines = new Set((fs.defines || []).map(define => define.trim().split(/\s+/)[0]))
  if (defines.has('CESIUM_REDIRECTED_COLOR_OUTPUT')) return null
  if (fs.sources.some(source => /\b(czm_non_pick_main|czm_shadow_cast_main|czm_translucent_main|czm_out_FragColor)\b/.test(source))) return null
  // 没有 HAS_WATER_MASK 时 u_waterMask/u_waterMaskTranslationAndScale 连声明都没有
  // （GlobeFS.js:53-57 的 #if 保护），此时该地形源没有水掩码，必须显式判定为不适用。
  if (!defines.has('HAS_WATER_MASK')) return null
  if (typeof C._shadersGlobeFS !== 'string') return null
  const globe = C._shadersGlobeFS.trim()
  // 与普通 Primitive 同一个陷阱：log-depth 派生会把入口函数改名
  // （main -> czm_log_depth_main），因此模板原文在真实命令里**不存在**。
  // 实测证据：globe 命令的 direct 变体 templateMatchesWholeSource=true，
  // 但 _draw 实际选用的 logDepth 变体为 false —— 若只按原文匹配，
  // 水面在开启 log-depth（Cesium 默认开启）时一条都不会被接入。
  const renamed = globe.replace(/\bvoid\s+main\s*\(/, 'void czm_log_depth_main(')
  let index = -1
  let matched = null
  for (const [position, source] of fs.sources.entries()) {
    for (const candidate of renamed === globe ? [globe] : [globe, renamed]) {
      if (!source.includes(candidate)) continue
      index = position
      matched = candidate
      break
    }
    if (index >= 0) break
  }
  if (index < 0) return null
  const source = fs.sources[index]
  // GlobeFS 以 `out_FragColor =  finalColor;` 汇总输出（注意是两个空格）。
  // 只在该赋值处接入，影像/水色本身完全不动。
  const marker = /out_FragColor\s*=\s*finalColor;/
  if (!marker.test(source)) return null
  // 区间自洽校验：命中的片段必须真的含最终输出与水面掩码 uniform 声明。
  if (!/u_waterMask/.test(source)) return null
  void matched
  // 采样必须照抄 GlobeFS:392-397 —— 同样的 scale/translation 与 y 翻转。
  // 这里重新采样而不是复用 `mask` 变量：`mask` 声明在
  // `#if defined(HAS_WATER_MASK) && (SHOW_REFLECTIVE_OCEAN || APPLY_MATERIAL)`
  // 块内（GlobeFS.js:391-412），在 out_FragColor 处已经超出作用域，
  // 直接引用会编译失败。水掩码纹理是同一张，重新采样结果一致。
  //
  // 法线同理不能直接用 `normalEC`：它由 `SHOW_REFLECTIVE_OCEAN ||
  // ENABLE_DAYNIGHT_SHADING || HDR` 保护（GlobeFS.js:339-342），
  // 对该组合不成立时会未声明。`v_normalEC` 由 GlobeVS 无条件输出
  // （GlobeVS.js:209），因此以它为准。
  const patched = source.replace(marker, `{
    vec4 ccr_globeColor = finalColor;
    vec2 ccr_globeUv = v_textureCoordinates.xy * u_waterMaskTranslationAndScale.zw + u_waterMaskTranslationAndScale.xy;
    ccr_globeUv.y = 1.0 - ccr_globeUv.y;
    float ccr_globeWater = texture(u_waterMask, ccr_globeUv).r;
    // 判据必须与 GlobeFS 完全一致：GlobeFS.js:400 用「大于 0.0」，即**非零即水**。
    //
    // 不能写成大于 0.5。水掩码有两种存储形态，取值尺度不同：
    //   * 长度 1（整块全水/全陆）：复用 allWaterTexture，像素值是 255 -> 归一化 1.0；
    //   * 逐像素掩码：Uint8Array 里存 0/1，作为 LUMINANCE/UNSIGNED_BYTE 纹理
    //     归一化后是 0.0 / 0.0039。
    // 用 0.5 阈值会让**所有逐像素掩码**被判成陆地（0.0039 < 0.5），
    // 而整水掩码恰好通过——形成「整水用例绿、逐像素用例红」的假象，
    // 实测就是这样先误导了一轮排查。
    bool ccr_globeIsWater = ccr_globeWater > 0.0;
    vec3 ccr_globeNormal = dot(v_normalEC, v_normalEC) > 1.0e-12 ? normalize(v_normalEC) : vec3(0.0, 0.0, 1.0);
    // 只有水域成为反射接收端：flags = SURFACE|NORMAL_VALID = 3，非水地面为 0。
    // 非水地面因此既不参与 SSR，也不被金属化，影像颜色原样进入 opaqueColor。
    out_FragColor = vec4(ccr_primitiveOctNormal(ccr_globeNormal), ccr_globeIsWater ? 0.08 : 1.0, 0.0);
    ${opaqueColor ? 'ccr_primitiveOpaqueColor = ccr_globeColor;' : ''}
    ccr_primitiveEmissiveFlags = vec4(0.0, 0.0, 0.0, ccr_globeIsWater ? 3.0 : 0.0);
    ccr_primitiveDepth = -v_positionEC.z;
    ccr_primitiveCoverage = 0.0;
    ${reflection ? `ccr_primitiveSpecular = vec4(ccr_globeIsWater ? vec3(0.02) : vec3(0.0), ccr_globeIsWater ? 1.0 : 0.0);
    ccr_primitiveResponse = vec4(ccr_globeIsWater ? vec3(0.02) : vec3(0.0), ccr_globeIsWater ? 0.08 : 1.0);` : ''}
}`)
  if (patched === source) return null
  const fragmentShaderSource = fs.clone()
  fragmentShaderSource.defines.push('CESIUM_REDIRECTED_COLOR_OUTPUT')
  fragmentShaderSource.sources = fs.sources.map((text, i) => i === index ? patched : text)
  fragmentShaderSource.sources.unshift(declarations)
  if (reflection) {
    fragmentShaderSource.sources.unshift('layout(location = 4) out vec4 ccr_primitiveSpecular;\nlayout(location = 5) out vec4 ccr_primitiveResponse;')
  }
  if (opaqueColor) fragmentShaderSource.sources.unshift('layout(location = 6) out vec4 ccr_primitiveOpaqueColor;')
  return { vertexShaderSource: vs, fragmentShaderSource }
}

/** 对外可见的支持/兼容边界，写入诊断，不使用「全部支持」这类说法。 */
export function primitiveReflectionDiagnostics() {
  return {
    version: PRIMITIVE_REFLECTION_VERSION,
    supported: 'AllMaterialAppearance / EllipsoidSurfaceAppearance / TexturedMaterialAppearance 的不透明与 FLAT 分支；Globe 命令的 water mask 区域',
    compatibility: 'PerInstanceColor/Polyline 等其它 appearance、拾取/阴影/透明派生包装、已被其它适配器接管的程序',
    roughnessMapping: `shininess -> GGX 粗糙度近似 ${ROUGHNESS_FROM_SHININESS}（Blinn-Phong 标准近似，与 B03 水面前向路径同一式子）`,
    f0Mapping: `specular -> F0 近似 ${F0_FROM_SPECULAR}（把 Phong 标量高光强度映射到电介质 F0，非物理等价）`,
    standardPbr: false,
    standardPbrReason: '刻意不设置 STANDARD_PBR_VALID，普通 Primitive 继续使用原生前向着色，不被 DeferredLighting 二次照亮'
  }
}
