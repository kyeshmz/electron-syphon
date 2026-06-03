# electron-syphon

Publish an Electron app's rendered GPU frames to **[Syphon](https://syphon.github.io/)** on macOS — **zero-copy**, from the main process. Any Syphon client (Resolume, MadMapper, VDMX, TouchDesigner, Syphon Recorder) can then receive your app's output as live video.

```ts
import { SyphonOutput } from 'electron-syphon'

const win = new BrowserWindow({
  show: false,
  webPreferences: { offscreen: { useSharedTexture: true }, backgroundThrottling: false }
})
win.webContents.setFrameRate(60)

const syphon = new SyphonOutput('My App')
syphon.attach(win.webContents) // publishes every frame to Syphon — that's it
win.loadURL(myVisualsUrl)
```

**The whole interface is one call: `attach(webContents)`.** You point it at an offscreen window's `webContents` and it publishes every frame that window renders. It never looks at *what* you draw — so canvas2D, WebGL, WebGPU, plain DOM, a `<video>`, your whole React app… all work identically. Multiple outputs = `attach` to multiple `webContents`. The only requirement is that the window is **offscreen with `useSharedTexture`** (that's what makes its `paint` event hand you a GPU frame).

- **Zero-copy.** Electron's offscreen `paint` event hands the main process a GPU **IOSurface handle**; we wrap it as a Metal texture and publish via `SyphonMetalServer`. **No pixel ever crosses IPC and nothing is read back to the CPU.**
- **Prebuilt.** Ships an N-API prebuilt binary (ABI-stable across Electron versions) and a vendored `Syphon.framework` — `npm install` needs no Xcode.
- **Fast.** ~0.13 ms/frame to publish at 1080p (≈40× real-time at 60 fps); 3–5× faster than the CPU-readback approach. See [Performance](#performance).

> **How is this different from [`node-syphon`](https://github.com/benoitlahoz/node-syphon)?** node-syphon is a fuller, two-way binding (it can *receive* Syphon too). Its *typical* Electron setup ships pixel buffers renderer→main over IPC every frame — that path does a GPU→CPU readback and leaks ([#45](https://github.com/benoitlahoz/node-syphon/issues/45), still open). But node-syphon *can* also publish a GPU handle directly (`publishSurfaceHandle`), so the core difference isn't the data path — it's ergonomics: `electron-syphon` runs the server in the **main process** through **`SyphonMetalServer`** (not OpenGL in a worker thread), ships a **prebuilt N-API binary + vendored framework** (no Xcode, no source build), and hides it all behind one call, `attach(webContents)`. If you need Syphon *input* or non-Electron use, reach for node-syphon. Full side-by-side in [`METHODOLOGY.md`](METHODOLOGY.md).

## Quick start

**See it working in 30 seconds** — clone this repo and run a minimal example:

```bash
git clone <this repo> && cd electron-spout/examples
npm install
npm run webgl      # also: simple-window · webgpu · multi-window · frame-test · single-render · planetary-room · signal-delay
```

A window appears; open a Syphon client (Resolume, MadMapper, VDMX, or [Syphon Recorder](https://syphon.github.io/)) and pick the `electron-syphon webgl` source. [`examples/`](examples/) has one tiny self-contained folder per scenario — `simple-window/`, `webgl/`, `webgpu/`, `multi-window/` — each in TypeScript.

**Add it to your own app** → [`npm install electron-syphon`](#install) and [10 lines of wiring](#usage); full walkthrough in [`INTEGRATION.md`](INTEGRATION.md). For a feature-complete reference app (every capture method, live controls, multi-output, a built-in test+benchmark), see [`examples/full-demo/`](examples/full-demo/).

**Want to know how it works?** [`METHODOLOGY.md`](METHODOLOGY.md) walks the zero-copy pipeline end to end and compares it, honestly, to every other way people get Electron output into Syphon.

## Install

```bash
npm install electron-syphon
```

macOS 11+. Electron is a peer dependency; **Electron 33+** for the zero-copy path (it falls back to a CPU bitmap on older/unsupported setups). The vendored `Syphon.framework` is bundled; see [Packaging](#packaging) for shipping it in your built app.

## Usage

`SyphonOutput.attach(webContents)` listens to the `paint` event and publishes each frame. Use it with a hidden **offscreen** window that renders whatever you want to broadcast:

```ts
import { app, BrowserWindow } from 'electron'
import { SyphonOutput, listServers } from 'electron-syphon'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      offscreen: { useSharedTexture: true }, // zero-copy GPU path
      backgroundThrottling: false            // keep painting while hidden
    }
  })
  win.webContents.setFrameRate(60)

  const out = new SyphonOutput('My App')
  out.attach(win.webContents, { width: 1280, height: 720 }) // render + publish at 720p

  win.loadURL('https://example.com/visuals')
})

// out.setResolution(960, 540)  // render + publish at a fixed size (see Performance knobs)
// out.resolution               // { width, height } you asked for (null = window's natural size)
// out.flipY = false            // ~33% faster, but pre-flip your content (see Performance knobs)
// out.pause() / out.resume()   // fully suspend rendering (offscreen → 1 fps) + publishing
// out.enabled = false   // stop publishing only (window keeps rendering at full rate)
// out.hasClients        // is a Syphon client connected?
// out.frames / out.publishMsEMA / out.outWidth / out.outHeight   // live stats
// out.dispose()
// listServers()         // every Syphon server on the machine
```

Don't call `app.disableHardwareAcceleration()` — the shared-texture path needs the GPU.

### Low-level API

`SyphonServer` (the native class) is also exported if you want to drive it yourself:

```ts
import { SyphonServer } from 'electron-syphon'
const s = new SyphonServer('My Server')
s.publishSurface(ioSurfaceHandle, w, h, flipY)              // zero-copy (sync)
s.publishSurfaceAsync(ioSurfaceHandle, w, h, flipY); s.reap() // zero-copy (pipelined)
s.publishImageBuffer(rgbaOrBgraBuffer, w, h, 'rgba', flipY) // CPU
s.hasClients; s.name; s.dispose()
```

A **`SyphonClient`** (receiver) is also exported — handy for tests, monitors, or building a Syphon viewer. It connects to a server by name and pulls frames:

```ts
import { SyphonClient } from 'electron-syphon'
const c = new SyphonClient('Resolume - Composition')
c.isValid                       // connected?
const f = c.receive(true)       // sample only: { hasFrame, width, height, nonBlack, r, g, b, a }
const full = c.receiveFrame()   // full frame: { hasFrame, width, height, pixels } (RGBA, a GPU→CPU readback)
c.hasNewFrame; c.dispose()
```

The example app's test suite uses it to verify frames are actually *received* end-to-end (publish → Syphon → receive → sample a pixel), not just that a server exists. `receiveFrame()` (full RGBA pixels) lets you build a **live monitor** — a window that displays exactly what you're publishing by receiving it back, so "what's on screen" *is* "what's sent" rather than a second, independent render. See [`examples/single-render/`](examples/single-render/).

## Performance knobs: resolution and orientation

Two settings dominate everything else. The native publish itself is already ~0.06 ms/frame at 1080p (see [Performance](#performance)) — what you actually pay scales with **how many pixels you render** and **which orientation you ask Syphon for**. Tune these two before anything else.

### 1. Resolution — render exactly what you send

This library publishes *exactly what the offscreen window renders* — no scaling, no readback — so the published resolution **is** the render resolution. Rendering fewer pixels shrinks Syphon's per-frame blit, GPU/VRAM bandwidth, and shared-texture-pool pressure all at once. It's the single biggest lever, and it compounds across many windows.

```ts
const out = new SyphonOutput('My App')
out.attach(win.webContents, { width: 1280, height: 720 }) // render + publish at 720p

out.setResolution(960, 540) // …or change it at runtime
out.resolution              // { width: 960, height: 540 }
out.outWidth / out.outHeight // what's *actually* being published
```

`setResolution` resizes the offscreen window to render at that exact size. **For the output to match what you ask for, create the window with `deviceScaleFactor: 1`** (Electron 42+) — otherwise a Retina display silently renders at 2× (a 1280×720 request becomes a 2560×1440 surface, 4× the work, which is what collapses many-window setups to ~2 fps). A one-time warning fires if the published size doesn't match the request.

```ts
const win = new BrowserWindow({
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, // ← render at the size you ask for
    backgroundThrottling: false
  }
})
```

Rule of thumb: **render at the resolution your Syphon consumer actually needs, not the display's.** If a client only composites your feed at 720p, sending 4K is pure waste. (If the `webContents` isn't owned by a `BrowserWindow`, size the window/view yourself — published size always equals rendered size.)

### 2. Orientation — `flipY = false` is ~33% faster

Syphon has two paths: a straight GPU blit (`flipped:NO`) and a sampled redraw (`flipped:YES`). The redraw is **~33% costlier** — the single largest *controllable* delta in the pipeline. `flipY` defaults to `true` because Electron OSR frames are top-left origin while most Syphon clients expect bottom-left. But if you **pre-flip your content**, you can take the fast blit path:

```ts
out.flipY = false // fast path — you now flip your content yourself
```

Flip in whatever you render so the frame is already bottom-left before it reaches Syphon:

```glsl
// WebGL / GLSL — flip clip-space Y (or invert the V texcoord when sampling):
gl_Position = vec4(pos.x, -pos.y, pos.z, 1.0);
```

```js
// Canvas 2D — flip the context once, then draw normally:
ctx.translate(0, canvas.height); ctx.scale(1, -1)
```

```js
// Three.js — flip the camera's Y (or set flipY on the texture you render):
camera.projectionMatrix.elements[5] *= -1
```

```css
/* DOM / CSS — flip the broadcast root element: */
#broadcast { transform: scaleY(-1); }
```

If you can't pre-flip (broadcasting arbitrary DOM, a `<video>`, etc.), leave `flipY = true` and pay the redraw — correct orientation beats the 33%.

## Example app

`examples/full-demo/` is a full electron-vite + React demo showing **many ways** to publish, each as its own Syphon server so you can compare them live:

| method | how | speed |
|---|---|---|
| **Zero-copy** | offscreen `useSharedTexture` → `publishSurface` | fastest |
| **CPU bitmap** | offscreen (no shared texture) → paint bitmap → `publishImageBuffer` | slower |
| **Canvas readback** | renderer `getImageData()` → IPC → `publishImageBuffer` | slowest (node-syphon's *common* path) |
| **Composite** | one offscreen window renders a 2×2 grid → **one** Syphon server | cheap fan-out |

…each driven by a selectable **canvas2D / WebGL / WebGPU** source, with live controls for **output scale** (`deviceScaleFactor`), **frame rate** (incl. 120/240), and **N extra outputs**.

```bash
cd examples/full-demo
npm install      # links electron-syphon from ../..
npm run dev      # control panel + the broadcast windows
npm run test     # headless: verifies every method is published AND received
```

### Multiple outputs (multiple windows + multiple Syphon servers)

Each offscreen window gets its own `SyphonOutput` → its own server, so a client sees them as distinct sources. On an M-series Mac at 720p this scales to **24+ simultaneous windows/servers at 60 fps** — *if* you avoid the traps:

- Keep resolution modest: create each window with `offscreen.deviceScaleFactor: 1` and set the exact size with `out.setResolution(w, h)` (or `attach(wc, { width, height })`). The old 4× Retina overdraw is what collapses many windows to ~2 fps — see [Performance knobs](#performance-knobs-resolution-and-orientation).
- Do **not** add `--disable-gpu-vsync` / `--disable-frame-rate-limit` — they make every window render unbounded and exhaust the IOSurface pools (`Failed to allocate IOSurface`). The benign `disable-renderer-backgrounding` / `disable-backgrounding-occluded-windows` are fine and prevent hidden-window throttling.
- For **many** regions that don't each need separate routing, use the **composite** pattern (one window, tiled layout, one server, one IOSurface pool) instead of N windows.

## Performance

`npm run bench` times the exact native publish path, isolated from Electron (Apple Silicon, arm64):

| resolution | zero-copy (sync) | zero-copy (async) | CPU buffer (sync) |
|---|---:|---:|---:|
| 1280×720 | 0.27 ms · 3.7k fps | 0.04 ms · 23k fps | 0.59 ms · 1.7k fps |
| 1920×1080 | 0.36 ms · 2.8k fps | 0.06 ms · 18k fps | 1.01 ms · 1.0k fps |
| 3840×2160 | 0.93 ms · 1.1k fps | 0.19 ms · 5.4k fps | 3.38 ms · 0.3k fps |

- **async pipeline** (`SyphonOutput.async`, default on) submits without blocking the main thread and releases the Electron texture a frame later — in the live app this drops main-thread cost from ~1.4 ms to ~0.13 ms/frame (~10×).
- **zero-copy beats CPU** ~2.8× at 1080p and ~3.6× at 4K on the directly-comparable *sync* columns (the *async* advantage is much larger); the gap widens with resolution (GPU blit vs. memory-bandwidth-bound upload). Counting the readback + IPC that the CPU-readback approach also pays, the real-world margin is bigger still.
- the texture wrapping Electron's rotating IOSurface pool is **cached**; publishing skips entirely when **no client** is attached.

## Packaging

`electron-builder` needs to ship the framework and unpack the addon. In your app's config:

```yaml
asarUnpack:
  - '**/node_modules/electron-syphon/prebuilds/**'
mac:
  extraFiles:
    - from: node_modules/electron-syphon/Frameworks/Syphon.framework
      to: Frameworks/Syphon.framework
```

The addon's `@executable_path/../Frameworks` rpath then resolves to `Contents/Frameworks` at runtime. For a notarized release, re-sign the framework with your identity (or grant `com.apple.security.cs.disable-library-validation`).

## Caveats

- **`useSharedTexture` placement:** it must be nested — `offscreen: { useSharedTexture: true }`. `offscreen: true, useSharedTexture: true` silently uses the CPU path.
- **Orientation:** `flipY` defaults to `true` (right-side-up in most clients). `flipY = false` is ~33% faster (Syphon's pure-blit fast path) but may appear upside-down unless you pre-flip your content — see [Performance knobs](#performance-knobs-resolution-and-orientation).
- **Retina / resolution:** on Electron < 42 an offscreen window renders at the display's scale factor, so a 1280×720 window yields a 2560×1440 IOSurface (4× the work). Electron 42's `offscreen.deviceScaleFactor: 1` fixes it; then `setResolution(w, h)` controls the published size exactly. `outWidth`/`outHeight` report the real published size. See [Performance knobs](#performance-knobs-resolution-and-orientation).
- **No keyed mutex:** Syphon (unlike Spout on Windows) doesn't lock writer vs. reader on the shared surface, so under heavy load a client *can* momentarily sample a partially-written frame. It's rare and transient — there's no per-frame fence to coordinate — but it's why Syphon trades a sync primitive for raw speed.
- **Keep Electron current:** shared-texture OSR had a use-after-free in `texture.release()` (CVE-2026-34764) fixed in 39.8.5 / 40.8.5 / 41.1.0 / 42.0.0-alpha.5. This library releases promptly; still, prefer a patched Electron.

## Building from source

```bash
npm run make-library          # framework + dist + prebuilds + verify
npm run make-library --pack    # also produce the publishable .tgz
./scripts/build-syphon-framework.sh   # rebuild the vendored framework (universal: ARCHS="arm64 x86_64")
```

## License

MIT. Bundles [Syphon-Framework](https://github.com/Syphon/Syphon-Framework) (BSD, bangnoise & vade). Prior art: [`vcync/electron-syphon`](https://github.com/vcync/electron-syphon), [`benoitlahoz/node-syphon`](https://github.com/benoitlahoz/node-syphon). Electron OffscreenSharedTexture by reitowo / Renaud Rohlinger.
