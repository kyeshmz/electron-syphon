# Methodology

> **Thesis.** The entire job of this library is to move a *GPU texture handle* between two
> processes — never the pixels behind it. An Electron offscreen window renders a frame that
> lives in GPU memory as an `IOSurface`; macOS's `IOSurface` primitive lets a second process
> bind its own texture to that *same* kernel-owned VRAM by passing only a small reference.
> What Electron hands the addon on `paint` is an **`IOSurfaceRef`** — a ~8-byte 64-bit pointer
> to the kernel-owned surface, delivered as a `Buffer` (the addon `reinterpret_cast`s it straight
> back to an `IOSurfaceRef`). The *mach port* enters later and elsewhere: it is Syphon's own
> cross-process transport between `SyphonServer` and `SyphonClient`, not the Electron→addon
> handoff. `electron-syphon` sits in the seam: it takes the `IOSurfaceRef` Electron hands it on
> `paint`, wraps it as a Metal texture, and republishes it through a `SyphonMetalServer` — all in
> the **main process**, with no readback to host memory and no pixel data on IPC. Everything below
> explains *why* the pipeline is shaped this way and how it differs from every other approach,
> including the modern ones that get the data path right but pay for it elsewhere.

This document is for an engineer who has read the README and wants the rationale underneath it:
the deliberate decisions, the failure modes they avoid, and an honest map of the alternatives.

---

## 1. The problem

You have an Electron app that renders visuals — a WebGL scene, a WebGPU shader, a `<canvas>`,
a `<video>`, a whole React UI — and you want that output to appear *live, at frame rate* inside
VJ / video software on the same Mac: Resolume, MadMapper, VDMX, TouchDesigner, Syphon Recorder.
On macOS the lingua franca for that is **Syphon**: a `SyphonMetalServer` advertises a named
source through `SyphonServerDirectory`, and any client looks it up and receives the frames.

The hard part is not Syphon. The hard part is getting Electron's rendered frame *to* the Syphon
server cheaply. A 1080p frame is ~8 MB; at 60 fps that is ~500 MB/s. If any stage of your
pipeline touches those bytes — reads them off the GPU, serializes them across a process boundary,
re-uploads them — you are now memory-bandwidth bound, you scale badly with resolution, and (as we
will see) you can leak unboundedly. Syphon itself is zero-copy by design; the whole game is to not
squander that before the data reaches the server.

The good path exists because of two pieces of platform plumbing that only recently lined up:

- **`IOSurface`** — a kernel-managed, GPU-pageable chunk of texture memory that can be referenced
  from multiple processes. Within a process you hold it by `IOSurfaceRef` (a pointer); Syphon
  ships the *same* surface to another process over a mach port. This is what makes Syphon
  zero-copy in the first place.
- **Electron offscreen rendering with `useSharedTexture`** — instead of copying each offscreen
  frame back to a CPU bitmap, Electron keeps it as a platform GPU texture and hands you a
  *serializable handle* to it (an `IOSurfaceRef` on macOS) on the `paint` event.

The methodology is: connect those two handles directly, in one process, and never look at the
pixels in between.

---

## 2. The core method

End to end, the zero-copy pipeline is six steps:

1. **Render offscreen with a shared texture.** The app creates a hidden `BrowserWindow` with
   `webPreferences.offscreen: { useSharedTexture: true }`. Electron renders the page on the GPU
   and keeps the composited frame as an `IOSurface` instead of reading it back.
2. **Receive the handle on `paint` (main process).** `SyphonOutput.attach(wc)` subscribes to
   `wc.on('paint', …)`. Each paint carries `event.texture` (an `OffscreenSharedTexture`) whose
   `textureInfo` exposes the `IOSurface` handle and `codedSize`. The handle is a `Buffer` of a few
   bytes holding a 64-bit pointer — `DecodeSurface` in the addon `reinterpret_cast`s it straight
   back to an `IOSurfaceRef` (~8 bytes/frame, no copy).
3. **Wrap the `IOSurface` as a Metal texture (cached).** The addon builds an `MTLTextureDescriptor`
   (`BGRA8Unorm`, `usage = ShaderRead` only, `storageMode = Shared`, dimensions from
   `IOSurfaceGetWidth/Height`) and calls `newTextureWithDescriptor:iosurface:plane:0`. The
   resulting texture *aliases the same VRAM* — nothing is copied.
