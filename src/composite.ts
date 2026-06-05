import type { WebContents, Rectangle, NativeImage } from 'electron'
import { SyphonServer, type NativeSyphonServer } from './native'

/** One cell of the composite grid. */
export interface CompositeSlot {
  /** Column (0-based) of this slot in the grid. */
  col: number
  /** Row (0-based) of this slot in the grid. */
  row: number
}

export interface CompositeOptions {
  /** Grid columns. Default 2. */
  cols?: number
  /** Grid rows. Default 2. */
  rows?: number
  /** Pixel width of each tile (= the size each source renders). Default 1280. */
  tileWidth?: number
  /** Pixel height of each tile. Default 720. */
  tileHeight?: number
  /** Flip the published atlas vertically (Electron OSR is top-left origin; many
   *  Syphon clients expect bottom-left). Default true. */
  flipY?: boolean
}

// Refcounted wrapper around an Electron shared texture. The atlas blit COPIES
// each source into the atlas, so a source texture is safe to release once it is
// (a) no longer the current frame for its slot AND (b) not used by any in-flight
// publish. We track both with a single refcount: +1 for "current", +1 per
// in-flight publish batch that referenced it.
class RefTexture {
  refs = 0
  constructor(readonly texture: Electron.OffscreenSharedTexture) {}
  retain(): this {
    this.refs++
    return this
  }
  release(): void {
    if (--this.refs <= 0) this.texture.release()
  }
}

/**
 * Publish N offscreen Electron windows through a SINGLE Syphon server by
 * compositing each window's GPU frame into one tiled atlas texture and
 * publishing it once per frame.
 *
 * This is dramatically faster than running one {@link SyphonOutput} per window:
 * it collapses N command-buffer commits + N Syphon blits into 1 + 1, and avoids
 * the N parallel command queues that make the per-server pattern fall off a
 * cliff at scale. Measured (1280×720 tiles, async): ~1.5× faster at 9 outputs,
 * ~2.5× at 16, ~6× at 25 — and the per-server pattern can no longer sustain a
 * large grid while this stays flat (~0.04 ms/tile). See `test/scaling-bench.js`.
 *
 * Every source must render offscreen with `useSharedTexture` and, ideally,
 * `offscreen.deviceScaleFactor: 1` so its frame is exactly `tileWidth ×
 * tileHeight` (otherwise it is cropped to the tile). The whole pipeline lives in
 * the main process; pixels never cross IPC and are never read back to the CPU.
 */
export class CompositeSyphonOutput {
  private readonly server: NativeSyphonServer
  readonly cols: number
  readonly rows: number
  readonly tileWidth: number
  readonly tileHeight: number

  /** Flip the published atlas vertically. */
  flipY: boolean
  /** Toggle publishing without tearing down the server. */
  enabled = true
  /** Skip all GPU work when no Syphon client is attached (idle win). */
  skipWhenNoClients = true

  /** Stats. */
  frames = 0
  lastFrameAt = 0

  // Latest (sticky) frame per slot — held with one "current" ref so an unchanged
  // tile keeps showing its last frame across publishes.
  private readonly current: (RefTexture | null)[]
  // FIFO of in-flight publish batches; batch[i] is the set of textures the i-th
  // submitted atlas referenced, released once reap() reports it completed.
  private pending: RefTexture[][] = []
  // Per-slot attached webContents + paint handler, for clean detach.
  private readonly attached: (WebContents | null)[]
  private readonly handlers: ((...args: never[]) => void)[]

  // Electron's shared-texture pool is 10 frames per webContents; keep the atlas
  // pipeline shallow so we never starve a source.
  private readonly maxInFlight = 6

  constructor(name: string, opts: CompositeOptions = {}) {
    this.server = new SyphonServer(name)
    this.cols = Math.max(1, Math.floor(opts.cols ?? 2))
    this.rows = Math.max(1, Math.floor(opts.rows ?? 2))
    this.tileWidth = Math.max(1, Math.floor(opts.tileWidth ?? 1280))
    this.tileHeight = Math.max(1, Math.floor(opts.tileHeight ?? 720))
    this.flipY = opts.flipY ?? true
    const n = this.cols * this.rows
    this.current = new Array(n).fill(null)
    this.attached = new Array(n).fill(null)
    this.handlers = new Array(n)
  }

  /** Full atlas width in published pixels. */
  get atlasWidth(): number {
    return this.cols * this.tileWidth
  }

  /** Full atlas height in published pixels. */
  get atlasHeight(): number {
    return this.rows * this.tileHeight
  }

