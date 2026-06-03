// Isolated check: does a Syphon CLIENT receive frames from a SERVER in the SAME
// process? Publishes a red frame, connects a client, samples the centre pixel.
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const { app } = require('electron')

app.whenReady().then(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const NAME = 'receiver-probe'
  const server = new addon.SyphonServer(NAME)
  const W = 256, H = 256
  const buf = Buffer.alloc(W * H * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255 // BGRA = red
  }
  const pub = setInterval(() => server.publishImageBuffer(buf, W, H, 'bgra', false), 16)
  await sleep(1200)
  const servers = addon.listServers().map((s) => s.name)
  const client = new addon.SyphonClient(NAME)
  let got = null
  for (let t = 0; t < 60 && !got; t++) {
    const f = client.receive(true)
    if (f.hasFrame) got = f
    else await sleep(50)
  }
  process.stdout.write('PROBE servers=' + JSON.stringify(servers) + '\n')
  process.stdout.write('PROBE isValid=' + client.isValid + '\n')
  process.stdout.write('PROBE received=' + JSON.stringify(got) + '\n')
  clearInterval(pub)
  client.dispose()
  server.dispose()
  app.exit(0)
})