4. **Publish via `SyphonMetalServer`.** Once-created `MTLCommandQueue` → per-frame `commandBuffer`
   → `server publishFrameTexture:tex onCommandBuffer:cmd imageRegion:NSMakeRect(0,0,w,h) flipped:`
   → `commit`. Syphon writes our texture into *its* rotating `IOSurface` and announces the frame.
5. **A client binds the same `IOSurface`.** Any `SyphonMetalClient` (`serversMatchingName` →
   connect → `newFrameImage`) receives a reference to Syphon's `IOSurface` across the process
   boundary (passed via a mach port) and wraps it as *its own* `MTLTexture`. Both processes'
   textures are backed by identical kernel memory.
6. **Release the Electron texture.** We call `texture.release()` exactly once to return the
   `IOSurface` to Electron's finite rotating pool (synchronously in the simple path, or a frame
   later in the async path — see §3).

```
 Electron offscreen window (GPU)
        │  renders frame into an IOSurface (stays in VRAM)
        ▼
 paint event ── event.texture.textureInfo ──►  IOSurfaceRef (~8-byte pointer, a Buffer)
        │                                        │   (MAIN PROCESS — no IPC, no readback)
        │                                        ▼
        │                       newTextureWithDescriptor:iosurface:plane:0   (cached, aliases VRAM)
        │                                        │
        │                                        ▼
        │                       SyphonMetalServer.publishFrameTexture:onCommandBuffer:…:flipped:
        │                                        │   writes into Syphon's own IOSurface
        ▼                                        ▼
 texture.release()                       SyphonServerDirectory announces "My App"
 (return to Electron pool)                       │
                                                 ▼  mach port (cross-process, handle only)
                                   SyphonMetalClient.newFrameImage → MTLTexture
                                                 │   binds the SAME IOSurface
                                                 ▼
                                       Resolume / MadMapper / TouchDesigner (GPU)

 No pixel crosses IPC.  Nothing is read back to the CPU.  The server lives in the MAIN process.
```

Three properties are load-bearing and worth stating flatly:

- **No pixel crosses IPC.** The only thing that travels renderer→main is whatever Electron's
  `paint` event carries, and on the shared-texture path that is an `IOSurfaceRef`, not a frame
  buffer.
- **Nothing is read back to the CPU.** The frame is born on the GPU and stays there through Syphon
  to the client. The only CPU touch is the ~8-byte handle.
- **The Syphon server runs in the main process.** Not the renderer, not a worker. The `IOSurface`
  handle Electron produces is a main-process object, and the texture's `release()` *must* be called
  from where the texture lives — the main process — so colocating the server there removes an entire
  class of cross-thread/cross-process coordination.

The public surface that wraps all of this is intentionally tiny: `attach(webContents)` and a handful
of fields. `SyphonOutput` never inspects *what* you render, only that a frame arrived — which is why
canvas2D, WebGL, WebGPU, DOM, and `<video>` all work identically.

---

## 3. What makes it correct and fast

Each decision below is a response to a specific cost or failure mode.

### Server in the main process (not renderer, not over IPC)
The competing instinct is to render in a renderer, read the canvas back, and ship the buffer to
main over IPC. That instinct is exactly what produces node-syphon's unbounded leak (§5). By keeping
the server in main and consuming Electron's own `paint` handle, there is no IPC pixel hop to copy,
serialize, or leak, and `texture.release()` runs on the thread that owns the texture. The class doc
says it plainly: the whole pipeline lives in the main process *because there is no readback, there is
no cross-thread pixel sharing.*

### `MTLTexture` cache keyed by `IOSurface`
Electron's shared-texture pool is small — on the order of **~10** `IOSurface`s — and it *rotates*:
the same few surfaces come back round and round. Re-wrapping a Metal texture for each one every
frame would be wasted allocation. The addon caches textures in `surfaceTextures_`, keyed by
`@((uintptr_t)surface)`, so a recurring `IOSurface` reuses its `MTLTexture`. The cache is bounded and
self-healing: a size change calls `removeAllObjects`, and the count is clamped (clears past ~32, max
~33) so it tracks Electron's ~10-surface working set without growing unbounded. This caching is what
the README means by "the texture wrapping Electron's rotating IOSurface pool is cached."

### `usage = ShaderRead` only
The Metal texture is created with the *minimal* usage flag. The addon's own comment records why:
the texture is only ever a **source** — a blit source on the `flipped:NO` fast path, or a sampled
source on the `flipped:YES` redraw path — and is never a render target. Declaring only `ShaderRead`
is both correct and lets the driver pick the most optimal layout.

