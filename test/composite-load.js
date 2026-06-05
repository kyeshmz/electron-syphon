// Sustained real-load test: N animating offscreen windows -> one
// CompositeSyphonOutput, driven at 60fps for a few seconds. Surfaces real
// bottlenecks the synthetic benches can't: IOSurface-pool exhaustion, reap
// cadence, coalescing behaviour, dropped frames, CPU time per publish.
//   N=9 SECONDS=5 ./node_modules/.bin/electron test/composite-load.js
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { CompositeSyphonOutput, SyphonClient, listServers } = require(path.join(__dirname, '..', 'dist', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const N = Number(process.env.N || 9)
const SECONDS = Number(process.env.SECONDS || 5)
const TW = Number(process.env.TW || 640)
const TH = Number(process.env.TH || 360)
const cols = Math.ceil(Math.sqrt(N))
const rows = Math.ceil(N / cols)

// An always-animating page (requestAnimationFrame loop) so every window repaints
// every frame — the worst case (full updates, max blits, max coalescing churn).
const anim = (i) => 'data:text/html,' + encodeURIComponent(
  `<html><body style="margin:0;background:#111;overflow:hidden">
   <canvas id="c" width="${TW}" height="${TH}"></canvas>
   <script>
     const x=document.getElementById('c').getContext('2d');let t=0;
     function f(){t+=0.05;x.fillStyle='hsl('+((${i}*40+t*20)%360)+',70%,50%)';x.fillRect(0,0,${TW},${TH});
     x.fillStyle='#fff';x.fillRect((Math.sin(t)*0.5+0.5)*${TW-60},20,60,60);requestAnimationFrame(f)}f();
   </script></body></html>`)

app.whenReady().then(async () => {
  let ioErrors = 0
  const origErr = console.error
  process.on('uncaughtException', (e) => { if (String(e).includes('IOSurface')) ioErrors++; else origErr(e) })

  const out = new CompositeSyphonOutput('composite-load', { cols, rows, tileWidth: TW, tileHeight: TH })
  out.skipWhenNoClients = false
  out.maxPublishRate = Number(process.env.CAP || 0)
  let paints = 0, maxPending = 0
  const wins = []
  for (let i = 0; i < N; i++) {
    const w = new BrowserWindow({ width: TW, height: TH, show: false,
      webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false } })
    w.webContents.setFrameRate(60)
    w.webContents.on('paint', () => { paints++; if (out.pendingDepth > maxPending) maxPending = out.pendingDepth })
    out.attach(w.webContents, { col: i % cols, row: (i / cols) | 0 })
    await w.webContents.loadURL(anim(i))
    wins.push(w)
  }

  // Attach a client so frames actually flow (and to sample receive rate).
  let client = null
  for (let t = 0; t < 40 && !client; t++) {
    if (listServers().some((s) => s.name === 'composite-load')) client = new SyphonClient('composite-load')
    if (!client || !client.isValid) { client = null; await sleep(100) }
  }

  const t0 = Date.now()
  out.frames = 0; paints = 0
  let received = 0, lastW = 0, lastH = 0
  const sampler = setInterval(() => { const f = client && client.receive(false); if (f && f.hasFrame) { received++; lastW = f.width; lastH = f.height } }, 16)
  await sleep(SECONDS * 1000)
  clearInterval(sampler)
  const dt = (Date.now() - t0) / 1000

  console.log(`\nCompositeSyphonOutput sustained load — ${N} windows ${cols}x${rows} @ ${TW}x${TH} (atlas ${cols*TW}x${rows*TH}), ${dt.toFixed(1)}s`)
  console.log(`  paints:     ${paints}  (${(paints/dt/N).toFixed(1)} fps/window, target 60)`)
  console.log(`  publishes:  ${out.frames}  (${(out.frames/dt).toFixed(1)} atlas-frames/sec)`)
  console.log(`  coalesce:   ${(paints/Math.max(1,out.frames)).toFixed(2)}x paints per publish`)
  console.log(`  client recv:${received} samples, last frame ${lastW}x${lastH}`)
  console.log(`  maxPending: ${maxPending} (cap ~6)   IOSurface errors: ${ioErrors}`)

  if (client) client.dispose()
  out.dispose(); for (const w of wins) w.destroy()
  const healthy = out.frames > 0 && ioErrors === 0 && (lastW === cols*TW)
  console.log(healthy ? '\nHEALTHY: sustained multi-window load published cleanly' : '\nWARN: investigate above')
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
