const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
function run() {
  const GRIDS = [[2,2],[3,3],[4,4],[5,5]]
  const tileW = 1280, tileH = 720, iters = 200
  console.log(`\nMulti-output scaling — tile ${tileW}x${tileH}, async, flip=true`)
  console.log('outputs\ttotalMP\tmode     \tframeMs\tperTileMs\tgridFps')
  for (const [cols, rows] of GRIDS) {
    const res = {}
    for (const mode of ['multi','atlas','composite']) {
      const r = addon.benchmarkScaling({ width: tileW, height: tileH, cols, rows, iterations: iters, mode, wait: false, flip: true })
      res[mode] = r
      console.log(`${r.outputs}\t${r.totalMegapixels.toFixed(1)}\t${mode.padEnd(9)}\t${r.avgMs.toFixed(3)}\t${r.perTileMs.toFixed(4)}\t${r.fps.toFixed(0)}`)
    }
    console.log(`\t\t→ atlas ${(res.multi.avgMs/res.atlas.avgMs).toFixed(2)}x faster than multi; composite(ceiling) ${(res.multi.avgMs/res.composite.avgMs).toFixed(2)}x\n`)
  }

  // Partial-update win: the persistent atlas re-blits only the tiles that
  // changed this frame (CompositeSyphonOutput only sends dirty slots). On a wall
  // where few windows repaint per frame this is the dominant lever.
  console.log(`Partial-update atlas — only N of the grid's tiles change per frame (async, flip)`)
  console.log('outputs\tdirty\tframeMs\tfps\tvs all-dirty')
  for (const [cols, rows] of [[4,4],[5,5]]) {
    const n = cols * rows
    const all = addon.benchmarkScaling({ width: tileW, height: tileH, cols, rows, iterations: 400, mode: 'atlas', wait: false, flip: true, dirtyPerFrame: n })
    for (const dirty of [n, Math.ceil(n/2), 4, 1]) {
      const r = addon.benchmarkScaling({ width: tileW, height: tileH, cols, rows, iterations: 400, mode: 'atlas', wait: false, flip: true, dirtyPerFrame: dirty })
      console.log(`${n}\t${dirty}\t${r.avgMs.toFixed(3)}\t${r.fps.toFixed(0)}\t${(all.avgMs/r.avgMs).toFixed(2)}x`)
    }
    console.log('')
  }

  // Ping-pong (double-buffered) atlas vs single buffer — ALL tiles change every
  // frame (live video wall). Two buffers remove the write-after-read hazard so
  // the next frame's blits overlap this frame's Syphon copy on the GPU.
  console.log(`Ping-pong atlas — all tiles change/frame, single vs double buffer (async, flip)`)
  console.log('outputs\tsingle\tdouble\tspeedup')
  for (const [cols, rows] of [[3,3],[4,4],[5,5]]) {
    const n = cols * rows
    const r1 = addon.benchmarkScaling({ width: tileW, height: tileH, cols, rows, iterations: 500, mode: 'atlas', wait: false, flip: true, atlasBuffers: 1 })
    const r2 = addon.benchmarkScaling({ width: tileW, height: tileH, cols, rows, iterations: 500, mode: 'atlas', wait: false, flip: true, atlasBuffers: 2 })
    console.log(`${n}\t${r1.avgMs.toFixed(3)}\t${r2.avgMs.toFixed(3)}\t${(r1.avgMs / r2.avgMs).toFixed(2)}x`)
  }
}
if (process.versions.electron) {
  const {app}=require('electron'); app.disableHardwareAcceleration()
  app.whenReady().then(run).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)})
} else run()