### Async / pipelined publish + deferred release
The default (`async = true`) submits the command buffer without `waitUntilCompleted`, so the main
thread is not blocked on the GPU. The contract is: `publishSurfaceAsync` returns `1` if it enqueued
(adds the command buffer to `inflight_`), and the JS side then *keeps the Electron texture alive* by
pushing it onto `pending`; `reap()` later reports how many frames finished and we release exactly
that many textures. `ReapInternal` walks `inflight_` FIFO from index 0 and counts a command buffer as
done when its status is **either `Completed` or `Error`** — an *errored* command buffer is still
reaped and its texture still released. That detail matters: a single GPU error cannot wedge the pool,
because a failed frame frees its slot exactly like a successful one. This is the difference the
benchmarks show: at 1080p the sync publish is ~0.36 ms but the async publish is ~0.06 ms, and in the
live app this drops main-thread cost from ~1.4 ms to ~**0.13 ms/frame** (~10×).

The pipeline is deliberately **shallow** because the pool is small and *cannot be enlarged*:
- We **reap every frame** (inline, right after enqueue) so released textures return to Electron's
  ~10-surface pool as fast as possible — this is the dominant lifetime concern, not the GPU latency.
- A `maxInFlight = 8` backstop: if a slow GPU/consumer ever lets `pending` reach 8, `flushPending()`
  calls native `drain()` (`DrainInternal` waits for *all* in-flight frames) and releases everything.
  The pool is 10, so the backstop fires before the pool can be exhausted.

If you forget this discipline — late or missing `release()` — you stall capture or hit
`Failed to allocate IOSurface`. The shallow async pipeline is the whole reason the library can run
**24+ windows/servers at 60 fps at 720p** on an M-series Mac. (That figure is resolution-bound, not
resolution-free — the very next decisions are about why resolution dominates.)

### `skipWhenNoClients`
There is no point doing GPU work nobody is watching. With `skipWhenNoClients = true` (default), the
handler checks `server.hasClients` (a direct accessor onto `SyphonMetalServer.hasClients`) and, when
no client is connected, releases the texture immediately and returns *before* wrapping or publishing.
Note this is an explicit, opt-out skip — Syphon does not auto-skip — and it gates all three publish
sites (shared-texture, CPU fallback, manual `publishImageBuffer`). It is the "idle win": zero GPU
cost until a client actually subscribes.

### `deviceScaleFactor` / Retina honesty
Dimensions come from `info.codedSize`, *not* from the window's logical size, precisely because
`codedSize` reveals Retina/DSF scaling: on Electron < 42 an offscreen window renders at the display's
scale factor, so a 1280×720 window yields a 2560×1440 `IOSurface` — 4× the pixels, which is what
collapses a many-window setup to ~2 fps. The library reports the *real* published size via
`outWidth`/`outHeight` so you can see it; Electron 42's `offscreen.deviceScaleFactor: 1` fixes the
overdraw at the source.

### ARC + `@autoreleasepool` + reuse (the leak fix)
node-syphon's most visible problem is a memory leak ([#45](https://github.com/benoitlahoz/node-syphon/issues/45)) —
production users reported **30+ GB of RAM in 1–2 minutes**. The root cause there is IPC pixel copies
accumulating (§5). This library avoids that *class* of leak by never doing IPC pixel transport at
all, but it also takes Objective-C memory management seriously on the native side, because a
publish-every-frame addon that leaks even a little is unusable:

- **ARC is mandatory** — the addon `#error`s the build unless `CLANG_ENABLE_OBJC_ARC=YES`, so the
  retain/release of every Metal/`IOSurface` object is compiler-managed and can't silently drift.
- **`@autoreleasepool` wraps every per-frame entry point** (decode, publish, reap, the CPU path),
  so autoreleased temporaries are reclaimed each frame instead of piling up until the run loop drains.
- **Texture reuse** (the cache above) keeps allocation churn near zero.

The CPU fallback follows the same discipline: a single `cpuTexture_` (default `Managed` storage) is
kept and updated in place via `EnsureCpuTexture` + `replaceRegion`, not reallocated per frame.

### Y-flip cost is a real knob
`flipped:NO` is a straight blit copy; `flipped:YES` is a sampled redraw and is **costlier** (the
README measures ~33%). `flipY` defaults to `true` because most Syphon clients expect bottom-left
origin while Electron OSR frames are top-left, but it is exposed at runtime so you can pre-flip your
content and take the fast path.

---

## 4. Lifecycle, disposal, and verification

