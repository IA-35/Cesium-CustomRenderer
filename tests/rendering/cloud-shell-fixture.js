import { cloudShellIntervals, cloudShellGLSL } from '../../src/environment/cloudShell143.js'

export function runCloudShellChecks(C, viewer) {
  const context = viewer.scene.context, gl = context._gl, radius = 6378137
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const texture = new C.Texture({ context, width: 1, height: 1, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
  const fbo = new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
  const values = { shellRadiusHeight: new C.Cartesian2(radius, 20), shellUp: new C.Cartesian3(0,0,1),
    u_direction: new C.Cartesian3(0,0,1), u_limit: 20000000 }
  const state = { viewport: new C.BoundingRectangle(0,0,1,1), depthTest:{enabled:false}, depthMask:false }
  const command = context.createViewportQuadCommand(`${cloudShellGLSL}
    uniform vec3 u_direction; uniform float u_limit;
    void main() { out_FragColor = shellIntervals(u_direction, 1000.0, 2000.0, u_limit); }`, {
    framebuffer: fbo, renderState: C.RenderState.fromCache(state),
    uniformMap: Object.fromEntries(Object.keys(values).map(name => [name, () => values[name]])) })
  const cases = [[20,[0,0,1],2e7], [20,[0,0,-1],2e7], [20,[0,0,1],500],
    [1500,[0,0,1],2e7], [1500,[0,0,-1],2e7], [20000,[0,0,-1],2e7], [20000,[0,0,1],2e7], [20,[1,0,0],2e7]]
  const measurements = []
  try {
    for (const [height, direction, limit] of cases) {
      values.shellRadiusHeight.y = height
      values.u_direction = new C.Cartesian3(...direction); values.u_limit = limit
      command.execute(context)
      const actual = Array.from(context.readPixels({ framebuffer:fbo, width:1, height:1 }))
      const reference = cloudShellIntervals([0,0,radius+height], direction, radius, 1000, 2000, limit)
      const intervals = [actual.slice(0,2), actual.slice(2,4)].filter(pair => pair[1] > pair[0]).flat()
      const error = intervals.length === reference.length ? Math.max(0,...intervals.map((v,i) => Math.abs(v-reference[i]))) : Infinity
      measurements.push({height,direction,limit,intervals,reference,error})
      if (error > .1) throw new Error('Shell GPU interval mismatch: '+JSON.stringify(measurements))
    }
    return {checks:{ gpuMatchesDoublePrecisionReference:true }, measurements}
  } finally {
    command.shaderProgram.destroy(); fbo.destroy(); texture.destroy(); C.RenderState.removeFromCache(state)
    context.uniformState.viewport=viewport
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)
  }
}
