const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname,'..'))
function run() {
  const tileW=1280, tileH=720, iters=600
  console.log('directflip CPU-encode vs total (async throughput) — where does the time go?')
  console.log('outputs\ttotal/frame\tCPU-encode\tGPU-bound?')
  for (const [cols,rows] of [[3,3],[4,4],[5,5]]) {
    const n=cols*rows
    addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:50,mode:'directflip',wait:false,flip:true}) //warm
    const r = addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:iters,mode:'directflip',wait:false,flip:true})
    const cpu=r.cpuEncodeMsPerFrame, tot=r.avgMs
    console.log(`${n}\t${tot.toFixed(3)}\t${cpu.toFixed(3)} (${(100*cpu/tot).toFixed(0)}%)\t${cpu/tot<0.3?'GPU-bound (floor)':'CPU-bound (N-texture binding — irreducible, measured)'}`)
  }
}
if (process.versions.electron){const {app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)})}else run()
