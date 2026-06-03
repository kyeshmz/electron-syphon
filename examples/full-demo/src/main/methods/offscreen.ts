import type { BrowserWindow } from 'electron'
import { SyphonOutput } from 'electron-syphon'
import { makeOffscreen, loadRoute, BROADCAST_W, BROADCAST_H } from './windows'
import type { CaptureMethod, MethodStats } from './types'

/**
 * Publishes a hidden offscreen window via the library's `paint` bridge.
 *
 *  - `useSharedTexture = true`  → zero-copy IOSurface (publishSurface). Fastest.
 *  - `useSharedTexture = false` → CPU bitmap from the paint event
 *    (publishImageBuffer). Slower, but works without the shared-texture feature.
 *
 * Both run entirely in the main process — no pixel ever crosses IPC.
 */
export class OffscreenMethod implements CaptureMethod {
  private win: BrowserWindow | null = null
  private output: SyphonOutput | null = null
  private currentScene = 'canvas2d'
  scale = 1
  fps = 60

  constructor(
    readonly id: string,
    readonly label: string,
    readonly description: string,
    readonly serverName: string,
    private readonly useSharedTexture: boolean,
    // Maps the current scene to a renderer route; composite outputs override this.
    private readonly routeFor: (scene: string) => string = (s) => `scene/${s}`
  ) {}

  start(scene: string): void {
    if (this.win) return
    this.currentScene = scene
    this.output = new SyphonOutput(this.serverName)
    this.output.skipWhenNoClients = false // demo: keep publishing with no client
    this.win = makeOffscreen(this.useSharedTexture, undefined, this.scale)
    this.win.webContents.setFrameRate(this.fps)
    this.output.attach(this.win.webContents)
    loadRoute(this.win, this.routeFor(scene), this.label)
  }

  stop(): void {
    this.output?.dispose()
    this.output = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  setScene(scene: string): void {
    this.currentScene = scene
    if (this.win && !this.win.isDestroyed()) loadRoute(this.win, this.routeFor(scene), this.label)
  }

  setFlip(on: boolean): void {
    if (this.output) this.output.flipY = on
  }

  setScale(scale: number): void {
    this.scale = scale
    if (this.win) {
      // deviceScaleFactor is fixed at window creation — recreate to apply.
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
      usingSharedTexture: o?.usingSharedTexture ?? null,
      hasClients: o?.hasClients ?? false,
      width: o?.outWidth || BROADCAST_W,
      height: o?.outHeight || BROADCAST_H,
      scene: this.currentScene,
      flipY: o?.flipY ?? true,
      scale: this.scale,
      fps: this.fps
    }
  }
}
