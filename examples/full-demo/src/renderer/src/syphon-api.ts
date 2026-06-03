// Renderer-facing types for the API exposed on window.api.

export interface MethodStats {
  id: string
  label: string
  description: string
  running: boolean
  frames: number
  avgPublishMs: number
  usingSharedTexture: boolean | null
  hasClients: boolean
  width: number
  height: number
  scene: string
  flipY: boolean
  scale: number
  fps: number
}

export interface SyphonServerInfo {
  name: string
  appName: string
  uuid: string
}

export interface SyphonState {
  scene: string
  scenes: string[]
  scale: number
  fps: number
  outputCount: number
  methods: MethodStats[]
  servers: SyphonServerInfo[]
}

export interface RendererAPI {
  syphon: {
    state: () => Promise<SyphonState>
    toggle: (id: string, on: boolean) => Promise<boolean>
    setScene: (scene: string) => Promise<string>
    setFlip: (on: boolean) => Promise<boolean>
    setScale: (scale: number) => Promise<number>
    setFps: (fps: number) => Promise<number>
    setOutputs: (n: number) => Promise<number>
  }
  readback: {
    sendFrame: (width: number, height: number, data: Uint8ClampedArray | Uint8Array) => void
  }
}