`attach()` is defensive: it calls `detach()` first (so re-attaching never double-subscribes), stores
the `WebContents`, and binds `handlePaint` as an arrow-function class field so `this` stays correct.
`detach()` removes the listener (guarded by `!wc.isDestroyed()`), then `flushPending()` — which
`drain()`s any in-flight async frames and releases their Electron textures — and nulls `wc`.
`dispose()` is `detach()` + native `dispose()`, and the native `Dispose` is itself idempotent
(drain → stop → nil). The result: tearing down mid-flight never leaks an Electron texture and never
leaves a half-published frame.

Stats are cheap and honest. Each publish is timed with `performance.now()` and folded into an EMA
(`publishMsEMA = publishMsEMA ? publishMsEMA*0.9 + dt*0.1 : dt`), `frames` increments, `lastFrameAt`
updates, and `usingSharedTexture` stays `null` until the first paint reveals which path Electron
actually chose. That signal is the operational tell for the single most common misconfiguration:
`useSharedTexture` must be **nested** (`offscreen: { useSharedTexture: true }`) — the *flat* form
(`offscreen: true, useSharedTexture: true`) silently falls back to the CPU bitmap path, so
`usingSharedTexture` reading `false` when you expected zero-copy almost always means a flat-vs-nested
config slip rather than a hardware problem.

**End-to-end receive verification.** The exported `SyphonClient` exists so the publish can be proven,
not assumed. Its `receive()` pulls a frame with `newFrameImage`, then blits an *N×N* sample (16×16
when dimensions ≥ 32, else 1×1) at offset `(w/3, h/3)` into a small `Shared` BGRA8 texture, reads the
bytes back, and reports `nonBlack` when any of R/G/B exceeds 8. The example app's test suite drives
the full chain — publish → Syphon → `serversMatchingName` connect → `receive` → non-black pixel sample
— so a green run means frames actually arrived on the other side, not merely that a server was
advertised.

---

## 5. How others have done it, and why we differ

