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
  /**
   * Cap the publish rate (frames/sec), independent of how fast the window
   * renders. Each publish is a GPU copy into Syphon's surface, but Syphon is
   * fire-and-forget — any frame the consumer never samples is wasted work. Unlike
   * `webContents.setFrameRate()`, this does NOT slow the renderer: the page keeps
   * painting (and its rAF loop keeps running) at full rate for smooth animation,
   * while only every Nth frame is published. Set to your consumer's rate (e.g.
   * 30) to skip the in-between paints. 0 = uncapped (publish every paint). */
  maxPublishRate = 0

  /** Stats. */
  frames = 0
  lastFrameAt = 0
  private lastPublishAt = 0
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

  // Desired render/publish resolution from setResolution(); 0 = the window's
  // natural size. Because we publish exactly what Electron renders, this is also
  // the size Syphon receives — no scaling, no readback.
  private reqWidth = 0
  private reqHeight = 0
  private warnedScale = false

  constructor(name: string) {
    this.server = new SyphonServer(name)
  }

  attach(wc: WebContents, opts?: { width?: number; height?: number }): void {
    this.detach()
    this.wc = wc
    wc.on('paint', this.handlePaint)
    if (opts?.width && opts?.height) {
      this.reqWidth = Math.max(0, Math.floor(opts.width))
      this.reqHeight = Math.max(0, Math.floor(opts.height))
    }
    this.applyResolution()
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

  /**
   * Set the resolution to publish — by setting the resolution Electron *renders*.
   *
   * This pipeline sends exactly what the offscreen window renders (no scaling, no
   * readback), so the publish resolution is the render resolution. Rendering fewer
   * pixels is the single biggest performance lever: it shrinks Syphon's per-frame
   * blit, GPU/VRAM bandwidth, and shared-texture-pool pressure all at once. Render
   * at the size your Syphon consumer actually needs, not the display's.
   *
   * Implementation: resizes the `BrowserWindow` that owns the attached
   * `webContents` (via `setContentSize`). For the published frame to be exactly
   * `width × height`, that window must have been created with
   * `webPreferences.offscreen.deviceScaleFactor: 1` (Electron 42+); otherwise the
   * realized output is `width*dsf × height*dsf` — `outWidth`/`outHeight` report the
   * truth and a one-time warning fires on the first mismatched frame.
   *
   * Pass `0, 0` to stop managing the size. No-op (with a warning) if the
   * `webContents` isn't owned by a `BrowserWindow` — in that case size the window
   * yourself; the published size still equals the rendered size.
   */
  setResolution(width: number, height: number): void {
    this.reqWidth = Math.max(0, Math.floor(width))
    this.reqHeight = Math.max(0, Math.floor(height))
    this.warnedScale = false
    this.applyResolution()
  }

  /** The requested render/publish resolution, or null when unmanaged (the window
   *  renders at its natural size). `outWidth`/`outHeight` report what is actually
   *  being published once frames flow. */
  get resolution(): { width: number; height: number } | null {
    return this.reqWidth > 0 && this.reqHeight > 0
      ? { width: this.reqWidth, height: this.reqHeight }
      : null
  }

  private applyResolution(): void {
    const wc = this.wc
    if (!wc || wc.isDestroyed() || this.reqWidth <= 0 || this.reqHeight <= 0) return
    // Lazy require so 'electron' stays an optional peer dep at module load.
    const { BrowserWindow } = require('electron') as typeof import('electron')
    const win = BrowserWindow.fromWebContents(wc)
    if (!win || win.isDestroyed()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[electron-syphon] setResolution: this webContents is not owned by a BrowserWindow; ' +
          'size the window/view yourself (published size == rendered size).'
      )
      return
    }
    win.setContentSize(this.reqWidth, this.reqHeight)
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

  // Returns true if enough time has elapsed to publish at maxPublishRate (and
  // records the moment); false to drop this frame. Always true when uncapped.
  // The dropped frame's texture is released by the caller — the renderer keeps
  // painting at full rate, we just don't forward every frame to Syphon.
  private rateGate(): boolean {
    if (this.maxPublishRate <= 0) return true
    const interval = 1000 / this.maxPublishRate
    const now = Date.now()
    if (this.lastPublishAt === 0) {
      this.lastPublishAt = now
      return true
    }
    if (now - this.lastPublishAt < interval) return false
    // Advance the target by exactly one interval (not to `now`) so jitter in
    // paint arrival doesn't compound into a slower-than-target rate. If we've
    // fallen more than an interval behind (a stall), resync to avoid a burst.
    this.lastPublishAt += interval
    if (now - this.lastPublishAt > interval) this.lastPublishAt = now
    return true
  }

  private handlePaint = (
    event: Electron.Event<Electron.WebContentsPaintEventParams>,
    _dirty: Rectangle,
    image: NativeImage
  ): void => {
    const texture = event.texture

    // Fallback: no shared texture → CPU bitmap (BGRA). Still main-process, no IPC.
    if (!texture) {
      if (this.enabled && (!this.skipWhenNoClients || this.server.hasClients) && this.rateGate()) {
        this.usingSharedTexture = false
        const { width, height } = image.getSize()
        if (width > 0 && height > 0) {
          const t0 = performance.now()
          // getBitmap() returns BGRA bytes at runtime; its TS return type drifts
          // across Electron versions (Buffer on <=41, mistyped void on 42), so cast.
          const bitmap = image.getBitmap() as unknown as Buffer
          this.server.publishImageBuffer(bitmap, width, height, 'bgra', this.flipY)
          this.noteRealized(width, height)
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
    // Rate gate after the other skips so a dropped-for-rate frame doesn't reset
    // timing against frames we skipped for being idle/disabled. Short-circuits so
    // rateGate() only ticks when we'd otherwise publish.
    if (skip || !this.rateGate()) {
      texture.release()
      return
    }

    const cs = info.codedSize // read the getter once, not twice
    const w = cs.width
    const h = cs.height
    this.noteRealized(w, h)
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

  /** Record the actually-published size and, once, warn if it doesn't match the
   *  resolution requested via setResolution() (the deviceScaleFactor != 1 trap). */
  private noteRealized(w: number, h: number): void {
    this.outWidth = w
    this.outHeight = h
    if (this.reqWidth > 0 && !this.warnedScale && (w !== this.reqWidth || h !== this.reqHeight)) {
      // Only flag the deviceScaleFactor trap: a uniform upscale of the requested
      // size on both axes (a transient size mid-resize won't match this).
      const sx = w / this.reqWidth
      const sy = h / this.reqHeight
      if (sx > 1 && Math.abs(sx - sy) < 0.001) {
        this.warnedScale = true
        // eslint-disable-next-line no-console
        console.warn(
          `[electron-syphon] requested ${this.reqWidth}×${this.reqHeight} but publishing ${w}×${h} ` +
            `(~${sx.toFixed(2)}× — a Retina/deviceScaleFactor scale-up); create the window with ` +
            'offscreen.deviceScaleFactor: 1 (Electron 42+) to render at the exact size.'
        )
      }
    }
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
