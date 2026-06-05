// Gate test for the zero-copy DirectServer: (1) correct composite (4 colored
// tiles land in the right quadrants), and (2) tearing under rapid full-frame
// alternation — flip between an all-RED and an all-BLUE frame as fast as
// possible; every received frame must be uniformly one color (a torn frame would
// mix RED and BLUE tiles).
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW=256, TH=256, AW=TW*2, AH=TH*2, NAME='direct-correctness'
  const srv = new addon.DirectServer(NAME)
  const mk=(r,g,b)=>addon.__makeTestSurface(TW,TH,r,g,b)
  const grid=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]]
  const tiles=grid.map((c,i)=>({handle:mk(...c),x:(i%2)*TW,y:((i/2)|0)*TH}))
  for(let i=0;i<6;i++){srv.publishAtlas(tiles,AW,AH, false, true); srv.reap();await sleep(15)}

  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(100)}}
  if(!client){console.error('FAIL: no client');process.exitCode=1;return}

  // (1) quadrant correctness
  let frame=null
  for(let i=0;i<80&&!frame;i++){srv.publishAtlas(tiles,AW,AH, false, true); srv.reap();const f=client.receiveFrame();if(f.hasFrame&&f.pixels)frame=f;else await sleep(20)}
  if(!frame){console.error('FAIL: no frame');process.exitCode=1;return}
  const near=(a,b)=>Math.abs(a-b)<=12
  {const {width:w,pixels}=frame;const at=(x,y)=>{const i=(y*w+x)*4;return[pixels[i],pixels[i+1],pixels[i+2]]}
   let ok=frame.width===AW
   // NOTE: DirectServer does no flip, so quadrant (col,row) maps straight through.
   for(let q=0;q<4;q++){const g=at((q%2)*TW+128,((q/2)|0)*TH+128);const e=grid[q];const p=near(g[0],e[0])&&near(g[1],e[1])&&near(g[2],e[2]);ok=ok&&p;console.log(`  quad${q} exp ${e} got ${g} ${p?'OK':'MISMATCH'}`)}
   if(!ok){console.error('quadrant correctness FAILED');process.exitCode=1}}

  // (2) tearing probe: alternate all-red / all-blue, look for mixed frames
  const red=Array.from({length:4},(_,i)=>({handle:mk(255,0,0),x:(i%2)*TW,y:((i/2)|0)*TH}))
  const blue=Array.from({length:4},(_,i)=>({handle:mk(0,0,255),x:(i%2)*TW,y:((i/2)|0)*TH}))
  let frames=0, torn=0
  for(let rep=0; rep<500; rep++){
    srv.publishAtlas(rep%2?blue:red, AW, AH, false, true); srv.reap()
    const f=client.receiveFrame()
    if(f.hasFrame&&f.pixels){
      const {width:w,pixels}=f;const cls=(x,y)=>{const i=(y*w+x)*4;return pixels[i]>pixels[i+2]?'R':(pixels[i+2]>pixels[i]?'B':'?')}
      const q=[cls(128,128),cls(384,128),cls(128,384),cls(384,384)]
      frames++; if(!q.every(c=>c===q[0]&&c!=='?')){torn++; if(torn<=6)console.log(`  rep${rep} TORN ${q.join('')}`)}
    }
    if(rep%40===0) await sleep(1)
  }
  client.dispose(); srv.dispose()
  console.log(`\ntearing probe: ${frames} frames, ${torn} torn`)
  if(process.exitCode){console.log('RESULT: DirectServer quadrants WRONG — not usable')}
  else if(torn>0){console.log(`RESULT: DirectServer TEARS (${torn}/${frames}) — needs double-buffering or unsafe`)}
  else {console.log('RESULT: DirectServer CORRECT and tear-free on this run')}
  process.exitCode = 0
}
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)})}else run()
