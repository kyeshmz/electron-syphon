import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { listServers } from 'electron-syphon'
import { OffscreenMethod } from './methods/offscreen'
import { CanvasReadbackMethod } from './methods/canvasReadback'
import type { CaptureMethod } from './methods/types'
import { runTests } from './test'

// Do NOT disableHardwareAcceleration() — the shared-texture path needs the GPU.

let controlWindow: BrowserWindow | null = null
let scene = process.env['SYPHON_SCENE'] ?? 'canvas2d'
let outputScale = 1 // deviceScaleFactor (Electron 34+; 1 → 720p, 2 → 1440p)
let outputFps = 60 // >240 allowed on the shared-texture path (Electron 36+)
const SCENES = ['canvas2d', 'webgl', 'webgpu']

// Keep hidden/occluded offscreen windows live instead of being throttled to a
// crawl. (Note: do NOT add --disable-gpu-vsync / --disable-frame-rate-limit —
// they make every window render unbounded and exhaust the IOSurface pools.)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// The "many ways" to publish to Syphon. Each is its own Syphon server, so you
// can open them side by side in a client and compare.
const methods: CaptureMethod[] = [
  new OffscreenMethod(
    'shared-texture',
    'Zero-copy (useSharedTexture)',
    'Offscreen GPU shared texture → publishSurface. Fastest; no readback, no IPC.',
    'electron-syphon (zero-copy)',
    true
  ),
  new OffscreenMethod(
    'cpu-bitmap',
    'Offscreen CPU bitmap',
    'Offscreen without useSharedTexture → paint bitmap → publishImageBuffer.',
    'electron-syphon (cpu bitmap)',
    false
  ),
  new CanvasReadbackMethod(),
  new OffscreenMethod(
    'composite',
    'Composite (2×2 grid, 1 server)',
    'One offscreen window renders a 2×2 grid of scenes, published as a SINGLE Syphon server — cheap high fan-out (one IOSurface pool).',
    'electron-syphon (composite)',
    true,
    () => 'composite/2x2'
  )
]

// A dynamic fan-out of independent zero-copy outputs — each its own offscreen
// window AND its own Syphon server, to demonstrate "multiple windows + multiple
// Syphon servers" and how many can run at once.
const outputs: OffscreenMethod[] = []
function setOutputCount(n: number): void {
  n = Math.max(0, Math.min(64, Math.floor(n)))
  while (outputs.length < n) {
    const i = outputs.length + 1
    const m = new OffscreenMethod(
      `output-${i}`,
      `Output ${i}`,
      'Independent zero-copy output (own window + own Syphon server).',
      `electron-syphon #${i}`,
      true
    )
    m.scale = outputScale
    m.fps = outputFps
    m.start(scene)
    outputs.push(m)
  }
  while (outputs.length > n) outputs.pop()?.stop()
}
const allMethods = (): CaptureMethod[] => [...methods, ...outputs]

function createControlWindow(): void {
  controlWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  controlWindow.on('ready-to-show', () => controlWindow?.show())
  controlWindow.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    controlWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    controlWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('syphon:state', () => ({
    scene,
    scenes: SCENES,
    scale: outputScale,
    fps: outputFps,
    outputCount: outputs.length,
    methods: allMethods().map((m) => m.stats()),
    servers: listServers()
  }))
  ipcMain.handle('syphon:scale', (_e, n: number) => {
    outputScale = n
    for (const m of allMethods()) m.setScale(n)
    return outputScale
  })
  ipcMain.handle('syphon:fps', (_e, n: number) => {
    outputFps = n
    for (const m of allMethods()) m.setFps(n)
    return outputFps
  })
  ipcMain.handle('syphon:toggle', (_e, id: string, on: boolean) => {
    const m = allMethods().find((x) => x.id === id)
    if (m) on ? m.start(scene) : m.stop()
    return m?.stats().running ?? false
  })
  ipcMain.handle('syphon:scene', (_e, s: string) => {
    if (!SCENES.includes(s)) return scene
    scene = s
    for (const m of allMethods()) m.setScene(s)
    return scene
  })
  ipcMain.handle('syphon:flip', (_e, on: boolean) => {
    for (const m of allMethods()) m.setFlip(on)
    return on
  })
  ipcMain.handle('syphon:outputs', (_e, n: number) => {
    setOutputCount(n)
    return outputs.length
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  registerIpc()
  // Start with the flagship zero-copy method running.
  methods[0].start(scene)
  createControlWindow()
  if (process.env['SYPHON_SMOKE'] || process.env['SYPHON_TEST']) {
    runTests({ methods, outputs: () => outputs, setOutputCount, scenes: SCENES })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => allMethods().forEach((m) => m.stop()))
