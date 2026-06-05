const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW = 256, TH = 256
  const AW = TW * 2, AH = TH * 2
  const colors = [
    { x: 0,  y: 0,  r: 255, g: 0,   b: 0   }, // TL red
    { x: TW, y: 0,  r: 0,   g: 255, b: 0   }, // TR green
    { x: 0,  y: TH, r: 0,   g: 0,   b: 255 }, // BL blue
    { x: TW, y: TH, r: 255, g: 255, b: 0   }, // BR yellow
  ]
  const tiles = colors.map(c => ({
    handle: addon.__makeTestSurface(TW, TH, c.r, c.g, c.b),
    x: c.x, y: c.y, w: TW, h: TH,
  }))

  const NAME = 'atlas-check'
  const server = new addon.SyphonServer(NAME)
  // flip=false so atlas pixel (x,y) maps straight to client readback (x,y).
  for (let i = 0; i < 5; i++) { server.publishAtlas(tiles, AW, AH, false); server.drain(); await sleep(20) }

  // Wait for the directory to announce the server, then connect.
  let client = null
  for (let t = 0; t < 60 && !client; t++) {
    if (addon.listServers().some(s => s.name === NAME)) client = new addon.SyphonClient(NAME)
    if (!client || !client.isValid) { client = null; await sleep(100) }
  }
  if (!client) { console.error('FAIL: client could not connect'); process.exitCode = 1; return }

  let frame = null
  for (let i = 0; i < 80 && !frame; i++) {
    server.publishAtlas(tiles, AW, AH, false); server.drain()
    const f = client.receiveFrame()
    if (f.hasFrame && f.pixels) frame = f
    else await sleep(30)
  }
  if (!frame) { console.error('FAIL: no frame received'); process.exitCode = 1; return }

  const { width, height, pixels } = frame
  console.log(`received ${width}x${height} (expected ${AW}x${AH})`)
  const at = (px, py) => { const i = (py * width + px) * 4; return { r: pixels[i], g: pixels[i+1], b: pixels[i+2] } }
  const near = (a, b) => Math.abs(a - b) <= 8
  let ok = width === AW && height === AH
  for (const c of colors) {
    const got = at((c.x + TW/2)|0, (c.y + TH/2)|0)
    const pass = near(got.r, c.r) && near(got.g, c.g) && near(got.b, c.b)
    ok = ok && pass
    console.log(`  quad(${c.x},${c.y}) exp rgb(${c.r},${c.g},${c.b}) got rgb(${got.r},${got.g},${got.b}) ${pass?'OK':'MISMATCH'}`)
  }
  client.dispose(); server.dispose()
  if (ok) console.log('\nPASS: atlas composited all 4 tiles into the correct quadrants')
  else { console.error('\nFAIL: atlas quadrants wrong'); process.exitCode = 1 }
}

if (process.versions.electron) {
  const { app } = require('electron'); app.disableHardwareAcceleration()
  app.whenReady().then(run).then(() => app.exit(process.exitCode || 0)).catch(e => { console.error(e); app.exit(1) })
} else run()
