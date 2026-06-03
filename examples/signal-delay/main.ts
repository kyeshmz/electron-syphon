// signal-delay — a telematic split-screen for distributed performers.
//
//   npm run signal-delay            (or: N=4 npm run signal-delay)
//
// One OFFSCREEN "portal" window PER remote peer, each its OWN named Syphon
// source ("signal-delay · portal #k"). This is the shape TouchDesigner can't
// give you: N independent WebRTC compositors, each publishing zero-copy.
//
// To stay SELF-CONTAINED and TOKENLESS, a single hidden "sender" window
// SIMULATES N remote performers — for each portal it builds an animated
// Canvas2D MediaStream (canvas.captureStream) and pushes it over a real
// RTCPeerConnection to that portal. Signaling is pure loopback THROUGH this
// main process (ipcMain relay), so there is NO STUN/TURN and NO network: the
// ICE host candidates are localhost. A real phone could join as an extra
// performer over the optional LAN page (see operator.html); that path is OFF
// the critical path — the synthetic peers work with zero network.
import { app, BrowserWindow, ipcMain } from 'electron'
import { SyphonOutput, SyphonClient, listServers } from 'electron-syphon'
import * as path from 'path'

const N = Number(process.env.N || 3)
const NAME = (k: number): string => `signal-delay · portal #${k}`

app.whenReady().then(() => {
  // dist/signal-delay/main.js → source HTML at ../../signal-delay/*.html
  const dir = path.join(__dirname, '..', '..', 'signal-delay')
  const outputs: SyphonOutput[] = []

  // The signaling relay. Every renderer (sender + N portals) talks to one
  // logical bus keyed by peer id. A portal is id `k`; the sender is `sender`.
  // We route each {to, from, kind, data} message to the right webContents.
  const portals: Array<BrowserWindow | null> = new Array(N + 1).fill(null) // 1-indexed
  let sender: BrowserWindow | null = null

  ipcMain.on('signal', (_e, msg: { to: string; from: string; kind: string; data: unknown }) => {
    const target =
      msg.to === 'sender' ? sender : portals[Number(msg.to)]
    if (target && !target.isDestroyed()) {
      target.webContents.send('signal', msg)
    }
  })

  // Connection-state telemetry from portals/sender → forwarded to the operator
  // dashboard so a human can watch the N peers come up. Pure status, no media.
  let operator: BrowserWindow | null = null
  const toOperator = (channel: string, payload: unknown): void => {
    if (operator && !operator.isDestroyed()) operator.webContents.send(channel, payload)
  }
  ipcMain.on('portalState', (_e, p) => {
    toOperator('portalState', p)
    // eslint-disable-next-line no-console
    console.log(`  · portal #${p.id} → ${p.state}`)
  })
  ipcMain.on('senderState', (_e, p) => {
    toOperator('senderState', p)
    // eslint-disable-next-line no-console
    console.log(`  · sender→#${p.id} → ${p.state}`)
  })

  // The OFFSCREEN portals — one published Syphon source each. nodeIntegration
  // so portal.html can require('electron') for the ipc signaling channel.
  for (let k = 1; k <= N; k++) {
    const portal = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
        backgroundThrottling: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    })
    portal.webContents.setFrameRate(60)
    portals[k] = portal

    const out = new SyphonOutput(NAME(k))
    out.skipWhenNoClients = false // composite + publish even with no client attached
    out.attach(portal.webContents)
    portal.loadFile(path.join(dir, 'portal.html'), { query: { id: String(k) } })
    outputs.push(out)
  }

  // The hidden SENDER — simulates N remote performers. nodeIntegration for ipc.
  sender = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  sender.loadFile(path.join(dir, 'sender.html'), { query: { n: String(N) } })

  // The ONE visible operator window — a dashboard. NOT published to Syphon.
  operator = new BrowserWindow({
    width: 900,
    height: 560,
    title: 'signal-delay — operator (not published)',
    backgroundColor: '#07080c',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })
  operator.loadFile(path.join(dir, 'operator.html'), { query: { n: String(N) } })

  // eslint-disable-next-line no-console
  console.log(
    `\n▶ signal-delay: ${N} offscreen WebRTC portals → ${N} Syphon servers ` +
      `("${NAME(1)}" … "${NAME(N)}"). One hidden sender simulates the remote ` +
      `performers; loopback signaling via this main process. Operator window is ` +
      `visible but NOT published.\n`
  )

  // SELF-VERIFY in-process: after the WebRTC tracks have had time to arrive,
  // open a SyphonClient on portal #1 and report nonBlack. nonBlack can only be
  // true if the track arrived AND the <video>/canvas is painting in the
  // offscreen window — i.e. the loopback genuinely delivered live video.
  let probe: InstanceType<typeof SyphonClient> | null = null
  let lastConnect = 0
  const verify = setInterval(() => {
    const live = listServers()
      .map((s) => s.name)
      .filter((n) => n.startsWith('signal-delay · portal'))
    if (!probe || !probe.isValid) {
      const nowish = Date.now()
      if (nowish - lastConnect > 800) {
        lastConnect = nowish
        try { probe?.dispose() } catch { /* not connected yet */ }
        probe = new SyphonClient(NAME(1))
      }
      // eslint-disable-next-line no-console
      console.log(`  ${live.length}/${N} portals live · connecting probe to "${NAME(1)}"…`)
      return
    }
    // receive(true) samples the centre pixel. nonBlack here can ONLY be true if
    // the WebRTC track arrived AND the portal is painting the <video> — i.e. the
    // loopback genuinely delivered live video into the published surface. The
    // centre RGB drifts frame-to-frame, which proves it's live, not a still.
    const f = probe.receive(true)
    // eslint-disable-next-line no-console
    console.log(
      `  ${live.length}/${N} portals live · portal #1 hasFrame=${f.hasFrame} ` +
        `nonBlack=${f.nonBlack} centreRGB=(${f.r ?? '-'},${f.g ?? '-'},${f.b ?? '-'})`
    )
  }, 1500)

  app.on('before-quit', () => {
    clearInterval(verify)
    try { probe?.dispose() } catch { /* already disposed */ }
    outputs.forEach((o) => o.dispose())
  })
})

app.on('window-all-closed', () => app.quit())
