// Frame-sync test — proves the frame we PUBLISH is the exact frame Syphon DELIVERS.
//
//   npm run frame-test          (from the examples/ folder)
//
// It renders a page that bakes its frame counter into the published pixels, lets
// it run, FREEZES it, then reads three numbers at the frozen instant:
//   1. the number on the visible PREVIEW window      (what you see on screen)
//   2. the number in the offscreen PUBLISHER          (what we actually send)
//   3. the number decoded from the SYPHON server      (what a client receives)
// (2) and (3) must match exactly — that's the end-to-end integrity check. (1) is a
// separate live render; any gap to (2) is the throttling/independence effect.
import { app, BrowserWindow } from 'electron'
import { SyphonOutput, SyphonClient } from 'electron-syphon'
import * as path from 'path'

const NAME = 'electron-syphon frame-test'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  // dist/frame-test/main.js → source HTML at ../../frame-test/index.html
  const file = path.join(__dirname, '..', '..', 'frame-test', 'index.html')

  // (1) Visible preview so you literally watch a window render and stop.
  const preview = new BrowserWindow({
    width: 640,
    height: 400,
    title: NAME,
    webPreferences: { backgroundThrottling: false }
  })
  preview.loadFile(file)

  // (2) Offscreen publisher — the source that is sent to Syphon, zero-copy.
  const publisher = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
      backgroundThrottling: false
    }
  })
  publisher.webContents.setFrameRate(60)

  const out = new SyphonOutput(NAME)
  out.skipWhenNoClients = false // always publish, even before a client connects
  out.attach(publisher.webContents)
  publisher.loadFile(file)

  // Let both windows render for a bit so the counters climb.
  await sleep(2500)

  // (3) Receiver: connect a Syphon client to our own server (in-process is fine).
  const client = new SyphonClient(NAME)
  for (let i = 0; i < 60 && !client.isValid; i++) await sleep(50)

  // Freeze both renders at the same instant.
  await preview.webContents.executeJavaScript('window.__stop()')
  await publisher.webContents.executeJavaScript('window.__stop()')

  // Let the final published frame land + the async pipeline drain.
  await sleep(300)

  const screenFrame = (await preview.webContents.executeJavaScript('window.__frame')) as number
  const sentFrame = (await publisher.webContents.executeJavaScript('window.__frame')) as number

  const f = client.receive(true) // { hasFrame, width, height, nonBlack, r, g, b, a }
  const r = f.r ?? 0, g = f.g ?? 0, b = f.b ?? 0
  const recvFrame = f.hasFrame ? r + (g << 8) : null
  const markerOk = f.hasFrame && Math.abs(b - 192) <= 2

  const line = (k: string, v: string | number): string => '  ' + k.padEnd(34) + v
  const log = (...a: unknown[]): void => console.log(...a) // eslint-disable-line no-console

  log('\n──────────── electron-syphon frame-sync test ────────────')
  log(line('preview window (on screen):', '#' + screenFrame))
  log(line('publisher (sent to Syphon):', '#' + sentFrame))
  log(line('decoded from Syphon client:', f.hasFrame ? '#' + recvFrame : 'NO FRAME RECEIVED'))
  log(line('received pixel rgb:', f.hasFrame ? `(${r}, ${g}, ${b})  marker b=192 → ${markerOk ? 'ok' : 'MISMATCH'}` : '—'))
  log(line('received size:', f.hasFrame ? `${f.width}×${f.height}` : '—'))
  log('  ' + '-'.repeat(54))

  const integrity = f.hasFrame && markerOk && recvFrame !== null && (sentFrame & 0xffff) === recvFrame
  const sentVsRecv = f.hasFrame && recvFrame !== null ? (sentFrame & 0xffff) - recvFrame : NaN
  const screenVsSent = screenFrame - sentFrame

  log(line('SENT vs RECEIVED (Syphon integrity):',
    integrity ? `✓ EXACT MATCH (Δ0)` : `Δ${sentVsRecv} frame(s)`))
  log(line('SCREEN vs SENT (preview vs publish):',
    `Δ${screenVsSent} frame(s) ${screenVsSent === 0 ? '(in lock-step)' : '(separate renders)'}`))
  log(line('RESULT:', integrity ? '✅ PASS — published frame == received frame' : '❌ FAIL'))
  log('─────────────────────────────────────────────────────────\n')

  client.dispose()
  out.dispose()
  app.exit(integrity ? 0 : 1)
})

app.on('window-all-closed', () => app.quit())
