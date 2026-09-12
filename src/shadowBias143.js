// Version-pinned exception: 1.143 exposes no public primitive depth-bias setter.
// Real campus roofs exhibit acne with 0.00002; keep this dependency isolated.
export default function configureShadowBias(pipeline) {
  const shadowMap = pipeline.viewer.shadowMap
  const bias = shadowMap._primitiveBias
  if (!bias || typeof bias.depthBias !== 'number') return
  pipeline.write(bias, 'depthBias', 0.0002)
  pipeline.write(bias, 'normalOffsetScale', 0.5)
  shadowMap.dirty = true
}
