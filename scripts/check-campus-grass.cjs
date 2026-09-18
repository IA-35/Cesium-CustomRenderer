// Dependency-free headless verification of the surveyed grass polygons.
//
// Drives the local Chrome install over the DevTools Protocol, so the check needs
// no extra packages. Point it at an already-running static server:
//
//   node scripts/check-campus-grass.cjs
//   CCR_TEST_PORT=5501 node scripts/check-campus-grass.cjs
//
// Usage: node scripts/check-campus-grass.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const os = require('node:os')
const { spawn } = require('node:child_process')

const port = process.env.CCR_TEST_PORT || 5501
const origin = `http://127.0.0.1:${port}`
const output = path.resolve(__dirname, '../docs/verification/campus-grass')
fs.mkdirSync(output, { recursive: true })

// Hard ceiling for the whole run. Without it this check can sit forever on a page
// that never reaches 'ready' — for example when the static server is not running.
const globalTimeoutMs = Number(process.env.CCR_GRASS_TIMEOUT_MS || 300000)
setTimeout(() => {
  console.error(`[check-campus-grass] aborting after ${globalTimeoutMs} ms; is the server up at ${origin}?`)
  process.exit(1)
}, globalTimeoutMs).unref()

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean)

function findChrome() {
  for (const candidate of chromeCandidates) if (fs.existsSync(candidate)) return candidate
  throw new Error('Chrome not found; set CHROME_PATH')
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return await getJson(`http://127.0.0.1:${port}/json/version`) } catch { await new Promise(r => setTimeout(r, 200)) }
  }
  throw new Error('Chrome DevTools endpoint did not come up')
}

// Minimal CDP client over the browser websocket, using Node's built-in WebSocket.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 0
    const events = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id)
        pending.delete(message.id)
        message.error ? fail(new Error(message.error.message)) : done(message.result)
      } else if (message.method) {
        events.push(message)
      }
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('open', () => resolve({
      events,
      send(method, params = {}, sessionId) {
        const id = ++nextId
        return new Promise((done, fail) => {
          pending.set(id, { resolve: done, reject: fail })
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        })
      },
      close() { socket.close() },
    }))
  })
}

