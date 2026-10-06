import { drawnVertices } from "@/engine/draw";
import type { BlendMode } from "@/engine/rigTypes";
import type { Camera, Size } from "./camera";
import type { StageLook } from "./look";
import { NO_LOOK } from "./look";
import type { Ghost } from "./onion";
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

/** A reference image as the renderer draws it: its corners and UVs (`referenceQuad`), at an opacity. */
export interface Backdrop { readonly bitmap: ImageBitmap; readonly xy: readonly number[]; readonly uv: readonly number[]; readonly opacity: number }

/** Two triangles over four corners in order. */
const QUAD_FAN = new Uint32Array([0, 1, 2, 2, 3, 0]);

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly view: WebGLUniformLocation;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly textures = new Map<ImageBitmap, WebGLTexture>();
  private readonly white: WebGLTexture;
  private checkerTex: WebGLTexture | null = null;

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
  keepOnly(pages: ReadonlyMap<string, ImageBitmap>, also: Iterable<ImageBitmap> = []): void {
    const live = new Set([...pages.values(), ...also]);
    for (const [bitmap, tex] of this.textures) {
      if (!live.has(bitmap)) { this.gl.deleteTexture(tex); this.textures.delete(bitmap); }
    }
  }

  /** `size` in CSS pixels; the canvas is `size × dpr` device pixels. */
  draw(p: Posed | null, pages: ReadonlyMap<string, ImageBitmap>, cam: Camera, size: Size, dpr: number, background: [number, number, number],
    references: readonly Backdrop[] = [], ghosts: readonly Ghost[] = [], grid: number | null = null, look: StageLook = NO_LOOK): void {
    const gl = this.gl;
    gl.viewport(0, 0, Math.round(size.width * dpr), Math.round(size.height * dpr));
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (!p && !references.length && !grid && !look.checker && !look.axes) return;
    gl.useProgram(this.program);
    gl.uniform4f(this.view, cam.x, cam.y, (cam.zoom * 2) / size.width, (cam.zoom * 2) / size.height);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    // The grid (E6 step 4e): behind everything.
    if (look.checker) this.checker(look.checker, look.checkerColour, cam, size, background);
    if (grid) this.grid(grid, cam, size, background, look.gridColour, look.gridPx);
    if (look.axes) this.centreAxes(cam, size, look);
    // Reference images first: behind the skeleton (E4 step 9).
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const r of references) {
      const data = new Float32Array(4 * STRIDE);
      for (let i = 0; i < 4; i++) {
        const o = i * STRIDE;
        data[o] = r.xy[i * 2]!; data[o + 1] = r.xy[i * 2 + 1]!;
        data[o + 2] = r.uv[i * 2]!; data[o + 3] = r.uv[i * 2 + 1]!;
        data[o + 4] = 1; data[o + 5] = 1; data[o + 6] = 1; data[o + 7] = r.opacity;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture(r.bitmap));
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QUAD_FAN, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 0);
    }
    if (!p) return;
    // Onion skin (E6 step 4d): each ghost posed when its turn comes and drawn faint, before the skeleton.
    for (const g of ghosts) {
      const gp = g.pose();
      if (gp) this.slots(gp, pages, g);
    }
    this.slots(p, pages, null);
  }

  /**
   * Every slot of `p` in draw order. A ghost draws at its opacity: in its colour as a silhouette
   * (light and dark both the colour, so every pixel takes it), or in the slot's own colours faded.
   */
  private slots(p: Posed, pages: ReadonlyMap<string, ImageBitmap>, ghost: Ghost | null): void {
    const gl = this.gl;
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
      const data = new Float32Array(n * STRIDE), uvs = d.frame.uvs, tint = ghost?.colour;
      const [r, g, b] = tint ?? d.color, a = d.color[3] * (ghost ? ghost.opacity : 1), dark = tint ?? d.dark ?? [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        data[o] = pos[i * 2]!; data[o + 1] = pos[i * 2 + 1]!;
        data[o + 2] = uvs[i * 2]!; data[o + 3] = uvs[i * 2 + 1]!;
        data[o + 4] = r; data[o + 5] = g; data[o + 6] = b; data[o + 7] = a;
        data[o + 8] = dark[0]; data[o + 9] = dark[1]; data[o + 10] = dark[2];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture(page));
      blend(gl, ghost ? "normal" : d.blend);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.triangles, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, d.triangles.length, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.STENCIL_TEST);
  }

  /**
   * A checkerboard of `cell`-unit squares behind everything: one quad over the view, textured with
   * a repeating 2x2 pattern (nearest filtering), faint, in the colour that shows on the background.
   * Zoomed far out the cell grows by fives, so a square stays at least 8 pixels.
   */
  private checker(cell: number, colour: readonly number[] | null, cam: Camera, size: Size, background: readonly number[]): void {
    const gl = this.gl;
    let c = cell;
    while (c * cam.zoom < 8) c *= 5;
    const lightBg = background[0]! * 0.3 + background[1]! * 0.59 + background[2]! * 0.11 > 0.5;
    const tex = (this.checkerTex ??= this.checkerTexture());
    const [cr, cg, cb] = colour ?? (lightBg ? [0, 0, 0] : [1, 1, 1]);
    const halfW = size.width / 2 / cam.zoom, halfH = size.height / 2 / cam.zoom;
    const x0 = cam.x - halfW, x1 = cam.x + halfW, y0 = cam.y - halfH, y1 = cam.y + halfH;
    const v = (x: number, y: number) => [x, y, x / (2 * c), y / (2 * c), cr!, cg!, cb!, 1, 0, 0, 0];
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...v(x0, y0), ...v(x1, y0), ...v(x1, y1), ...v(x0, y1)]), gl.STREAM_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QUAD_FAN, gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 0);
  }

  /** A 2x2 premultiplied texture, repeating: two clear texels and two faint white ones (the vertex colour tints them). */
  private checkerTexture(): WebGLTexture {
    const gl = this.gl, a = 18, c = a;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0, c, c, c, a, c, c, c, a, 0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  /** The centre axes through the origin, each in its own colour (dark grey unless set), over the checkerboard. */
  private centreAxes(cam: Camera, size: Size, look: StageLook): void {
    const gl = this.gl;
    const halfW = size.width / 2 / cam.zoom, halfH = size.height / 2 / cam.zoom, h = look.axisPx / 2 / cam.zoom;
    const x0 = cam.x - halfW, x1 = cam.x + halfW, y0 = cam.y - halfH, y1 = cam.y + halfH;
    const quad = (ax: number, ay: number, bx: number, by: number, r: number, g: number, b: number) => [
      [ax, ay], [bx, ay], [bx, by], [ax, by]].flatMap(([x, y]) => [x!, y!, 0, 0, r, g, b, 0.7, 0, 0, 0]);
    // The x axis (y = 0) runs along the view's width; the y axis (x = 0) along its height.
    const data = new Float32Array([...quad(x0, -h, x1, h, ...look.axisX), ...quad(-h, y0, h, y1, ...look.axisY)]);
    const idx = new Uint32Array([0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4]);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, 12, gl.UNSIGNED_INT, 0);
  }

  /**
   * Lines every `spacing` units across the view, one screen pixel wide: every fifth stronger, the
   * axes through the origin strongest; in the colour that shows on the background. Zoomed far
   * out, only every fifth (then every 25th…) is drawn, so lines stay at least 6 pixels apart.
   */
  private grid(spacing: number, cam: Camera, size: Size, background: readonly number[], colour: readonly number[] | null, thickness: number): void {
    const gl = this.gl;
    let step = spacing;
    while (step * cam.zoom < 6) step *= 5;
    const halfW = size.width / 2 / cam.zoom, halfH = size.height / 2 / cam.zoom, px = thickness / cam.zoom;
    const x0 = cam.x - halfW, x1 = cam.x + halfW, y0 = cam.y - halfH, y1 = cam.y + halfH;
    const light = background[0]! * 0.3 + background[1]! * 0.59 + background[2]! * 0.11 > 0.5 ? 0 : 1;
    const [lr, lg, lb] = colour ?? [light, light, light];
    const quads: number[] = [];
    const line = (ax: number, ay: number, bx: number, by: number, alpha: number) => {
      // A thin quad: x and y lines are one pixel thick across their run.
      const vx = ax === bx, h = px / 2;
      const c = [ax - (vx ? h : 0), ay - (vx ? 0 : h), bx + (vx ? h : 0), by - (vx ? 0 : h), bx + (vx ? h : 0), by + (vx ? 0 : h), ax - (vx ? h : 0), ay + (vx ? 0 : h)];
      for (let i = 0; i < 4; i++) quads.push(c[i * 2]!, c[i * 2 + 1]!, 0, 0, lr!, lg!, lb!, alpha, lr!, lg!, lb!);
    };
    const strength = (v: number) => (Math.abs(v) < step / 2 ? 0.35 : Math.round(v / step) % 5 === 0 ? 0.18 : 0.08);
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) line(x, y0, x, y1, strength(x));
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) line(x0, y, x1, y, strength(y));
    const n = quads.length / (4 * STRIDE);
    if (!n) return;
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 3, i * 4], i * 6);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quads), gl.STREAM_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
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
