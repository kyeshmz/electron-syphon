import { useEffect, useRef } from 'react'
import { startScene } from './scenes'
import { Label } from './Label'

// Each tile runs a different scene so the composite is visually distinct.
const TILE_SCENES = ['canvas2d', 'webgl', 'webgpu', 'canvas2d', 'webgl', 'webgpu']

/**
 * Renders a cols×rows grid of scenes in ONE page. The whole grid is captured by
 * a single offscreen window and published as ONE Syphon server — the cheap way
 * to fan out many regions without N IOSurface pools.
 */
export default function CompositeView({ grid }: { grid: string }): React.JSX.Element {
  const [cols, rows] = grid.split('x').map((n) => Math.max(1, parseInt(n, 10) || 2))
  const refs = useRef<(HTMLCanvasElement | null)[]>([])

  useEffect(() => {
    const stops = refs.current.map((c, i) =>
      c ? startScene(TILE_SCENES[i % TILE_SCENES.length], c) : () => {}
    )
    return () => stops.forEach((s) => s())
  }, [cols, rows])

  const n = cols * rows
  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 2,
          background: '#000'
        }}
      >
        {Array.from({ length: n }).map((_, i) => (
          <canvas
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        ))}
      </div>
      <Label />
    </>
  )
}
