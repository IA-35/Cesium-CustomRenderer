import { compareRenderItems143 } from './RenderItem143.js'

export default class RenderItemQueue143 {
  constructor() { this.frameState = null; this.items = []; this.generation = 0 }
  begin(frameState) { this.frameState = frameState; this.items = []; this.generation++ }
  submit(item) { if (!item) return; this.items.push(item); return item }
  itemsFor(pass) { return this.items.filter(item => !pass || item.pass === pass).sort(compareRenderItems143) }
  snapshot(pass) { return Object.freeze(this.itemsFor(pass).slice()) }
  clear() { this.frameState = null; this.items = [] }
  getDiagnostics() { return { generation: this.generation, frameNumber: this.frameState?.frameNumber ?? null, count: this.items.length, passes: [...new Set(this.items.map(item => item.pass))] } }
}
