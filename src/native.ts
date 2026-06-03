import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { SyphonServerInfo } from './types'

/** The native Syphon server (one video output). See native/syphon/syphon_addon.mm. */
export interface NativeSyphonServer {
  /** Zero-copy, synchronous: publish the IOSurface handle and wait for the GPU. */
  publishSurface(handle: Buffer, width: number, height: number, flipY: boolean): void
  /** Zero-copy, async: submit only. Returns 1 if enqueued (keep the Electron
   *  texture alive until a later reap() reports completion), 0 if skipped. */
  publishSurfaceAsync(handle: Buffer, width: number, height: number, flipY: boolean): number
  /** How many async frames finished on the GPU since last call (drops them). */
  reap(): number
  /** Wait for all in-flight async frames; returns how many were drained. */
  drain(): number
  /** CPU fallback: publish a raw pixel buffer. */
  publishImageBuffer(
    pixels: Buffer | Uint8Array,
    width: number,
    height: number,
    format: 'rgba' | 'bgra',
    flipY: boolean
  ): void
  /** Throughput benchmark of the publish path (see README / npm run bench). */
  benchmark(opts: {
    width?: number
    height?: number
    iterations?: number
    mode?: 'surface' | 'image'
    wait?: boolean
  }): {
    mode: string
    width: number
    height: number
    iterations: number
    wait: boolean
    totalMs: number
    avgMs: number
    fps: number
    megapixels: number
    throughputGBps: number
  }
  dispose(): void
  readonly name: string | null
  readonly hasClients: boolean
}

/** A received frame, optionally sampled to verify it isn't black. */
export interface ReceivedFrame {
  valid: boolean
  hasFrame: boolean
  width?: number
  height?: number
  nonBlack?: boolean
  r?: number
  g?: number
  b?: number
  a?: number
}

/** A received frame with its full pixel data (RGBA), for display/monitoring. */
export interface ReceivedFramePixels {
  valid: boolean
  hasFrame: boolean
  width?: number
  height?: number
  /** Tightly-packed RGBA8 (width*height*4), opaque alpha. Present when hasFrame. */
  pixels?: Buffer
}

/** The native Syphon client (receiver). */
export interface NativeSyphonClient {
  /** Pull the latest frame. Pass true to also sample the centre pixel. */
  receive(sample?: boolean): ReceivedFrame
  /** Pull the latest frame WITH its full RGBA pixels (a GPU→CPU readback) so a
   *  window can display exactly what is being published. Heavier than receive();
   *  meant for a monitor/preview, not the publish path. */
  receiveFrame(): ReceivedFramePixels
  dispose(): void
  /** Whether a connection to the server was established. */
  readonly isValid: boolean
  /** Whether a new frame is waiting. */
  readonly hasNewFrame: boolean
}

interface NativeAddon {
  SyphonServer: new (name: string) => NativeSyphonServer
  SyphonClient: new (serverName: string) => NativeSyphonClient
  listServers(): SyphonServerInfo[]
}

// node-gyp-build resolves prebuilds/<platform>-<arch>/*.node (shipped) or
// build/Release/*.node (compiled fallback), relative to the package root. Since
// this file compiles to dist/native.js, the package root is one level up.
const nodeRequire = createRequire(__filename)
const gypBuild = nodeRequire('node-gyp-build') as (dir: string) => NativeAddon
const addon: NativeAddon = gypBuild(join(__dirname, '..'))

/** Low-level native Syphon server. Most apps want {@link SyphonOutput} instead. */
export const SyphonServer = addon.SyphonServer

/** Syphon receiver — connect to a server by name and pull/verify frames. */
export const SyphonClient = addon.SyphonClient

/** Every Syphon server currently published on this machine. */
export function listServers(): SyphonServerInfo[] {
  return addon.listServers()
}
