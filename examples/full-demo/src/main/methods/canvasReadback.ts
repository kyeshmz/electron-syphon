import { ipcMain, type BrowserWindow } from 'electron'
import { join } from 'path'
import { SyphonOutput } from 'electron-syphon'
import { makeOffscreen, loadRoute, BROADCAST_W, BROADCAST_H } from './windows'
import type { CaptureMethod, MethodStats } from './types'

/**
 * The node-syphon / electron-syphon style path, included for CONTRAST:
 * a renderer reads its canvas back with getImageData() and ships the pixels to
 * the main process over IPC, which then calls publishImageBuffer().
 *
 * This is the slow path (GPU→CPU readback + IPC serialization — the very thing
 * that leaks in node-syphon #45). It exists so you can compare it live against
 * the zero-copy offscreen method in the control panel.
 */
export class CanvasReadbackMethod implements CaptureMethod {
  readonly id = 'canvas-readback'
  readonly label = 'Canvas readback (IPC)'
  readonly serverName = 'electron-syphon (canvas readback)'
  readonly description =
    'Renderer getImageData() → IPC → publishImageBuffer. The classic CPU path, for comparison.'

  private win: BrowserWindow | null = null
  private output: SyphonOutput | null = null
  private currentScene = 'canvas2d'
  private flipY = true
  private lastW = BROADCAST_W
  private lastH = BROADCAST_H
  scale = 1
  fps = 60
  // Compare senders by id (safe even after the window is destroyed; touching
  // a destroyed window's `.webContents` throws "Object has been destroyed").
  private wcId = -1

  constructor() {
    ipcMain.on(
      'readback:frame',
      (e, msg: { width: number; height: number; data: Uint8Array }) => {
        try {
          if (!this.output || e.sender.id !== this.wcId) return
          this.output.flipY = this.flipY
          // IPC delivers a typed array; the native side needs a node Buffer.
          this.output.publishImageBuffer(Buffer.from(msg.data), msg.width, msg.height, 'rgba')
          this.lastW = msg.width
          this.lastH = msg.height
        } catch {
          /* window/server torn down mid-frame — ignore */
        }
      }
    )
  }

  start(scene: string): void {
    if (this.win) return
    this.currentScene = scene
    this.output = new SyphonOutput('electron-syphon (canvas readback)')
    this.output.skipWhenNoClients = false
    // Offscreen (so Electron actively drives rendering and requestAnimationFrame
    // fires — a plain hidden window has rAF paused). The renderer reads its
    // canvas back and ships pixels over IPC; we don't attach to its paint event.
    this.win = makeOffscreen(false, join(__dirname, '../preload/index.js'), this.scale)
    this.win.webContents.setFrameRate(this.fps)
    this.wcId = this.win.webContents.id
    loadRoute(this.win, `readback/${scene}`, this.label)
  }

  stop(): void {
    this.wcId = -1
    this.output?.dispose()
    this.output = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  setScene(scene: string): void {
    this.currentScene = scene
    if (this.win && !this.win.isDestroyed()) loadRoute(this.win, `readback/${scene}`, this.label)
  }

  setFlip(on: boolean): void {
    this.flipY = on
  }

  setScale(scale: number): void {
    this.scale = scale
    if (this.win) {
      this.stop()
      this.start(this.currentScene)
    }
  }

  setFps(fps: number): void {
    this.fps = fps
    if (this.win && !this.win.isDestroyed()) this.win.webContents.setFrameRate(fps)
  }

  stats(): MethodStats {
    const o = this.output
    return {
      id: this.id,
      label: this.label,
      description: this.description,
      running: !!this.win,
      frames: o?.frames ?? 0,
      avgPublishMs: o?.publishMsEMA ?? 0,
      usingSharedTexture: false,
      hasClients: o?.hasClients ?? false,
      width: this.lastW,
      height: this.lastH,
      scene: this.currentScene,
      flipY: this.flipY,
      scale: this.scale,
      fps: this.fps
    }
  }
}
