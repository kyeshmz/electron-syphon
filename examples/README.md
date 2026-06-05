# electron-syphon examples

Minimal examples, **one folder per scenario**. Each folder is a tiny, self-contained Electron app that renders something and publishes it to **Syphon**. Every example is written in **TypeScript** (compiled with `tsc`, then run).

```
examples/
  simple-window/    one window → one Syphon server (2D canvas)
  webgl/            a WebGL shader
  webgpu/           a WebGPU scene
  p5js/             a p5.js sketch (flow field), vendored p5 — runs offline
  multi-window/     N windows → N Syphon servers at once
  composite-wall/   N windows → ONE Syphon server (a video wall, 1.5–10× faster)
  frame-test/       render → freeze → prove the SENT frame == the RECEIVED frame
  single-render/    ONE render; the visible window monitors its own Syphon output
  planetary-room/   a live geospatial control room → 4 independent Syphon feeds
  signal-delay/     N WebRTC peers → N Syphon sources (telematic split-screen)
  full-demo/        the complete reference app (see below)
```

The small folders above share one `package.json` / `npm install`. **`full-demo/`** is its own standalone electron-vite + React app (own `package.json`) — a feature-complete playground with every capture method, live controls (scale, fps, multi-output, composite), and a built-in `npm test` that verifies each mode is published *and received*. Run it on its own:

```bash
cd full-demo && npm install && npm run dev
```

Each folder contains:
- `index.html` — the thing being rendered (plain HTML/JS, runs in the renderer),
- `main.ts` — the Electron main process (TypeScript).

(`single-render`, `planetary-room`, and `signal-delay` have several HTML files instead — one per window/source: a monitor, the four geo views, the WebRTC portal/sender, etc.)

## Run

```bash
cd examples
npm install            # Electron + links electron-syphon from ../

# each script runs `tsc` then launches the compiled app from dist/:
npm run simple-window
npm run webgl
npm run webgpu
npm run p5js
npm run multi-window   # N=8 npm run multi-window  to fan out further
npm run composite-wall # N windows composited into ONE Syphon server (video wall); N=9 to grow the grid
npm run frame-test     # render → freeze → verify the SENT frame == the RECEIVED frame
npm run single-render  # ONE render; the visible window monitors its own Syphon output
npm run planetary-room # 4 live geospatial feeds (globe / radar / quakes / telemetry)
npm run signal-delay   # N WebRTC performers, each its own Syphon source  (N=5 npm run signal-delay)
```

Each opens a small **preview window** (so you can see it) plus a hidden **offscreen window** that is what gets published. Then open a Syphon client — **Resolume, MadMapper, VDMX, TouchDesigner, or [Syphon Recorder](https://syphon.github.io/)** — and pick the source (e.g. `electron-syphon webgl`). `multi-window` opens N tiled previews and publishes `electron-syphon window #1 … #N`, each a distinct hue.

Every window shows a live **`FRAME` counter + timecode + fps** overlay (top-left). It's drawn into the page, so it appears in the Syphon output too — handy for spotting that the preview and the published stream are *independent renders* (the preview tracks your display's refresh; the publisher runs at `setFrameRate`, so their counters drift). The visible preview uses `backgroundThrottling: false` so it keeps full rate even when it isn't the focused window.

### `frame-test` — does the receiver get the frame we sent?

`npm run frame-test` proves end-to-end integrity. The page bakes its frame counter into the published pixels (`rgb(frame&255, frame>>8, 192)`); the test renders for a moment, **freezes**, then reads the frame number three ways — the on-screen preview, the offscreen publisher, and the number a `SyphonClient` **decodes from the received pixels** — and compares them:

```
  publisher (sent to Syphon):       #130
  decoded from Syphon client:       #130
  SENT vs RECEIVED (Syphon integrity):✓ EXACT MATCH (Δ0)
  RESULT:                           ✅ PASS — published frame == received frame
```

The publisher and the Syphon client match exactly (Δ0): the frame you publish *is* the frame Syphon delivers. The on-screen preview is a separate render and its counter will differ — that difference is the "looks faster/slower than what we send" effect, now made visible.

### `single-render` — one render, no parallel preview

The other examples render **twice**: a visible preview *and* a hidden offscreen publisher. They're independent renders, so what's on screen genuinely differs from what's sent (different rate, different frame number). `npm run single-render` removes the second render entirely:

- one **offscreen** window is the only render, published to Syphon;
- the **main process** receives that output back with a `SyphonClient` (`receiveFrame()`) and forwards the pixels to a visible window, which just draws them.

