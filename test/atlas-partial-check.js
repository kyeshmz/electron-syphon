const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW = 256, TH = 256, AW = TW*2, AH = TH*2
  const NAME = 'atlas-partial-check'
  const server = new addon.SyphonServer(NAME)
  const mk = (r,g,b) => addon.__makeTestSurface(TW, TH, r, g, b)
  // initial: TL red, TR green, BL blue, BR yellow
  const full = [
    { handle: mk(255,0,0),   x: 0,  y: 0,  w: TW, h: TH },
    { handle: mk(0,255,0),   x: TW, y: 0,  w: TW, h: TH },
    { handle: mk(0,0,255),   x: 0,  y: TH, w: TW, h: TH },
    { handle: mk(255,255,0), x: TW, y: TH, w: TW, h: TH },
  ]
  for (let i=0;i<5;i++){ server.publishAtlas(full, AW, AH, false); server.drain(); await sleep(20) }

  // partial update: ONLY TL changes to white. Pass a single dirty tile.
  const onlyTL = [{ handle: mk(255,255,255), x: 0, y: 0, w: TW, h: TH }]

  let client = null
  for (let t=0;t<60 && !client;t++){ if (addon.listServers().some(s=>s.name===NAME)) client=new addon.SyphonClient(NAME); if(!client||!client.isValid){client=null;await sleep(100)} }
  if (!client){ console.error('FAIL: no client'); process.exitCode=1; return }

  let frame=null
  for (let i=0;i<80 && !frame;i++){
    server.publishAtlas(onlyTL, AW, AH, false); server.drain()
    const f=client.receiveFrame(); if(f.hasFrame&&f.pixels) frame=f; else await sleep(30)
  }
  if(!frame){ console.error('FAIL: no frame'); process.exitCode=1; return }
  const {width:w,height:h,pixels}=frame
  const at=(x,y)=>{const i=(y*w+x)*4;return{r:pixels[i],g:pixels[i+1],b:pixels[i+2]}}
  const near=(a,b)=>Math.abs(a-b)<=8
  const checks=[
    {name:'TL (changed→white)', x:128, y:128, exp:[255,255,255]},
    {name:'TR (kept green)',     x:384, y:128, exp:[0,255,0]},
    {name:'BL (kept blue)',      x:128, y:384, exp:[0,0,255]},
    {name:'BR (kept yellow)',    x:384, y:384, exp:[255,255,0]},
  ]
  let ok=true
  for(const c of checks){const g=at(c.x,c.y);const pass=near(g.r,c.exp[0])&&near(g.g,c.exp[1])&&near(g.b,c.exp[2]);ok=ok&&pass;console.log(`  ${c.name.padEnd(22)} exp rgb(${c.exp}) got rgb(${g.r},${g.g},${g.b}) ${pass?'OK':'MISMATCH'}`)}
  client.dispose(); server.dispose()
  if(ok) console.log('\nPASS: partial update changed 1 tile, persistent atlas kept the other 3')
  else { console.error('\nFAIL: partial update corrupted unchanged tiles'); process.exitCode=1 }
}
if (process.versions.electron){const {app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
