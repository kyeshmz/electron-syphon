// Multi-window electron-syphon example — TypeScript.
//
//   npm run ts:multi-window        (or: N=8 npm run ts:multi-window)
//
// For each i in 1..N we open a visible PREVIEW window (tiled in a grid) so you
// can see source #i, plus a hidden OFFSCREEN window that is actually published.
//
// This demonstrates the ONE-SERVER-PER-WINDOW pattern — use it when a downstream
// app needs to route each source independently. If instead you want all windows
// as ONE combined output (a video wall / multiview), `CompositeSyphonOutput`
// ({ direct: true }) is 1.5–10× faster: it composites every window into a single
// Syphon server in one GPU pass, scales linearly past 25 windows where this
// pattern's per-server cost falls off a cliff, and downscales near-free
// (`outputScale`). See the README "Multiple outputs" section.
import { app, BrowserWindow, screen } from 'electron'
import { SyphonOutput, listServers } from 'electron-syphon'
import * as path from 'path'

const N = Number(process.env.N || 4)

app.whenReady().then(() => {
  // dist/multi-window/main.js → source HTML at ../../multi-window/index.html
  const file = path.join(__dirname, '..', '..', 'multi-window', 'index.html')
  const outputs: SyphonOutput[] = []

  // Spacebar (from any preview window) fully suspends/resumes ALL outputs at
  // once. pause() drops each publisher to 1 fps (GPU paint + rAF loop go
  // near-idle) and stops publishing — not just `enabled = false`, which would
  // leave every offscreen window rendering at full rate. Servers stay up, so
  // clients keep their connections and see frozen frames. Space resumes.
  let paused = false
  const toggleAll = (): void => {
    paused = !paused
    for (const o of outputs) (paused ? o.pause() : o.resume())
    // eslint-disable-next-line no-console
    console.log(paused ? `⏸  suspended all ${outputs.length} — space to resume` : '▶  resumed all')
  }

  // Lay the visible previews out in a grid so all N are on screen at once.
  const cols = Math.ceil(Math.sqrt(N))
  const pad = 16
  const pw = 440
  const ph = 280
  const work = screen.getPrimaryDisplay().workArea

  for (let i = 1; i <= N; i++) {
    const col = (i - 1) % cols
    const row = Math.floor((i - 1) / cols)

    // Visible preview so you can actually SEE source #i.
    const preview = new BrowserWindow({
      width: pw,
      height: ph,
      x: work.x + pad + col * (pw + pad),
      y: work.y + pad + row * (ph + pad),
      title: `electron-syphon window #${i}`,
      backgroundColor: '#000000',
      webPreferences: { backgroundThrottling: false } // keep full rate when unfocused
    })
    preview.loadFile(file, { query: { i: String(i) } })
    preview.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.code === 'Space') {
        e.preventDefault()
        toggleAll()
      }
    })

    // Hidden offscreen window — this is the one published to Syphon, zero-copy.
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
    const syphon = new SyphonOutput(`electron-syphon window #${i}`)
    syphon.attach(publisher.webContents)
    publisher.loadFile(file, { query: { i: String(i) } })
    outputs.push(syphon)
  }

  // eslint-disable-next-line no-console
  console.log(`\n▶ ${N} preview windows on screen; publishing ${N} Syphon servers (TypeScript). Open a client to see them all.\n`)
  setInterval(() => {
    const mine = listServers().filter((s) => s.name.startsWith('electron-syphon window'))
    // eslint-disable-next-line no-console
    console.log(`  ${mine.length} live`)
  }, 2000)

  app.on('before-quit', () => outputs.forEach((o) => o.dispose()))
})

app.on('window-all-closed', () => app.quit())
