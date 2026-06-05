// Real-Electron measurement of the "one window renders the whole grid" pattern
// (the theoretical ceiling) vs the multi-webContents atlas. ONE 1280x720
// offscreen window renders a 2x2 CSS grid; SyphonOutput publishes it with the
// per-frame GPU cost measured in SYNC mode (async=false → publishMsEMA is the
// real wait-for-GPU time). Verifies a client receives all 4 quadrant colors.
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { SyphonOutput, SyphonClient, listServers } = require(path.join(__dirname, '..', 'dist', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const grid = 'data:text/html,' + encodeURIComponent(
  `<html><body style="margin:0">
   <div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;width:100vw;height:100vh">
     <div style="background:#ff0000"></div><div style="background:#00ff00"></div>
     <div style="background:#0000ff"></div><div style="background:#ffff00"></div>
   </div>
   <div style="position:fixed;top:0;left:0;width:30px;height:30px;background:#fff;animation:m 1s linear infinite"></div>
   <style>@keyframes m{from{transform:translateX(0)}to{transform:translateX(150px)}}</style>
   </body></html>`)

app.whenReady().then(async () => {
  const W = 1280, H = 720
  const win = new BrowserWindow({ width: W, height: H, show: false,
    webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false } })
  win.webContents.setFrameRate(60)
  const out = new SyphonOutput('single-window-grid')
  out.skipWhenNoClients = false
  out.async = false // SYNC: publishMsEMA becomes the real per-frame GPU cost
  out.attach(win.webContents)
  await win.webContents.loadURL(grid)

  let client = null
  for (let t = 0; t < 60 && !client; t++) {
    if (listServers().some((s) => s.name === 'single-window-grid')) client = new SyphonClient('single-window-grid')
    if (!client || !client.isValid) { client = null; await sleep(100) }
  }
  if (!client) { console.error('FAIL: no client'); app.exit(1); return }

  // Let it stream a couple seconds so publishMsEMA settles.
  let frame = null
  for (let i = 0; i < 200; i++) {
    const f = client.receiveFrame()
    if (f.hasFrame && f.pixels && f.width === W) frame = f
    await sleep(10)
  }
  if (!frame) { console.error('FAIL: no frame'); app.exit(1); return }

  const { width: w, pixels } = frame
  const at = (x, y) => { const i = (y * w + x) * 4; return { r: pixels[i], g: pixels[i+1], b: pixels[i+2] } }
  const code = ({ r, g, b }) => [r > 128 ? 1 : 0, g > 128 ? 1 : 0, b > 128 ? 1 : 0].join('')
  const seen = new Set()
  for (const [cx, cy] of [[0.25,0.3],[0.75,0.3],[0.25,0.7],[0.75,0.7]]) {
    const p = at((w*cx)|0, (H*cy)|0); seen.add(code(p))
    console.log(`  sample(${cx},${cy}) rgb(${p.r},${p.g},${p.b})`)
  }
  const colors = ['100','010','001','110'].filter((c) => seen.has(c)).length
  console.log(`\none-window-grid SYNC publish cost: ${out.publishMsEMA.toFixed(3)} ms/frame @${W}x${H} (${out.frames} frames)`)
  console.log(`distinct quadrant colors present: ${colors}/4`)

  client.dispose(); out.dispose(); win.destroy()
  const ok = colors >= 3
  console.log(ok ? '\nPASS: one window published a 2x2 grid through the single-copy ceiling path' : '\nFAIL')
  app.exit(ok ? 0 : 1)
}).catch((e) => { console.error(e); app.exit(1) })