;(async () => {
  // Fail fast and loudly when the static server is missing: a silent hang here
  // looks identical to a slow scene and wastes the whole timeout.
  await new Promise((resolve, reject) => {
    const request = http.get(`${origin}/examples/campus.html`, response => {
      response.resume()
      response.statusCode === 200
        ? resolve()
        : reject(new Error(`Server at ${origin} returned ${response.statusCode}`))
    })
    request.on('error', error => reject(new Error(`Cannot reach ${origin}: ${error.message}`)))
    request.setTimeout(8000, () => { request.destroy(new Error('probe timed out')) })
  })
  console.log(`[check-campus-grass] server ok at ${origin}`)

  const chromePath = findChrome()
  const debugPort = 9333 + (Number(process.env.CCR_DEBUG_PORT_OFFSET) || 0)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-grass-'))
  const chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })

  let target
  try {
    await waitForDevTools(debugPort, 30000)
    const version = await getJson(`http://127.0.0.1:${debugPort}/json/version`)
    const client = await connect(version.webSocketDebuggerUrl)
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })

    const pageErrors = []; const httpErrors = []; const consoleErrors = []; const grassResponses = []
    const onEvent = setInterval(() => {
      while (client.events.length) {
        const message = client.events.shift()
        if (message.method === 'Runtime.exceptionThrown') {
          pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text)
        } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
          consoleErrors.push(message.params.args.map(a => a.value ?? a.description).join(' '))
        } else if (message.method === 'Network.responseReceived') {
          const response = message.params.response
          if (/\/grass-(10|17)\.glb(?:\?|$)/.test(response.url)) grassResponses.push({ status: response.status, url: response.url })
          if (response.status >= 400) httpErrors.push({ status: response.status, url: response.url })
        }
      }
    }, 20)

    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Network.enable', {}, sessionId)
    await client.send('Page.enable', {}, sessionId)

    const evaluate = async (expression, awaitPromise = true) => {
      const result = await client.send('Runtime.evaluate', {
        expression, awaitPromise, returnByValue: true, userGesture: true,
      }, sessionId)
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }

    // Deliberately omit the grass query: the actual default campus URL must load it.
    await client.send('Page.navigate', { url: `${origin}/examples/campus.html?imagery=none&contextTiles=none` }, sessionId)

    const waitFor = async (expression, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await evaluate(expression)
        if (value) return value
        await new Promise(r => setTimeout(r, 500))
      }
      // Surface whatever the page reported, so a stalled load is diagnosable
      // rather than a silent hang.
      let detail = ''
      try { detail = await evaluate(`JSON.stringify({errors:campus?.errors||[], status:(document.querySelector('#status')||{}).textContent, state: campus?.grass ? campus.grass.getDiagnostics().state : 'missing'})`) } catch {}
      throw new Error(`Timed out waiting for ${label}. Page state: ${detail}`)
    }

    await waitFor(
      `!!(window.campus && (campus.grass?.getDiagnostics().state === 'ready' || campus.errors?.length))`,
      240000, 'grass readiness')
    const earlyErrors = await evaluate(`JSON.stringify(campus.errors || [])`)
    assert.equal(earlyErrors, '[]', `Example reported errors: ${earlyErrors}`)
    const initialState = await evaluate(`campus.grass ? campus.grass.getDiagnostics().state : 'missing'`)
    assert.equal(initialState, 'ready', `Grass did not become ready (state=${initialState})`)

    const frames = count => evaluate(`new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{remove();reject(new Error('frames timed out: '+(campus.errors||[]).join('; ')))},90000)
      const remove=campus.viewer.scene.postRender.addEventListener(()=>{if(--window.__n===0){clearTimeout(timer);remove();resolve(true)}})
      window.__n=${count}
    })`)

    await evaluate(`(()=>{document.querySelectorAll('.lil-gui.lil-root,#hud').forEach(e=>e.style.display='none');campus.stats.dom.style.display='none';return true})()`)
    // Isolate grass against a flat background so terrain/imagery green cannot be
    // mistaken for grass pixels.
    await evaluate(`(()=>{
      campus.pipeline.setEnabled(false)
      campus.tiles.forEach(t=>t.show=false); campus.contextTiles.forEach(t=>t.show=false)
      const s=campus.viewer.scene
      s.globe.show=false;s.skyBox.show=false;s.skyAtmosphere.show=false;s.sun.show=false;s.moon.show=false
      s.backgroundColor=new Cesium.Color(0.16,0.16,0.16,1)
      return true})()`)

    const diagnostics = JSON.parse(await evaluate('JSON.stringify(campus.grass.getDiagnostics())'))
    assert.equal(diagnostics.backend, 'cesium-ez-tree')
    assert.equal(diagnostics.source, 'grass')
    assert.equal(diagnostics.state, 'ready')
    assert.equal(diagnostics.primitiveCount, 1)
    assert.equal(diagnostics.grassAssets, 2)
    assert.equal(diagnostics.sharedColorTextures, 1)
    assert.equal(diagnostics.variantCounts['grass-10'] + diagnostics.variantCounts['grass-17'], diagnostics.instances)
    assert.ok(Math.abs(diagnostics.variantCounts['grass-10'] - diagnostics.variantCounts['grass-17']) <= 1)
    assert.equal(diagnostics.polygons, 314)
    assert.equal(diagnostics.heightMode, 'fixed')
    assert.equal(diagnostics.height, 3)
    assert.equal(diagnostics.groundClamped, false)
    assert.equal(diagnostics.groundFallbacks, 0)
    assert.ok(diagnostics.instances > 0, `No grass instances: ${JSON.stringify(diagnostics)}`)

    const views = [
      ['overview', 123.4122, 41.7630, 300, -70],
      ['close', 123.4122, 41.7630, 35, -20],
    ]
    const states = []
    for (const [name, longitude, latitude, height, pitch] of views) {
      await evaluate(`(()=>{campus.viewer.camera.setView({
        destination:Cesium.Cartesian3.fromDegrees(${longitude},${latitude},${height}),
        orientation:{heading:0,pitch:Cesium.Math.toRadians(${pitch}),roll:0}});return true})()`)
      await frames(25)
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'))
      states.push({ name, shot: shot.data, diagnostics: JSON.parse(await evaluate('JSON.stringify(campus.grass.getDiagnostics())')) })
    }

    const visibleShot = states.at(-1).shot
    await evaluate('campus.grass.setVisible(false)'); await frames(12)
    const hiddenShot = (await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data
    fs.writeFileSync(path.join(output, 'close-hidden.png'), Buffer.from(hiddenShot, 'base64'))
    await evaluate('campus.grass.setVisible(true)'); await frames(12)

    const pixelDelta = await evaluate(`(async()=>{
      const decode=async b=>createImageBitmap(await (await fetch('data:image/png;base64,'+b)).blob())
      const [a,b]=await Promise.all([decode(${JSON.stringify(visibleShot)}),decode(${JSON.stringify(hiddenShot)})])
      const c=new OffscreenCanvas(a.width,a.height),x=c.getContext('2d',{willReadFrequently:true})
      x.drawImage(a,0,0);const l=x.getImageData(0,0,a.width,a.height).data
      x.clearRect(0,0,a.width,a.height);x.drawImage(b,0,0);const r=x.getImageData(0,0,b.width,b.height).data
      let changed=0
      for(let i=0;i<l.length;i+=4){const d=Math.abs(l[i]-r[i])+Math.abs(l[i+1]-r[i+1])+Math.abs(l[i+2]-r[i+2]);if(d>12)changed++}
      return {width:a.width,height:a.height,changed,percent:100*changed/(a.width*a.height)}
    })()`)

    const colors = await evaluate(`(async()=>{
      const bm=await createImageBitmap(await (await fetch('data:image/png;base64,'+${JSON.stringify(visibleShot)})).blob())
      const c=new OffscreenCanvas(bm.width,bm.height),x=c.getContext('2d');x.drawImage(bm,0,0)
      const d=x.getImageData(0,0,bm.width,bm.height).data
      let green=0,neutralBright=0,nonBackground=0
      for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],bl=d[i+2]
        if(!(Math.abs(r-41)<10&&Math.abs(g-41)<10&&Math.abs(bl-41)<10))nonBackground++
        if(g>r*1.10&&g>bl*1.10&&g>30)green++
        if(Math.max(r,g,bl)-Math.min(r,g,bl)<10&&g>90)neutralBright++}
      return {green,neutralBright,nonBackground}
    })()`)

    clearInterval(onEvent)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(httpErrors, [])
    assert.deepEqual([...new Set(grassResponses.map(response => new URL(response.url).pathname))].sort(),
      ['/assets/grass/grass-10.glb', '/assets/grass/grass-17.glb'])
    assert.ok(colors.green > 2000, `No green grass pixels: ${JSON.stringify(colors)}`)
    assert.ok(colors.green > colors.neutralBright * 2, `Grass is predominantly white/grey: ${JSON.stringify(colors)}`)
    assert.ok(pixelDelta.percent > 0.2, `Grass visibility changed only ${pixelDelta.percent}% of pixels`)

    const report = {
      scope: '1280x800 headless Chrome (SwiftShader); isolated (globe/tiles/imagery hidden); surveyed polygons; grass only',
      diagnostics, states: states.map(s => ({ name: s.name, ...s.diagnostics })),
      pixelDelta, colors, grassResponses, pageErrors, consoleErrors, httpErrors,
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    client.close()
  } finally {
    chrome.kill()
  }
})().catch(error => {
  console.error(error)
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error?.message))) {
    console.error(`[check-campus-grass] start the server with: node scripts/dev-server.cjs --port ${port}`)
  }
  process.exitCode = 1
})
