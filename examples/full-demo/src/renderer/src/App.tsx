import { useEffect, useState } from 'react'
import ControlPanel from './ControlPanel'
import SceneView from './SceneView'
import ReadbackView from './ReadbackView'
import CompositeView from './CompositeView'

function parse(): { kind: string; scene: string } {
  const h = window.location.hash.replace(/^#\/?/, '')
  const [kind, scene] = h.split('/')
  return { kind: kind || 'control', scene: scene || 'canvas2d' }
}

function App(): React.JSX.Element {
  const [route, setRoute] = useState(parse())
  useEffect(() => {
    const on = (): void => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  if (route.kind === 'scene') return <SceneView scene={route.scene} />
  if (route.kind === 'readback') return <ReadbackView scene={route.scene} />
  if (route.kind === 'composite') return <CompositeView grid={route.scene} />
  return <ControlPanel />
}

export default App
