/**
 * Overlays the output's label (e.g. "Output 1") onto the frame, read from the
 * URL's ?label= param. Captured into the published frame so you can tell which
 * Syphon source is which when several are running.
 */
export function Label(): React.JSX.Element | null {
  const label = new URLSearchParams(window.location.search).get('label')
  if (!label) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 18,
        left: 18,
        padding: '8px 16px',
        background: 'rgba(0,0,0,0.55)',
        color: '#fff',
        font: '700 30px system-ui, sans-serif',
        borderRadius: 10,
        letterSpacing: 0.5,
        pointerEvents: 'none',
        zIndex: 10
      }}
    >
      {label}
    </div>
  )
}
