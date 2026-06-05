# electron-syphon

Publish an Electron app's rendered GPU frames to **[Syphon](https://syphon.github.io/)** on macOS — **zero-copy**, from the main process. Any Syphon client receives your app's output as live video:

[![Resolume](https://img.shields.io/badge/Resolume-FF3B30?style=for-the-badge&logoColor=white)](https://resolume.com)
[![MadMapper](https://img.shields.io/badge/MadMapper-FF2D78?style=for-the-badge&logoColor=white)](https://madmapper.com)
[![TouchDesigner](https://img.shields.io/badge/TouchDesigner-2B2B2B?style=for-the-badge&logoColor=white)](https://derivative.ca)
[![VDMX](https://img.shields.io/badge/VDMX-FF6A00?style=for-the-badge&logoColor=white)](https://vidvox.net)
[![Syphon Recorder](https://img.shields.io/badge/Syphon_Recorder-1E8E5A?style=for-the-badge&logoColor=white)](https://syphon.github.io)

```ts
import { SyphonOutput } from 'electron-syphon'

const win = new BrowserWindow({
  show: false,
  webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false }
})
win.webContents.setFrameRate(60)

const out = new SyphonOutput('My App')
out.attach(win.webContents, { width: 1280, height: 720 }) // publishes every frame — that's it
win.loadURL(myVisualsUrl)

// out.setResolution(960, 540)  // render + publish at a fixed size (the biggest perf knob)
// out.flipY = false            // ~33% faster — but pre-flip your content
// out.pause() / out.resume()   // suspend rendering (→1 fps) + publishing
// out.enabled = false          // stop publishing only (window keeps rendering)
// out.hasClients               // is a Syphon client connected?
// out.frames / out.publishMsEMA / out.outWidth / out.outHeight   // live stats
// out.dispose(); listServers()
```

**One call: `attach(webContents)`.** Point it at an offscreen window's `webContents` and it publishes every frame that window renders — canvas2D, WebGL, WebGPU, DOM, `<video>`, your whole React app, all identical. Multiple outputs = `attach` to multiple `webContents`. The only requirement: the window is **offscreen with `useSharedTexture`** (that's what makes `paint` hand you a GPU frame).

- **Zero-copy** — `paint` hands main an **IOSurface handle**; we wrap it as a Metal texture and publish via `SyphonMetalServer`. No pixel crosses IPC; nothing is read back to the CPU.
- **Prebuilt** — N-API binary (ABI-stable across Electron versions) + vendored `Syphon.framework`. `npm install` needs no Xcode.
- **Fast** — ~0.13 ms/frame at 1080p (≈40× real-time @60 fps); 3–5× the CPU-readback approach.

## Install

```bash
npm install electron-syphon
```

macOS 11+. Electron is an optional peer dep; **33+** for the zero-copy path (older falls back to a CPU bitmap). Run an example: `cd examples && npm install && npm run webgl` (also `simple-window · webgpu · multi-window · single-render · …`). See [`INTEGRATION.md`](INTEGRATION.md) for step-by-step wiring and [`METHODOLOGY.md`](METHODOLOGY.md) for how the pipeline works.

## Two knobs that matter

Publish is ~0.06 ms/frame at 1080p; what you pay scales with **pixels** and **orientation**.

- **Resolution** — render size *is* send size (we publish exactly what's rendered). Set via `attach(wc, { width, height })` or `setResolution(w, h)`, and create the window with **`deviceScaleFactor: 1`** (Electron 42+) or Retina renders 2× (4× the work). Render at the size your consumer needs, not the display's.
- **Orientation** — `flipY` defaults to `true` (Electron top-left → most clients want bottom-left). `flipY = false` takes Syphon's pure-blit path (~33% faster) if you pre-flip your content:

```
gl_Position = vec4(pos.x, -pos.y, pos.z, 1.0);   // WebGL: flip clip-space Y
ctx.translate(0, h); ctx.scale(1, -1);            // Canvas 2D: flip the context
camera.projectionMatrix.elements[5] *= -1;        // Three.js: flip the camera
#broadcast { transform: scaleY(-1); }             // DOM/CSS: flip the root
```

## Multiple outputs

Two patterns, depending on whether your consumer needs each source as a *separate* Syphon server.

**Distinct servers** — each offscreen window → its own `SyphonOutput` → its own server. Use when a downstream app routes each source independently. Scales to ~16 windows before the per-server cost (N command queues + N publishes) starts to bite; keep resolution modest (`deviceScaleFactor: 1` + `setResolution`) and **don't** pass `--disable-gpu-vsync` / `--disable-frame-rate-limit` (they exhaust the IOSurface pool → `Failed to allocate IOSurface`).

**One composite server** (faster at scale) — `CompositeSyphonOutput` blits N windows into one tiled atlas texture and publishes it through a *single* server. This collapses N command-buffer commits + N Syphon blits into 1 + 1:

```ts
import { CompositeSyphonOutput } from 'electron-syphon'

const grid = new CompositeSyphonOutput('Wall', { cols: 4, rows: 4, tileWidth: 1280, tileHeight: 720 })
grid.attach(win0.webContents, { col: 0, row: 0 })
grid.attach(win1.webContents, { col: 1, row: 0 })
// … one server, published as a single 5120×2880 frame
```

Measured (`npm run bench:scaling`, 1280×720 tiles, async) — time per *full-grid* frame, equal total pixels:

| outputs | distinct servers | composite atlas | speedup |
|---|---:|---:|---:|
| 9  | 0.48 ms | 0.33 ms | **1.5×** |
| 16 | 1.63 ms | 0.66 ms | **2.5×** |
| 25 | 5.96 ms | 0.99 ms | **6.0×** |

The per-server pattern's cost per tile grows and falls off a cliff (~0.2 ms/tile at 25 outputs — can no longer sustain the grid); the atlas stays flat (~0.04 ms/tile). Sources should render at `tileWidth × tileHeight` (larger frames are cropped to the tile).

`CompositeSyphonOutput` re-blits **only the tiles that changed** since the last frame — the atlas texture is persistent, so unchanged windows keep their last pixels for free. On a wall where few windows repaint per frame this is the dominant lever:

| of 25 tiles, changed/frame | frame time | vs all-change |
|---|---:|---:|
| 25 (all) | 0.98 ms | 1.0× |
| 4  | 0.50 ms | 2.0× |
| 1  | 0.40 ms | 2.5× |

Combined with the atlas (vs one server per window, all repainting), a sparsely-updating 25-window wall publishes ~11× faster. Call `republish()` to re-emit the current atlas to a client that connects to an otherwise-static wall.

`examples/full-demo/` shows every capture method side by side with live controls.

## Low-level API

```ts
import { SyphonServer, SyphonClient, listServers } from 'electron-syphon'

const s = new SyphonServer('My Server')
s.publishSurface(handle, w, h, flipY)                // zero-copy (sync)
s.publishSurfaceAsync(handle, w, h, flipY); s.reap() // zero-copy (pipelined)
s.publishAtlas(tiles, atlasW, atlasH, flipY)         // composite N→1 (see CompositeSyphonOutput)
s.publishImageBuffer(buf, w, h, 'rgba', flipY)       // CPU
s.hasClients; s.name; s.dispose()

const c = new SyphonClient('Resolume - Composition') // receiver (tests, monitors)
c.receive(true)   // { hasFrame, width, height, nonBlack, r, g, b, a } (sampled)
c.receiveFrame()  // { …, pixels } full RGBA (GPU→CPU readback — for a live monitor)
c.isValid; c.hasNewFrame; c.dispose()
```

## Performance

`npm run bench` — native publish path, isolated from Electron (Apple Silicon, arm64):

| resolution | zero-copy sync | zero-copy async | CPU buffer sync |
|---|---:|---:|---:|
| 1280×720 | 0.27 ms | 0.04 ms | 0.59 ms |
| 1920×1080 | 0.36 ms | 0.06 ms | 1.01 ms |
| 3840×2160 | 0.93 ms | 0.19 ms | 3.38 ms |

The **async pipeline** (default) submits without blocking and releases the texture a frame later — ~1.4 ms → ~0.13 ms/frame live (~10×). Zero-copy beats CPU ~2.8× @1080p / ~3.6× @4K (sync columns), widening with resolution. The wrapping texture is cached; publishing skips entirely with no client attached.

## Packaging (electron-builder)

```yaml
asarUnpack:
  - '**/node_modules/electron-syphon/prebuilds/**'
mac:
  extraFiles:
    - from: node_modules/electron-syphon/Frameworks/Syphon.framework
      to: Frameworks/Syphon.framework
```

The addon's `@executable_path/../Frameworks` rpath resolves to `Contents/Frameworks`. For notarization, re-sign the framework (or grant `com.apple.security.cs.disable-library-validation`).

## Caveats

- **`useSharedTexture` must be nested** — `offscreen: { useSharedTexture: true }`. The flat form silently uses the CPU path; check `out.usingSharedTexture`.
- **No keyed mutex** — Syphon (unlike Spout) doesn't lock writer vs. reader, so under heavy load a client can momentarily sample a partially-written frame. Rare; the price of its raw speed.
- **Keep Electron current** — `texture.release()` UAF (CVE-2026-34764) fixed in 39.8.5 / 40.8.5 / 41.1.0 / 42.0.0-alpha.5.

## Build from source

Consumers never need this — `npm install` pulls a prebuilt N-API binary and the vendored framework. Build from source only to hack on the addon or update Syphon. It assumes a standard macOS dev box:

- **macOS 11+** — Syphon is macOS-only; other platforms compile a no-op stub (`native/syphon/stub.cpp`).
- **Xcode Command Line Tools** (`xcode-select --install`) — provides `clang`/`clang++`, the macOS SDK and system frameworks linked by the addon (Metal, IOSurface, Foundation, QuartzCore), plus `xcodebuild`, `otool`, `lipo`, `install_name_tool`, `ditto` used by the scripts.
- **clang with ARC + C++17 + libc++** — the `.mm` `#error`s unless built with Objective-C ARC; `binding.gyp` pins `CLANG_ENABLE_OBJC_ARC=YES`, `CLANG_CXX_LANGUAGE_STANDARD=c++17`, `libc++`, RTTI + C++ exceptions on, `MACOSX_DEPLOYMENT_TARGET=11.0`.
- **Node ≥ 18 + node-gyp's deps** (Python 3 and `make`, both shipped with the CLT) — to compile. **node-addon-api 8 / N-API**, so `prebuildify --napi` emits one ABI-stable `.node` that loads across Electron/Node versions without a rebuild.
- **git** — only for `build-syphon-framework.sh`, which clones and `xcodebuild`s [Syphon-Framework](https://github.com/Syphon/Syphon-Framework) (universal arm64 + x86_64).
- The vendored **`Frameworks/Syphon.framework`** must be present to link; rpaths resolve it in dev and at `@executable_path/../Frameworks` once packaged.

```bash
npm run make-library                       # framework (if missing) + dist + prebuilds + verify
ARCHS="arm64 x86_64" npm run make-library  # universal (Intel + Apple Silicon) prebuild
./scripts/build-syphon-framework.sh        # rebuild the vendored Syphon.framework only
```

## License

MIT. Bundles [Syphon-Framework](https://github.com/Syphon/Syphon-Framework) (BSD, bangnoise & vade). Prior art: [`vcync/electron-syphon`](https://github.com/vcync/electron-syphon), [`benoitlahoz/node-syphon`](https://github.com/benoitlahoz/node-syphon). OffscreenSharedTexture by reitowo / Renaud Rohlinger.
