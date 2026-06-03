/// <reference types="vite/client" />
import type { RendererAPI } from './syphon-api'

declare global {
  interface Window {
    electron: unknown
    api: RendererAPI
  }
}
