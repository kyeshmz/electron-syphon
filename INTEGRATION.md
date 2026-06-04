# Adding electron-syphon to your Electron app

A step-by-step guide to publishing your app's output to Syphon. Total: ~15 lines of code.

## 1. Install

```bash
npm install electron-syphon
```

No Xcode needed — a prebuilt binary and the Syphon framework ship with the package. (macOS 11+, Electron 33+ for the zero-copy path.)

## 2. Decide what to broadcast

`electron-syphon` publishes whatever an **offscreen** `webContents` renders. Two common shapes:

- **Dedicated output (recommended).** A hidden offscreen window renders your "broadcast" view (a canvas/WebGL/WebGPU scene, a `<video>`, a cut-down version of your UI). Your visible app windows are untouched.
- **Mirror an existing view.** Point the offscreen window at the same route/URL as a visible window.

You can't make a *visible* window publish directly — offscreen rendering is what produces the shareable GPU frame. Render your output offscreen; show a preview separately if you want one.

## 3. Wire it up (main process)

```ts
// main.ts
import { app, BrowserWindow } from 'electron'
import { SyphonOutput } from 'electron-syphon'

let output: SyphonOutput | null = null

function startSyphon(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false, // hidden — it only exists to be captured
    webPreferences: {
      // ← MUST be nested; deviceScaleFactor: 1 publishes at the exact size (no Retina 2×)
      offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
      backgroundThrottling: false            // keep painting while hidden
    }
  })
  win.webContents.setFrameRate(60)

  output = new SyphonOutput('My App') // the name clients will see
  output.attach(win.webContents, { width: 1280, height: 720 }) // render + publish at this size

  win.loadURL(process.env.BROADCAST_URL ?? 'https://example.com/visuals')
  // (in electron-vite: `${process.env.ELECTRON_RENDERER_URL}#/broadcast`)
}

app.whenReady().then(startSyphon)
app.on('before-quit', () => output?.dispose())
```

That's the whole integration. Open a Syphon client and **My App** appears as a source.

## 4. Control it (optional)

Expose a few IPC handles so your UI can drive it:

```ts
import { ipcMain } from 'electron'
import { listServers } from 'electron-syphon'

ipcMain.handle('syphon:status', () => ({
  hasClients: output?.hasClients ?? false,
  fps: output?.frames ?? 0,
  publishMs: output?.publishMsEMA ?? 0,
  size: [output?.outWidth, output?.outHeight]
}))
ipcMain.handle('syphon:enable', (_e, on: boolean) => { if (output) output.enabled = on })
ipcMain.handle('syphon:flip', (_e, on: boolean) => { if (output) output.flipY = on })
ipcMain.handle('syphon:resolution', (_e, w: number, h: number) => output?.setResolution(w, h))
ipcMain.handle('syphon:servers', () => listServers())
```

`output.skipWhenNoClients = true` (default) means no GPU work happens until a client actually connects. **`output.setResolution(w, h)` is the biggest performance knob** — it renders (and therefore publishes) at exactly that size; combined with `deviceScaleFactor: 1` it's how you keep many windows fast. And `output.flipY = false` is ~33% faster if you pre-flip your content. Both are covered in the README's [Two knobs that matter](README.md#two-knobs-that-matter).

## 5. Ship it (electron-builder)

Bundle the framework and unpack the native addon. In your `electron-builder.yml` / `build` config:

```yaml
asarUnpack:
  - '**/node_modules/electron-syphon/prebuilds/**'
mac:
  extraFiles:
    - from: node_modules/electron-syphon/Frameworks/Syphon.framework
      to: Frameworks/Syphon.framework
```

For a **notarized** release, the bundled framework must be signed by your identity (electron-builder signs `Contents/Frameworks/*` for you) or you must grant `com.apple.security.cs.disable-library-validation` in your entitlements.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| Source never appears in a client | A Syphon client must be running; check `listServers()` includes your name. Don't `app.disableHardwareAcceleration()`. |
| `usingSharedTexture` is `false` | You wrote `offscreen: true, useSharedTexture: true`. It must be `offscreen: { useSharedTexture: true }`. |
| Output is upside-down | Toggle `output.flipY`. If you set `flipY = false` for speed, pre-flip your content (README → Performance knobs). |
| Output is 2× the expected size | Retina scaling. Create the window with `offscreen.deviceScaleFactor: 1` (Electron 42+), then `output.setResolution(w, h)` for an exact size. `outWidth`/`outHeight` report the truth; a one-time console warning fires on mismatch. |
| Black frames | The page isn't actually rendering (check the offscreen window's URL loads), or alpha/premultiplied issues with `transparent: true`. |
| Module won't load after packaging | The framework didn't get into `Contents/Frameworks`, or the `.node` is still inside the asar — re-check the `asarUnpack` / `extraFiles` above. |

See `examples/full-demo/` for a complete app demonstrating several capture methods and scene types.
