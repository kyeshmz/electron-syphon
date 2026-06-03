import { app } from 'electron'
import { SyphonClient, listServers, type NativeSyphonClient } from 'electron-syphon'
import type { CaptureMethod } from './methods/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface TestContext {
  methods: CaptureMethod[]
  outputs: () => CaptureMethod[]
  setOutputCount: (n: number) => void
  scenes: string[]
}

interface Case {
  name: string
  pass: boolean
  detail: string
}

interface ReceiveResult {
  connected: boolean
  received: boolean
  nonBlack: boolean
  width: number
  height: number
  recvFps: number
}

/**
 * Connect a Syphon CLIENT to `serverName`, confirm a frame is received, sample a
 * pixel to prove it isn't black, and measure the received-new-frame rate.
 * This is the end-to-end check: publish → Syphon → receive.
 */
async function verifyReceive(serverName: string, timeoutMs = 1500): Promise<ReceiveResult> {
  const res: ReceiveResult = {
    connected: false,
    received: false,
    nonBlack: false,
    width: 0,
    height: 0,
    recvFps: 0
  }

  // 1. Wait for the server to appear in the directory, then connect.
  let client: NativeSyphonClient | null = null
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (listServers().some((s) => s.name === serverName)) {
      const c = new SyphonClient(serverName)
      if (c.isValid) {
        client = c
        break
      }
      c.dispose()
    }
    await sleep(100)
  }
  if (!client) return res
  res.connected = true

  // 2. Poll for a frame and sample its centre pixel.
  const t1 = Date.now()
  while (Date.now() - t1 < timeoutMs) {
    const f = client.receive(true)
    if (f.hasFrame) {
      res.received = true
      res.width = f.width ?? 0
      res.height = f.height ?? 0
      res.nonBlack = !!f.nonBlack
      break
    }
    await sleep(40)
  }

  // 3. Received-new-frame rate over ~0.6s (yield so the server keeps publishing).
  let n = 0
  const t2 = Date.now()
  const window = 600
  while (Date.now() - t2 < window) {
    if (client.hasNewFrame) {
      client.receive(false)
      n++
    }
    await sleep(2)
  }
  res.recvFps = Math.round((n / window) * 1000)
  client.dispose()
  return res
}

export async function runTests(ctx: TestContext): Promise<void> {
  const results: Case[] = []
  const rec = (name: string, pass: boolean, detail = ''): void => {
    results.push({ name, pass, detail })
    // eslint-disable-next-line no-console
    console.log(`  ${pass ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`)
  }
  const stopAll = (): void => {
    ctx.methods.forEach((m) => m.stop())
    ctx.setOutputCount(0)
  }

  // eslint-disable-next-line no-console
  console.log('\n===== electron-syphon test suite =====')

  // [1] Each capture method publishes AND is received end-to-end.
  // eslint-disable-next-line no-console
  console.log('\n[1] capture methods — publish + receive (+ verify pixels)')
  for (const m of ctx.methods) {
    stopAll()
    m.start('canvas2d')
    await sleep(900)
    const s0 = m.stats().frames
    const r = await verifyReceive(m.serverName)
    const produced = m.stats().frames - s0
    m.stop()
    const pass = produced > 0 && r.connected && r.received && r.nonBlack
    rec(
      `method ${m.id}`,
      pass,
      `published✓ received=${r.received ? '✓' : '✗'} nonBlack=${r.nonBlack ? '✓' : '✗'} ` +
        `${r.width}×${r.height} recvFps≈${r.recvFps}`
    )
  }

  // [2] Each scene renders content and is received non-black.
  // eslint-disable-next-line no-console
  console.log('\n[2] scenes (via zero-copy) — render + receive')
  const zc = ctx.methods[0]
  for (const sc of ctx.scenes) {
    stopAll()
    zc.start(sc)
    await sleep(1100)
    const r = await verifyReceive(zc.serverName)
    zc.stop()
    rec(
      `scene ${sc}`,
      r.received && r.nonBlack,
      `received=${r.received ? '✓' : '✗'} nonBlack=${r.nonBlack ? '✓' : '✗'} ${r.width}×${r.height}`
    )
  }

  // [3] Capabilities.
  // eslint-disable-next-line no-console
  console.log('\n[3] capabilities')
  stopAll()
  zc.setScale(2)
  zc.start('canvas2d')
  await sleep(1100)
  const a2 = zc.stats()
  zc.setScale(1)
  await sleep(1100)
  const a1 = zc.stats()
  zc.stop()
  zc.setScale(1)
  rec(
    'deviceScaleFactor 1×/2×',
    a2.width === 2 * a1.width && a1.width === 1280,
    `2×=${a2.width}×${a2.height}  1×=${a1.width}×${a1.height}`
  )

  stopAll()
  zc.setFps(120)
  zc.start('canvas2d')
  await sleep(900)
  const f0 = zc.stats().frames
  await sleep(1500)
  const fps120 = (zc.stats().frames - f0) / 1.5
  zc.stop()
  zc.setFps(60)
  rec('fps cap lifted (120)', fps120 > 75, `measured ${fps120.toFixed(0)}fps`)

  stopAll()
  zc.start('canvas2d')
  await sleep(800)
  zc.setFlip(false)
  await sleep(400)
  const flipping = zc.stats().frames > 0
  const flipR = await verifyReceive(zc.serverName)
  zc.setFlip(true)
  zc.stop()
  rec('flip toggle', flipping && flipR.received, `still publishing + received`)

  // [4] Multiple windows + multiple servers, each receivable.
  // eslint-disable-next-line no-console
  console.log('\n[4] multiple outputs')
  ctx.setOutputCount(4)
  await sleep(1600)
  const outs = ctx.outputs()
  const base = outs.map((o) => o.stats().frames)
  await sleep(1200)
  const minFps = Math.min(...outs.map((o, i) => (o.stats().frames - base[i]) / 1.2))
  const servers = listServers().filter((s) => s.name.startsWith('electron-syphon')).length
  const r1 = await verifyReceive(outs[0]?.serverName ?? 'electron-syphon #1')
  ctx.setOutputCount(0)
  rec('4 windows + 4 servers @60fps', minFps >= 45 && servers >= 4, `min ${minFps.toFixed(0)}fps, ${servers} servers`)
  rec('receive from output #1', r1.received && r1.nonBlack, `received=${r1.received ? '✓' : '✗'} nonBlack=${r1.nonBlack ? '✓' : '✗'}`)

  const passed = results.filter((r) => r.pass).length
  // eslint-disable-next-line no-console
  console.log(`\n===== ${passed}/${results.length} passed =====\n`)
  app.exit(passed === results.length ? 0 : 1)
}
