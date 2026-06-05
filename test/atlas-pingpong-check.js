// Validates the double-buffered (ping-pong) full-update path AND its interplay
// with partial updates. Each full update writes the ALTERNATE buffer and swaps;
// a stale-buffer bug would surface as an old frame's colors. flip=false so a
// readback pixel maps straight to the atlas pixel.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const TW = 256, TH = 256, AW = TW*2, AH = TH*2, NAME = 'atlas-pingpong-check'
  const server = new addon.SyphonServer(NAME)
  const mk = (r,g,b) => addon.__makeTestSurface(TW, TH, r, g, b)
  const full = (cs) => [
    { handle: mk(...cs[0]), x: 0,  y: 0,  w: TW, h: TH },
    { handle: mk(...cs[1]), x: TW, y: 0,  w: TW, h: TH },
    { handle: mk(...cs[2]), x: 0,  y: TH, w: TW, h: TH },
    { handle: mk(...cs[3]), x: TW, y: TH, w: TW, h: TH },
  ]

  // Prime both ping-pong buffers with full updates.
  for (let i=0;i<4;i++){ server.publishAtlas(full([[10,10,10],[10,10,10],[10,10,10],[10,10,10]]), AW, AH, false, true); server.drain(); await sleep(15) }

  let client = null
  for (let t=0;t<60 && !client;t++){ if (addon.listServers().some(s=>s.name===NAME)) client=new addon.SyphonClient(NAME); if(!client||!client.isValid){client=null;await sleep(100)} }
  if (!client){ console.error('FAIL: no client'); process.exitCode=1; return }

  const near=(a,b)=>Math.abs(a-b)<=10
  async function publishAndCheck(label, tiles, fullUpdate, expect) {
    let frame=null
    for (let i=0;i<60 && !frame;i++){ server.publishAtlas(tiles, AW, AH, false, fullUpdate); server.drain(); const f=client.receiveFrame(); if(f.hasFrame&&f.pixels) frame=f; else await sleep(20) }
    if(!frame){ console.error(`FAIL(${label}): no frame`); process.exitCode=1; return false }
    const {width:w,pixels}=frame
    const at=(x,y)=>{const i=(y*w+x)*4;return[pixels[i],pixels[i+1],pixels[i+2]]}
    const pts=[[128,128],[384,128],[128,384],[384,384]]
    let ok=true
    for(let q=0;q<4;q++){const g=at(...pts[q]);const e=expect[q];const pass=near(g[0],e[0])&&near(g[1],e[1])&&near(g[2],e[2]);ok=ok&&pass;if(!pass)console.log(`  ${label} q${q} exp ${e} got ${g} MISMATCH`)}
    console.log(`  ${label}: ${ok?'OK':'FAIL'}`)
    if(!ok) process.exitCode=1
    return ok
  }

  // Run several full updates back-to-back with DISTINCT content each time — a
  // stale ping-pong buffer would echo a previous frame here.
  const A=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]]
  const B=[[0,255,255],[255,0,255],[128,128,128],[255,128,0]]
  await publishAndCheck('full#A', full(A), true, A)
  await publishAndCheck('full#B', full(B), true, B)
  await publishAndCheck('full#A2', full(A), true, A)
  // Partial update on top of the last full (B-base would be wrong): change TL to white.
  await publishAndCheck('partial TL→white', [{handle:mk(255,255,255),x:0,y:0,w:TW,h:TH}], false,
    [[255,255,255], A[1], A[2], A[3]])
  // Another full update after the partial.
  await publishAndCheck('full#B2', full(B), true, B)

  client.dispose(); server.dispose()
  if (!process.exitCode) console.log('\nPASS: ping-pong full updates + partial interplay all correct')
  else console.error('\nFAIL: ping-pong/partial sequence wrong')
}
if (process.versions.electron){const {app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
