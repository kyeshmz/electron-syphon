import { startCanvas2D } from './canvas2d'
import { startWebGL } from './webgl'
import { startWebGPU } from './webgpu'

export type SceneId = 'canvas2d' | 'webgl' | 'webgpu'

/** Start a scene by id, drawing into `canvas`. Returns a stop() function. */
export function startScene(id: string, canvas: HTMLCanvasElement): () => void {
  switch (id) {
    case 'webgl':
      return startWebGL(canvas)
    case 'webgpu':
      return startWebGPU(canvas)
    default:
      return startCanvas2D(canvas)
  }
}