This section is deliberately fair: some of these alternatives have the *wrong* data path, but one of
them (node-syphon's modern GPU path) has essentially the *same* data path as ours, and the honest
differences there are ergonomic, not fundamental.

### node-syphon — CPU readback over IPC (the legacy/common Electron usage)
```
renderer GPU surface → getImageData/readPixels/capturePage (GPU→CPU readback)
  → IPC structured-clone copy (renderer→main) → main Buffer
  → publishImageData → native replaceRegion (CPU→GPU re-upload) → SyphonMetalServer → client
```
**Drawbacks.** Three full-frame copies per frame: the readback stalls the GPU pipeline, the IPC
serialization copies the buffer (this is the leak in [#45](https://github.com/benoitlahoz/node-syphon/issues/45) —
"Electron IPC serialization creates copies that accumulate"; reported as 30+ GB in 1–2 min; buffer
reuse + nullification help but do **not** eliminate it; the issue is still **open**), and
`replaceRegion` re-uploads CPU→GPU. It is memory-bandwidth bound and scales badly with resolution;
`capturePage` is async and slower still. Our own bench puts the *native publish step alone* at
~1.0 ms @1080p / ~3.4 ms @4K vs ~0.06 ms @1080p to ~0.19 ms @4K async zero-copy — and that excludes
the readback and IPC, which are the dominant real costs.
**What we do instead.** No readback, no IPC pixels, no re-upload — we wrap the handle Electron
already produced and publish from main.

> **Caveat on the framing.** It is accurate that node-syphon's *typical* Electron usage ships pixel
> buffers renderer→main every frame, but it overstates to imply node-syphon can *only* do this. See
> the next entry. Likewise, [#39](https://github.com/benoitlahoz/node-syphon/issues/39) and
> [#42](https://github.com/benoitlahoz/node-syphon/issues/42) are about the **receive/subscribe**
> side (consuming Syphon frames in workers / in the renderer), not how node-syphon *publishes*
> Electron output — so they don't characterize node-syphon's publish path. We note this so the
> comparison is honest rather than convenient.

### node-syphon — GPU shared-texture / `publishSurfaceHandle` (its modern path)
```
offscreen window GPU IOSurface → paint event.texture.sharedTextureHandle (main)
  → server.publishSurfaceHandle(handle, 'GL_TEXTURE_RECTANGLE_EXT', visibleRect, codedSize, flipped)
  → Syphon → client     (no readback, no IPC pixels)
```
**This is architecturally the same idea as ours**, and for the publish step itself the cost is
comparable (both wrap the same Electron `IOSurface`). The real differences are ergonomic, not
data-path:
- node-syphon's `publishSurfaceHandle` here goes through the **OpenGL** server
  (`GL_TEXTURE_RECTANGLE_EXT`); a "publishSurfaceHandle in Metal" was a pending TODO. We go straight
  through **`SyphonMetalServer`**.
- node-syphon's example runs the server inside a Node `worker_thread` (the maintainer calls it
  "hacky memory-sharing", and it is still aimed at the CPU-pixel case); we run in the **main thread**,
  which is simpler and is where the Electron texture and its `release()` already live.
- node-syphon is a **source build** (node-gyp, needs `Syphon.framework` at build time); we ship a
  **prebuilt N-API binary** and a vendored framework — `npm install` needs no Xcode.

It is **not** true that node-syphon forces readback/IPC; this GPU path avoids both. We differ on
Metal-vs-GL, main-thread-vs-worker, and prebuilt-vs-source — and on packaging the whole thing behind
a one-call API.

### vcync/electron-syphon — native addon in a renderer Web Worker, `getImageData` upload
```
OffscreenCanvas 2D → drawImage copy → getImageData (CPU readback)
  → syphon.node (in the worker) → MTLTexture replaceRegion (CPU→GPU re-upload)
  → SyphonMetalServer (flipped:YES) → client
```
**Drawbacks.** A full `getImageData` readback every frame, then `replaceRegion` re-uploads — the
frame crosses GPU→CPU→GPU pointlessly, memory-bandwidth bound, defeating the GPU. It *does* avoid
node-syphon's IPC leak (the addon runs in the worker, so there's no main↔renderer IPC hop — a genuine
difference) but at the cost of running native code in the renderer (no sandbox; `nodeIntegrationInWorker`
required). It is also tied to a 2D-canvas demo, assumes RGBA8, has no prebuilt binary, and its
Windows/Spout path is a stub. Experimental, ~8 stars, no releases.
**What we do instead.** Wrap the offscreen `IOSurface` directly in **main** — no readback, no
re-upload, no native code in the renderer.

### Electron offscreen **CPU bitmap** `paint` path (`useSharedTexture: false`)
```
offscreen window → Electron GPU→CPU bitmap copy → paint NativeImage.getBitmap() (BGRA)
  → publishImageBuffer (CPU→GPU upload) → Syphon → client
```
This is the honest apples-to-apples baseline and is what `electron-syphon` itself **falls back to**
when no shared texture is present. Electron does the GPU→CPU copy ("slower… requires more system
resources" — Electron docs), then you upload CPU→GPU again to publish. No IPC if done in main, but the
readback is unavoidable and bandwidth-bound, and this path carries Electron's documented **240 fps
cap** ("greater values bring only performance losses"). That cap applies specifically to the CPU
bitmap path (`useSharedTexture: false`); there is no equivalently documented frame-rate ceiling on
the shared-texture path, so do not assume 240 fps bounds the zero-copy path. Our handler implements
exactly this baseline as the `if (!texture)` branch (`getBitmap()` →
`publishImageBuffer(..., 'bgra', flipY)`, still main-process, still no IPC) — so the library degrades
gracefully rather than failing on setups without shared-texture support. It is strictly worse than the
zero-copy path on the same machine; we use it only when we have to.

---

## 6. Comparison

| method | data path (abridged) | crosses IPC? | CPU readback? | leaks? | relative speed |
|---|---|:---:|:---:|:---:|---|
| **electron-syphon (this lib, zero-copy)** | offscreen IOSurface → paint handle (main) → MTLTexture → SyphonMetalServer | **no** | **no** | **no** | **fastest** — ~0.06 ms @1080p to ~0.19 ms @4K (async); ~0.13 ms/frame live |
| node-syphon GPU `publishSurfaceHandle` | offscreen IOSurface → paint handle → publishSurfaceHandle (GL) | no | no | no | comparable publish; GL + worker + source-build |
| node-syphon CPU readback over IPC | renderer readback → IPC copy → replaceRegion (re-upload) | **yes** | **yes** | **yes (#45, open)** | slowest; ~1.0 ms @1080p *just for publish*, unbounded RAM |
| vcync/electron-syphon (worker) | OffscreenCanvas getImageData → addon in worker → replaceRegion | no | **yes** | no | slow; GPU→CPU→GPU round-trip |
| Electron CPU bitmap paint (our fallback) | Electron GPU→CPU bitmap → getBitmap → publishImageBuffer | no | **yes** | no | slower; bandwidth-bound, 240 fps cap |

Speeds are this repo's bench, native publish only (Apple Silicon, arm64). The directly comparable
**sync** columns give zero-copy ~0.36 ms vs CPU ~1.01 ms at 1080p (≈2.8×) and ~0.93 ms vs ~3.38 ms at
4K (≈3.6×), the gap widening with resolution (GPU blit vs memory-bandwidth-bound upload). The
README's headline "3× at 1080p, 5.5× at 4K" is reproduced from its own performance section; the
4K multiple is not derivable from the published sync columns alone (those yield ≈3.6×) and appears to
fold in the larger async advantage, so treat the directly-derivable sync figures above as the
verifiable ones.

---

## 7. The bigger picture

**Syphon and Spout are twins.** Both implement the same thesis — *pass the GPU texture handle, never
the pixels* — on different OS primitives. Syphon uses an `IOSurface` referenced across processes via a
mach port; Spout uses a DXGI/D3D11 shared texture referenced via a `CreateSharedHandle` NT handle, with
a keyed mutex to serialize access. Same tradeoffs (same-machine, same-GPU, agree on orientation and
premultiplied alpha), different kernel object. One synchronization difference is worth naming: Spout's
keyed mutex coordinates writer and reader, whereas **Syphon imposes no keyed mutex**, so under heavy
load a Syphon client can occasionally sample a half-written frame — Syphon's zero-copy is fast and
clean but not synchronization-guaranteed in the way Spout's keyed-mutex path is. This twinning is not
incidental to the repo: the directory is named **`electron-spout`**, and an
`electron-spout`/`electron-syphon` pair is meant to mirror each other — the macOS half is what's
documented here.

**The Electron OSR evolution is what made the zero-copy path possible at all**, and its version
history is the part most likely to bite you:
- Classic OSR delivered a CPU `NativeImage` bitmap every frame (the §5 fallback). The shared-texture
  path (reitowo / Renaud Rohlinger, electron/electron PRs #42001 / #42953, plus a 33.x backport
  #44511) keeps the frame as a platform GPU texture and hands you an `IOSurfaceRef` on `paint`.
- **Config is easy to get wrong:** `useSharedTexture` must be **nested** (`offscreen: { useSharedTexture: true }`);
  the flat form silently falls back to the CPU path. (`usingSharedTexture` lets you detect this — see §4.)
- **The handle shape moved:** Electron ≤ 38 exposes `textureInfo.sharedTextureHandle`; 39+ moved it to
  `textureInfo.handle.ioSurface`. The handler **probes both** with nullish-coalescing so an upgrade
  doesn't break you.
- **Retina default changed:** before Electron 42 an offscreen window rendered at the display scale
  factor (the 2×/4× overdraw trap); 42's `deviceScaleFactor: 1.0` fixes it.
- **Security:** a use-after-free existed in `texture.release()` (CVE-2026-34764), fixed in
  39.8.5 / 40.8.5 / 41.1.0 / 42.0.0-alpha.5. This library releases promptly, but pin a patched Electron.

> The README says "Electron 33+" for the zero-copy path. The shared-texture OSR feature itself landed
> around **Electron 35** (PRs #42001 / #42953, ~Chromium 134), with a 33.x backport (#44511). Treat 33
> as the backport floor and verify against the version where `offscreen.useSharedTexture` /
> `event.texture` first appear in your target line. Corroborating this, the package declares electron
> only as an **optional** peer dependency (`peerDependencies: { electron: ">=33" }` with
> `peerDependenciesMeta.electron.optional: true`) while the repo itself develops and tests against
> `electron ^35.1.5` as a devDependency — i.e. 35 is the line it is actually exercised on.

**Why not the network/capture transports?** They solve a different problem and all pay CPU cost:
- **NDI** reads the frame off the GPU, compresses it, and sends it over IP — sub-100 ms (Full) to
  100–200 ms (HX) latency, real CPU, lossy. Right tool for *across machines*, wrong tool for
  same-box app→VJ compositing.
- **Virtual cameras / CoreMediaIO DAL** force GPU→CPU readback + ARGB→YUV conversion per frame
  ("CPU hungry"); their value is webcam *compatibility*, not latency.
- **ScreenCaptureKit / desktop duplication** captures the *compositor's* output on the capture
  pipeline's cadence (~30–100 ms at 1080p), not your app's exact render target on your render loop.
- **WebRTC** encodes and serializes through a media stack with jitter buffering — heavier and
  higher-latency even over loopback; built for remote real-time comms, not a pixel-perfect local hand-off.

Handle-passing wins for local compositing because the GPU image never leaves the GPU: near-zero
latency, near-zero CPU, lossless. The moment a frame must leave the box or feed a generic
camera/codec consumer, you fall back to a CPU transport and lose the win — which is exactly when one
of the above is the correct choice.

---

## 8. Trade-offs and when the other methods still make sense

The zero-copy method is not universally applicable. Be honest about the edges:

- **No shared texture → CPU path is the right call.** On setups where Electron produces no shared
  texture (misconfig — including the flat-vs-nested `useSharedTexture` slip — older/unsupported
  Electron, hardware acceleration disabled), the `getBitmap()` fallback is the only thing that works.
  We ship it for exactly this reason. If your scene is small or low-fps, the CPU path's cost may
  simply not matter.
- **Capturing something you didn't render.** If you don't control the rendering — you want to capture
  another app, a display, or a visible window — Syphon-via-shared-texture cannot help; you need
  ScreenCaptureKit (or a CPU `capturePage`/canvas readback). You **can't** make a *visible* window
  publish directly; offscreen rendering is what produces the shareable GPU frame.
- **Cross-process / worker consumption.** Our publish path is deliberately main-thread because that's
  where the Electron texture and its `release()` live. If your architecture needs Syphon work in a
  worker (node-syphon's #39/#42 territory) — usually on the *receive* side — a different design with
  explicit thread-safe frame handoff is warranted, and it will involve a GPU→CPU download that our
  publish-only library never needs.
- **`flipY` cost.** The default right-side-up orientation takes Syphon's sampled-redraw path (~33%
  costlier than the pure blit). If you're throughput-bound at high resolution and can pre-flip your
  content, `flipY = false` buys back that margin.
- **Notarization / framework shipping.** Zero-copy comes with a native addon and a vendored
  `Syphon.framework` you must `asarUnpack` and ship into `Contents/Frameworks`; a notarized release
  must re-sign the framework (or grant `com.apple.security.cs.disable-library-validation`). A
  pure-JS CPU path through a different binding may have a simpler packaging story — at the cost of the
  performance and leak guarantees above.

In short: use the zero-copy path whenever you render the content yourself, on a current Electron, on
the same Mac as the VJ app. Reach for a CPU/capture/network transport only when one of those
preconditions doesn't hold.

---

## 9. Implementation notes worth keeping straight

A few concrete details that the rationale above rests on:

- **ABI stability is earned by a build flag, not a hope.** Prebuilds are produced with
  `prebuildify --napi --strip` against `node-addon-api ^8.3.1`. The `--napi` flag is what selects
  N-API, and because N-API is ABI-stable across V8/Node/Electron versions, a single prebuilt `.node`
  works across Electron versions without recompiling. The `install` script runs `node-gyp-build`,
  which resolves a shipped `prebuilds/<platform>-<arch>/*.node` or compiles `build/Release` as a
  fallback. This is the actual basis for the README's "ABI-stable across Electron versions" claim.
- **The native stub lives at `native/syphon/stub.cpp`** (a no-op on non-macOS), not `native/stub.cpp`
  — worth knowing if you build on a non-Mac CI runner.
- **The bench harness publishes 1920×1080 over 600 iterations** to produce the per-resolution numbers
  in §6; `npm run bench` times the native publish path in isolation from Electron.

---

## 10. The performance frontier — what's at the floor, and the only two ways past it

Every layer of the publish pipeline has been profiled and driven to its structural floor. This
section records *where* the floor is on each layer, and — honestly — the only two changes that could
move it, both of which require an upstream API we do not own. It exists so nobody re-treads ground
that's already been measured to a dead end.

**Each layer, and why it can't go lower with the current primitives:**

- **Single-window publish — 1 copy (floor).** `PublishSurfaceCore` wraps Electron's `IOSurface` as a
  *cached, zero-copy* `MTLTexture`, then `publishFrameTexture` does Syphon's one internal copy into the
  server's own surface. No readback, no second copy. The zero-copy `direct` trick that helps compositing
  can't help here — single-window is already a single blit, and `publishFrameTexture` is the optimized
  route for it.
- **Composite — 2× area (atlas) or 1 blit (direct), partial scales below.** Reading N sources once and
  writing the output once is the irreducible minimum; the persistent atlas + partial updates mean only
  *changed* tiles cost anything (≈10× on a sparse wall), and `outputScale` drops it further (≈scale²)
  when the consumer shows the wall smaller than native.
- **Per-frame CPU encode is the residual, and it's a non-bottleneck.** Profiling (`npm run bench:profile`)
  shows the direct path is ~88–90% CPU command-encode, ~10% GPU — but at 25 tiles × 60 fps that's
  ~0.54 ms/frame, ≈3% of one core. The per-tile binding cost is irreducible (instancing and Metal-3
  bindless were both *built and measured* at 1.00× — the N-texture residency is the floor, not the
  binding style).
- **Receiver — readback-bound, swizzle offloaded.** `receiveFrame` is dominated by the GPU→CPU copy the
  caller asked for; the BGRA→RGBA conversion is done on the GPU, and the sample texture is reused.

Cumulative effect on a realistic sparse 16–25-window wall: **≈21–42× over the naive
one-server-per-window baseline.** The render-side `deviceScaleFactor: 1` fix (§7) is, on a Retina
display, a bigger single win than anything in the publish path — the publish path is <5% of the frame
budget; the workflow is **render-bound**, not publish-bound.

**The only two theoretical wins left — both blocked by Syphon's surface-ownership model:**

1. **0-copy single-window publish.** Today single-window pays one copy because a Syphon server must
   publish a surface *it* allocated. To reach zero copies you would publish Electron's own `IOSurface`
   *as* the Syphon frame. Syphon has no API for advertising a foreign surface — even
   `SyphonSubclassing`'s `newSurfaceForWidth` returns *the server's own* surface — and Electron won't
   render OSR into a surface we supply. Blocked at **both** ends.
2. **Promoting the faster `direct` backend to the default.** `direct` is 1.5–2× over `atlas` but stays
   opt-in because it renders zero-copy into Syphon's *single* published surface, which a client can be
   reading while the next frame overwrites it (the §7 keyed-mutex gap, structurally). Making it the
   default would require tear-safe **double-buffering**, and `SyphonSubclassing.h` forecloses it:
   `newSurfaceForWidth` returns *"an existing or new IOSurface sized for the given dimensions"* (one
   cached surface per size — re-asking the same size returns the *same* surface) and `-publish`
   advertises *that one surface*. There is no publish-by-surface call, so a server holds exactly one
   surface at a time. `atlas` stays the safe default not by caution but by protocol.

Both unlocks need the **same upstream change**: a Syphon API to publish a caller-owned / rotating set
of `IOSurface`s (i.e. what Spout gets from its keyed-mutex shared texture on the Windows side), and/or
Electron accepting an external render target. Until one of those exists, this library is at its
measurable floor, and further local micro-optimization has been verified — repeatedly, by building the
candidates and measuring 1.00× — to yield nothing.

---

## 11. Further reading

**In this repo**
- [`README.md`](README.md) — install, usage, packaging, the performance table.
- [`INTEGRATION.md`](INTEGRATION.md) — step-by-step wiring into an existing app + troubleshooting.
- `src/output.ts` — the `SyphonOutput` JS pipeline (paint handler, async/reap, fallback).
- `src/native.ts` — the N-API surface (`publishSurface`, `publishSurfaceAsync`, `reap`, `drain`).
- `native/syphon/syphon_addon.mm` — the Metal/`IOSurface`/Syphon implementation.

**External**
- Syphon project — <https://syphon.info/> ; Syphon-Framework (`SyphonMetalServer.m`) —
  <https://github.com/Syphon/Syphon-Framework>
- Spout (the Windows twin) — <https://github.com/leadedge/Spout2>
- Apple `IOSurface` — <https://developer.apple.com/documentation/iosurface> ;
  cross-process rendering — <http://www.russbishop.net/cross-process-rendering>
- Electron offscreen rendering — <https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering> ;
  shared-texture OSR README — <https://github.com/electron/electron/blob/main/shell/browser/osr/README.md> ;
  PRs <https://github.com/electron/electron/pull/42001> · <https://github.com/electron/electron/pull/42953> ·
  <https://github.com/electron/electron/pull/44511>
- node-syphon — <https://github.com/benoitlahoz/node-syphon> ; the leak
  [#45](https://github.com/benoitlahoz/node-syphon/issues/45) ; worker design
  [#39](https://github.com/benoitlahoz/node-syphon/issues/39) ; receive-side zero-copy
  [#42](https://github.com/benoitlahoz/node-syphon/issues/42)
- vcync/electron-syphon (prior art) — <https://github.com/vcync/electron-syphon>
- Syphon vs Spout vs NDI overview — <https://github.com/CESNET/UltraGrid/wiki/Syphon,-Spout-and-NDI>
- CVE-2026-34764 (`release()` UAF, fixed 39.8.5 / 40.8.5 / 41.1.0 / 42.0.0-alpha.5) —
  <https://advisories.gitlab.com/pkg/npm/electron/CVE-2026-34764/>
