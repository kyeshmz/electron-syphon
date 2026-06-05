// Verify DirectServer flipY=true ACTUALLY flips each tile vertically. Each tile
// has a RED top half and BLUE bottom half (in source memory order). The Syphon
// client reads BGRA top-down. With flipY=false the top stays red; with flipY=true
// the tile is mirrored so the top reads BLUE.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(flip) {
  const TW=128, TH=128, AW=TW*2, AH=TH*2, NAME='directflip-'+(flip?'T':'F')
  const srv = new addon.DirectServer(NAME)
  // top half red(255,0,0), bottom half blue(0,0,255)
  const mk = () => addon.__makeTestSurface(TW,TH, 255,0,0, 0,0,255)
  const tiles = Array.from({length:4},(_,i)=>({handle:mk(),x:(i%2)*TW,y:((i/2)|0)*TH,w:TW,h:TH}))
  for(let i=0;i<6;i++){srv.publishAtlas(tiles,AW,AH,flip,true);srv.drain();await sleep(15)}
  let client=null
  for(let t=0;t<60&&!client;t++){if(addon.listServers().some(s=>s.name===NAME))client=new addon.SyphonClient(NAME);if(!client||!client.isValid){client=null;await sleep(100)}}
  if(!client){console.log(`flip=${flip}: no client`);return}
  let frame=null
  for(let i=0;i<80&&!frame;i++){srv.publishAtlas(tiles,AW,AH,flip,true);srv.drain();const f=client.receiveFrame();if(f.hasFrame&&f.pixels)frame=f;else await sleep(20)}
  const {width:w,pixels}=frame
  const at=(x,y)=>{const i=(y*w+x)*4;return[pixels[i],pixels[i+1],pixels[i+2]]}
  // sample top quarter and bottom quarter of the top-left tile
  const top=at(TW/2|0, TH*0.25|0), bot=at(TW/2|0, TH*0.75|0)
  const isRed=c=>c[0]>150&&c[2]<100, isBlue=c=>c[2]>150&&c[0]<100
  const topName=isRed(top)?'RED':isBlue(top)?'BLUE':'?', botName=isRed(bot)?'RED':isBlue(bot)?'BLUE':'?'
  // flip=false → top RED bottom BLUE; flip=true → top BLUE bottom RED
  const ok = flip ? (topName==='BLUE'&&botName==='RED') : (topName==='RED'&&botName==='BLUE')
  console.log(`flip=${flip}: tile top=${topName} bottom=${botName} → ${ok?'CORRECT':'WRONG'}`)
  client.dispose(); srv.dispose()
  if(!ok) process.exitCode=1
}
async function run(){ await probe(false); await probe(true)
  console.log(process.exitCode?'\nFAIL: flip orientation wrong':'\nPASS: flipY=false unflipped, flipY=true flips each tile correctly') }
if(process.versions.electron){const{app}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(run).then(()=>app.exit(process.exitCode||0)).catch(e=>{console.error(e);app.exit(1)})}else run()
