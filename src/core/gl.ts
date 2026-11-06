import type { RawTex, TexSource, UniformValue } from './types';

export interface Tex {
  tex: WebGLTexture;
  fb: WebGLFramebuffer | null;
  width: number;
  height: number;
  float: boolean;
  filter: 'linear' | 'nearest';
  /** Pool bookkeeping. */
  pooled?: boolean;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, { loc: WebGLUniformLocation; type: number; size: number }>;
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // full-screen triangle; v_uv (0,0) = first row in memory = image top
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export class ShaderCompileError extends Error {
  constructor(message: string, public log: string, public source: string) {
    super(message);
  }
}

/** Thin WebGL2 wrapper: programs, textures, render targets, pooling. */
export class GL {
  gl: WebGL2RenderingContext;
  floatRT: boolean;
  private vao: WebGLVertexArrayObject;
  private programs = new Map<string, ProgramInfo | ShaderCompileError>();
  private pool: Tex[] = [];
  private fallbacks = new Map<string, Tex>();
  maxSize: number;

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      alpha: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not supported in this browser');
    this.gl = gl;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  /** Compile (cached) a fragment shader. Throws ShaderCompileError. */
  program(fragSource: string): ProgramInfo {
    const cached = this.programs.get(fragSource);
    if (cached instanceof ShaderCompileError) throw cached;
    if (cached) return cached;
    const gl = this.gl;
    try {
      const vs = this.compile(gl.VERTEX_SHADER, VERT);
      const fs = this.compile(gl.FRAGMENT_SHADER, fragSource);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.bindAttribLocation(program, 0, 'a_pos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || '';
        throw new ShaderCompileError('Shader link failed: ' + log, log, fragSource);
      }
      const uniforms = new Map<string, { loc: WebGLUniformLocation; type: number; size: number }>();
      const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(program, i)!;
        const name = info.name.replace(/\[0\]$/, '');
        const loc = gl.getUniformLocation(program, info.name);
        if (loc) uniforms.set(name, { loc, type: info.type, size: info.size });
      }
      const p = { program, uniforms };
      this.programs.set(fragSource, p);
      return p;
    } catch (e) {
      if (e instanceof ShaderCompileError) this.programs.set(fragSource, e);
      throw e;
    }
  }

  private compile(type: number, src: string) {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || '';
      throw new ShaderCompileError('Shader compile failed:\n' + log, log, src);
    }
    return s;
  }

  createTarget(width: number, height: number, filter: 'linear' | 'nearest' = 'linear', float = this.floatRT): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, width, height);
    this.setFilter(filter, false);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, width, height, float, filter };
  }

  private setFilter(filter: 'linear' | 'nearest', mips: boolean) {
    const gl = this.gl;
    const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Get a render target from the pool (or create one). */
  acquire(width: number, height: number, filter: 'linear' | 'nearest' = 'linear'): Tex {
    width = Math.max(1, Math.min(this.maxSize, Math.round(width)));
    height = Math.max(1, Math.min(this.maxSize, Math.round(height)));
    const i = this.pool.findIndex((t) => t.width === width && t.height === height);
    if (i >= 0) {
      const t = this.pool.splice(i, 1)[0];
      t.pooled = false;
      if (t.filter !== filter) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, t.tex);
        this.setFilter(filter, false);
        t.filter = filter;
      }
      return t;
    }
    return this.createTarget(width, height, filter);
  }

  release(t: Tex | null | undefined) {
    if (!t || t.pooled || !t.fb) return;
    t.pooled = true;
    this.pool.push(t);
    // keep pool bounded
    while (this.pool.length > 24) this.destroy(this.pool.shift()!);
  }

  destroy(t: Tex) {
    this.gl.deleteTexture(t.tex);
    if (t.fb) this.gl.deleteFramebuffer(t.fb);
  }

  /** Upload a CPU source as a (non-render-target) texture. Images get mipmaps for good downscaling. */
  upload(src: TexSource, prev?: Tex): Tex {
    const gl = this.gl;
    if (prev) this.destroy(prev);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    let width: number, height: number, float = false;
    let filter: 'linear' | 'nearest' = 'linear';
    let mips = false;
    if (isRaw(src)) {
      width = src.width;
      height = src.height;
      filter = src.filter ?? 'linear';
      if (src.data instanceof Float32Array) {
        float = true;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, src.data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
      }
    } else {
      width = (src as { width: number }).width;
      height = (src as { height: number }).height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      gl.generateMipmap(gl.TEXTURE_2D);
      mips = true;
    }
    this.setFilter(filter, mips);
    return { tex, fb: null, width, height, float, filter };
  }

  /** 1x1 constant texture for unconnected optional inputs. */
  fallback(kind: 'black' | 'white' | 'transparent' | 'gray'): Tex {
    let t = this.fallbacks.get(kind);
    if (!t) {
      const v = { black: [0, 0, 0, 255], white: [255, 255, 255, 255], transparent: [0, 0, 0, 0], gray: [128, 128, 128, 255] }[kind];
      t = this.upload({ width: 1, height: 1, data: new Uint8Array(v), filter: 'nearest' });
      this.fallbacks.set(kind, t);
    }
    return t;
  }

  /** Run a fragment program into `target` (null = canvas). */
  draw(
    prog: ProgramInfo,
    target: Tex | null,
    textures: Record<string, Tex>,
    uniforms: Record<string, UniformValue>,
    viewport?: [number, number, number, number],
  ) {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    if (viewport) gl.viewport(...viewport);
    else if (target) gl.viewport(0, 0, target.width, target.height);
    else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      const u = prog.uniforms.get(name);
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(u.loc, unit);
      unit++;
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const u = prog.uniforms.get(name);
      if (!u) continue;
      setUniform(gl, u.type, u.loc, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read a texture's pixels as RGBA float (top row first). */
  readFloat(t: Tex): Float32Array {
    const gl = this.gl;
    const fb = t.fb ?? this.tmpFb(t);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    let out: Float32Array;
    if (t.float) {
      out = new Float32Array(t.width * t.height * 4);
      gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, out);
    } else {
      const u8 = new Uint8Array(t.width * t.height * 4);
      gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, u8);
      out = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
    }
    if (!t.fb) gl.deleteFramebuffer(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Read as 8-bit RGBA (top row first). Float textures are clamped/rounded. */
  readU8(t: Tex): Uint8ClampedArray<ArrayBuffer> {
    const f = this.readFloat(t);
    const out = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i] * 255);
    return out;
  }

  private tmpFb(t: Tex) {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return fb;
  }
}

function isRaw(s: TexSource): s is RawTex {
  return typeof (s as RawTex).data !== 'undefined' && !(s instanceof ImageData);
}

function setUniform(gl: WebGL2RenderingContext, type: number, loc: WebGLUniformLocation, v: UniformValue) {
  const arr = Array.isArray(v) ? v : [typeof v === 'boolean' ? (v ? 1 : 0) : v];
  switch (type) {
    case gl.FLOAT: arr.length > 1 ? gl.uniform1fv(loc, arr) : gl.uniform1f(loc, arr[0]); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(loc, arr); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(loc, arr); break;
    case gl.INT:
    case gl.BOOL: gl.uniform1iv(loc, arr.map((x) => Math.round(x))); break;
    case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, arr.map(Math.round)); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, arr); break;
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, arr); break;
  }
}
