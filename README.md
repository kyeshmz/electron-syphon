# electron-syphon

<p>
  <a href="https://resolume.com"><img src="docs/assets/logos/resolume.png" alt="Resolume" title="Resolume" width="56" height="56" /></a>&nbsp;&nbsp;
  <a href="https://madmapper.com"><img src="docs/assets/logos/madmapper.png" alt="MadMapper" title="MadMapper" width="56" height="56" /></a>&nbsp;&nbsp;
  <a href="https://derivative.ca"><img src="docs/assets/logos/touchdesigner.png" alt="TouchDesigner" title="TouchDesigner" width="56" height="56" /></a>&nbsp;&nbsp;
  <a href="https://vidvox.net"><img src="docs/assets/logos/vdmx.png" alt="VDMX" title="VDMX" width="56" height="56" /></a>&nbsp;&nbsp;
  <a href="https://syphon.github.io"><img src="docs/assets/logos/syphon-recorder.png" alt="Syphon Recorder" title="Syphon Recorder" width="56" height="56" /></a>
</p>

Publish an Electron app's rendered GPU frames to **[Syphon](https://syphon.github.io/)** on macOS — **zero-copy**, from the main process. Any Syphon client receives your app's output as live video:

<p align="center">
  <img src="docs/assets/electron-syphon.gif" alt="electron-syphon publishing an Electron app's frames to a Syphon client in real time" width="800" />
</p>




```ts
import { SyphonOutput } from 'electron-syphon'

const win = new BrowserWindow({
  show: false,
  webPreferences: { offscreen: {
    useSharedTexture: true,// this is required
    deviceScaleFactor: 1 },
    backgroundThrottling: false }
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
- **Fast** — ~0.13 ms/frame at 1080p (~125× real-time @60 fps); 3–5× the CPU-readback approach.

## Install

```bash
# This does require Electron 33+
npm install electron-syphon
```
See [`INTEGRATION.md`](INTEGRATION.md) for step-by-step wiring and [`METHODOLOGY.md`](METHODOLOGY.md) for how the pipeline works.

## Tuning & multiple outputs

Publish is ~0.13 ms/frame at 1080p (live, end-to-end), so what you pay scales with a few obvious knobs:

- **Resolution** — render size *is* send size. Set it with `setResolution(w, h)` and create the window with `deviceScaleFactor: 1` so Retina doesn't quietly render 2×.
- **Publish rate** — `maxPublishRate` caps how often frames reach Syphon without slowing the renderer. Syphon is fire-and-forget, so any frame the consumer never pulls is wasted.
- **Orientation** — `flipY` defaults to `true`; pre-flip your content and set it `false` for Syphon's ~33% faster pure-blit path.

For many sources at once you have two patterns:

- **One server per source** — give each offscreen window its own `SyphonOutput`. Fine to ~16 windows, and the right choice when a downstream app routes each independently.
- **One composite server** — `CompositeSyphonOutput` blits N windows into one tiled atlas and publishes a *single* server: 1.5–6× faster at 9–25 tiles and scaling linearly past 64. It re-blits only the tiles that changed, coalesces same-tick paints into one publish, and offers a zero-copy `direct: true` backend (1.3–2× faster again, plus an `outputScale` publish-time downscale). Stacked, a 16-window wall with a few tiles changing can run ~21× faster than one-server-per-window.

See [`METHODOLOGY.md`](METHODOLOGY.md) for the full benchmarks and `examples/full-demo/` for every method side by side with live controls.

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

### Where the time actually goes

Measured end-to-end (one offscreen window, `useSharedTexture`, `deviceScaleFactor: 1`), the publish call is **~0.12–0.16 ms/frame — under 1% of a 16.7 ms frame**, with a ~6000–8000 fps ceiling.

In order of impact:

1. **Render fewer pixels** — `deviceScaleFactor: 1` (avoids 4× Retina overdraw), and render/`setResolution` to the size your consumer needs, not the display's. For composite walls shown small, `outputScale`.
2. **Don't render/publish faster than the consumer pulls** — `maxPublishRate` (publish side, keeps the renderer smooth) or `webContents.setFrameRate()` (also throttles rendering).
3. **For many windows** — one composite server (`CompositeSyphonOutput`, ideally `direct: true`) instead of N servers; for sparse walls it's ~10× and downscales for near-free.
4. **Need >60 fps? Don't drive rendering with `requestAnimationFrame`** — rAF is vsync-locked to ~60 Hz, so it's the limiter (not OSR or the publish). A non-rAF render loop (`setInterval`/`setTimeout`, or a manual WebGL/WebGPU draw loop) plus `webContents.setFrameRate(120/240)` lets OSR deliver **up to ~240 fps** (measured: 120 → 120, 240 → 238 paints/sec), and the publish still keeps up at <5% of the frame budget.

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
