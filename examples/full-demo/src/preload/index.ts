import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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
}
export interface SyphonState {
  scene: string
  scenes: string[]
  methods: MethodStats[]
  servers: { name: string; appName: string; uuid: string }[]
}

const api = {
  syphon: {
    state: (): Promise<SyphonState> => ipcRenderer.invoke('syphon:state'),
    toggle: (id: string, on: boolean): Promise<boolean> => ipcRenderer.invoke('syphon:toggle', id, on),
    setScene: (scene: string): Promise<string> => ipcRenderer.invoke('syphon:scene', scene),
    setFlip: (on: boolean): Promise<boolean> => ipcRenderer.invoke('syphon:flip', on),
    setScale: (scale: number): Promise<number> => ipcRenderer.invoke('syphon:scale', scale),
    setFps: (fps: number): Promise<number> => ipcRenderer.invoke('syphon:fps', fps),
    setOutputs: (n: number): Promise<number> => ipcRenderer.invoke('syphon:outputs', n)
  },
  // Used only by the canvas-readback window to ship pixels to the main process.
  readback: {
    sendFrame: (width: number, height: number, data: Uint8Array): void =>
      ipcRenderer.send('readback:frame', { width, height, data })
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
