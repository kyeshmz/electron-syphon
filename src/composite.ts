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

// The atlas blit COPIES each source into a PERSISTENT atlas texture, so once a
// publish that blitted a source completes, the pixels live in the atlas and the
// source can be released — the atlas itself provides "sticky" tiles. A source
// texture therefore only needs to survive until the one publish that blits it
// finishes, so a plain FIFO of in-flight batches suffices (no refcount needed).

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
  /**
   * Coalesce all paints that land in the same event-loop turn into ONE atlas
   * publish (batching every dirty tile), instead of publishing once per paint.
   * Without this, N windows repainting in a tick cause N full-atlas Syphon
   * publishes when one suffices — the dominant cost at high window counts. On by
   * default; set false for an immediate publish on every paint (lowest latency,
   * highest overhead). */
  coalesce = true
  /**
   * Cap the publish rate (frames/sec). Each atlas publish is a full-area Syphon
   * copy — the dominant bandwidth cost — but Syphon is fire-and-forget, so any
   * frame a client never samples is wasted work. When N sources animate at 60fps
   * the pipeline would otherwise publish far more often than any consumer pulls
   * (e.g. ~250/s for 9 windows). Set this to your consumer's rate (e.g. 60) to
   * accumulate dirty tiles between publishes and emit at most this many full
   * frames per second — same visible result, a fraction of the GPU/bandwidth/
   * power. 0 = uncapped (publish as soon as a paint lands, coalesced per turn). */
  maxPublishRate = 0

  /** Stats. */
  frames = 0
  lastFrameAt = 0
  private lastPublishAt = 0
  private rateTimer: ReturnType<typeof setTimeout> | null = null

  // Latest UN-BLITTED frame per slot ("dirty"). Once blitted into the atlas the
  // slot goes back to null — the atlas holds the pixels, so we don't keep the
  // source texture around. A new paint before the next publish supersedes (and
  // releases) the previous un-blitted one.
  private readonly dirty: (Electron.OffscreenSharedTexture | null)[]
  // FIFO of in-flight publish batches; batch[i] is the set of source textures
  // the i-th submitted atlas blitted, released once reap() reports it completed.
  private pending: Electron.OffscreenSharedTexture[][] = []
  // Per-slot attached webContents + paint handler, for clean detach.
  private readonly attached: (WebContents | null)[]
  private readonly handlers: ((...args: never[]) => void)[]
  // Set while a coalesced publish is queued for the end of this loop turn.
  private publishQueued: ReturnType<typeof setImmediate> | null = null

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
    this.dirty = new Array(n).fill(null)
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
    const cur = this.dirty[idx]
    if (cur) {
      this.dirty[idx] = null
      cur.release() // an un-blitted frame that will never be published
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
    // Mark this slot dirty with the new frame; drop any earlier un-blitted one
    // (it was never published, the atlas never saw it).
    const prev = this.dirty[idx]
    this.dirty[idx] = texture
    if (prev) prev.release()

    if (this.coalesce) this.schedulePublish()
    else this.publish()
  }

  // Queue one publish for the end of the current loop turn. Every paint that
  // lands before it fires just marks its slot dirty; the single publish then
  // batches them all into one atlas frame.
  private schedulePublish(): void {
    if (this.maxPublishRate > 0) {
      // Rate-capped: one publish is scheduled at a time; paints arriving before
      // it fires just accumulate dirty tiles, so we emit at most maxPublishRate
      // full frames/sec (and batch more tiles per publish).
      if (this.rateTimer) return
      const minInterval = 1000 / this.maxPublishRate
      const wait = Math.max(0, this.lastPublishAt + minInterval - Date.now())
      this.rateTimer = setTimeout(() => {
        this.rateTimer = null
        this.lastPublishAt = Date.now()
        this.publish()
      }, wait)
      return
    }
    if (this.publishQueued) return
    this.publishQueued = setImmediate(() => {
      this.publishQueued = null
      this.publish()
    })
  }

  /**
   * Composite all current tiles into the atlas and publish once. Called
   * automatically on each source paint; safe to call manually (e.g. on a timer)
   * if you want a fixed cadence independent of source repaints.
   */
  publish(): void {
    if (!this.enabled) return
    if (this.skipWhenNoClients && !this.server.hasClients) return

    // Only re-blit slots whose source repainted since the last publish; the
    // persistent atlas keeps every other tile's last pixels. This is the 2.5–3×
    // win on a wall where few windows change per frame.
    const tiles: { handle: Buffer; x: number; y: number; w: number; h: number }[] = []
    const batch: Electron.OffscreenSharedTexture[] = []
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const idx = row * this.cols + col
        const tex = this.dirty[idx]
        if (!tex) continue
        const info = tex.textureInfo
        const handle: Buffer | undefined =
          (info as { sharedTextureHandle?: Buffer }).sharedTextureHandle ??
          (info as { handle?: { ioSurface?: Buffer } }).handle?.ioSurface
        if (!handle) {
          // Unusable frame — drop it so it can't wedge the slot dirty forever.
          this.dirty[idx] = null
          tex.release()
          continue
        }
        tiles.push({
          handle,
          x: col * this.tileWidth,
          y: row * this.tileHeight,
          w: this.tileWidth,
          h: this.tileHeight
        })
        this.dirty[idx] = null // consumed: the atlas will hold its pixels
        batch.push(tex) // kept alive until this publish completes
      }
    }
    if (tiles.length === 0) return // nothing changed → atlas already shows it

    // Every grid cell rewritten this frame → safe to ping-pong the atlas (no
    // write-after-read stall against the previous frame's Syphon copy).
    const fullUpdate = tiles.length === this.cols * this.rows
    const enqueued = this.server.publishAtlas(
      tiles,
      this.atlasWidth,
      this.atlasHeight,
      this.flipY,
      fullUpdate
    )
    if (enqueued) {
      this.pending.push(batch)
      this.frames++
      this.lastFrameAt = Date.now()
    } else {
      for (const t of batch) t.release() // not enqueued → release immediately
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

  /** Force a republish of the current atlas without waiting for a source to
   *  repaint (e.g. to feed a client that just connected to a static wall).
   *  No-op until at least one tile has been published. */
  republish(): void {
    if (!this.enabled) return
    if (this.skipWhenNoClients && !this.server.hasClients) return
    if (this.dirty.some((d) => d)) {
      this.publish()
      return
    }
    // 0 dirty tiles: re-emit the persisted atlas (native publishes it as-is).
    this.server.publishAtlas([], this.atlasWidth, this.atlasHeight, this.flipY)
    let done = this.server.reap()
    while (done-- > 0 && this.pending.length) {
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
    if (this.publishQueued) {
      clearImmediate(this.publishQueued)
      this.publishQueued = null
    }
    if (this.rateTimer) {
      clearTimeout(this.rateTimer)
      this.rateTimer = null
    }
    for (let i = 0; i < this.dirty.length; i++) this.detachSlot(i)
    this.flushPending()
    this.server.dispose()
  }
}
