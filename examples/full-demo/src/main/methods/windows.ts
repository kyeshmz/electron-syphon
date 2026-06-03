import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'

export const BROADCAST_W = 1280
export const BROADCAST_H = 720

/** Load a hash route (e.g. "scene/webgl") in dev or production, with an optional
 *  label that the renderer overlays onto the frame (so you can tell which output
 *  a Syphon source is). */
export function loadRoute(win: BrowserWindow, route: string, label?: string): void {
  const q = label ? `?label=${encodeURIComponent(label)}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${q}#/${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: route,
      ...(label ? { query: { label } } : {})
    })
  }
}

/** Forward renderer console warnings/errors to the main-process stdout. */
function forwardConsole(win: BrowserWindow): void {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[renderer ${win.webContents.id}] ${message}`)
  })
}

/**
 * Hidden offscreen window. `useSharedTexture` toggles the zero-copy GPU path.
 * `scale` is the output deviceScaleFactor — NEW in Electron 42: it controls the
 * published IOSurface resolution (1 → 1280×720, 2 → 2560×1440). On Electron 35
 * this was impossible (you got the display's scale factor, silently 2× on Retina).
 */
export function makeOffscreen(
  useSharedTexture: boolean,
  preload?: string,
  scale = 1
): BrowserWindow {
  const win = new BrowserWindow({
    width: BROADCAST_W,
    height: BROADCAST_H,
    show: false,
    webPreferences: {
      offscreen: { useSharedTexture, deviceScaleFactor: scale } as unknown as Electron.Offscreen,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      ...(preload ? { preload } : {})
    }
  })
  forwardConsole(win)
  return win
}
