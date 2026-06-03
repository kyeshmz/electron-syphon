// Texture-passing throughput benchmark.
//
// Runs the EXACT production publish path (PublishSurfaceCore / PublishImageCore)
// in a tight loop against a real IOSurface / pixel buffer, with no Electron
// renderer in the way — so the numbers reflect how fast we can hand textures to
// Syphon, isolated from how fast a page happens to paint.
//
// Run:  npm run bench          (uses Electron's ABI build of the addon)
//   or: ./node_modules/.bin/electron test/bench.js
//
// "sync" = each publish waits for GPU completion (the safe, race-free production
// default, required so Electron can immediately recycle its IOSurface).
// "async" = submit-only throughput (GPU drained once at the end) — shows the
// headroom the per-frame wait costs us.
const path = require('path')
// Resolve the prebuilt (or freshly-built) addon exactly like the library does.
const addon = require('node-gyp-build')(path.join(__dirname, '..'))

const RESOLUTIONS = [
  { w: 640, h: 360, iters: 1000 },
  { w: 1280, h: 720, iters: 600 },
  { w: 1920, h: 1080, iters: 400 },
  { w: 2560, h: 1440, iters: 250 },
  { w: 3840, h: 2160, iters: 120 }
]

function run() {
  const server = new addon.SyphonServer('electron-spout bench')
  const rows = []
  for (const { w, h, iters } of RESOLUTIONS) {
    for (const mode of ['surface', 'image']) {
      for (const wait of [true, false]) {
        const r = server.benchmark({ width: w, height: h, iterations: iters, mode, wait })
        rows.push(r)
      }
    }
  }
  server.dispose()

  const pad = (s, n) => String(s).padEnd(n)
  const padL = (s, n) => String(s).padStart(n)
  console.log('\nelectron-spout — Syphon texture-passing benchmark')
  console.log(`device: ${process.platform}/${process.arch}  electron: ${process.versions.electron || 'n/a'}\n`)
  console.log(
    pad('Resolution', 12) + pad('MP', 6) + pad('Path', 11) + pad('Sync', 7) +
    padL('avg ms', 9) + padL('fps', 9) + padL('GB/s', 9)
  )
  console.log('-'.repeat(63))
  let lastKey = ''
  for (const r of rows) {
    const key = `${r.width}x${r.height}`
    const res = key === lastKey ? '' : key
    lastKey = key
    console.log(
      pad(res, 12) +
        pad(res ? r.megapixels.toFixed(1) : '', 6) +
        pad(r.mode === 'surface' ? 'IOSurface' : 'CPU buf', 11) +
        pad(r.wait ? 'sync' : 'async', 7) +
        padL(r.avgMs.toFixed(3), 9) +
        padL(r.fps.toFixed(0), 9) +
        padL(r.throughputGBps.toFixed(1), 9)
    )
  }
  const hd = rows.find((r) => r.width === 1920 && r.mode === 'surface' && r.wait)
  if (hd) {
    console.log(
      `\n→ Headline: zero-copy 1080p publish costs ${hd.avgMs.toFixed(2)} ms/frame ` +
        `(${hd.fps.toFixed(0)} fps ceiling) — ~${(hd.fps / 60).toFixed(0)}× real-time @60fps.`
    )
  }
  console.log(
    '\nIOSurface = zero-copy path used with Electron useSharedTexture (a new\n' +
    'MTLTexture is wrapped around the surface each frame, then blitted by Syphon).\n' +
    'CPU buf = fallback path (replaceRegion upload into a reused texture).\n'
  )
}

if (process.versions.electron) {
  const { app } = require('electron')
  app.disableHardwareAcceleration() // we only need Metal compute, no compositor
  app
    .whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((e) => {
      console.error(e)
      app.exit(1)
    })
} else {
  run()
}
