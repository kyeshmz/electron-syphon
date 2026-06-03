// Minimal electron-syphon example — TypeScript. One window, one Syphon server.
//
//   npm run ts:simple-window      (from the examples/ folder)
//
// Compiles to ../dist/simple-window/main.js; the HTML lives next to this source.
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
      offscreen: { useSharedTexture: true },
      backgroundThrottling: false
    }
  })
  publisher.webContents.setFrameRate(60)

  const syphon = new SyphonOutput(NAME)
  syphon.attach(publisher.webContents)
  publisher.loadFile(file)

  // Spacebar fully suspends/resumes the OFFSCREEN render. pause() drops the
  // publisher to 1 fps (so its GPU paint AND its requestAnimationFrame loop go
  // near-idle) and stops publishing — not just `enabled = false`, which would
  // leave the window rendering at full rate. The Syphon server stays up, so a
  // connected client keeps the connection and sees a frozen frame. Space resumes.
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