  private slotIndex(col: number, row: number): number {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      throw new RangeError(
        `slot (${col},${row}) is outside the ${this.cols}×${this.rows} grid`
      )
    }
    return row * this.cols + col
  }

  /**
   * Attach an offscreen `webContents` to a grid cell. Its frames are composited
   * into that tile and published with everyone else's. Re-attaching a cell
   * replaces the previous source. The source should render at `tileWidth ×
   * tileHeight`; larger frames are cropped to the tile, smaller ones leave the
   * remainder of the cell showing its previous contents.
   */
  attach(wc: WebContents, slot: CompositeSlot): void {
    const idx = this.slotIndex(slot.col, slot.row)
    this.detachSlot(idx)
    const handler = (
      _event: Electron.Event<Electron.WebContentsPaintEventParams>,
      _dirty: Rectangle,
      _image: NativeImage
    ): void => this.onPaint(idx, _event)
    wc.on('paint', handler as never)
    this.attached[idx] = wc
    this.handlers[idx] = handler as never
  }

  /** Detach the source at a grid cell (if any). */
  detach(slot: CompositeSlot): void {
    this.detachSlot(this.slotIndex(slot.col, slot.row))
  }

  private detachSlot(idx: number): void {
    const wc = this.attached[idx]
    if (wc && !wc.isDestroyed()) wc.removeListener('paint', this.handlers[idx] as never)
    this.attached[idx] = null
    const cur = this.current[idx]
    if (cur) {
      this.current[idx] = null
      cur.release() // drop the "current" ref; in-flight batches keep it alive
    }
  }

  private onPaint(
    idx: number,
    event: Electron.Event<Electron.WebContentsPaintEventParams>
  ): void {
    const texture = event.texture
    if (!texture) return // composite path requires shared textures; ignore CPU frames
    if (!this.enabled || (this.skipWhenNoClients && !this.server.hasClients)) {
      texture.release()
      return
    }
    const info = texture.textureInfo
    const isFrame = !info.widgetType || info.widgetType === 'frame'
    if (!isFrame) {
      texture.release()
      return
    }
    // Replace this slot's sticky frame with the new one.
    const next = new RefTexture(texture).retain() // "current" ref
    const prev = this.current[idx]
    this.current[idx] = next
    if (prev) prev.release()

    this.publish()
  }

  /**
   * Composite all current tiles into the atlas and publish once. Called
   * automatically on each source paint; safe to call manually (e.g. on a timer)
   * if you want a fixed cadence independent of source repaints.
   */
  publish(): void {
    if (!this.enabled) return
    if (this.skipWhenNoClients && !this.server.hasClients) return

    const tiles: { handle: Buffer; x: number; y: number; w: number; h: number }[] = []
    const batch: RefTexture[] = []
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cur = this.current[row * this.cols + col]
        if (!cur) continue
        const info = cur.texture.textureInfo
        const handle: Buffer | undefined =
          (info as { sharedTextureHandle?: Buffer }).sharedTextureHandle ??
          (info as { handle?: { ioSurface?: Buffer } }).handle?.ioSurface
        if (!handle) continue
        tiles.push({
          handle,
          x: col * this.tileWidth,
          y: row * this.tileHeight,
          w: this.tileWidth,
          h: this.tileHeight
        })
        batch.push(cur.retain()) // +1 in-flight ref
      }
    }
    if (tiles.length === 0) return

    const enqueued = this.server.publishAtlas(tiles, this.atlasWidth, this.atlasHeight, this.flipY)
    if (enqueued) {
      this.pending.push(batch)
      this.frames++
      this.lastFrameAt = Date.now()
    } else {
      for (const t of batch) t.release() // not enqueued → drop the in-flight refs
    }

    let done = this.server.reap()
    while (done-- > 0 && this.pending.length) {
      for (const t of this.pending.shift()!) t.release()
    }
    if (this.pending.length >= this.maxInFlight) this.flushPending()
  }

  /** Wait for all in-flight atlas publishes and release their source textures. */
  private flushPending(): void {
    try {
      this.server.drain()
    } catch {
      /* server may already be disposed */
    }
    while (this.pending.length) {
      for (const t of this.pending.shift()!) t.release()
    }
  }

  /** How many atlas publishes are awaiting GPU completion. */
  get pendingDepth(): number {
    return this.pending.length
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
    for (let i = 0; i < this.current.length; i++) this.detachSlot(i)
    this.flushPending()
    this.server.dispose()
  }
}
