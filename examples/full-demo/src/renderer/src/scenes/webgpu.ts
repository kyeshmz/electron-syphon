/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * An animated WebGPU scene (fullscreen triangle, time-based gradient).
 * Falls back to an animated 2D message if WebGPU is unavailable. Returns stop().
 * Typed loosely (`any`) so it needs no @webgpu/types dependency.
 */
export function startWebGPU(canvas: HTMLCanvasElement): () => void {
  let stopped = false
  let raf = 0

  const fallback = (msg: string): void => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const tick = (t: number): void => {
      if (stopped) return
      canvas.width = canvas.clientWidth || 1280
      canvas.height = canvas.clientHeight || 720
      ctx.fillStyle = '#101418'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = `hsl(${(t / 20) % 360},80%,55%)`
      ctx.fillRect((t / 5) % canvas.width, 0, 80, canvas.height)
      ctx.fillStyle = 'white'
      ctx.textAlign = 'center'
      ctx.font = '600 36px system-ui'
      ctx.fillText(msg, canvas.width / 2, canvas.height / 2)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  const gpu: any = (navigator as any).gpu
  if (!gpu) {
    fallback('WebGPU unavailable')
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }

  ;(async () => {
    try {
      const adapter = await gpu.requestAdapter()
      const device: any = await adapter.requestDevice()
      const ctx: any = canvas.getContext('webgpu')
      const format = gpu.getPreferredCanvasFormat()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round((canvas.clientWidth || 1280) * dpr)
      canvas.height = Math.round((canvas.clientHeight || 720) * dpr)
      ctx.configure({ device, format, alphaMode: 'opaque' })

      const module = device.createShaderModule({
        code: `
        @group(0) @binding(0) var<uniform> t : f32;
        @vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
          var p = array<vec2f,3>(vec2f(-1.,-1.), vec2f(3.,-1.), vec2f(-1.,3.));
          return vec4f(p[i], 0., 1.);
        }
        @fragment fn fs(@builtin(position) c: vec4f) -> @location(0) vec4f {
          let uv = c.xy / vec2f(${canvas.width}., ${canvas.height}.);
          let v = sin(uv.x*10.+t) + sin(uv.y*10.+t*1.3) + sin(length(uv-0.5)*18.-t*2.);
          let col = 0.5 + 0.5*cos(vec3f(0.,2.,4.) + v + t*0.2);
          return vec4f(col, 1.);
        }`
      })
      const usage = (globalThis as any).GPUBufferUsage
      const ubuf = device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST })
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      })
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ubuf } }]
      })

      const frame = (tMs: number): void => {
        if (stopped) return
        device.queue.writeBuffer(ubuf, 0, new Float32Array([tMs / 1000]))
        const enc = device.createCommandEncoder()
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: ctx.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.draw(3)
        pass.end()
        device.queue.submit([enc.finish()])
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    } catch {
      fallback('WebGPU init failed')
    }
  })()

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
  }
}
