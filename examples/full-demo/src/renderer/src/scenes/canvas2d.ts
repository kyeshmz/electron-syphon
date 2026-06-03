/** A generative 2D-canvas animation. Returns a stop() function. */
export function startCanvas2D(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return () => {}
  let raf = 0
  let frame = 0
  let stopped = false

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round((canvas.clientWidth || 1280) * dpr)
    canvas.height = Math.round((canvas.clientHeight || 720) * dpr)
  }
  resize()
  window.addEventListener('resize', resize)

  const draw = (tMs: number): void => {
    if (stopped) return
    const w = canvas.width
    const h = canvas.height
    const t = tMs / 1000
    const hue = (t * 20) % 360
    const bg = ctx.createLinearGradient(0, 0, w, h)
    bg.addColorStop(0, `hsl(${hue}, 70%, 12%)`)
    bg.addColorStop(1, `hsl(${(hue + 80) % 360}, 70%, 22%)`)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    ctx.lineWidth = Math.max(2, w / 400)
    for (let i = 0; i < 14; i++) {
      const r = ((t * 120 + i * 60) % (Math.max(w, h) * 0.7)) + 10
      ctx.strokeStyle = `hsla(${(hue + i * 18) % 360}, 90%, 65%, ${1 - r / (Math.max(w, h) * 0.7)})`
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    const px = cx + Math.cos(t * 1.3) * (w * 0.34)
    const py = cy + Math.sin(t * 1.7) * (h * 0.34)
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 95%, 60%)`
    ctx.beginPath()
    ctx.arc(px, py, Math.max(10, w / 40), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'white'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 ${Math.round(w / 20)}px system-ui, sans-serif`
    ctx.fillText('electron-syphon · canvas2d', cx, cy - h * 0.05)
    ctx.font = `500 ${Math.round(w / 46)}px ui-monospace, monospace`
    ctx.fillText(`frame ${frame} · ${new Date().toLocaleTimeString()}`, cx, cy + h * 0.06)
    frame++
    raf = requestAnimationFrame(draw)
  }
  raf = requestAnimationFrame(draw)
  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
  }
}
