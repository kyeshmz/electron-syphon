// Verify DirectServer partial updates preserve unchanged tiles: publish a full
// 2x2 grid of distinct colors, then publish ONLY the top-left changed to white;
// the other 3 must keep their colors (loadAction=Load + per-tile viewport).
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW=256, TH=256, AW=TW*2, AH=TH*2, NAME='direct-partial-check'
  const srv = new addon.DirectServer(NAME)
  const mk=(r,g,b)=>addon.__makeTestSurface(TW,TH,r,g,b)
  const grid=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]]
  const full=grid.map((c,i)=>({handle:mk(...c),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  // flipY=false so quadrant maps straight through
  for(let i=0;i<6;i++){srv.publishAtlas(full,AW,AH,false,true);srv.drain();await sleep(15)}

  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(100)}}
  if(!client){console.error('FAIL: no client');process.exitCode=1;return}

  // partial: only TL → white. fullUpdate=false (partial).
  const onlyTL=[{handle:mk(255,255,255),x:0,y:0,w:TW,h:TH}]
  let frame=null
  for(let i=0;i<80&&!frame;i++){srv.publishAtlas(onlyTL,AW,AH,false,false);srv.drain();const f=client.receiveFrame();if(f.hasFrame&&f.pixels)frame=f;else await sleep(20)}
  if(!frame){console.error('FAIL: no frame');process.exitCode=1;return}
  const {width:w,pixels}=frame
  const at=(x,y)=>{const i=(y*w+x)*4;return[pixels[i],pixels[i+1],pixels[i+2]]}
  const near=(a,b)=>Math.abs(a-b)<=12
  const checks=[
    {n:'TL changed→white', x:128,y:128, e:[255,255,255]},
    {n:'TR kept green',    x:384,y:128, e:[0,255,0]},
    {n:'BL kept blue',     x:128,y:384, e:[0,0,255]},
    {n:'BR kept yellow',   x:384,y:384, e:[255,255,0]},
  ]
  let ok=true
  for(const c of checks){const g=at(c.x,c.y);const p=near(g[0],c.e[0])&&near(g[1],c.e[1])&&near(g[2],c.e[2]);ok=ok&&p;console.log(`  ${c.n.padEnd(18)} exp ${c.e} got ${g} ${p?'OK':'MISMATCH'}`)}
  client.dispose(); srv.dispose()
  if(ok)console.log('\nPASS: direct partial update changed 1 tile, kept the other 3')
  else{console.error('\nFAIL: direct partial corrupted unchanged tiles');process.exitCode=1}
}
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
