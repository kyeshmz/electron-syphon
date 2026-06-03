import { useEffect, useRef, useState } from 'react'
import type { SyphonState, MethodStats } from './syphon-api'

const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: '14px 16px'
}

function Pill({
  on,
  onClick,
  children
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 11px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.15)',
        background: on ? '#3a6df0' : 'transparent',
        color: 'white',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}

function Group({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div
        title={hint}
        style={{
          opacity: 0.55,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 8,
          cursor: hint ? 'help' : 'default'
        }}
      >
        {label}
        {hint ? ' ⓘ' : ''}
      </div>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
}

function Dot({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        marginRight: 8,
        background: on ? '#3ddc84' : '#555',
        boxShadow: on ? '0 0 8px #3ddc84' : 'none'
      }}
    />
  )
}

export default function ControlPanel(): React.JSX.Element {
  const [state, setState] = useState<SyphonState | null>(null)
  const [fps, setFps] = useState<Record<string, number>>({})
  const last = useRef<Record<string, { frames: number; t: number }>>({})

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const s = await window.api.syphon.state()
      if (!alive) return
      const now = Date.now()
      const next: Record<string, number> = {}
      for (const m of s.methods) {
        const prev = last.current[m.id]
        if (prev && now - prev.t > 300) {
          next[m.id] = ((m.frames - prev.frames) / (now - prev.t)) * 1000
          last.current[m.id] = { frames: m.frames, t: now }
        } else {
          next[m.id] = fps[m.id] ?? 0
          if (!prev) last.current[m.id] = { frames: m.frames, t: now }
        }
      }
      setFps(next)
      setState(s)
    }
    const id = setInterval(poll, 500)
    poll()
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flipOn = state?.methods.some((m) => m.flipY) ?? true

  return (
    <div
      style={{
        maxWidth: 980,
        margin: '0 auto',
        padding: 'clamp(16px, 3vw, 32px)',
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left'
      }}
    >
      <h1 style={{ margin: '0 0 6px', fontSize: 'clamp(22px, 4vw, 32px)' }}>electron-syphon</h1>
      <p style={{ opacity: 0.6, marginTop: 0, lineHeight: 1.5 }}>
        Many ways to publish an Electron app to <strong>Syphon</strong>. Each method is its own
        server — open them side by side in a Syphon client to compare.
      </p>

      <div
        style={{
          ...card,
          marginTop: 16,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 20,
          alignItems: 'start'
        }}
      >
        <Group label="Scene">
          <Row>
            {(state?.scenes ?? ['canvas2d', 'webgl', 'webgpu']).map((s) => (
              <Pill key={s} on={state?.scene === s} onClick={() => window.api.syphon.setScene(s)}>
                {s}
              </Pill>
            ))}
          </Row>
        </Group>
        <Group
          label="Output scale"
          hint="deviceScaleFactor — Electron 34+. On Retina, 1× = 720p, 2× = 1440p."
        >
          <Row>
            {[1, 2].map((s) => (
              <Pill key={s} on={state?.scale === s} onClick={() => window.api.syphon.setScale(s)}>
                {s}×
              </Pill>
            ))}
          </Row>
        </Group>
        <Group
          label="Frame rate"
          hint="setFrameRate — Electron 36+ removed the 240 cap on the shared-texture path."
        >
          <Row>
            {[30, 60, 120, 240].map((f) => (
              <Pill key={f} on={state?.fps === f} onClick={() => window.api.syphon.setFps(f)}>
                {f}
              </Pill>
            ))}
          </Row>
        </Group>
        <Group
          label="Extra outputs"
          hint="Each is its own offscreen window AND its own Syphon server, labelled in the frame."
        >
          <Row>
            {[0, 1, 2, 4].map((n) => (
              <Pill
                key={n}
                on={state?.outputCount === n}
                onClick={() => window.api.syphon.setOutputs(n)}
              >
                +{n}
              </Pill>
            ))}
          </Row>
        </Group>
        <Group label="Orientation">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={flipOn}
              onChange={(e) => window.api.syphon.setFlip(e.target.checked)}
            />
            Flip vertically
          </label>
        </Group>
      </div>

      <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
        {(state?.methods ?? []).map((m) => (
          <MethodCard key={m.id} m={m} fps={fps[m.id] ?? 0} />
        ))}
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ opacity: 0.55, fontSize: 12, textTransform: 'uppercase', marginBottom: 8 }}>
          Syphon servers on this machine ({state?.servers.length ?? 0})
        </div>
        {(state?.servers ?? []).length === 0 ? (
          <div style={{ opacity: 0.5 }}>none yet…</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state?.servers.map((s) => (
              <li key={s.uuid} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
                {s.appName} / <strong>{s.name || '(unnamed)'}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 16 }}>
        Open <em>Resolume, MadMapper, VDMX, TouchDesigner</em> or Syphon Recorder and pick an{' '}
        <strong>electron-syphon</strong> source.
      </p>
    </div>
  )
}

function MethodCard({ m, fps }: { m: MethodStats; fps: number }): React.JSX.Element {
  const path =
    m.usingSharedTexture === true
      ? '⚡ zero-copy IOSurface'
      : m.usingSharedTexture === false
        ? 'CPU bitmap'
        : '—'
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            <Dot on={m.running} /> {m.label}
          </div>
          <div style={{ opacity: 0.6, fontSize: 13, marginTop: 2 }}>{m.description}</div>
        </div>
        <label style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={m.running}
            onChange={(e) => window.api.syphon.toggle(m.id, e.target.checked)}
          />
        </label>
      </div>
      {m.running && (
        <div style={{ display: 'flex', gap: 18, marginTop: 10, fontSize: 13, flexWrap: 'wrap' }}>
          <span>{path}</span>
          <span>
            {m.width}×{m.height}
          </span>
          <span>{fps.toFixed(0)} fps</span>
          <span>{m.avgPublishMs.toFixed(2)} ms/frame</span>
          <span>
            <Dot on={m.hasClients} />
            {m.hasClients ? 'client' : 'no client'}
          </span>
        </div>
      )}
    </div>
  )
}
