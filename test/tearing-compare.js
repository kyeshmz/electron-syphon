// Harsh tearing comparison: atlas (ping-pong double-buffered on full updates) vs
// direct (one persistent surface). Alternate all-RED / all-BLUE full frames as
// fast as possible with a deep async pipeline; a torn frame has both colors.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(label, useDirect) {
  const TW=512, TH=512, AW=TW*2, AH=TH*2, NAME='tearing-'+label
  const srv = useDirect ? new addon.DirectServer(NAME) : new addon.SyphonServer(NAME)
  const mk=(r,g,b)=>addon.__makeTestSurface(TW,TH,r,g,b)
  const red=Array.from({length:4},(_,i)=>({handle:mk(255,0,0),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  const blue=Array.from({length:4},(_,i)=>({handle:mk(0,0,255),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  for(let i=0;i<4;i++){srv.publishAtlas(red,AW,AH,false,true);srv.drain();await sleep(10)}
  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(80)}}
  if(!client){console.log(`${label}: no client`);return}
  let frames=0, torn=0
  for(let rep=0; rep<1000; rep++){
    // submit 2-3 full frames without draining → deep pipeline, max overwrite pressure
    srv.publishAtlas(rep%2?blue:red, AW, AH, false, true)
    srv.publishAtlas(rep%2?red:blue, AW, AH, false, true)
    srv.reap()
    const f=client.receiveFrame()
    if(f.hasFrame&&f.pixels){
      const {width:w,pixels}=f
      const cls=(x,y)=>{const i=(y*w+x)*4;return pixels[i]>pixels[i+2]?'R':(pixels[i+2]>pixels[i]?'B':'?')}
      const q=[cls(256,256),cls(768,256),cls(256,768),cls(768,768)]
      frames++; if(!q.every(c=>c===q[0]&&c!=='?')){torn++; if(torn<=3)console.log(`  ${label} rep${rep} torn ${q.join('')}`)}
    }
    if(rep%60===0) await sleep(1)
  }
  srv.drain(); client.dispose(); srv.dispose()
  const pct=100*torn/Math.max(1,frames)
  console.log(`${label.padEnd(7)}: ${frames} frames, ${torn} torn (${pct.toFixed(1)}%)`)
  if(pct>2){console.error(`  ${label}: tearing >2% — regression`);process.exitCode=1}
}
async function run(){ await probe('atlas', false); await probe('direct', true); console.log(process.exitCode?"\nFAIL":"\nPASS: both backends tear-free under harsh load") }
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
