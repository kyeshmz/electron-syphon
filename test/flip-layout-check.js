// Both backends must give a GRID-PRESERVING per-tile flip for flipY=true: a 2x2
// grid TL=R TR=G BL=B BR=Y must publish with the same layout (not a mirrored
// grid). Regression for the atlas whole-surface-flip layout bug.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(NAME, useDirect) {
  const TW=256, TH=256, AW=TW*2, AH=TH*2
  const srv = useDirect ? new addon.DirectServer(NAME) : new addon.SyphonServer(NAME)
  const grid=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]] // TL TR BL BR
  const tiles=grid.map((c,i)=>({handle:addon.__makeTestSurface(TW,TH,...c),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  for(let i=0;i<6;i++){srv.publishAtlas(tiles,AW,AH,true,true);srv.drain();await sleep(15)}
  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(100)}}
  if(!client){console.error(`${NAME}: no client`);process.exitCode=1;return}
  let frame=null
  for(let i=0;i<80&&!frame;i++){srv.publishAtlas(tiles,AW,AH,true,true);srv.drain();const f=client.receiveFrame();if(f.hasFrame&&f.pixels)frame=f;else await sleep(20)}
  const {width:w,pixels}=frame
  const dom=(x,y)=>{const i=(y*w+x)*4;const r=pixels[i],g=pixels[i+1],b=pixels[i+2];return r>g&&r>b?'R':g>r&&g>b?'G':b>r&&b>g?'B':'Y'}
  const got=[dom(128,128),dom(384,128),dom(128,384),dom(384,384)].join('')
  const ok = got==='RGBY' // grid preserved
  console.log(`  ${(useDirect?'direct':'atlas ')}: quadrants=${got} ${ok?'OK (grid preserved)':'MISMATCH (grid mirrored!)'}`)
  client.dispose(); srv.dispose()
  if(!ok) process.exitCode=1
}
async function run(){ await probe('flip-layout-atlas', false); await probe('flip-layout-direct', true)
  console.log(process.exitCode?'\nFAIL':'\nPASS: both backends grid-preserving per-tile flip for flipY=true') }
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
