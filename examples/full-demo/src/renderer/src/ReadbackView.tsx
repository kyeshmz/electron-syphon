import { useEffect, useRef } from 'react'
import { startScene } from './scenes'

/**
 * Renders a scene, then each frame reads it back with getImageData() and ships
 * the pixels to the main process over IPC (the classic CPU path). Demonstrated
 * for comparison with the zero-copy method.
 */
export default function ReadbackView({ scene }: { scene: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return undefined
    const canvas = ref.current
    const stop = startScene(scene, canvas)
    const copy = document.createElement('canvas')
    const cctx = copy.getContext('2d', { willReadFrequently: true })!
    let raf = 0
    let alive = true
    // Readback + IPC cost scales with pixel count, so cap the published height
    // (this is the slow CPU path; real apps downscale here too).
    const MAX_H = 720
    const pump = (): void => {
      if (!alive) return
      const sw = canvas.width
      const sh = canvas.height
      if (sw > 0 && sh > 0) {
        const scale = Math.min(1, MAX_H / sh)
        const w = Math.round(sw * scale)
        const h = Math.round(sh * scale)
        if (copy.width !== w) copy.width = w
        if (copy.height !== h) copy.height = h
        cctx.drawImage(canvas, 0, 0, w, h) // also rasterizes webgl/webgpu canvases
        const img = cctx.getImageData(0, 0, w, h)
        window.api.readback.sendFrame(w, h, img.data)
      }
      raf = requestAnimationFrame(pump)
    }
    raf = requestAnimationFrame(pump)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stop()
    }
  }, [scene])
  return (
    <canvas
      ref={ref}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', display: 'block' }}
    />
  )
}
