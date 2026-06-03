export interface MethodStats {
  id: string
  label: string
  description: string
  running: boolean
  frames: number
  avgPublishMs: number
  /** true = zero-copy IOSurface, false = CPU, null = no frame yet */
  usingSharedTexture: boolean | null
  hasClients: boolean
  width: number
  height: number
  scene: string
  flipY: boolean
  /** Output deviceScaleFactor (Electron 34+; default 1.0 on 42+). */
  scale: number
  /** Requested frame rate (>240 allowed on the shared-texture path, Electron 36+). */
  fps: number
}

/** One "way" of getting frames into Syphon. */
export interface CaptureMethod {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly serverName: string
  start(scene: string): void
  stop(): void
  setScene(scene: string): void
  setFlip(on: boolean): void
  /** Output deviceScaleFactor — recreates the window (Electron 34+). */
  setScale(scale: number): void
  /** Requested frame rate — applied live (Electron 36+ lifts the 240 cap). */
  setFps(fps: number): void
  stats(): MethodStats
}
