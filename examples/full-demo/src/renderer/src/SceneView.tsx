import { useEffect, useRef } from 'react'
import { startScene } from './scenes'
import { Label } from './Label'

/** Fullscreen scene, rendered in the offscreen broadcast windows. */
export default function SceneView({ scene }: { scene: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return undefined
    return startScene(scene, ref.current)
  }, [scene])
  return (
    <>
      <canvas
        ref={ref}
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', display: 'block' }}
      />
      <Label />
    </>
  )
}
