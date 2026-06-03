// Smoke + leak test for the Syphon addon, runnable in plain node.
// (Self-discovery via listServers() only works inside Electron's CFRunLoop, so
//  here we focus on: construct, publish many frames, and verify RSS stays flat.)
const path = require('path')
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'syphon_addon.node'))

const W = 640, H = 360
const frame = Buffer.alloc(W * H * 4) // BGRA

function fill(t) {
  // cheap animated gradient so it's not all one color
  for (let i = 0; i < frame.length; i += 4) {
    const p = i / 4
    frame[i] = (p + t) & 0xff       // B
    frame[i + 1] = (p >> 2) & 0xff  // G
    frame[i + 2] = (t * 2) & 0xff   // R
    frame[i + 3] = 0xff             // A
  }
}

console.log('exports:', Object.keys(addon))
const server = new addon.SyphonServer('electron-spout smoke test')
console.log('server.name =', server.name, '| hasClients =', server.hasClients)

const N = 1000
global.gc && global.gc()
const rssStart = process.memoryUsage().rss
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  fill(i)
  server.publishImageBuffer(frame, W, H, 'bgra', true)
}
const ms = Date.now() - t0
global.gc && global.gc()
const rssEnd = process.memoryUsage().rss
const deltaMB = (rssEnd - rssStart) / 1048576

console.log(`published ${N} frames @ ${W}x${H} in ${ms}ms (${(N / (ms / 1000)).toFixed(0)} fps)`)
console.log(`RSS delta over ${N} frames: ${deltaMB.toFixed(1)} MB`)
// Old node-syphon would leak ~one ${(W*H*4/1048576).toFixed(2)}MB texture/frame
// = ${((W * H * 4 / 1048576) * N).toFixed(0)}MB. We expect a few MB at most.
const leakBudgetMB = 20
if (deltaMB > leakBudgetMB) {
  console.error(`LEAK SUSPECTED: grew ${deltaMB.toFixed(1)}MB (> ${leakBudgetMB}MB budget)`)
  process.exit(1)
}
console.log('OK: memory stayed flat — no per-frame texture leak.')
server.dispose()
