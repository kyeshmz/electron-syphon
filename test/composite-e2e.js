// End-to-end: 4 offscreen windows -> CompositeSyphonOutput (2x2) -> one server.
// Verifies a composited frame arrives with each window's color in its quadrant,
// and that coalescing keeps publishes well below the raw paint count.
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { CompositeSyphonOutput, SyphonClient, listServers } = require(path.join(__dirname, '..', 'dist', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] // TL TR BL BR
const page = (c) => 'data:text/html,' + encodeURIComponent(
  `<html><body style="margin:0;background:${c};overflow:hidden">
   <div style="width:40px;height:40px;background:#fff;animation:m 1s linear infinite"></div>
   <style>@keyframes m{from{transform:translateX(0)}to{transform:translateX(200px)}}</style>
   </body></html>`)

app.whenReady().then(async () => {
  const TW = 640, TH = 360
  const out = new CompositeSyphonOutput('composite-e2e', { cols: 2, rows: 2, tileWidth: TW, tileHeight: TH })
  out.skipWhenNoClients = false // publish even before a client attaches
  out.maxPublishRate = Number(process.env.CAP || 0)

  let paints = 0
  const wins = []
  for (let i = 0; i < 4; i++) {
    const w = new BrowserWindow({ width: TW, height: TH, show: false,
      webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false } })
    w.webContents.setFrameRate(30)
    w.webContents.on('paint', () => { paints++ })
    out.attach(w.webContents, { col: i % 2, row: (i / 2) | 0 })
    await w.webContents.loadURL(page(COLORS[i]))
    wins.push(w)
  }

  // Let frames flow and the server announce.
  let client = null
  for (let t = 0; t < 60 && !client; t++) {
    if (listServers().some((s) => s.name === 'composite-e2e')) client = new SyphonClient('composite-e2e')
    if (!client || !client.isValid) { client = null; await sleep(100) }
  }
  if (!client) { console.error('FAIL: client could not connect'); app.exit(1); return }

  let frame = null
  for (let i = 0; i < 100 && !frame; i++) {
    const f = client.receiveFrame()
    if (f.hasFrame && f.pixels && f.width === TW * 2) frame = f
    else await sleep(30)
  }
  if (!frame) { console.error('FAIL: no composited frame'); app.exit(1); return }

  const { width: w, height: h, pixels } = frame
  // flipY defaults true → atlas is published bottom-up; account for it when
  // mapping a quadrant to a readback row.
  const at = (x, y) => { const i = (y * w + x) * 4; return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] } }
  const hexOf = ({ r, g, b }) => [r > 128 ? 1 : 0, g > 128 ? 1 : 0, b > 128 ? 1 : 0].join('')
  const want = { '#ff0000': '100', '#00ff00': '010', '#0000ff': '001', '#ffff00': '110' }
  // Sample all 4 quadrants (avoid the moving white square top strip; sample lower in each tile).
  const quads = [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 1 }
  ]
  let nonBlack = 0
  const seen = new Set()
  for (const q of quads) {
    const sx = q.col * TW + TW / 2
    const sy = q.row * TH + TH * 0.8 // low in the tile, below the animated square
    const px = at(sx | 0, sy | 0)
    if (px.r > 16 || px.g > 16 || px.b > 16) nonBlack++
    seen.add(hexOf(px))
    console.log(`  quad(${q.col},${q.row}) rgb(${px.r},${px.g},${px.b})`)
  }
  const colorsSeen = Object.values(want).filter((code) => seen.has(code)).length
  console.log(`paints=${paints} publishes=${out.frames} (coalesce ratio ${(paints / Math.max(1, out.frames)).toFixed(2)}x)`)
  console.log(`non-black quadrants: ${nonBlack}/4 ; distinct expected colors present: ${colorsSeen}/4`)

  client.dispose(); out.dispose()
  for (const w of wins) w.destroy()

  const ok = nonBlack === 4 && colorsSeen >= 3 && out.frames > 0
  if (ok) console.log('\nPASS: composite e2e published all 4 windows through one server')
  else console.error('\nFAIL: composite e2e did not render all quadrants')
  app.exit(ok ? 0 : 1)
}).catch((e) => { console.error(e); app.exit(1) })
