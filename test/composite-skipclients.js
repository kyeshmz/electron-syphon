// Test the path I changed: skipWhenNoClients=true (default). Must skip while no
// client (and not leak textures), then publish once a client connects.
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { CompositeSyphonOutput, SyphonClient, listServers } = require(path.join(__dirname, '..', 'dist', 'index.js'))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const page = (c) => 'data:text/html,'+encodeURIComponent(`<html><body style="margin:0;background:${c}"><div style="width:20px;height:20px;background:#fff;animation:m 1s infinite"></div><style>@keyframes m{to{transform:translateX(100px)}}</style></body></html>`)
app.whenReady().then(async () => {
  const out = new CompositeSyphonOutput('skipclients', { cols:2, rows:2, tileWidth:320, tileHeight:240, direct:true })
  // skipWhenNoClients stays TRUE (default) — the path I changed
  const cols=['#f00','#0f0','#00f','#ff0']; const wins=[]
  for (let i=0;i<4;i++){
    const w=new BrowserWindow({width:320,height:240,show:false,webPreferences:{offscreen:{useSharedTexture:true,deviceScaleFactor:1},backgroundThrottling:false}})
    w.webContents.setFrameRate(30); out.attach(w.webContents,{col:i%2,row:(i/2)|0}); await w.webContents.loadURL(page(cols[i])); wins.push(w)
  }
  await sleep(1000)
  const framesWhileIdle = out.frames // should be ~0 (no client → skip)
  // now connect a client
  let client=null
  for(let t=0;t<50&&!client;t++){if(listServers().some(s=>s.name==='skipclients'))client=new SyphonClient('skipclients');if(!client||!client.isValid){client=null;await sleep(100)}}
  out.frames=0; await sleep(1500)
  const framesWithClient = out.frames // should be >0 (client → publish)
  let got=false
  for(let i=0;i<40&&!got;i++){const f=client&&client.receive(true);if(f&&f.hasFrame&&f.nonBlack)got=true;else await sleep(30)}
  console.log(`idle publishes=${framesWhileIdle} (want ~0), with-client publishes=${framesWithClient} (want >0), client got non-black frame=${got}`)
  out.dispose(); for(const w of wins) w.destroy()
  const ok = framesWhileIdle < 5 && framesWithClient > 0 && got
  console.log(ok?'PASS: skips while idle, publishes on client connect':'FAIL')
  app.exit(ok?0:1)
}).catch(e=>{console.error(e);app.exit(1)})
