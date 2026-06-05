// Cumulative win: naive (one Syphon server per window, full res, all redrawn)
// vs the optimized composite stack (direct zero-copy + sparse partial updates +
// downscaled output), at a realistic 16-window wall. Shows how the levers stack.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname,'..'))
function run() {
  const tileW=1280, tileH=720, cols=4, rows=4, n=cols*rows, iters=400
  const B=(mode,opts={})=>addon.benchmarkScaling({width:tileW,height:tileH,cols,rows,iterations:iters,mode,wait:false,flip:true,...opts})
  // warm
  B('multi'); B('directflip',{outputScale:0.5,dirtyPerFrame:2})
  const naive = B('multi').avgMs                                   // one server/window
  const atlas = B('atlas').avgMs                                   // composite atlas
  const direct = B('directflip').avgMs                            // + zero-copy
  const directSparse = B('directflip',{dirtyPerFrame:2}).avgMs    // + partial (2/16 change)
  const full = B('directflip',{dirtyPerFrame:2,outputScale:0.5}).avgMs // + downscale to half
  const f=x=>x.toFixed(3)
  console.log(`\nCumulative composite stack — ${n} windows @ ${tileW}x${tileH}, per grid-frame:\n`)
  console.log(`  naive (server/window, all redrawn)   ${f(naive)} ms   1.0x   ${(1000/naive).toFixed(0)} fps`)
  console.log(`  + atlas composite                    ${f(atlas)} ms   ${(naive/atlas).toFixed(1)}x`)
  console.log(`  + direct zero-copy                   ${f(direct)} ms   ${(naive/direct).toFixed(1)}x`)
  console.log(`  + partial (2 of 16 tiles change)     ${f(directSparse)} ms   ${(naive/directSparse).toFixed(1)}x`)
  console.log(`  + outputScale 0.5 (wall shown small) ${f(full)} ms   ${(naive/full).toFixed(0)}x   ${(1000/full).toFixed(0)} fps`)
  console.log(`\n  → full optimized stack is ${(naive/full).toFixed(0)}x faster than naive for this realistic wall.\n`)
}
if (process.versions.electron){const {app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)})}else run()
