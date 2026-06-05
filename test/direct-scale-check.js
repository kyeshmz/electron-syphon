// Verify DirectServer outputScale: a 2x2 grid of distinct colors published at
// 0.5 scale must yield a half-size surface with the 4 colors in the right
// quadrants (downscaled, still correct).
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW=256, TH=256, AW=TW*2, AH=TH*2, SCALE=0.5, NAME='direct-scale-check'
  const srv = new addon.DirectServer(NAME, SCALE)
  const mk=(r,g,b)=>addon.__makeTestSurface(TW,TH,r,g,b)
  const grid=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]]
  const tiles=grid.map((c,i)=>({handle:mk(...c),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  for(let i=0;i<6;i++){srv.publishAtlas(tiles,AW,AH,false,true);srv.drain();await sleep(15)}

  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(100)}}
  if(!client){console.error('FAIL: no client');process.exitCode=1;return}
  let frame=null
  for(let i=0;i<80&&!frame;i++){srv.publishAtlas(tiles,AW,AH,false,true);srv.drain();const f=client.receiveFrame();if(f.hasFrame&&f.pixels)frame=f;else await sleep(20)}
  if(!frame){console.error('FAIL: no frame');process.exitCode=1;return}
  const {width:w,height:h,pixels}=frame
  const expW=Math.round(AW*SCALE), expH=Math.round(AH*SCALE)
  console.log(`received ${w}x${h} (expected ${expW}x${expH})`)
  const at=(x,y)=>{const i=(y*w+x)*4;return[pixels[i],pixels[i+1],pixels[i+2]]}
  const near=(a,b)=>Math.abs(a-b)<=16
  let ok = (w===expW && h===expH)
  // quadrant centers in the downscaled surface
  const qpts=[[w*0.25,h*0.25],[w*0.75,h*0.25],[w*0.25,h*0.75],[w*0.75,h*0.75]]
  for(let q=0;q<4;q++){const g=at(qpts[q][0]|0,qpts[q][1]|0);const e=grid[q];const p=near(g[0],e[0])&&near(g[1],e[1])&&near(g[2],e[2]);ok=ok&&p;console.log(`  quad${q} exp ${e} got ${g} ${p?'OK':'MISMATCH'}`)}
  client.dispose(); srv.dispose()
  if(ok)console.log('\nPASS: downscaled composite has correct size and quadrants')
  else{console.error('\nFAIL');process.exitCode=1}
}
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
