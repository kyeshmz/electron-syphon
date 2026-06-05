const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname,'..'))
function run() {
  const tileW=1280, tileH=720, iters=400
  console.log('Direct (zero-copy into server surface) vs atlas vs composite-ceiling (async, flip)')
  console.log('outputs\tatlas\tdirect\tspeedup\tcomposite(ceiling)')
  for (const [cols,rows] of [[2,2],[3,3],[4,4],[5,5]]) {
    const n=cols*rows
    const a = addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:iters,mode:'atlas',wait:false,flip:true}).avgMs
    const d = addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:iters,mode:'direct',wait:false,flip:true}).avgMs
    const c = addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:iters,mode:'composite',wait:false,flip:true}).avgMs
    console.log(`${n}\t${a.toFixed(3)}\t${d.toFixed(3)}\t${(a/d).toFixed(2)}x\t${c.toFixed(3)}`)
  }
}
if (process.versions.electron){const {app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)})}else run()
