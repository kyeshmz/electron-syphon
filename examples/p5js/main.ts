// p5.js → Syphon — TypeScript. One window, one Syphon server.
//
//   npm run p5js      (from the examples/ folder)
//
// Identical wiring to webgl/simple-window: a visible preview window plus a
// hidden offscreen window that is what actually gets published. The only thing
// that differs is index.html — here it runs a p5.js sketch. p5 draws into a
// normal <canvas>, which composites like any other page content, so Syphon
// captures it with zero p5-specific glue.
//
// Compiles to ../dist/p5js/main.js; the HTML + vendored p5.min.js live next to
// this source.
import { app, BrowserWindow } from 'electron'
import { SyphonOutput } from 'electron-syphon'
import * as path from 'path'

const folder = path.basename(__dirname) // dist/<folder> → "<folder>"
const NAME = `electron-syphon ${folder}`

app.whenReady().then(() => {
  // dist/<folder>/main.js → source HTML is at ../../<folder>/index.html
  const file = path.join(__dirname, '..', '..', folder, 'index.html')

  // backgroundThrottling:false → preview keeps full rate when unfocused (matches publisher)
  const preview = new BrowserWindow({ width: 700, height: 420, title: NAME, webPreferences: { backgroundThrottling: false } })
  preview.loadFile(file)

  const publisher = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      // deviceScaleFactor: 1 renders at exactly 1280×720 — without it a Retina
      // display renders at 2× (4× the pixels = 4× the render+publish work).
      offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
      backgroundThrottling: false
    }
  })
  publisher.webContents.setFrameRate(60)

  const syphon = new SyphonOutput(NAME)
  syphon.attach(publisher.webContents)
  publisher.loadFile(file)

  // Spacebar fully suspends/resumes the OFFSCREEN render. pause() drops the
  // publisher to 1 fps (GPU paint + requestAnimationFrame loop go near-idle) and
  // stops publishing — not just `enabled = false`, which would leave the window
  // rendering at full rate. The Syphon server stays up, so a connected client
  // keeps the connection and sees a frozen frame. Press space again to resume.
  const togglePublishing = (): void => {
    syphon.paused ? syphon.resume() : syphon.pause()
    // eslint-disable-next-line no-console
    console.log(syphon.paused ? '⏸  suspended — space to resume' : '▶  resumed')
  }
  preview.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.code === 'Space') {
      e.preventDefault()
      togglePublishing()
    }
  })

  // eslint-disable-next-line no-console
  console.log(`\n▶ Publishing to Syphon as "${NAME}". Space pauses/resumes. Open a Syphon client to receive it.\n`)
  app.on('before-quit', () => syphon.dispose())
})

app.on('window-all-closed', () => app.quit())
