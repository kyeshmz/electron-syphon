// Verify SyphonOutput.maxPublishRate: the window paints at full rate while only
// the capped number of frames reach Syphon. Renders an animating page at 60fps,
// caps publishing at CAP, measures paints vs publishes over a few seconds.
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { SyphonOutput, SyphonClient, listServers } = require(path.join(__dirname, '..', 'dist', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAP = Number(process.env.CAP || 30)
const SECONDS = Number(process.env.SECONDS || 4)
const anim = 'data:text/html,' + encodeURIComponent(
  `<html><body style="margin:0;background:#202">
   <canvas id="c" width="1280" height="720"></canvas>
   <script>const x=document.getElementById('c').getContext('2d');let t=0;
   function f(){t+=0.04;x.fillStyle='hsl('+((t*40)%360)+',70%,50%)';x.fillRect(0,0,1280,720);requestAnimationFrame(f)}f()</script>
   </body></html>`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false,
    webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false } })
  win.webContents.setFrameRate(60)
  const out = new SyphonOutput('output-rate-load')
  out.skipWhenNoClients = false
  out.maxPublishRate = CAP
  let paints = 0
  win.webContents.on('paint', () => { paints++ })
  out.attach(win.webContents)
  await win.webContents.loadURL(anim)

  let client = null
  for (let t = 0; t < 40 && !client; t++) {
    if (listServers().some((s) => s.name === 'output-rate-load')) client = new SyphonClient('output-rate-load')
    if (!client || !client.isValid) { client = null; await sleep(100) }
  }
  let nonBlack = false
  if (client) { for (let i=0;i<30;i++){ const f=client.receive(true); if(f.hasFrame){ if(f.nonBlack) nonBlack=true; break } await sleep(30) } }

  const t0 = Date.now(); out.frames = 0; paints = 0
  await sleep(SECONDS * 1000)
  const dt = (Date.now() - t0) / 1000
  console.log(`\nSyphonOutput rate cap — render 60fps, maxPublishRate=${CAP}, ${dt.toFixed(1)}s`)
  console.log(`  paints:    ${paints}  (${(paints/dt).toFixed(1)} fps rendered)`)
  console.log(`  publishes: ${out.frames}  (${(out.frames/dt).toFixed(1)} fps published)`)
  console.log(`  frame content non-black: ${nonBlack}`)
  if (client) client.dispose()
  out.dispose(); win.destroy()
  const ok = Math.abs(out.frames/dt - CAP) <= CAP*0.25 && paints/dt > CAP*1.4 && nonBlack
  console.log(ok ? '\nPASS: renderer ran full-rate; publishing capped to target' : '\nFAIL: cap not behaving')
  app.exit(ok ? 0 : 1)
}).catch((e) => { console.error(e); app.exit(1) })
