// Planetary control room — FOUR independent Syphon feeds from one process.
//
//   npm run planetary-room        (from the examples/ folder)
//
// A "live geospatial control room": four OFFSCREEN BrowserWindows, each its own
// named Syphon server, plus ONE visible operator window (status only, never
// published). This is the multi-window supervisor pattern, but instead of N
// copies of one HTML it drives four DISTINCT scenes:
//
//   planetary-room · orbit      — rotating 3D globe (THREE via CDN importmap,
//                                 Canvas2D fallback), live USGS quakes plotted
//   planetary-room · approach   — Canvas2D city approach radar (synthetic traffic)
//   planetary-room · seismic    — Canvas2D equirectangular world quake map (live USGS)
//   planetary-room · telemetry  — DOM/CSS dashboard of the live USGS feed
//
// The live hero feed is the USGS "all earthquakes, past hour" GeoJSON, fetched
// in the renderers (USGS sends CORS headers). Everything still renders offline:
// the maps/rings/dashboard chrome draw immediately, before any network reply.
import { app, BrowserWindow, screen } from 'electron'
import { SyphonOutput, SyphonClient, listServers } from 'electron-syphon'
import * as path from 'path'

// Each entry becomes one offscreen publisher → one named Syphon server.
const SOURCES = [
  { key: 'orbit', name: 'planetary-room · orbit', file: 'orbit.html' },
  { key: 'approach', name: 'planetary-room · approach', file: 'approach.html' },
  { key: 'seismic', name: 'planetary-room · seismic', file: 'seismic.html' },
  { key: 'telemetry', name: 'planetary-room · telemetry', file: 'telemetry.html' }
] as const

app.whenReady().then(() => {
  // dist/planetary-room/main.js → source HTML at ../../planetary-room/*.html
  const dir = path.join(__dirname, '..', '..', 'planetary-room')
  const outputs: SyphonOutput[] = []

  // Spin up the four offscreen publishers. Each is the mandatory OSR shape:
  // hidden, useSharedTexture nested, no background throttling, 60 fps.
  for (const src of SOURCES) {
    const publisher = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
        backgroundThrottling: false
      }
    })
    publisher.webContents.setFrameRate(60)

    const out = new SyphonOutput(src.name)
    out.skipWhenNoClients = false // publish even with no client attached
    out.attach(publisher.webContents)
    publisher.loadFile(path.join(dir, src.file))
    outputs.push(out)
  }

  // The ONE visible window: operator status panel. NOT published to Syphon —
  // it's an ordinary window so the operator can read the source list and counts.
  const operator = new BrowserWindow({
    width: 980,
    height: 620,
    title: 'planetary-room — operator',
    backgroundColor: '#05070d',
    webPreferences: { backgroundThrottling: false }
  })
  operator.loadFile(path.join(dir, 'operator.html'))

  // eslint-disable-next-line no-console
  console.log(
    `\n▶ planetary-room: 4 offscreen publishers → Syphon. Open a client and add:\n` +
      SOURCES.map((s) => `   ${s.name}`).join('\n') +
      `\n`
  )

  // Self-verify: connect a SyphonClient back to two of our own sources and log
  // whether real, non-black frames are flowing. Clients only bind at construction
  // (the server announces async), so reconnect until valid. Runs in main, where
  // Metal works. This is purely diagnostic — it does not touch the publish path.
  const probeNames = ['planetary-room · seismic', 'planetary-room · telemetry']
  const clients = probeNames.map((n) => ({ name: n, c: new SyphonClient(n), last: 0 }))
  const probe = setInterval(() => {
    const now = Date.now()
    for (const p of clients) {
      if (!p.c.isValid) {
        if (now - p.last > 800) {
          p.last = now
          try { p.c.dispose() } catch { /* not connected yet */ }
          p.c = new SyphonClient(p.name)
        }
        continue
      }
      const f = p.c.receive(true)
      if (f.hasFrame) {
        // eslint-disable-next-line no-console
        console.log(`  [verify] "${p.name}" ${f.width}x${f.height} nonBlack=${f.nonBlack}`)
      }
    }
    const mine = listServers().filter((s) => s.name.startsWith('planetary-room'))
    // eslint-disable-next-line no-console
    console.log(`  [servers] ${mine.length} live: ${mine.map((s) => s.name.split('· ')[1]).join(', ')}`)
  }, 2000)

  app.on('before-quit', () => {
    clearInterval(probe)
    for (const p of clients) { try { p.c.dispose() } catch { /* already gone */ } }
    outputs.forEach((o) => o.dispose())
  })
})

app.on('window-all-closed', () => app.quit())
