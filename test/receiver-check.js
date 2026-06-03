// Connect (from a SEPARATE process) to a Syphon server by name and verify we
// receive a non-black frame. Usage: SERVER="electron-syphon canvas2d" electron test/receiver-check.js
const path = require('path')
const addon = require('node-gyp-build')(path.join(__dirname, '..'))
const { app } = require('electron')
const SERVER = process.env.SERVER || 'electron-syphon canvas2d'

app.whenReady().then(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let got = null
  let valid = false
  for (let t = 0; t < 60 && !got; t++) {
    if (addon.listServers().some((s) => s.name === SERVER)) {
      const c = new addon.SyphonClient(SERVER)
      valid = c.isValid
      for (let k = 0; k < 30 && !got; k++) {
        const f = c.receive(true)
        if (f.hasFrame) got = f
        else await sleep(50)
      }
      c.dispose()
    }
    if (!got) await sleep(100)
  }
  process.stdout.write(`CHECK server=${JSON.stringify(SERVER)} valid=${valid} received=${JSON.stringify(got)}\n`)
  app.exit(got && got.nonBlack ? 0 : 1)
})
