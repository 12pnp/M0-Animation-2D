import { drawnVertices } from "@/engine/draw";
import type { BlendMode } from "@/engine/rigTypes";
import type { Camera, Size } from "./camera";
import type { Posed } from "./posed";

/**
 * Draws the posed skeleton's images with WebGL2: one draw per slot, in draw order. Textures are
 * premultiplied (the session uploads them so); a slot's colour tints them, and a slot with a dark
 * colour gets two-colour tint: each channel goes from the dark colour where the image is black to
 * the light colour where it is white. A clipping attachment cuts the slots under it through the
 * stencil buffer (its polygon drawn as a fan with INVERT, so a concave one works too).
 */

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec4 a_light;
in vec3 a_dark;
uniform vec4 u_view;
out vec2 v_uv;
out vec4 v_light;
out vec3 v_dark;
void main() {
  v_uv = a_uv;
  v_light = a_light;
  v_dark = a_dark;
  gl_Position = vec4((a_pos - u_view.xy) * u_view.zw, 0.0, 1.0);
}`;

// t is premultiplied: t.rgb = colour × t.a. Light is straight (not premultiplied).
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_light;
in vec3 v_dark;
uniform sampler2D u_tex;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  o = vec4(v_light.a * (t.rgb * v_light.rgb + (t.a - t.rgb) * v_dark), t.a * v_light.a);
}`;

/** Floats per vertex: x y, u v, light r g b a, dark r g b. */
const STRIDE = 11;

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly view: WebGLUniformLocation;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly textures = new Map<ImageBitmap, WebGLTexture>();
  private readonly white: WebGLTexture;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: false, stencil: true, antialias: true });
    if (!gl) throw new Error("This browser has no WebGL2; the stage cannot draw.");
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    this.view = gl.getUniformLocation(this.program, "u_view")!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    const attr = (name: string, size: number, offset: number) => {
      const at = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    attr("a_pos", 2, 0);
    attr("a_uv", 2, 2);
    attr("a_light", 4, 4);
    attr("a_dark", 3, 8);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  /** Drop the textures of pages no longer shown. */
  keepOnly(pages: ReadonlyMap<string, ImageBitmap>): void {
    const live = new Set(pages.values());
    for (const [bitmap, tex] of this.textures) {
      if (!live.has(bitmap)) { this.gl.deleteTexture(tex); this.textures.delete(bitmap); }
    }
  }

  /** `size` in CSS pixels; the canvas is `size × dpr` device pixels. */
  draw(p: Posed | null, pages: ReadonlyMap<string, ImageBitmap>, cam: Camera, size: Size, dpr: number, background: [number, number, number]): void {
    const gl = this.gl;
    gl.viewport(0, 0, Math.round(size.width * dpr), Math.round(size.height * dpr));
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (!p) return;
    gl.useProgram(this.program);
    gl.uniform4f(this.view, cam.x, cam.y, (cam.zoom * 2) / size.width, (cam.zoom * 2) / size.height);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    let clip = -1;
    for (const d of p.draw.slots) {
      if (d.clip !== clip) {
        clip = d.clip;
        this.setClip(p, clip);
      }
      const page = pages.get(d.frame.region.page.name);
      if (!page) continue;
      const n = d.vertexCount;
      const pos = new Float64Array(n * 2);
      drawnVertices(p.rig, d, pos);
      const data = new Float32Array(n * STRIDE), uvs = d.frame.uvs, [r, g, b, a] = d.color, dark = d.dark ?? [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        data[o] = pos[i * 2]!; data[o + 1] = pos[i * 2 + 1]!;
        data[o + 2] = uvs[i * 2]!; data[o + 3] = uvs[i * 2 + 1]!;
        data[o + 4] = r; data[o + 5] = g; data[o + 6] = b; data[o + 7] = a;
        data[o + 8] = dark[0]; data[o + 9] = dark[1]; data[o + 10] = dark[2];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture(page));
      blend(gl, d.blend);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.triangles, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, d.triangles.length, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.STENCIL_TEST);
  }

  /** Open the clip of slot `slot` (its polygon into the stencil), or close any with -1. */
  private setClip(p: Posed, slot: number): void {
    const gl = this.gl;
    const c = slot >= 0 ? p.draw.clips.get(slot) : undefined;
    if (!c || c.vertexCount < 3) { gl.disable(gl.STENCIL_TEST); return; }
    const pos = new Float64Array(c.vertexCount * 2);
    p.rig.vertexWorld(slot, c, 0, c.vertexCount * 2, pos, 0);
    const data = new Float32Array(c.vertexCount * STRIDE);
    for (let i = 0; i < c.vertexCount; i++) { data[i * STRIDE] = pos[i * 2]!; data[i * STRIDE + 1] = pos[i * 2 + 1]!; }
    gl.enable(gl.STENCIL_TEST);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(1);
    gl.stencilFunc(gl.ALWAYS, 0, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, c.vertexCount);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, c.inverse ? 0 : 1, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private texture(bitmap: ImageBitmap): WebGLTexture {
    let t = this.textures.get(bitmap);
    if (t) return t;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(bitmap, t);
    return t;
  }
}

/** Premultiplied compositing for each of Spine's blend modes. */
function blend(gl: WebGL2RenderingContext, mode: BlendMode): void {
  switch (mode) {
    case "additive": gl.blendFunc(gl.ONE, gl.ONE); break;
    case "multiply": gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
    case "screen": gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
    default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Stage shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Stage shader: ${gl.getProgramInfoLog(p)}`);
  return p;
}
