import { ElectronAPI } from '@electron-toolkit/preload'
import type { SyphonState } from './index'

export interface ICustomAPI {
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

declare global {
  interface Window {
    electron: ElectronAPI
    api: ICustomAPI
  }
}
