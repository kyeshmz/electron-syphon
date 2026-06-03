import { startCanvas2D } from './canvas2d'

/** An animated WebGL plasma shader. Returns a stop() function. */
export function startWebGL(canvas: HTMLCanvasElement): () => void {
  const gl =
    (canvas.getContext('webgl', { alpha: false }) as WebGLRenderingContext | null) ??
    (canvas.getContext('experimental-webgl', { alpha: false }) as WebGLRenderingContext | null)
  if (!gl) {
    console.error('[webgl] getContext returned null — falling back to canvas2d')
    return startCanvas2D(canvas)
  }

  const vs = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`
  const fs = `precision highp float;
    uniform vec2 r;
    uniform float t;
    void main(){
      vec2 uv = gl_FragCoord.xy / r;
      float v = sin(uv.x*10.0 + t)
              + sin(uv.y*10.0 + t*1.3)
              + sin((uv.x+uv.y)*10.0 + t*0.7)
              + sin(length(uv - vec2(0.5))*20.0 - t*2.0);
      vec3 col = 0.5 + 0.5*cos(vec3(0.0, 2.0, 4.0) + v + t*0.2);
      gl_FragColor = vec4(col, 1.0);
    }`

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('[webgl] shader compile error:', gl.getShaderInfoLog(sh))
      return null
    }
    return sh
  }
  const vsh = compile(gl.VERTEX_SHADER, vs)
  const fsh = compile(gl.FRAGMENT_SHADER, fs)
  const prog = gl.createProgram()!
  if (vsh) gl.attachShader(prog, vsh)
  if (fsh) gl.attachShader(prog, fsh)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[webgl] program link error:', gl.getProgramInfoLog(prog))
  }
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const uR = gl.getUniformLocation(prog, 'r')
  const uT = gl.getUniformLocation(prog, 't')

  let raf = 0
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
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(uR, canvas.width, canvas.height)
    gl.uniform1f(uT, tMs / 1000)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    raf = requestAnimationFrame(draw)
  }
  raf = requestAnimationFrame(draw)
  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
  }
}
