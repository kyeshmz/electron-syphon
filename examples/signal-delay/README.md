# signal-delay — a telematic split-screen for distributed performers

```
npm run signal-delay            # 3 performers (default)
N=4 npm run signal-delay        # any N
```

One **offscreen WebRTC portal window per remote performer**, each published as
its own named Syphon source:

```
signal-delay · portal #1
signal-delay · portal #2
signal-delay · portal #3
```

This is the architecture TouchDesigner can't give you: N independent WebRTC
compositors, each compositing a live remote video + a broadcast overlay, each
published **zero-copy** as a distinct Syphon source you can route, mix, and
re-key separately downstream.

## What you see

- **operator** window (visible, **not** published) — a dashboard of the N
  portal source names and their live WebRTC connection states.
- The portals are **offscreen**. To watch them, open any Syphon client — a
  Simple Client, or in TouchDesigner a `Syphon Spout In` TOP per source — and
  you'll see a full-bleed remote performer with a "PERFORMER #k" overlay, a
  city, a green **LIVE** dot, and a 1 Hz latency/jitter readout from
  `RTCPeerConnection.getStats()`.

## Self-contained, tokenless, zero-network

There is no real camera, phone, STUN, or TURN. A single hidden **sender**
window simulates the N remote performers: for each portal it animates a
Canvas2D scene, turns it into a live `MediaStream` via `canvas.captureStream(30)`,
and pushes it over a real `RTCPeerConnection` to that portal. Signaling is pure
**loopback through the main process** (`ipcRenderer`/`ipcMain` relay, routed by
peer id). ICE uses host candidates on `localhost`, so `iceServers: []` and it
runs with the network fully offline.

The offscreen portal composites the incoming `<video>` (drawn to a `<canvas>`
each `requestAnimationFrame` — the robust path for OSR capture) plus the
overlay, and electron-syphon publishes exactly that.

## Files

- `main.ts` — spawns N offscreen portals + 1 hidden sender + 1 visible
  operator; wires the `ipcMain` signaling relay (routes by peer id); disposes
  the Syphon outputs on `before-quit`. Includes an in-process `SyphonClient`
  self-check that logs `nonBlack` on portal #1.
- `sender.html` — simulated performers (one animated `captureStream` + one
  `RTCPeerConnection` each); the **offerer**.
- `portal.html` — offscreen compositor; the **answerer**; `ontrack` →
  `<video>` → drawn full-bleed to canvas + overlay; live `getStats()` readout.
- `operator.html` — the visible dashboard (not published).

## Real-phone path (optional, off the critical path)

The synthetic senders are the default and need zero network. To bring a **real
phone** in as performer #(N+1):

1. Start a tiny LAN page from `main.ts` using Node's built-in `http` (no deps),
   serving a one-file `getUserMedia()` + `RTCPeerConnection` sender. Print the
   `http://<your-LAN-ip>:<port>` URL (and optionally a QR rendered as ASCII or
   a data-URI) to the console / operator window.
2. Reuse the **same** `ipcMain` signaling relay over a WebSocket (or long-poll)
   instead of `ipcRenderer`, keying the phone as a new peer id.
3. Because a phone is off-host, that path needs real ICE — add a public STUN
   server (`stun:stun.l.google.com:19302`) so host/srflx candidates can pair.

Keep this **optional and disabled by default**: the synthetic loopback path
must remain the thing that runs everywhere, offline, with no keys.
