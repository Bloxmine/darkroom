/**
 * Small, non-blocking GPU readbacks for the viewer's pro tools: a decimated copy of a
 * texture for the scopes (≤ 320 px, point-sampled so clipped pixels stay clipped) and
 * single-pixel / n×n reads for the pixel readout, colour samplers and eyedropper.
 *
 * Every read goes through a PIXEL_PACK_BUFFER + fence and is collected on a later task
 * once the fence has passed, so it never stalls the render loop (no sync readPixels).
 */
import type { GL, Tex } from './gl';

const DECIMATE_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec2 u_ratio;
void main() {
  ivec2 sz = textureSize(u_src, 0);
  ivec2 p = clamp(ivec2(gl_FragCoord.xy * u_ratio), ivec2(0), sz - 1);
  fragColor = clamp(texelFetch(u_src, p, 0), 0.0, 1.0);
}`;

const targets = new WeakMap<GL, Map<string, Tex>>();

function target(g: GL, w: number, h: number): Tex {
  let m = targets.get(g);
  if (!m) targets.set(g, (m = new Map()));
  const k = w + 'x' + h;
  let t = m.get(k);
  if (!t) {
    if (m.size > 8) {
      for (const x of m.values()) g.destroy(x);
      m.clear();
    }
    t = g.createTarget(w, h, 'nearest', false);
    m.set(k, t);
  }
  return t;
}

/** Issue an async readPixels of a framebuffer region into a PBO; resolve once the GPU is done. */
function readAsync(g: GL, fb: WebGLFramebuffer, x: number, y: number, w: number, h: number, float: boolean, timeoutMs = 3000): Promise<Float32Array | Uint8Array | null> {
  const gl = g.gl;
  const bytes = w * h * 4 * (float ? 4 : 1);
  const pbo = gl.createBuffer()!;
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.readPixels(x, y, w, h, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  const t0 = performance.now();
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      let out: Float32Array | Uint8Array | null = null;
      if (ok && !gl.isContextLost()) {
        out = float ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
      gl.deleteBuffer(pbo);
      if (sync) gl.deleteSync(sync);
      resolve(out);
    };
    const poll = () => {
      if (!sync || gl.isContextLost()) return done(false);
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) return done(true);
      if (st === gl.WAIT_FAILED || performance.now() - t0 > timeoutMs) return done(false);
      setTimeout(poll, 4);
    };
    setTimeout(poll, 0);
  });
}

/** A framebuffer for reading `t` (uploaded textures have none; a temporary one is made). */
function withFb<T>(g: GL, t: Tex, fn: (fb: WebGLFramebuffer) => T): T {
  if (t.fb) return fn(t.fb);
  const gl = g.gl;
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  try {
    return fn(fb);
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); // the queued readPixels keeps working
  }
}

/**
 * Read an RGBA region of a texture as floats (0..1, HDR values preserved for float textures).
 * Texel row 0 = image top. Null if the context is lost or the GPU is too busy (> 3 s).
 */
export async function readRegion(g: GL, t: Tex, x: number, y: number, w: number, h: number): Promise<Float32Array | null> {
  x = Math.max(0, Math.min(t.width - 1, Math.floor(x)));
  y = Math.max(0, Math.min(t.height - 1, Math.floor(y)));
  w = Math.max(1, Math.min(t.width - x, Math.floor(w)));
  h = Math.max(1, Math.min(t.height - y, Math.floor(h)));
  const float = t.float && g.floatRT;
  const p = withFb(g, t, (fb) => readAsync(g, fb, x, y, w, h, float));
  const r = await p;
  if (!r) return null;
  if (r instanceof Float32Array) return r;
  const f = new Float32Array(r.length);
  for (let i = 0; i < r.length; i++) f[i] = r[i] / 255;
  return f;
}

/**
 * Point-sampled (nearest) decimation of a texture to fit `maxSize`, read back as 8-bit RGBA
 * (top row first). Used for the scopes: ≤ 320 × 320 × 4 bytes per update.
 */
export async function decimate(g: GL, src: Tex, maxSize = 256, timeoutMs = 3000): Promise<ImageData | null> {
  const k = Math.min(1, maxSize / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const dst = target(g, w, h);
  g.draw(g.program(DECIMATE_FRAG), dst, { u_src: src }, { u_ratio: [src.width / w, src.height / h] });
  const px = (await readAsync(g, dst.fb!, 0, 0, w, h, false, timeoutMs)) as Uint8Array | null;
  return px ? new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), w, h) : null;
}

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main() { fragColor = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

/** An owned copy of a texture (same size / precision), e.g. a compare snapshot. Free with g.destroy(). */
export function copyTexture(g: GL, src: Tex): Tex {
  const t = g.createTarget(src.width, src.height, 'linear', src.float && g.floatRT);
  g.draw(g.program(BLIT_FRAG), t, { u_src: src }, {});
  return t;
}
