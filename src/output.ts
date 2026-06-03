import type { WebContents, Rectangle, NativeImage } from 'electron'
import { SyphonServer, type NativeSyphonServer } from './native'

/**
 * Bridges an Electron `WebContents` (running offscreen with
 * `webPreferences.offscreen.useSharedTexture`) to a Syphon server.
 *
 * The whole pipeline lives in the MAIN process: the `paint` event hands us a
 * GPU IOSurface *handle* (a few bytes), which we publish zero-copy. Pixel data
 * never crosses IPC and is never read back to the CPU — this is what sidesteps
 * node-syphon's IPC memory leak (#45) and its worker-thread/readback issues
 * (#39): there is no cross-thread pixel sharing because there is no readback.
 */
export class SyphonOutput {
  private readonly server: NativeSyphonServer
  private wc: WebContents | null = null

  /** Toggle publishing without tearing down the server. */
  enabled = true
  /** Flip vertically. Electron OSR frames are top-left origin; many Syphon
   *  clients expect bottom-left. Exposed so it can be corrected at runtime. */
  flipY = true
  /** Async pipeline: submit without blocking the main thread, releasing the
   *  Electron texture a frame later once the GPU is done. Much higher throughput
   *  at high resolution. Set false for the simple synchronous path. */
  async = true
  /** Skip all GPU work when no Syphon client is attached (idle win). */
  skipWhenNoClients = true

  /** Stats. */
  frames = 0
  lastFrameAt = 0
  /** Exponential moving average of the native publish call (ms). */
  publishMsEMA = 0
  /** Actual published frame size (= codedSize; reveals Retina/DSF scaling). */
  outWidth = 0
  outHeight = 0
  /** null until the first paint tells us which path Electron actually used. */
  usingSharedTexture: boolean | null = null

  // Electron's shared-texture pool is hardcoded to 10 frames and cannot be
  // enlarged, so the async pipeline must stay shallow. We reap every frame;
  // this is a backstop if a slow GPU/consumer ever backs things up.
  private readonly maxInFlight = 8
  private pending: Electron.OffscreenSharedTexture[] = []

  // Frame rate to restore on resume(); -1 means "not currently paused".
  private savedFrameRate = -1

  constructor(name: string) {
    this.server = new SyphonServer(name)
  }

  attach(wc: WebContents): void {
    this.detach()
    this.wc = wc
    wc.on('paint', this.handlePaint)
  }

  detach(): void {
    if (this.wc && !this.wc.isDestroyed()) {
      this.wc.removeListener('paint', this.handlePaint)
    }
    this.flushPending()
    this.wc = null
    this.savedFrameRate = -1
  }

  /** True while suspended via pause(). */
  get paused(): boolean {
    return this.savedFrameRate !== -1
  }

  /**
   * Fully suspend BOTH rendering and publishing without tearing down the server.
   *
   * Setting `enabled = false` alone only skips the publish call — the offscreen
   * window keeps painting at full frame rate (the GPU/compositor cost, and the
   * renderer's requestAnimationFrame loop, both keep running). pause() also
   * throttles the attached offscreen webContents to 1 fps (Electron's floor),
   * which — because OSR drives the renderer's rAF cadence — slows the renderer
   * animation AND the GPU paint to a near-idle crawl.
   *
   * The Syphon server stays up; a connected client keeps its connection and sees
   * a frozen frame. Call resume() to restore the previous frame rate. No-op if
   * not attached to an offscreen webContents (use `enabled` for those).
   */
  pause(): void {
    if (this.paused) return
    this.enabled = false
    this.flushPending()
    const wc = this.wc
    if (wc && !wc.isDestroyed() && wc.isOffscreen()) {
      this.savedFrameRate = wc.getFrameRate()
      wc.setFrameRate(1)
    }
  }

  /** Restore rendering and publishing after pause(). */
  resume(): void {
    const wc = this.wc
    if (this.paused && wc && !wc.isDestroyed()) {
      wc.setFrameRate(this.savedFrameRate)
    }
    this.savedFrameRate = -1
    this.enabled = true
  }

