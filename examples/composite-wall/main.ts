// Composite video-wall electron-syphon example — TypeScript.
//
//   npm run composite-wall        (or: N=9 npm run composite-wall)
//
// This is the FAST counterpart to `multi-window`. Where `multi-window` opens N
// windows and publishes N separate Syphon servers (one server per window), this
// opens N offscreen windows and composites them all into ONE Syphon server — a
// single video wall / multiview — using `CompositeSyphonOutput({ direct: true })`.
//
// Why prefer this for a wall:
//   • 1.5–10× faster than N separate servers: every tile is blitted into the
//     wall in ONE GPU pass, straight into Syphon's own surface (zero-copy,
//     `direct: true`), instead of N publishes/frame.
//   • Scales linearly past 25 windows, where the per-server pattern's cost
//     falls off a cliff.
//   • Downscales near-free: `outputScale: 0.5` publishes the wall at half
//     resolution for ~4× less GPU work (great when the wall is shown small).
//   • Only re-blits tiles whose source actually repainted this frame (the
//     persistent atlas keeps every other tile's last pixels).
//
// Use `multi-window` instead only when a downstream app must route each source
// independently. For one combined output, this is the pattern.
import { app, BrowserWindow, screen } from 'electron'
import { CompositeSyphonOutput, listServers } from 'electron-syphon'
import * as path from 'path'

const N = Number(process.env.N || 4)
const TILE_W = 1280
const TILE_H = 720

app.whenReady().then(() => {
  // Square-ish grid that holds all N tiles.
  const cols = Math.ceil(Math.sqrt(N))
  const rows = Math.ceil(N / cols)

  // dist/composite-wall/main.js → source HTML at ../../multi-window/index.html
  // (reuse multi-window's page — each ?i= renders a distinct hue + frame HUD).
  const file = path.join(__dirname, '..', '..', 'multi-window', 'index.html')

  // ONE Syphon server for the whole wall. `direct: true` renders every tile
  // straight into Syphon's published surface in a single GPU pass (zero-copy).
  // Try `outputScale: 0.5` to publish the wall at half-res for ~4× less work.
  const wall = new CompositeSyphonOutput('electron-syphon wall', {
    direct: true,
    cols,
    rows,
    tileWidth: TILE_W,
    tileHeight: TILE_H
  })

  const publishers: BrowserWindow[] = []

  // Lay the visible previews out in a grid so you can see every source.
  const pad = 16
  const pw = 440
  const ph = Math.round((pw * TILE_H) / TILE_W)
  const work = screen.getPrimaryDisplay().workArea

  for (let i = 0; i < N; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)

    // Visible preview so you can actually SEE source #(i+1).
    const preview = new BrowserWindow({
      width: pw,
      height: ph,
      x: work.x + pad + col * (pw + pad),
      y: work.y + pad + row * (ph + pad),
      title: `wall tile #${i + 1}`,
      backgroundColor: '#000000',
      webPreferences: { backgroundThrottling: false }
    })
    preview.loadFile(file, { query: { i: String(i + 1) } })

    // Hidden offscreen window → composited into grid cell (col,row), zero-copy.
    // deviceScaleFactor:1 makes its frame exactly TILE_W×TILE_H (otherwise a
    // Retina display renders at 2× and the frame is cropped to the tile).
    const publisher = new BrowserWindow({
      width: TILE_W,
      height: TILE_H,
      show: false,
      webPreferences: {
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
        backgroundThrottling: false
      }
    })
    publisher.webContents.setFrameRate(60)
    wall.attach(publisher.webContents, { col, row })
    publisher.loadFile(file, { query: { i: String(i + 1) } })
    publishers.push(publisher)
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n▶ ${N} sources composited into ONE Syphon server "electron-syphon wall" ` +
      `(${cols}×${rows} grid, ${wall.atlasWidth}×${wall.atlasHeight}). Open a client to see the wall.\n`
  )
  setInterval(() => {
    const live = listServers().some((s) => s.name === 'electron-syphon wall')
    // eslint-disable-next-line no-console
    console.log(live ? '  wall live' : '  wall offline')
  }, 2000)

  app.on('before-quit', () => wall.dispose())
})

app.on('window-all-closed', () => app.quit())