So the visible window shows the *exact* frames being sent (render → publish → receive → display — the same frame, round-tripped). It decodes the frame number from the received pixels and shows `RECEIVED #N`, which equals the publisher's `SENT #N`. Press **space** to pause publishing; the monitor freezes on the last sent frame.

> **Why receive in the main process?** A `SyphonClient` is Metal-based, and a sandboxed **renderer can't create a Metal device** — so receiving must happen in **main** (or a utility process), then the pixels go to the window over IPC. That monitor readback + IPC is a deliberate convenience for the preview; your real Syphon **output** is still published **zero-copy**. This is the pattern to use when "what I see must equal what I send."

### `planetary-room` — a live geospatial control room (4 feeds)

`npm run planetary-room` is the "things you can't do in TouchDesigner" example. One Electron process opens **four** offscreen windows → four named Syphon sources, each a different live web-native geospatial view:

- `planetary-room · orbit` — a rotating 3D globe (**three.js**, loaded from a CDN via an ESM import-map) plotting **live USGS earthquakes** at their lat/lon plus synthetic flight arcs (Canvas2D globe fallback if the CDN/network is down);
- `planetary-room · approach` — a city approach radar (range rings, sweep, easing inbound aircraft);
- `planetary-room · seismic` — an equirectangular world map with magnitude-sized quake pulses + a recent-events list;
- `planetary-room · telemetry` — a DOM/CSS dashboard with variable-font numerals and a live quake ticker.

The earthquake feed is real (`earthquake.usgs.gov`, no key, CORS); aircraft are synthetic (a comment shows how to swap in OpenSky). The visible operator window is a status console, **not** published. Why TD can't: its CEF Web Render TOP can't CORS-fetch a live GeoJSON feed, load three.js over a CDN, or render four HTML/CSS/WebGL geo views as four simultaneous Syphon outputs.

### `signal-delay` — N WebRTC performers, N Syphon sources

`npm run signal-delay` ( `N=5 npm run signal-delay` to add more ) shows the **one-offscreen-window-per-remote-peer** pattern. Each portal window holds its own `RTCPeerConnection`, receives a live video track, composites it with a broadcast overlay (`PERFORMER #k`, a city, a live latency/jitter readout from `getStats()`), and publishes it as `signal-delay · portal #k`. A hidden sender simulates the remote performers with synthetic `captureStream()` video, and **loopback signaling runs through the main process** (no STUN/TURN, no network) so it's fully self-contained. Real-phone wiring (LAN HTTP + WebSocket signaling) is documented in `signal-delay/README.md`. Why TD can't: it has no native WebRTC peer, and no way to materialize *N* live peers as *N* separately-routable GPU sources.

### `composite-wall` — N windows → ONE Syphon server (the fast wall)

`npm run composite-wall` ( `N=9 npm run composite-wall` to grow the grid ) is the **fast** way to build a video wall / multiview. `multi-window` publishes N *separate* servers (one per window — use it when a downstream app routes each source independently); `composite-wall` composites all N windows into **one** Syphon server with `CompositeSyphonOutput({ direct: true })`:

```ts
const wall = new CompositeSyphonOutput('electron-syphon wall', {
  direct: true, cols, rows, tileWidth: 1280, tileHeight: 720
})
wall.attach(publisher.webContents, { col, row })   // place each window in a grid cell
```

Every tile is blitted into the wall in **one GPU pass**, straight into Syphon's own surface (zero-copy) — **1.5–10× faster** than N publishes/frame, scaling linearly past 25 windows where the per-server pattern falls off a cliff. It only re-blits tiles whose source repainted this frame (the atlas keeps the rest), and `outputScale: 0.5` publishes the wall at half-res for ~4× less GPU work. Open one client and you get the whole `cols×rows` wall as a single source.

## The whole publish side

That's all there is to it (`simple-window/main.ts`):

```ts
import { app, BrowserWindow } from 'electron'
import { SyphonOutput } from 'electron-syphon'
import * as path from 'path'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    // deviceScaleFactor: 1 avoids 2× Retina overdraw (4× the work).
    webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false }
  })
  win.webContents.setFrameRate(60)
  new SyphonOutput('My Source').attach(win.webContents) // ← publishes every frame
  win.loadFile(path.join(__dirname, 'index.html'))
})
```

Point it at any page that renders and it gets published, zero-copy. See the repo root `README.md` for the full library API and `INTEGRATION.md` to add electron-syphon to your own app.