  /** Manually publish a CPU pixel buffer (for non-offscreen capture methods,
   *  e.g. a renderer canvas read back to the main process). */
  publishImageBuffer(
    pixels: Buffer | Uint8Array,
    width: number,
    height: number,
    format: 'rgba' | 'bgra' = 'rgba'
  ): void {
    if (!this.enabled) return
    if (this.skipWhenNoClients && !this.server.hasClients) return
    const t0 = performance.now()
    this.server.publishImageBuffer(pixels, width, height, format, this.flipY)
    this.usingSharedTexture = false
    this.outWidth = width
    this.outHeight = height
    this.note(performance.now() - t0)
  }

  /** Wait for all in-flight async frames and release their Electron textures. */
  private flushPending(): void {
    try {
      this.server.drain()
    } catch {
      /* server may already be disposed */
    }
    while (this.pending.length) this.pending.shift()?.release()
  }

  get pendingDepth(): number {
    return this.pending.length
  }

  private handlePaint = (
    event: Electron.Event<Electron.WebContentsPaintEventParams>,
    _dirty: Rectangle,
    image: NativeImage
  ): void => {
    const texture = event.texture

    // Fallback: no shared texture → CPU bitmap (BGRA). Still main-process, no IPC.
    if (!texture) {
      if (this.enabled && (!this.skipWhenNoClients || this.server.hasClients)) {
        this.usingSharedTexture = false
        const { width, height } = image.getSize()
        if (width > 0 && height > 0) {
          const t0 = performance.now()
          // getBitmap() returns BGRA bytes at runtime; its TS return type drifts
          // across Electron versions (Buffer on <=41, mistyped void on 42), so cast.
          const bitmap = image.getBitmap() as unknown as Buffer
          this.server.publishImageBuffer(bitmap, width, height, 'bgra', this.flipY)
          this.outWidth = width
          this.outHeight = height
          this.note(performance.now() - t0)
        }
      }
      return
    }

    // We now hold a shared texture and MUST release it exactly once.
    this.usingSharedTexture = true
    const info = texture.textureInfo
    const isFrame = !info.widgetType || info.widgetType === 'frame'
    // Field-name drift: <=38 → `textureInfo.sharedTextureHandle`; 39+ moved it
    // to `textureInfo.handle.ioSurface`. Probe both so upgrades don't break us.
    const handle: Buffer | undefined =
      (info as { sharedTextureHandle?: Buffer }).sharedTextureHandle ??
      (info as { handle?: { ioSurface?: Buffer } }).handle?.ioSurface

    const skip =
      !this.enabled || !isFrame || !handle || (this.skipWhenNoClients && !this.server.hasClients)
    if (skip) {
      texture.release()
      return
    }

    const w = info.codedSize.width
    const h = info.codedSize.height
    this.outWidth = w
    this.outHeight = h
    const t0 = performance.now()

    if (this.async) {
      const enqueued = this.server.publishSurfaceAsync(handle!, w, h, this.flipY)
      if (enqueued) this.pending.push(texture)
      else texture.release()
      let done = this.server.reap()
      while (done-- > 0 && this.pending.length) this.pending.shift()!.release()
      if (this.pending.length >= this.maxInFlight) this.flushPending()
    } else {
      try {
        this.server.publishSurface(handle!, w, h, this.flipY)
      } finally {
        texture.release()
      }
    }

    this.note(performance.now() - t0)
  }

  private note(dt: number): void {
    this.publishMsEMA = this.publishMsEMA ? this.publishMsEMA * 0.9 + dt * 0.1 : dt
    this.frames++
    this.lastFrameAt = Date.now()
  }

  get name(): string | null {
    return this.server.name
  }

  get hasClients(): boolean {
    return this.server.hasClients
  }

  /** The underlying native server (for `benchmark()`, etc.). */
  get native(): NativeSyphonServer {
    return this.server
  }

  dispose(): void {
    this.detach()
    this.server.dispose()
  }
}
