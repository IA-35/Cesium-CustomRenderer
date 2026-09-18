import test from 'node:test'
import assert from 'node:assert/strict'
import RenderTargetPool143,{getRenderTargetPool} from '../../src/pipeline/RenderTargetPool143.js'
import {registerHdrEffect} from '../../src/environment/HdrCoordinator143.js'
function engine(){
 let id=0
 return {PixelFormat:{RGBA:1},PixelDatatype:{FLOAT:2},TextureMinificationFilter:{NEAREST:3},TextureMagnificationFilter:{NEAREST:3},
  Sampler:class{},Texture:class{constructor(o){Object.assign(this,o);this.id=++id;this.sizeInBytes=o.width*o.height*16}isDestroyed(){return !!this.dead}destroy(){this.dead=true}},
  Framebuffer:class{constructor(o){Object.assign(this,o);this.status=1}isDestroyed(){return !!this.dead}destroy(){this.dead=true}}}
}
const spec={width:64,height:32,pixelFormat:1,pixelDatatype:2,samples:1}
test('leases reuse only matching released targets and invalidate old handles',()=>{
 const pool=new RenderTargetPool143(engine(),{_gl:{FRAMEBUFFER_COMPLETE:1}}),a=pool.acquire('ao',spec),texture=a.texture
 const b=pool.acquire('bloom',spec);assert.notEqual(b.texture,texture)
 a.release();assert.throws(()=>a.texture,/expired/)
 const c=pool.acquire('bloom',spec);assert.equal(c.texture,texture);assert.equal(pool.getDiagnostics().reused,1)
 b.release();c.release();pool.destroy();assert.equal(texture.isDestroyed(),true)
})
test('read reservations prohibit framebuffer feedback even after a lease is released',()=>{
 const pool=new RenderTargetPool143(engine(),{_gl:{FRAMEBUFFER_COMPLETE:1}}),a=pool.acquire('ao',spec),texture=a.texture
 const unreserve=pool.reserve([texture]);a.release();const b=pool.acquire('bloom',spec)
 assert.notEqual(b.texture,texture);unreserve();b.release();pool.destroy()
})
test('descriptor and context identity separate targets; owner invalidation releases only its leases',()=>{
 const C=engine(),ctx={_gl:{FRAMEBUFFER_COMPLETE:1}},pool=new RenderTargetPool143(C,ctx),a=pool.acquire('ao',spec)
 assert.throws(()=>pool.acquire('wrong',{...spec,context:{}}),/context/)
 const b=pool.acquire('bloom',{...spec,width:32});pool.releaseOwner('ao')
 assert.throws(()=>a.framebuffer,/expired/);assert.ok(b.framebuffer);assert.equal(pool.getDiagnostics().live,1)
 b.release();pool.destroy();assert.equal(pool.getDiagnostics().currentBytes,0)
})
test('resize invalidates every generation and frees storage without touching borrowed inputs',()=>{
 const pool=new RenderTargetPool143(engine(),{_gl:{FRAMEBUFFER_COMPLETE:1}}),a=pool.acquire('ao',spec),texture=a.texture,borrowed={dead:false}
 const unreserve=pool.reserve([borrowed]);pool.invalidate();assert.equal(texture.isDestroyed(),true);assert.throws(()=>a.texture,/expired/)
 assert.equal(borrowed.dead,false);unreserve();pool.destroy()
})
test('failed framebuffer allocation releases the texture',()=>{
 const C=engine();let texture
 const Original=C.Texture;C.Texture=class extends Original{constructor(o){super(o);texture=this}}
 C.Framebuffer=class{constructor(){throw new Error('allocation failed')}}
 const pool=new RenderTargetPool143(C,{_gl:{FRAMEBUFFER_COMPLETE:1}})
 assert.throws(()=>pool.acquire('ao',spec),/allocation failed/);assert.equal(texture.dead,true);assert.equal(pool.getDiagnostics().live,0)
 pool.destroy()
})

test('retired storage survives an outstanding reader but its lease expires immediately',()=>{
 const pool=new RenderTargetPool143(engine(),{_gl:{FRAMEBUFFER_COMPLETE:1}}),a=pool.acquire('ao',spec),texture=a.texture
 const unreserve=pool.reserve([texture]);pool.invalidate()
 assert.equal(a.valid,false);assert.throws(()=>a.texture,/expired/);assert.equal(texture.isDestroyed(),false)
 const b=pool.acquire('bloom',spec);assert.notEqual(b.texture,texture)
 unreserve();assert.equal(texture.isDestroyed(),true);unreserve();b.release();pool.destroy()
})

test('context loss invalidates live handles and releases their owned attachments',()=>{
 const canvas=new EventTarget(),pool=new RenderTargetPool143(engine(),{_gl:{FRAMEBUFFER_COMPLETE:1,canvas}})
 const a=pool.acquire('ao',spec),texture=a.texture,framebuffer=a.framebuffer
 canvas.dispatchEvent(new Event('webglcontextlost'))
 assert.equal(a.valid,false);assert.equal(texture.isDestroyed(),true);assert.equal(framebuffer.isDestroyed(),true)
 assert.equal(pool.getDiagnostics().live,0);assert.equal(pool.getDiagnostics().currentBytes,0)
 pool.destroy()
})

test('a later HDR consumer failure releases the current pooled color lease',()=>{
 const ctx={_gl:{FRAMEBUFFER_COMPLETE:1}},pool=getRenderTargetPool(engine(),ctx),lease=pool.acquire('ao',spec),texture=lease.texture
 const scene={postProcessStages:{execute(){assert.fail('native tonemap must not retry after failure')}}}
 const removeAo=registerHdrEffect(scene,10,()=>texture)
 const removeNext=registerHdrEffect(scene,20,()=>{throw new Error('consumer failed')})
 assert.throws(()=>scene.postProcessStages.execute(ctx,{}),/consumer failed/)
 assert.equal(lease.valid,false);assert.equal(pool.getDiagnostics().live,0)
 removeAo();removeNext();pool.destroy()
})
