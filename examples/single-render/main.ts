// Single-render example — ONE render, shown by monitoring its own Syphon output.
//
//   npm run single-render        (from the examples/ folder)
//
// The earlier examples render TWICE: a visible preview AND a hidden offscreen
// publisher — two independent renders, so what's on screen differs from what's
// sent. Here there is exactly ONE render (the offscreen publisher). The visible
// window is a LIVE MONITOR that displays the frames we publish, received back
// from Syphon (render → publish → receive → display — the same frame).
//
// NOTE on architecture: a SyphonClient is Metal-based, so it must run in the MAIN
// process (a sandboxed renderer can't create a Metal device). So we receive here
// in main and send the pixels to the monitor window over IPC for drawing. That
// monitor readback+IPC is a deliberate convenience — your real Syphon OUTPUT is
// still published zero-copy; only this preview pays a copy.
import { app, BrowserWindow } from 'electron'
import { SyphonOutput, SyphonClient } from 'electron-syphon'
import * as path from 'path'

const NAME = 'electron-syphon single-render'

app.whenReady().then(() => {
  // dist/single-render/main.js → source HTML at ../../single-render/*.html
  const dir = path.join(__dirname, '..', '..', 'single-render')

  // The ONE render: offscreen, published to Syphon zero-copy.
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

  const out = new SyphonOutput(NAME)
  out.skipWhenNoClients = false // publish even before the monitor connects
  out.attach(publisher.webContents)
  publisher.loadFile(path.join(dir, 'index.html'))

  // The visible window: a live monitor. It only draws pixels we send it.
  const monitor = new BrowserWindow({
    width: 900,
    height: 540,
    title: 'electron-syphon — live monitor (what is being sent)',
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })
  monitor.loadFile(path.join(dir, 'monitor.html'))

  // Receive our own Syphon output (in main, where Metal works) and forward the
  // pixels to the monitor at ~30 fps. The client only finds the server once at
  // construction, so reconnect until it's valid (the server announces async).
  let client = new SyphonClient(NAME)
  let lastConnect = 0
  const pump = setInterval(() => {
    const nowish = Date.now()
    if (!client.isValid) {
      if (nowish - lastConnect > 800) {
        lastConnect = nowish
        try { client.dispose() } catch { /* not connected yet */ }
        client = new SyphonClient(NAME)
      }
      return
    }
    const f = client.receiveFrame()
    if (f.hasFrame && f.pixels && !monitor.isDestroyed()) {
      monitor.webContents.send('frame', { width: f.width, height: f.height, pixels: f.pixels })
    }
  }, 33)

  // Spacebar pauses/resumes publishing; the monitor then holds the last SENT frame.
  let paused = false
  monitor.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.code === 'Space') {
      e.preventDefault()
      paused = !paused
      out.enabled = !paused
      // eslint-disable-next-line no-console
      console.log(paused ? '⏸  paused — monitor holds the last sent frame' : '▶  resumed')
    }
  })

  // eslint-disable-next-line no-console
  console.log(`\n▶ One offscreen render → Syphon "${NAME}". The visible window is a live monitor receiving it back. Space pauses.\n`)

  app.on('before-quit', () => {
    clearInterval(pump)
    try { client.dispose() } catch { /* already disposed */ }
    out.dispose()
  })
})

app.on('window-all-closed', () => app.quit())
