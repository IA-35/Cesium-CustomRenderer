import createNoise from '../../src/environment/noiseAtlas.js'
import { createEnvironmentStages } from '../../src/environment/environmentStages.js'

// Independent CPU trilinear reference catches atlas interpolation seams that
// become streaks after many samples along a shell ray.
export function runNoiseChecks(C, viewer) {
  const context = viewer.scene.context, gl = context._gl, width = 4096, height = 3
  const viewport = C.BoundingRectangle.clone(context.uniformState.viewport)
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  let lattice
  createNoise({ ...C, Texture: class { constructor(o) { lattice = o.source.arrayBufferView } } }, context)
  const noise = createNoise(C, context), stages = createEnvironmentStages(C, {}, 'balanced', 'shell')
  const functions = 'float noiseVoxel' + stages.raymarchStage.fragmentShader.split('float noiseVoxel')[1].split('float phaseHG')[0]
  const texture = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT })
  const fbo = new C.Framebuffer({ context, colorTextures: [texture], destroyAttachments: false })
  const state = { viewport: new C.BoundingRectangle(0,0,width,height), depthTest: { enabled:false }, depthMask:false }
  const command = context.createViewportQuadCommand(`#define CLOUD_SHELL
    uniform highp sampler2D noiseTexture;
    ${functions}
    void main() {
      vec2 xy = gl_FragCoord.y < 1.0 ? vec2(42.123,57.83) : gl_FragCoord.y < 2.0 ? vec2(63.99,0.01) : vec2(-0.01,64.125);
      out_FragColor = vec4(noise3D(vec3(xy, gl_FragCoord.x/64.0)));
    }`, { framebuffer:fbo, renderState:C.RenderState.fromCache(state), uniformMap:{noiseTexture:()=>noise} })
  const wrap = n => ((n % 64) + 64) % 64
  const sample = (x,y,z) => { x=wrap(x);y=wrap(y);z=wrap(z); return lattice[((Math.floor(z/8)*66+y+1)*528+z%8*66+x+1)*4]/255 }
  let maximumError=0
  try {
    command.execute(context)
    const pixels=context.readPixels({framebuffer:fbo,width,height})
    const coords=[[42.123,57.83],[63.99,.01],[-.01,64.125]]
    for(let row=0;row<3;row++) for(let i=0;i<width;i++) {
      const p=[...coords[row],(i+.5)/64], base=p.map(Math.floor), fraction=p.map((v,j)=>{const f=v-base[j];return f*f*(3-2*f)})
      let expected=0
      for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++) {
        expected+=sample(base[0]+x,base[1]+y,base[2]+z)*[x,y,z].reduce((w,v,j)=>w*(v?fraction[j]:1-fraction[j]),1)
      }
      maximumError=Math.max(maximumError,Math.abs(expected-pixels[(row*width+i)*4]))
    }
    if(maximumError>0.00003)throw new Error('Noise lattice interpolation error: '+maximumError)
    return {checks:{shellNoiseMatchesTrilinearReference:true},samples:width*height,maximumError}
  } finally {
    command.shaderProgram.destroy();fbo.destroy();texture.destroy();noise.destroy();stages.composite.destroy();C.RenderState.removeFromCache(state)
    context.uniformState.viewport=viewport;gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw)
  }
}
